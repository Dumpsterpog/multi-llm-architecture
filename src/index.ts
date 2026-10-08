/**
 * Process entry point: load config, start the server, shut down gracefully.
 *
 * GRACEFUL SHUTDOWN matters for an AI API: requests can run for a minute
 * (debates). On deploy, Kubernetes/your host sends SIGTERM; we stop taking
 * new requests and let in-flight ones finish before exiting, so deploys
 * never cut off a user's answer halfway (and never bill for it).
 */
import { createApp } from "./app.js";
import { loadDotEnvFile, loadEnv } from "./config/env.js";

const hadDotEnv = loadDotEnvFile();
const env = loadEnv();
const app = createApp(env);

const providers = app.registry.configuredProviders();
if (providers.length === 1 && providers[0] === "mock") {
  app.logger.info("No AI provider keys set: using the free mock models (placeholder answers, no cost).");
}
if (providers.length === 0) {
  app.logger.warn("No model providers configured. Set provider API keys or ENABLE_MOCK_PROVIDER=true.");
}

await app.server.listen({ port: env.PORT, host: "0.0.0.0" });
app.logger.info({ port: env.PORT, providers, store: env.STORE, kv: env.KV, dotEnvLoaded: hadDotEnv }, "multi-llm gateway listening");
if (!hadDotEnv && env.NODE_ENV !== "production") {
  app.logger.warn("No .env file found in this folder. Copy .env.example to .env (cp .env.example .env) and restart.");
}
if (env.NODE_ENV !== "production") {
  app.logger.info(`Demo chat page: http://localhost:${env.PORT}/demo`);
}

let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.logger.info({ signal }, "shutting down: draining in-flight requests");
    // Hard stop if draining takes too long (longer than the platform's grace period).
    setTimeout(() => process.exit(1), 90_000).unref();
    await app.close();
    process.exit(0);
  });
}
