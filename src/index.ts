/**
 * Process entry point: load config, start the server, shut down gracefully.
 *
 * GRACEFUL SHUTDOWN matters for an AI API: requests can run for a minute
 * (debates). On deploy, Kubernetes/your host sends SIGTERM; we stop taking
 * new requests and let in-flight ones finish before exiting, so deploys
 * never cut off a user's answer halfway (and never bill for it).
 */
import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";

const env = loadEnv();
const app = createApp(env);

const providers = app.registry.configuredProviders();
if (providers.length === 0) {
  app.logger.warn("No model providers configured. Set provider API keys or ENABLE_MOCK_PROVIDER=true.");
}

await app.server.listen({ port: env.PORT, host: "0.0.0.0" });
app.logger.info({ port: env.PORT, providers, store: env.STORE, kv: env.KV }, "multi-llm gateway listening");

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
