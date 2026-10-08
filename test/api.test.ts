/**
 * End-to-end tests through the real HTTP layer, using the mock models.
 * No network, no API keys, no Redis/Postgres needed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { MemoryStore } from "../src/store/memory.js";

function setup(extraEnv: Record<string, string> = {}) {
  const env = loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    ENABLE_MOCK_PROVIDER: "true",
    AUTH_JWT_SECRET: "test-secret",
    CACHE_TTL_SECONDS: "0",
    ...extraEnv,
  });
  const store = new MemoryStore();
  store.addApiKey("mlk_pro", "pro", "org_pro");
  store.addApiKey("mlk_free", "free", "org_free");
  store.addApiKey("mlk_team", "team", "org_team");
  const app = createApp(env, { store });
  return { app, store, server: app.server };
}

const auth = (k: string) => ({ authorization: `Bearer ${k}` });

test("parallel: three models answer and one synthesis comes back", async () => {
  const { server } = setup();
  const res = await server.inject({
    method: "POST",
    url: "/v1/chat",
    headers: auth("mlk_pro"),
    payload: { messages: [{ role: "user", content: "Explain recursion" }], strategy: "parallel", include_trace: true },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.strategy, "parallel");
  assert.equal(body.models.length, 3);
  assert.match(body.answer, /synthesis/);
  assert.ok(body.usage.total_tokens > 0 && body.usage.cost_usd > 0);
  assert.equal(body.trace.filter((t: { stage: string }) => t.stage === "answer").length, 3);
});

test("debate: models revise each other and stop early on consensus", async () => {
  const { server } = setup();
  const res = await server.inject({
    method: "POST",
    url: "/v1/chat",
    headers: auth("mlk_team"),
    payload: { messages: [{ role: "user", content: "Is P = NP?" }], strategy: "debate", rounds: 3 },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.rounds, 2, "mock models report CHANGED: no, so round 3 is skipped");
  assert.ok(body.notes.some((n: string) => n.includes("Consensus")));
});

test("critique: author drafts, reviewers approve", async () => {
  const { server } = setup();
  const res = await server.inject({
    method: "POST",
    url: "/v1/chat",
    headers: auth("mlk_pro"),
    payload: { messages: [{ role: "user", content: "Write a haiku" }], strategy: "critique" },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().strategy, "critique");
});

test("router: one model is chosen", async () => {
  const { server } = setup();
  const res = await server.inject({
    method: "POST",
    url: "/v1/chat",
    headers: auth("mlk_pro"),
    payload: { messages: [{ role: "user", content: "hello" }], strategy: "router" },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().models.length, 1);
});

test("a failing model is skipped and the others still answer", async () => {
  const { server } = setup();
  const res = await server.inject({
    method: "POST",
    url: "/v1/chat",
    headers: auth("mlk_pro"),
    payload: { messages: [{ role: "user", content: "question [[fail:mock-beta]]" }], strategy: "parallel" },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.deepEqual(body.models.sort(), ["mock-alpha", "mock-gamma"]);
  assert.ok(body.notes.some((n: string) => n.includes("mock-beta")));
});

test("free plan cannot use debate", async () => {
  const { server } = setup();
  const res = await server.inject({
    method: "POST",
    url: "/v1/chat",
    headers: auth("mlk_free"),
    payload: { messages: [{ role: "user", content: "hi" }], strategy: "debate" },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.type, "permission_denied");
});

test("rate limit returns 429 with retry-after", async () => {
  const { server } = setup();
  const send = () =>
    server.inject({ method: "POST", url: "/v1/chat", headers: auth("mlk_free"), payload: { messages: [{ role: "user", content: "hi" }] } });
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await send()).statusCode);
  assert.ok(codes.includes(429), `expected a 429 in ${codes}`);
  const last = await send();
  assert.equal(last.statusCode, 429);
  assert.ok(last.headers["retry-after"]);
});

test("platform daily budget protects the owner's bill", async () => {
  const { server } = setup({ PLATFORM_DAILY_BUDGET_USD: "0.000001" });
  const res = await server.inject({
    method: "POST",
    url: "/v1/chat",
    headers: auth("mlk_pro"),
    payload: { messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(res.statusCode, 503);
});

test("missing or bad credentials are rejected", async () => {
  const { server } = setup();
  assert.equal((await server.inject({ method: "GET", url: "/v1/me" })).statusCode, 401);
  assert.equal((await server.inject({ method: "GET", url: "/v1/me", headers: auth("mlk_nope") })).statusCode, 401);
  assert.equal((await server.inject({ method: "GET", url: "/v1/me", headers: auth("a.b.c") })).statusCode, 401);
});

test("website flow: login, chat, continue the conversation, list, delete", async () => {
  const { server } = setup();
  const tok = (await server.inject({ method: "POST", url: "/v1/auth/dev-token", payload: { user_id: "u1" } })).json().token;

  const first = await server.inject({ method: "POST", url: "/v1/chat", headers: auth(tok), payload: { message: "What is DNA?" } });
  assert.equal(first.statusCode, 200, first.body);
  const convId = first.json().conversation_id;
  assert.ok(convId);

  const second = await server.inject({
    method: "POST",
    url: "/v1/chat",
    headers: auth(tok),
    payload: { message: "And RNA?", conversation_id: convId },
  });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().conversation_id, convId);

  const conv = (await server.inject({ method: "GET", url: `/v1/conversations/${convId}`, headers: auth(tok) })).json();
  assert.equal(conv.messages.length, 4);
  assert.equal(conv.title, "What is DNA?");

  // Another user can't read it.
  const tok2 = (await server.inject({ method: "POST", url: "/v1/auth/dev-token", payload: { user_id: "u2" } })).json().token;
  assert.equal((await server.inject({ method: "GET", url: `/v1/conversations/${convId}`, headers: auth(tok2) })).statusCode, 404);

  const list = (await server.inject({ method: "GET", url: "/v1/conversations", headers: auth(tok) })).json();
  assert.equal(list.data.length, 1);

  assert.equal((await server.inject({ method: "DELETE", url: `/v1/conversations/${convId}`, headers: auth(tok) })).statusCode, 204);
  const me = (await server.inject({ method: "GET", url: "/v1/me", headers: auth(tok) })).json();
  assert.equal(me.plan.id, "free");
  assert.ok(me.usage.daily_tokens_used > 0);
});

test("streaming sends progress events then a done event", async () => {
  const { server } = setup();
  const res = await server.inject({
    method: "POST",
    url: "/v1/chat",
    headers: auth("mlk_pro"),
    payload: { messages: [{ role: "user", content: "hi" }], strategy: "parallel", stream: true },
  });
  assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.match(res.body, /event: progress/);
  assert.match(res.body, /"type":"model_done"/);
  assert.match(res.body, /event: done/);
});

test("CORS: allowed origin gets headers, preflight succeeds", async () => {
  const { server } = setup({ CORS_ORIGINS: "https://chat.example.com" });
  const pre = await server.inject({ method: "OPTIONS", url: "/v1/chat", headers: { origin: "https://chat.example.com" } });
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers["access-control-allow-origin"], "https://chat.example.com");
  const other = await server.inject({ method: "OPTIONS", url: "/v1/chat", headers: { origin: "https://evil.example" } });
  assert.equal(other.headers["access-control-allow-origin"], undefined);
});
