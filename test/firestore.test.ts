/**
 * Integration tests against a real Firestore (the local emulator).
 * Skipped unless FIRESTORE_EMULATOR_HOST is set, so `npm test` works anywhere.
 *
 *   npx firebase emulators:start --only firestore     (in another terminal)
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm test
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { initFirebase } from "../src/firebase.js";
import { LimitsService } from "../src/limits/limits.js";
import { PLANS } from "../src/config/plans.js";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const skip = emulator ? false : "set FIRESTORE_EMULATOR_HOST to run Firestore tests";

// A fresh prefix per run keeps runs independent without wiping the emulator.
const prefix = `t${Date.now()}_`;

function setup() {
  const env = loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    ENABLE_MOCK_PROVIDER: "true",
    AUTH_JWT_SECRET: "test-secret",
    CACHE_TTL_SECONDS: "60",
    STORE: "firestore",
    KV: "firestore",
    FIREBASE_PROJECT_ID: "demo-mlm",
    FIRESTORE_COLLECTION_PREFIX: prefix,
  });
  return { env, app: createApp(env), db: initFirebase(env).db };
}

const auth = (k: string) => ({ authorization: `Bearer ${k}` });

test("firestore: website flow end to end", { skip }, async () => {
  const { app } = setup();
  const s = app.server;
  const tok = (await s.inject({ method: "POST", url: "/v1/auth/dev-token", payload: { user_id: `u_${randomUUID()}` } })).json().token;

  const first = await s.inject({ method: "POST", url: "/v1/chat", headers: auth(tok), payload: { message: "What is DNA?", strategy: "parallel" } });
  assert.equal(first.statusCode, 200, first.body);
  const convId = first.json().conversation_id;

  const second = await s.inject({ method: "POST", url: "/v1/chat", headers: auth(tok), payload: { message: "And RNA?", conversation_id: convId } });
  assert.equal(second.statusCode, 200, second.body);

  const conv = (await s.inject({ method: "GET", url: `/v1/conversations/${convId}`, headers: auth(tok) })).json();
  assert.deepEqual(
    conv.messages.map((m: { role: string }) => m.role),
    ["user", "assistant", "user", "assistant"],
  );

  const list = (await s.inject({ method: "GET", url: "/v1/conversations", headers: auth(tok) })).json();
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].id, convId);

  const other = (await s.inject({ method: "POST", url: "/v1/auth/dev-token", payload: { user_id: "intruder" } })).json().token;
  assert.equal((await s.inject({ method: "GET", url: `/v1/conversations/${convId}`, headers: auth(other) })).statusCode, 404);

  assert.equal((await s.inject({ method: "DELETE", url: `/v1/conversations/${convId}`, headers: auth(tok) })).statusCode, 204);
  const after = (await s.inject({ method: "GET", url: "/v1/conversations", headers: auth(tok) })).json();
  assert.equal(after.data.length, 0);

  const me = (await s.inject({ method: "GET", url: "/v1/me", headers: auth(tok) })).json();
  assert.equal(me.plan.id, "free");
  assert.ok(me.usage.daily_tokens_used > 0, "daily token counter persisted in Firestore KV");
  assert.ok(me.usage.month_spend_usd > 0, "monthly spend persisted in Firestore KV");
});

test("firestore: API key auth, ledger and usage aggregation", { skip }, async () => {
  const { app, db } = setup();
  const raw = `mlk_test_${randomUUID()}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  await db.collection(`${prefix}orgs`).doc("org_api").set({ name: "Acme", plan: "team", limitOverrides: null });
  await db.collection(`${prefix}apiKeys`).doc(hash).set({ orgId: "org_api", userId: null, name: "ci" });

  const res = await app.server.inject({
    method: "POST",
    url: "/v1/chat",
    headers: auth(raw),
    payload: { messages: [{ role: "user", content: "debate this" }], strategy: "debate" },
  });
  assert.equal(res.statusCode, 200, res.body);
  const id = res.json().id;

  const reqDoc = (await db.collection(`${prefix}requests`).doc(id).get()).data()!;
  assert.equal(reqDoc.orgId, "org_api");
  assert.ok(reqDoc.calls.length >= 4, "debate records every model call");
  assert.equal(reqDoc.calls[0].text, undefined, "model output text is not stored");

  const ledger = (await db.collection(`${prefix}ledger`).doc(`${id}_usage`).get()).data()!;
  assert.equal(ledger.priceMicros, reqDoc.priceMicros);

  const usage = await app.store.usageSince("org_api", new Date(Date.now() - 3600_000));
  assert.equal(usage.requests, 1);
  assert.equal(usage.priceMicros, reqDoc.priceMicros);

  const revoked = await app.server.inject({ method: "GET", url: "/v1/me", headers: auth("mlk_wrong") });
  assert.equal(revoked.statusCode, 401);
});

test("firestore KV: limits are atomic under concurrent requests", { skip }, async () => {
  const { app } = setup();
  const limits = new LimitsService(app.kv);
  const plan = { ...PLANS.free, monthlyIncludedUsd: 1, allowOverage: false };
  // 10 parallel $0.30 reservations against a $1 cap: exactly 3 may succeed.
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => limits.reserveSpend("org_race", plan, 300_000)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);

  // Token bucket: 5 requests/minute, 8 parallel attempts.
  const rpm = await Promise.allSettled(Array.from({ length: 8 }, () => limits.checkRequestRate("org_rpm", plan)));
  assert.equal(rpm.filter((r) => r.status === "fulfilled").length, 5);
});
