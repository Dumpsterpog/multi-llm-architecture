/**
 * COMPOSITION ROOT: builds every component and wires them together.
 *
 * This is the only file that knows which concrete implementations are used
 * (Firestore vs memory, Redis vs Firestore...). Everything else depends on
 * interfaces, which is what makes the pieces swappable and testable.
 */
import { usesFirebase, type Env } from "./config/env.js";
import { initFirebase } from "./firebase.js";
import { createWebTokenVerifier } from "./gateway/auth.js";
import { ResponseCache } from "./cache/responseCache.js";
import { ChatPipeline } from "./gateway/pipeline.js";
import { buildServer } from "./gateway/server.js";
import { FirestoreKV } from "./kv/firestore.js";
import { MemoryKV } from "./kv/memory.js";
import { RedisKV } from "./kv/redis.js";
import type { KV } from "./kv/types.js";
import { LimitsService } from "./limits/limits.js";
import { createLogger } from "./observability/logger.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { ProviderRegistry } from "./providers/registry.js";
import { ResilientCaller } from "./providers/resilience.js";
import { OpenAIModeration, SafetyService } from "./safety/moderation.js";
import { MemoryStore } from "./store/memory.js";
import { FirestoreStore } from "./store/firestore.js";
import type { Store } from "./store/types.js";

export function createApp(env: Env, overrides: { kv?: KV; store?: Store } = {}) {
  const logger = createLogger(env.LOG_LEVEL);

  // Firebase is only initialised when something actually uses it.
  const firebase = usesFirebase(env) ? initFirebase(env) : undefined;
  const prefix = env.FIRESTORE_COLLECTION_PREFIX;

  const kv: KV =
    overrides.kv ??
    (env.KV === "redis"
      ? new RedisKV(env.REDIS_URL!)
      : env.KV === "firestore"
        ? new FirestoreKV(firebase!.db, prefix)
        : new MemoryKV());

  let store: Store;
  if (overrides.store) {
    store = overrides.store;
  } else if (env.STORE === "firestore") {
    store = new FirestoreStore(firebase!.db, prefix);
  } else {
    const mem = new MemoryStore();
    if (env.DEV_API_KEY) mem.addApiKey(env.DEV_API_KEY, env.DEV_API_KEY_PLAN);
    store = mem;
  }

  const registry = new ProviderRegistry(env);
  const resilient = new ResilientCaller({ timeoutMs: env.PROVIDER_TIMEOUT_MS, maxRetries: env.PROVIDER_MAX_RETRIES });
  const limits = new LimitsService(kv);
  const orchestrator = new Orchestrator(registry, resilient);
  const safety = new SafetyService(env.OPENAI_API_KEY ? new OpenAIModeration(env.OPENAI_API_KEY) : undefined);
  const cache = new ResponseCache(kv, env.CACHE_TTL_SECONDS);
  const pipeline = new ChatPipeline({ env, store, limits, orchestrator, registry, resilient, safety, cache, logger });

  const verifyWebToken = createWebTokenVerifier(env, firebase?.auth);
  const server = buildServer({ env, logger, store, kv, limits, registry, pipeline, verifyWebToken });

  return {
    server,
    store,
    kv,
    logger,
    registry,
    async close() {
      await server.close();
      await Promise.allSettled([kv.close(), store.close()]);
    },
  };
}
