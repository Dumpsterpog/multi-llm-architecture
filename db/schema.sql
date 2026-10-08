-- ===========================================================================
-- Multi-LLM platform: Postgres schema
--
-- Conventions:
--   * UUID primary keys (safe to expose in URLs, no guessable sequence)
--   * money as BIGINT micro-dollars (1 USD = 1,000,000). Never FLOAT for money.
--   * soft delete (deleted_at) for user content, so "undo" and audits work;
--     a nightly job hard-deletes rows past the plan's retention window.
--   * created_at on everything; most analytics queries filter by time.
--
-- Run in production through a migration tool (node-pg-migrate, Prisma,
-- Flyway...). docker-compose loads this file directly for local dev.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- An organisation is the BILLING unit. A website user gets a personal org
-- automatically; a company with many users/API keys shares one org.
CREATE TABLE organizations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  plan             TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','team','enterprise')),
  -- Per-contract overrides of config/plans.ts (e.g. {"tokensPerMinute": 9000000}).
  limit_overrides  JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  -- The id from your auth provider (Supabase/Firebase/Clerk/Auth0 "sub" claim).
  external_auth_id  TEXT NOT NULL UNIQUE,
  email             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ
);
CREATE INDEX users_org_idx ON users(org_id);

-- API keys for developers calling the API directly. We store only a SHA-256
-- hash: if the database leaks, the keys are still useless. The prefix
-- (first chars) is kept so users can tell keys apart in a dashboard.
CREATE TABLE api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  user_id       UUID REFERENCES users(id),
  name          TEXT NOT NULL DEFAULT 'default',
  key_prefix    TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

-- Paid subscription state, written by your payment provider's webhook
-- (Stripe, DodoPayments, Razorpay...). organizations.plan is updated from it.
CREATE TABLE subscriptions (
  org_id                    UUID PRIMARY KEY REFERENCES organizations(id),
  plan                      TEXT NOT NULL,
  status                    TEXT NOT NULL,          -- active | past_due | canceled
  payment_provider          TEXT NOT NULL,
  provider_customer_id      TEXT,
  provider_subscription_id  TEXT,
  current_period_end        TIMESTAMPTZ,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Chat website data
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id),
  user_id     UUID REFERENCES users(id),
  title       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
-- The sidebar query: "my recent chats, newest first".
CREATE INDEX conversations_user_recent_idx ON conversations(user_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE messages (
  id               BIGSERIAL PRIMARY KEY,
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('system','user','assistant')),
  content          TEXT NOT NULL,
  request_id       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages(conversation_id, id);

-- ---------------------------------------------------------------------------
-- Metering and billing
-- ---------------------------------------------------------------------------

-- One row per API/chat request (the user-visible unit).
CREATE TABLE requests (
  id               UUID PRIMARY KEY,
  org_id           UUID NOT NULL,
  user_id          UUID,
  api_key_id       UUID,
  conversation_id  UUID,
  strategy         TEXT NOT NULL,
  status           TEXT NOT NULL,      -- ok | error
  error_type       TEXT,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_micros      BIGINT  NOT NULL DEFAULT 0,  -- what vendors charged us
  price_micros     BIGINT  NOT NULL DEFAULT 0,  -- what we charge the customer
  latency_ms       INTEGER NOT NULL,
  cache_hit        BOOLEAN NOT NULL DEFAULT false,
  prompt_version   TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX requests_org_time_idx ON requests(org_id, created_at DESC);
-- At scale: partition this table by month (PARTITION BY RANGE (created_at)).

-- One row per individual model call inside a request (a debate = many rows).
-- This is how you answer "which vendor costs us the most?" and "is Gemini
-- slower today?". Model OUTPUT TEXT is deliberately NOT stored here (privacy).
CREATE TABLE model_calls (
  id                   BIGSERIAL PRIMARY KEY,
  request_id           UUID NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  stage                TEXT NOT NULL,
  round                INTEGER NOT NULL,
  model_id             TEXT NOT NULL,
  provider             TEXT NOT NULL,
  ok                   BOOLEAN NOT NULL,
  error                TEXT,
  input_tokens         INTEGER,
  output_tokens        INTEGER,
  cached_input_tokens  INTEGER,
  cost_micros          BIGINT NOT NULL DEFAULT 0,
  latency_ms           INTEGER NOT NULL,
  finish_reason        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX model_calls_request_idx ON model_calls(request_id);
CREATE INDEX model_calls_model_time_idx ON model_calls(model_id, created_at DESC);

-- APPEND-ONLY money ledger: the source of truth for invoices.
-- Never UPDATE or DELETE rows; corrections are new 'adjustment' rows.
-- UNIQUE(request_id, kind) makes writes idempotent: a retried write can't double-bill.
CREATE TABLE usage_ledger (
  id            BIGSERIAL PRIMARY KEY,
  org_id        UUID NOT NULL,
  request_id    UUID,
  kind          TEXT NOT NULL CHECK (kind IN ('usage','credit','adjustment')),
  price_micros  BIGINT NOT NULL,   -- positive = customer owes, negative = credit
  cost_micros   BIGINT NOT NULL DEFAULT 0,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id, kind)
);
CREATE INDEX usage_ledger_org_time_idx ON usage_ledger(org_id, created_at);
