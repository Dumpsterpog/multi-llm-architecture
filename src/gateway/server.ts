/**
 * HTTP API (Fastify), built to be called straight from your chat website.
 *
 * Website-friendly details:
 *  - CORS: only your site's origins (CORS_ORIGINS) may call it from a browser.
 *  - Streaming: POST /v1/chat with "stream": true returns Server-Sent Events
 *    over a normal fetch() response, so the UI can show live progress
 *    ("Claude answering... GPT done... combining answers").
 *  - Stop button = cost control: if the user closes the tab or presses stop,
 *    the connection closes and we ABORT all in-flight model calls, so you
 *    don't pay for answers nobody will read.
 *  - /v1/me gives the UI what it needs for a usage meter / upgrade prompt.
 *  - /v1/conversations powers the chat-history sidebar.
 *  - Every error is JSON: { error: { type, message, retry_after_ms? } }.
 *
 * Endpoints:
 *   GET    /health                     liveness (process is up)
 *   GET    /ready                      readiness (Redis + Postgres reachable)
 *   GET    /metrics                    Prometheus (keep internal, see below)
 *   GET    /v1/models                  models the caller's plan can use
 *   GET    /v1/me                      plan, limits and current usage
 *   POST   /v1/chat                    the main endpoint
 *   GET    /v1/conversations           chat history list (sidebar)
 *   GET    /v1/conversations/:id       one chat with its messages
 *   DELETE /v1/conversations/:id       delete a chat
 *   POST   /v1/auth/dev-token          DEV ONLY: get a login token for testing
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { Env } from "../config/env.js";
import { PLANS, resolveLimits } from "../config/plans.js";
import { AppError } from "../errors.js";
import type { KV } from "../kv/types.js";
import type { LimitsService } from "../limits/limits.js";
import type { Logger } from "../observability/logger.js";
import { registry as metricsRegistry } from "../observability/metrics.js";
import type { OrchestrationEvent } from "../orchestrator/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { Principal, Store } from "../store/types.js";
import { authenticate, signJwt } from "./auth.js";
import type { ChatPipeline } from "./pipeline.js";
import { ChatBody, DevTokenBody, ListConversationsQuery } from "./schemas.js";

export interface ServerDeps {
  env: Env;
  logger: Logger;
  store: Store;
  kv: KV;
  limits: LimitsService;
  registry: ProviderRegistry;
  pipeline: ChatPipeline;
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export function buildServer(d: ServerDeps) {
  const app = Fastify({
    loggerInstance: d.logger,
    bodyLimit: 2 * 1024 * 1024, // 2 MB: big enough for long pasted docs, small enough to stop abuse
    // Behind a load balancer the client IP is in X-Forwarded-For. Only trust
    // it when you really are behind a proxy you control.
    trustProxy: d.env.NODE_ENV === "production",
    genReqId: (req) => (req.headers["x-request-id"] as string | undefined)?.slice(0, 64) ?? randomUUID(),
  });

  const allowedOrigins = new Set(
    d.env.CORS_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  function corsHeaders(origin: string | undefined): Record<string, string> {
    if (!origin || !allowedOrigins.has(origin)) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "authorization, content-type, x-request-id",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-expose-headers": "x-request-id, retry-after",
      "access-control-max-age": "600",
      vary: "Origin",
    };
  }

  // --- CORS + security headers + request id on every response ---
  app.addHook("onRequest", async (req, reply) => {
    reply.headers(corsHeaders(req.headers.origin));
    reply.header("x-request-id", req.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    if (req.method === "OPTIONS") {
      // Browser preflight: answer immediately, no auth needed.
      return reply.code(204).send();
    }
  });

  // --- Auth for everything under /v1 except the dev-token route ---
  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/v1/") || req.url.startsWith("/v1/auth/")) return;
    req.principal = await authenticate(req.headers.authorization, d.store, d.env.AUTH_JWT_SECRET);
  });

  // --- One error format for everything ---
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.retryAfterMs !== undefined) reply.header("retry-after", Math.ceil(err.retryAfterMs / 1000));
      return reply.code(err.status).send(err.toJSON());
    }
    if (err instanceof ZodError) {
      const msg = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
      return reply.code(400).send(new AppError(400, "invalid_request", msg).toJSON());
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.code(status).send(new AppError(status, "invalid_request", (err as Error).message).toJSON());
    }
    // Unknown error: log details, return nothing internal to the client.
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send(new AppError(500, "internal_error", "Something went wrong. Please try again.").toJSON());
  });

  // --- Health ---
  app.get("/health", async () => ({ ok: true }));
  app.get("/ready", async (_req, reply) => {
    const [kv, db] = await Promise.all([d.kv.ping(), d.store.ping()]);
    return reply.code(kv && db ? 200 : 503).send({ kv, db, providers: d.registry.configuredProviders() });
  });
  // In production, block /metrics at the load balancer or serve it on a
  // separate internal port: it reveals traffic and cost data.
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });

  // --- Models available to this caller ---
  app.get("/v1/models", async (req) => {
    const plan = resolveLimits(req.principal!.plan, req.principal!.limitOverrides);
    return {
      data: d.registry
        .availableModels()
        .filter((m) => plan.allowedModelTiers.includes(m.tier))
        .map((m) => ({ id: m.id, name: m.displayName, provider: m.provider, tier: m.tier, context_window: m.contextWindow })),
    };
  });

  // --- Plan + usage (for the website's usage meter / upgrade prompt) ---
  app.get("/v1/me", async (req) => {
    const p = req.principal!;
    const plan = resolveLimits(p.plan, p.limitOverrides);
    const usage = await d.limits.snapshot(p.orgId, plan);
    return {
      user_id: p.userId,
      plan: { id: plan.id, name: plan.displayName, price_usd_per_month: plan.priceUsdPerMonth },
      limits: {
        requests_per_minute: plan.requestsPerMinute,
        daily_tokens: plan.dailyTokenLimit,
        max_output_tokens: plan.maxOutputTokens,
        strategies: plan.allowedStrategies,
        max_models_per_request: plan.maxModelsPerRequest,
      },
      usage: {
        daily_tokens_used: usage.dailyTokensUsed,
        daily_tokens_remaining: Math.max(0, usage.dailyTokenLimit - usage.dailyTokensUsed),
        month_spend_usd: usage.monthSpendUsd,
        month_limit_usd: usage.monthLimitUsd,
      },
      upgrade_options: Object.values(PLANS)
        .filter((x) => x.priceUsdPerMonth > plan.priceUsdPerMonth)
        .map((x) => ({ id: x.id, name: x.displayName, price_usd_per_month: x.priceUsdPerMonth })),
    };
  });

  // --- Main chat endpoint ---
  app.post("/v1/chat", async (req, reply) => {
    const body = ChatBody.parse(req.body);

    // If the client goes away (tab closed / stop button), abort all model calls.
    const abort = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) abort.abort();
    });

    if (!body.stream) {
      return d.pipeline.handle(req.principal!, body, { ip: req.ip, requestId: req.id, signal: abort.signal });
    }
    return streamChat(req, reply, body, abort);
  });

  /**
   * SSE streaming. Event types the frontend handles:
   *   event: progress   data: OrchestrationEvent (strategy, model_start, model_done, ...)
   *   event: done       data: ChatResponse (the final answer)
   *   event: error      data: { error: { type, message } }
   * Read it in the browser with fetch() + response.body.getReader()
   * (see examples/chat.html). EventSource can't send POST bodies or auth headers.
   */
  async function streamChat(req: FastifyRequest, reply: FastifyReply, body: ReturnType<typeof ChatBody.parse>, abort: AbortController) {
    reply.hijack(); // we write the raw response ourselves
    const res = reply.raw;
    res.writeHead(200, {
      ...corsHeaders(req.headers.origin),
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // tell nginx not to buffer the stream
      "x-request-id": req.id,
    });
    const send = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // Heartbeat comment so proxies/load balancers don't kill an idle stream during a long debate.
    const heartbeat = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), 15_000);
    try {
      const result = await d.pipeline.handle(req.principal!, body, {
        ip: req.ip,
        requestId: req.id,
        signal: abort.signal,
        emit: (e: OrchestrationEvent) => send("progress", e),
      });
      send("done", result);
    } catch (err) {
      const appErr =
        err instanceof AppError ? err : new AppError(500, "internal_error", "Something went wrong. Please try again.");
      if (!(err instanceof AppError)) req.log.error({ err }, "stream error");
      send("error", appErr.toJSON());
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }

  // --- Conversations (chat history sidebar) ---
  app.get("/v1/conversations", async (req) => {
    const q = ListConversationsQuery.parse(req.query);
    const data = await d.store.listConversations(req.principal!, q.limit, q.before);
    return { data, next_before: data.length === q.limit ? data[data.length - 1]!.updatedAt : null };
  });

  app.get<{ Params: { id: string } }>("/v1/conversations/:id", async (req) => {
    const conv = await d.store.getConversation(req.params.id, req.principal!);
    if (!conv) throw new AppError(404, "invalid_request", "Conversation not found");
    return conv;
  });

  app.delete<{ Params: { id: string } }>("/v1/conversations/:id", async (req, reply) => {
    const ok = await d.store.deleteConversation(req.params.id, req.principal!);
    if (!ok) throw new AppError(404, "invalid_request", "Conversation not found");
    return reply.code(204).send();
  });

  // --- Dev-only login: lets you build the website before wiring a real auth provider ---
  if (d.env.NODE_ENV !== "production" && d.env.AUTH_JWT_SECRET) {
    // Reference chat page (examples/chat.html), served same-origin so no CORS setup is needed.
    app.get("/demo", async (_req, reply) => {
      const html = await readFile(join(process.cwd(), "examples", "chat.html"), "utf8");
      return reply.type("text/html; charset=utf-8").send(html);
    });
    app.post("/v1/auth/dev-token", async (req) => {
      const b = DevTokenBody.parse(req.body ?? {});
      const token = signJwt({ sub: b.user_id, email: b.email, exp: Math.floor(Date.now() / 1000) + 24 * 3600 }, d.env.AUTH_JWT_SECRET!);
      return { token, note: "Development only. Use your real auth provider's token in production." };
    });
  }

  return app;
}
