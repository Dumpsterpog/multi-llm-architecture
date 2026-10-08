# What happens when a message comes in

Every step a message goes through, from the browser to the answer, with the file and function that does it. GitHub draws the diagrams below automatically.

Legend: **red exits** = the request is refused (HTTP status shown), **$** = a cost-control step, **model** = a paid model call.

## 1. The whole flow

```mermaid
flowchart TD
  A([Browser / API client<br/>POST /v1/chat]) --> B

  subgraph S1["Server: src/gateway/server.ts"]
    B["onRequest hook<br/>CORS, request id, security headers"] --> C["preHandler: authenticate()<br/>auth.ts: API key hash or Firebase verifyIdToken"]
    C --> D["ChatBody.parse()<br/>schemas.ts: validate body"]
    D --> E["AbortController<br/>tab closed = cancel model calls ($)"]
  end

  C -. bad token .-> X401[[401 authentication_error]]
  D -. bad body .-> X400[[400 invalid_request]]

  E --> P1

  subgraph S2["Free checks, nothing spent yet: ChatPipeline.handle() in pipeline.ts"]
    P1["resolveLimits()<br/>plans.ts"] --> P2["checkIpRate / checkRequestRate / acquireConcurrency ($)<br/>limits.ts, token buckets"]
    P2 --> P3["buildMessages()<br/>load chat history from Firestore"]
    P3 --> P4["safety.checkInput()<br/>moderation.ts"]
    P4 --> P5["trimHistory() ($)<br/>memory/conversations.ts"]
    P5 --> P6{"Client named a<br/>strategy or models?"}
    P6 -- yes --> P6m["MANUAL: selectStrategy / selectModels<br/>selection.ts"]
    P6 -- no --> P6a["AUTO: supervisor will decide"]
    P6m --> P7
    P6a --> P7["cache.get() ($)<br/>responseCache.ts"]
    P7 -- miss --> P8["checkDailyTokens(prompt) ($)"]
    P8 --> P9["reserveSpend + reservePlatformBudget ($)<br/>hold worst-case cost"]
  end

  P2 -. too fast .-> X429[[429 rate_limit_exceeded]]
  P4 -. blocked .-> XC[[400 content_blocked]]
  P5 -. message too long .-> X413[[413 context_length_exceeded]]
  P6m -. not in plan .-> X403[[403 permission_denied]]
  P8 -. quota used .-> XQ[[429 quota_exceeded]]
  P9 -. monthly cap / platform budget .-> X402[[402 or 503]]
  P7 -- hit: $0 --> R4

  P9 --> O1

  subgraph S3["Orchestrator.run(): orchestrator.ts, one Budget for everything"]
    O1["new Budget + RecordingCaller<br/>budget.ts, caller.ts"] --> O2{"AUTO mode?"}
    O2 -- yes --> O3["supervise() model<br/>supervisor.ts: Gemini Flash reads the message"]
    O3 --> O4["buildDispatch()<br/>dispatch.ts: route + tier, capped by plan"]
    O2 -- no --> O5
    O4 --> O5["estimateRunTokens + checkTokenRate + checkDailyTokens ($)"]
    O5 --> O6{"route"}
    O6 -- direct --> T0["runRouter()<br/>1 fast model"]
    O6 -- lite --> T1["runParallel()<br/>2 fast models + merge"]
    O6 -- standard --> T2["runParallel() or runCritique()<br/>3 models, one per vendor"]
    O6 -- max --> T3["runDebate() or runCritique()<br/>3 flagship models, rounds"]
  end

  O5 -. over token limit .-> X429b[[429 rate_limit_exceeded]]

  T0 & T1 & T2 & T3 --> R1

  subgraph S4["After: back in pipeline.ts"]
    R1["settleAll() ($)<br/>release holds, record real cost"] --> R2["safety.checkOutput()<br/>cache.set()"]
    R2 --> R3["finish(): save messages<br/>store.appendMessages + recordRequest (ledger)"]
    R3 --> R4(["Respond: JSON or SSE 'done'<br/>answer, route, tier, models, tokens, cost"])
  end
```

## 2. How the supervisor picks a route

```mermaid
flowchart LR
  M[Latest message<br/>trimmed to 6,000 chars] --> G["Supervisor model<br/>Gemini Flash, 120 tokens out,<br/>8s timeout, no retry"]
  G -- "JSON ok" --> D{route?}
  G -- "slow / down / bad JSON" --> H["heuristicDecision()<br/>free keyword rules"] --> D
  D -- direct --> DIR["direct<br/>one fast model"]
  D -- "orchestrate + complexity" --> N["needed tier<br/>simple=lite, medium=standard, complex=max"]
  N --> CAP{"min(needed, plan ceiling)<br/>free=lite, pro=standard, team+=max"}
  CAP --> L["lite"] & S["standard"] & X["max"]
```

The plan ceiling is applied in plain code (`buildDispatch()` in `dispatch.ts`), never by the model, so a message that tries to talk the supervisor into a bigger tier cannot exceed what the plan pays for.

| Route | Models | How they collaborate | Who can reach it |
|---|---|---|---|
| direct | 1 fast model (falls back to others if it fails) | single answer | everyone, for simple messages |
| lite | 2 fast models, fast model merges | parallel, then synthesis | Free and up |
| standard | 3 models, one per vendor; balanced model merges | parallel; critique for writing and code | Pro and up |
| max | 3 flagship models; flagship model merges | debate up to 3 rounds; critique for writing | Team, Enterprise |

## 3. Inside every single model call

```mermaid
flowchart LR
  A["RecordingCaller.call()<br/>caller.ts"] --> B{"budget.begin()<br/>worst case fits?"}
  B -- no --> SKIP["skip this call<br/>strategy finishes with what it has"]
  B -- yes --> C["ResilientCaller.call()<br/>resilience.ts: timeout, retries, circuit breaker"]
  C --> D["Provider adapter<br/>anthropic.ts / openai.ts / google.ts"]
  D --> E["budget.end()<br/>real tokens from the vendor"]
  E --> F["record call + metrics<br/>emit model_done (SSE progress)"]
```
