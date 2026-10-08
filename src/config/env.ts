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
import { z } from "zod";

// zod's coerce turns the string "8080" into the number 8080, etc.
const boolish = z
  .enum(["true", "false", "1", "0", ""])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // Storage backends. "memory" = zero-infra dev mode.
  STORE: z.enum(["memory", "postgres"]).default("memory"),
  DATABASE_URL: z.string().optional(),
  KV: z.enum(["memory", "redis"]).default("memory"),
  REDIS_URL: z.string().optional(),

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
  /** Secret that verifies website login tokens (HS256 JWT, e.g. your Supabase JWT secret). */
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
  if (env.STORE === "postgres" && !env.DATABASE_URL) {
    throw new Error("STORE=postgres requires DATABASE_URL");
  }
  if (env.KV === "redis" && !env.REDIS_URL) {
    throw new Error("KV=redis requires REDIS_URL");
  }
  if (env.NODE_ENV === "production") {
    // Guard rails: dev conveniences must never reach production.
    if (env.STORE === "memory" || env.KV === "memory") {
      throw new Error("Production must use STORE=postgres and KV=redis (memory state is lost on restart and not shared across instances)");
    }
    if (env.ENABLE_MOCK_PROVIDER) {
      throw new Error("ENABLE_MOCK_PROVIDER must be false in production");
    }
  }
  return env;
}
