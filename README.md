# Multi-LLM Platform

Several AI models (Claude, GPT, Gemini, and any others you add) work on the same message, check each other's answers, and return **one** final answer. Built to sit behind a ChatGPT-style website and a developer API, with the token limits, quotas and spending caps an AI company needs.

**Start here:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) explains the whole system with diagrams. Every source file also has comments explaining what it does and why.

## What's inside

- **4 ways for models to collaborate:** router (pick the best single model), parallel + synthesis, multi-round debate, and draft/critique/refine. `auto` picks one per message.
- **Cost control at every level:** per-request spending cap, tokens per minute, daily token quota, monthly spend cap per customer, and a **platform-wide daily budget** that protects your own bill.
- **Plans:** free / pro / team / enterprise, each with its own limits (`src/config/plans.ts`).
- **Website-ready API:** login tokens, CORS, streaming progress over SSE, conversation history, usage meter endpoint, and a stop button that cancels model calls so you stop paying.
- **Resilience:** timeouts, retries with backoff, per-model circuit breakers, graceful degradation when a vendor is down.
- **Billing:** exact vendor token counts, integer micro-dollar money, append-only ledger, margin tracking.
- **Ops:** Postgres schema, Redis rate limiting, Prometheus metrics, structured logs, Docker, graceful shutdown.

## Run it locally (no API keys needed)

Requires Node 20.10+.

```bash
npm install
cp .env.example .env      # works as-is with free mock models
npm run dev
```

- Open **http://localhost:8080/demo** for a working chat page.
- Or call the API:

```bash
curl -s localhost:8080/v1/chat \
  -H "authorization: Bearer mlk_dev_change_me" \
  -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"Explain recursion"}],"strategy":"debate","include_trace":true}'
```

To use real models, put any of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` in `.env`. A vendor is enabled only when its key is set. **Before using real keys, update the prices and model ids in `src/config/models.ts`** (they are placeholders) and set `PLATFORM_DAILY_BUDGET_USD` to what you can afford per day.

### With Postgres and Redis (production-like)

```bash
docker compose up --build
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start with auto-reload |
| `npm test` | Unit + end-to-end tests (mock models, no network) |
| `npm run typecheck` | TypeScript check |
| `npm run build && npm start` | Production build and run |
| `npm run create-key -- <org_id>` | Generate a developer API key |

## Calling it from your website

```js
// 1. Get your user's login token from your auth provider (Supabase, Firebase, Clerk...)
// 2. Send a message; keep conversation_id to continue the same chat
const res = await fetch("https://api.yoursite.com/v1/chat", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ message: "Why is the sky blue?", conversation_id, stream: true }),
  signal: abortController.signal, // Stop button = abortController.abort()
});
// 3. Read events: "progress" (which model is working), "done" (final answer), "error"
```

`examples/chat.html` is a complete working example of this, including stream parsing.

## Project layout

```
docs/ARCHITECTURE.md     full system design, read this first
src/config/              models + prices, plans + limits, env validation
src/gateway/             HTTP routes, auth, the request pipeline
src/orchestrator/        strategies, prompts, per-request budget
src/providers/           Claude / GPT / Gemini / mock adapters, retries, breakers
src/limits/              rate limits, quotas, spend reservations
src/billing/             token estimates, money maths
src/memory/              chat history trimming
src/safety/              moderation, prompt-injection signals
src/cache/               response cache
src/store/, src/kv/      Postgres + Redis (and in-memory versions for dev)
src/observability/       logs + Prometheus metrics
db/schema.sql            database tables
examples/chat.html       reference chat page
test/                    tests
```
