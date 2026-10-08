/**
 * Environment configuration.
 *
 * WHY: every setting the service needs is read and validated here, once, at
 * boot. If something is missing or malformed the process refuses to start
 * with a clear message. That is far better than discovering a bad
 * REDIS_URL on the first paying customer's request.
 *
 * Nothing else in the codebase should read process.env directly.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { z } from "zod";

/**
 * Load the .env file in the current folder into process.env, if there is one.
 * Real environment variables win over the file, so a host's settings
 * (Render, Cloud Run...) always take precedence. In production there is
 * usually no .env file at all, which is fine.
 */
export function loadDotEnvFile(path = ".env"): boolean {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}

// zod's coerce turns the string "8080" into the number 8080, etc.
const boolish = z
  .enum(["true", "false", "1", "0", ""])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // Storage backends. "memory" = zero-setup dev mode (lost on restart).
  // STORE holds users, chats and the billing ledger: Firestore in production.
  STORE: z.enum(["memory", "firestore"]).default("memory"),
  // KV holds the fast rate-limit / quota counters. "firestore" works for
  // launch-level traffic; "redis" (e.g. Upstash) when you grow. See kv/firestore.ts.
  KV: z.enum(["memory", "firestore", "redis"]).default("memory"),
  REDIS_URL: z.string().optional(),

  // Firebase Admin credentials (same variables as the FORKSAI app).
  // On Google Cloud Run / Firebase you can leave them empty: the service
  // account of the machine is used automatically.
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  /**
   * Prefix for every Firestore collection this service creates ("llm_users",
   * "llm_conversations"...). Lets it share a Firebase project with another
   * app (like FORKSAI, which already has a "users" collection) without clashes.
   */
  FIRESTORE_COLLECTION_PREFIX: z.string().default("llm_"),

  // Provider credentials. Empty string is treated as "not configured".
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  ENABLE_MOCK_PROVIDER: boolish,

  // Dev bootstrap key for the in-memory store.
  DEV_API_KEY: z.string().optional(),
  DEV_API_KEY_PLAN: z.enum(["free", "pro", "team", "enterprise"]).default("pro"),

  // --- Website ---
  /** Browser origins allowed to call the API, comma-separated (e.g. https://chat.example.com). */
  CORS_ORIGINS: z.string().default("http://localhost:3000,http://localhost:5173"),
  /**
   * Website logins are verified with Firebase Auth whenever Firebase is
   * configured. AUTH_JWT_SECRET is a DEVELOPMENT shortcut only: it lets
   * POST /v1/auth/dev-token issue test tokens so you can try the API without
   * a Firebase login. Ignored in production.
   */
  AUTH_JWT_SECRET: z.string().optional(),

  // --- Cost protection for YOU (the platform owner) ---
  /**
   * Hard cap on what the whole platform may spend on vendors per UTC day,
   * across ALL users. When reached, new requests get "busy, try later"
   * instead of running up your bill. Your last line of defence against
   * abuse, bugs, or going viral on a free tier.
   */
  PLATFORM_DAILY_BUDGET_USD: z.coerce.number().positive().default(25),
  /** Per-IP request rate, catches one person spinning up many free accounts. */
  IP_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(30),

  // Tuning knobs.
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  PROVIDER_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(3600),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;

  // Cross-field rules zod can't express nicely above.
  // Zero-setup local testing: in development, with no AI keys set, use the
  // free mock models, and let the demo page log in without configuring a
  // secret. Neither ever applies in production (see the checks below).
  if (env.NODE_ENV === "development") {
    const hasProviderKey = !!(env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || env.GOOGLE_API_KEY);
    if (!hasProviderKey && source.ENABLE_MOCK_PROVIDER === undefined) env.ENABLE_MOCK_PROVIDER = true;
    // Random per run: demo logins simply expire when you restart the server.
    env.AUTH_JWT_SECRET ??= randomBytes(32).toString("hex");
  }

  if (env.KV === "redis" && !env.REDIS_URL) {
    throw new Error("KV=redis requires REDIS_URL");
  }
  if (env.NODE_ENV === "production") {
    // Guard rails: dev conveniences must never reach production.
    if (env.STORE === "memory" || env.KV === "memory") {
      throw new Error("Production must use STORE=firestore and KV=firestore or redis (memory state is lost on restart and not shared across instances)");
    }
    if (env.ENABLE_MOCK_PROVIDER) {
      throw new Error("ENABLE_MOCK_PROVIDER must be false in production");
    }
  }
  return env;
}

/** True when this deployment talks to Firebase (data, counters or logins). */
export function usesFirebase(env: Env): boolean {
  return env.STORE === "firestore" || env.KV === "firestore" || !!env.FIREBASE_PROJECT_ID;
}
