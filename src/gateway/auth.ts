/**
 * AUTHENTICATION: who is calling?
 *
 * Two kinds of caller, both sent as `Authorization: Bearer <token>`:
 *
 * 1. WEBSITE USERS (your ChatGPT-style site). The user signs in with
 *    Firebase Auth in the browser (Google sign-in etc.), the website calls
 *    `await auth.currentUser.getIdToken()` and sends that token. We verify
 *    it with the Firebase Admin SDK and map the user's uid to a user +
 *    personal org (created on first login, free plan). Same pattern as
 *    `adminAuth.verifyIdToken()` in the FORKSAI API.
 *
 * 2. DEVELOPERS using the API directly, with an API key "mlk_...".
 *    We hash the key and look the hash up (keys are never stored raw).
 *
 * Dev shortcut: outside production, HS256 tokens signed with AUTH_JWT_SECRET
 * (issued by POST /v1/auth/dev-token) are accepted too, so you can test
 * without a Firebase login. They are always rejected in production.
 *
 * NEVER trust a user id sent in the request body or query string. Identity
 * comes only from a verified token.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Auth } from "firebase-admin/auth";
import type { Env } from "../config/env.js";
import { AppError } from "../errors.js";
import type { Principal, Store } from "../store/types.js";

export const API_KEY_PREFIX = "mlk_";

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

interface JwtClaims {
  sub: string;
  email?: string;
  exp?: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Minimal HS256 JWT verification (signature + expiry). */
export function verifyJwt(token: string, secret: string): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AppError(401, "authentication_error", "Malformed token");
  const [header, payload, sig] = parts as [string, string, string];

  let head: { alg?: string };
  try {
    head = JSON.parse(Buffer.from(header, "base64url").toString()) as { alg?: string };
  } catch {
    throw new AppError(401, "authentication_error", "Malformed token");
  }
  // Reject "alg: none" and algorithm-confusion attacks: only accept what we expect.
  if (head.alg !== "HS256") throw new AppError(401, "authentication_error", "Unsupported token algorithm");

  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const given = Buffer.from(sig, "base64url");
  // timingSafeEqual: comparing byte-by-byte with === leaks timing info to attackers.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new AppError(401, "authentication_error", "Invalid token signature");
  }
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as JwtClaims;
  if (!claims.sub) throw new AppError(401, "authentication_error", "Token has no subject");
  if (claims.exp && claims.exp * 1000 < Date.now()) throw new AppError(401, "authentication_error", "Token expired");
  return claims;
}

/** Issue an HS256 token. Used only by the dev login route and tests. */
export function signJwt(claims: JwtClaims, secret: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

/** Verifies a website login token and returns who it belongs to. */
export type WebTokenVerifier = (token: string) => Promise<{ uid: string; email: string | null }>;

function tokenAlg(token: string): string | undefined {
  try {
    return (JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString()) as { alg?: string }).alg;
  } catch {
    return undefined;
  }
}

export function createWebTokenVerifier(env: Env, firebaseAuth?: Auth): WebTokenVerifier {
  const devSecret = env.NODE_ENV !== "production" ? env.AUTH_JWT_SECRET : undefined;

  return async (token) => {
    // Dev tokens are HS256; Firebase ID tokens are RS256. The header tells them apart.
    if (tokenAlg(token) === "HS256") {
      if (!devSecret) throw new AppError(401, "authentication_error", "Invalid token");
      const c = verifyJwt(token, devSecret);
      return { uid: c.sub, email: c.email ?? null };
    }
    if (!firebaseAuth) throw new AppError(401, "authentication_error", "Web login is not configured on this server");
    try {
      // Checks signature against Google's public keys, expiry, audience (your project) and issuer.
      const decoded = await firebaseAuth.verifyIdToken(token);
      return { uid: decoded.uid, email: decoded.email ?? null };
    } catch {
      throw new AppError(401, "authentication_error", "Invalid or expired login. Please sign in again.");
    }
  };
}

export async function authenticate(authHeader: string | undefined, store: Store, verifyWebToken: WebTokenVerifier): Promise<Principal> {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
  if (!token) throw new AppError(401, "authentication_error", "Missing Authorization: Bearer <token>");

  if (token.startsWith(API_KEY_PREFIX)) {
    const p = await store.findApiKeyByHash(hashApiKey(token));
    if (!p) throw new AppError(401, "authentication_error", "Invalid or revoked API key");
    return p;
  }

  const { uid, email } = await verifyWebToken(token);
  return store.upsertWebUser(uid, email);
}
