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
- **Firebase:** Firestore stores users, chats and billing; Firebase Auth handles website logins (same setup as FORKSAI). Redis is optional, for later.
- **Ops:** Prometheus metrics, structured logs, graceful shutdown. No Docker needed.

## Run it locally (no API keys needed)

Requires Node 20.10+.

```bash
npm install
npm run dev
```

No API keys or `.env` needed for this: with no AI keys set, it uses free mock models that reply with placeholder text, so you can see how everything works at no cost. When you're ready for real models, `cp .env.example .env` and fill it in.

- Open **http://localhost:8080/demo** for a working chat page.
- Or call the API:

```bash
curl -s localhost:8080/v1/chat \
  -H "authorization: Bearer mlk_dev_change_me" \
  -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"Explain recursion"}],"strategy":"debate","include_trace":true}'
```

To use real models, put any of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` in `.env`. A vendor is enabled only when its key is set. **Before using real keys, update the prices and model ids in `src/config/models.ts`** (they are placeholders) and set `PLATFORM_DAILY_BUDGET_USD` to what you can afford per day.

### With Firebase

1. Firebase console: create (or reuse) a project, enable **Firestore** and **Authentication > Google**.
2. Project settings > Service accounts > **Generate new private key**. Copy `project_id`, `client_email` and `private_key` into `.env` as `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (the same variables FORKSAI uses).
3. In `.env` set `STORE=firestore` and `KV=firestore`.
4. Deploy the indexes and TTL policy: `npx firebase deploy --only firestore:indexes` (uses `firestore.indexes.json`).
5. Read `firestore.rules` before touching your rules, especially if the project is shared with FORKSAI.

Collections are all prefixed `llm_`, so sharing a project with FORKSAI is safe.

### Deploying (no Docker needed)

- **Google Cloud Run** (best fit with Firebase): `gcloud run deploy --source .`. No private key needed there.
- **Render / Railway**: connect the GitHub repo; build `npm ci && npm run build`, start `npm start`.
- Not Vercel: this is a long-running streaming server, and debates can exceed serverless time limits. Keep FORKSAI on Vercel and run this API separately.

Details in [`docs/ARCHITECTURE.md` section 9.1](docs/ARCHITECTURE.md#91-where-to-deploy-no-docker-needed).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start with auto-reload |
| `npm test` | Unit + end-to-end tests (mock models, no network) |
| `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm test` | Also runs the Firestore tests, against the emulator (`npx firebase emulators:start --only firestore`) |
| `npm run typecheck` | TypeScript check |
| `npm run build && npm start` | Production build and run |
| `npm run create-key -- <org_id>` | Generate a developer API key and save it to Firestore |

## Calling it from your website

```js
// 1. Get the signed-in user's Firebase ID token (refreshes automatically)
const token = await auth.currentUser.getIdToken();
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
src/store/, src/kv/      Firestore (+ optional Redis), and in-memory versions for dev
src/firebase.ts          Firebase Admin setup
src/observability/       logs + Prometheus metrics
firestore.rules          keeps browsers out of the llm_ collections
firestore.indexes.json   indexes + TTL policy for Firestore
examples/chat.html       reference chat page
test/                    tests
```
