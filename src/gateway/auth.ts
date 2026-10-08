/**
 * AUTHENTICATION: who is calling?
 *
 * Two kinds of caller, both sent as `Authorization: Bearer <token>`:
 *
 * 1. WEBSITE USERS (your ChatGPT-style site). The user logs in with your
 *    auth provider (Supabase, Firebase, Clerk, Auth0...). The browser sends
 *    that provider's JWT. We verify its signature and map its `sub` claim to
 *    a user + personal org (created on first login, free plan).
 *    This file verifies HS256 JWTs with a shared secret (Supabase's default).
 *    For providers that sign with RS256 + JWKS (Firebase, Clerk, Auth0),
 *    replace verifyJwt() with `jose`'s createRemoteJWKSet + jwtVerify.
 *
 * 2. DEVELOPERS using the API directly, with an API key "mlk_...".
 *    We hash the key and look the hash up (keys are never stored raw).
 *
 * NEVER trust a user id sent in the request body or query string. Identity
 * comes only from a verified token.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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

export async function authenticate(authHeader: string | undefined, store: Store, jwtSecret: string | undefined): Promise<Principal> {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
  if (!token) throw new AppError(401, "authentication_error", "Missing Authorization: Bearer <token>");

  if (token.startsWith(API_KEY_PREFIX)) {
    const p = await store.findApiKeyByHash(hashApiKey(token));
    if (!p) throw new AppError(401, "authentication_error", "Invalid or revoked API key");
    return p;
  }

  if (!jwtSecret) throw new AppError(401, "authentication_error", "Web login is not configured on this server");
  const claims = verifyJwt(token, jwtSecret);
  return store.upsertWebUser(claims.sub, claims.email ?? null);
}
