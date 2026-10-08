/**
 * THE CHAT PIPELINE: everything that happens to one request, in order.
 *
 *  ┌─ 1. resolve plan limits for this customer
 *  ├─ 2. cheap guards first: IP rate, requests/minute, concurrency slot
 *  ├─ 3. build the message list (load conversation for website users)
 *  ├─ 4. safety check on the new user message
 *  ├─ 5. trim history to the plan's token allowance          (cost control)
 *  ├─ 6. choose strategy + models allowed by the plan
 *  ├─ 7. response cache (identical stateless question = free answer)
 *  ├─ 8. token checks: tokens/minute, daily token quota       (cost control)
 *  ├─ 9. reserve worst-case spend: customer monthly cap AND
 *  │     platform daily budget                                (cost control)
 *  ├─ 10. ORCHESTRATE: models collaborate under a per-request budget
 *  ├─ 11. settle: swap reservations for actual usage (always, even on error)
 *  ├─ 12. safety check on the answer
 *  ├─ 13. save conversation + request ledger
 *  └─ 14. respond
 *
 * Order matters: the cheapest checks run first so abusive or over-limit
 * traffic is rejected before we spend anything on it.
 */
import { randomUUID } from "node:crypto";
import type { Env } from "../config/env.js";
import { resolveLimits, type PlanLimits } from "../config/plans.js";
import { AppError } from "../errors.js";
import { microsToUsd, usdToMicros } from "../billing/pricing.js";
import { estimateMessagesTokens } from "../billing/tokenizer.js";
import type { ResponseCache } from "../cache/responseCache.js";
import type { LimitsService } from "../limits/limits.js";
import { titleFrom, trimHistory } from "../memory/conversations.js";
import type { Logger } from "../observability/logger.js";
import { metrics } from "../observability/metrics.js";
import type { OrchestrationResult, Orchestrator } from "../orchestrator/orchestrator.js";
import { PROMPT_VERSION } from "../orchestrator/prompts.js";
import { estimateRunTokens, selectModels, selectStrategy } from "../orchestrator/selection.js";
import type { CallRecord, ConcreteStrategy, OrchestrationEvent } from "../orchestrator/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ResilientCaller } from "../providers/resilience.js";
import type { ChatMessage } from "../providers/types.js";
import type { SafetyService } from "../safety/moderation.js";
import type { Principal, Store } from "../store/types.js";
import type { ChatBodyT } from "./schemas.js";

export interface ChatResponse {
  id: string;
  object: "chat.completion";
  conversation_id: string | null;
  answer: string;
  strategy: ConcreteStrategy;
  models: string[];
  rounds: number;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number; cost_usd: number };
  history_messages_dropped: number;
  cached: boolean;
  notes: string[];
  trace?: Array<Pick<CallRecord, "stage" | "round" | "modelId" | "ok" | "text" | "error" | "latencyMs">>;
}

export interface PipelineDeps {
  env: Env;
  store: Store;
  limits: LimitsService;
  orchestrator: Orchestrator;
  registry: ProviderRegistry;
  resilient: ResilientCaller;
  safety: SafetyService;
  cache: ResponseCache;
  logger: Logger;
}

type Partial_ = { calls: CallRecord[]; usage: { inputTokens: number; outputTokens: number }; costMicros: number; priceMicros: number };

export class ChatPipeline {
  constructor(private readonly d: PipelineDeps) {}

  async handle(
    principal: Principal,
    body: ChatBodyT,
    ctx: { ip: string; requestId?: string; emit?: (e: OrchestrationEvent) => void; signal?: AbortSignal },
  ): Promise<ChatResponse> {
    const requestId = ctx.requestId ?? randomUUID();
    const started = Date.now();
    const log = this.d.logger.child({ requestId, orgId: principal.orgId });

    // 1. Plan limits (with any per-org contract overrides).
    const plan = resolveLimits(principal.plan, principal.limitOverrides);

    // 2. Cheap guards.
    await this.guard("ip", () => this.d.limits.checkIpRate(ctx.ip, this.d.env.IP_REQUESTS_PER_MINUTE));
    await this.guard("rpm", () => this.d.limits.checkRequestRate(principal.orgId, plan));
    const release = await this.guard("concurrency", () => this.d.limits.acquireConcurrency(principal.orgId, plan));

    let strategy: ConcreteStrategy = "router";
    try {
      // 3. Messages: website mode loads history from the DB, API mode sends it all.
      const { messages: fullMessages, conversationId, newUserMessage } = await this.buildMessages(principal, body);

      // 4. Safety on the NEW text only (history was already checked when it was sent).
      const { injectionSignals } = await this.d.safety.checkInput(newUserMessage);
      if (injectionSignals.length) log.warn({ injectionSignals }, "possible prompt injection");

      // 5. Trim history so long chats don't get ever more expensive.
      const { messages, dropped } = trimHistory(fullMessages, plan.maxHistoryTokens, plan.maxInputTokens);

      // 6. Strategy and models.
      strategy = selectStrategy(body.strategy, messages, plan);
      const available = this.d.registry.availableModels().filter((m) => this.d.resilient.isAvailable(m.id));
      const sel = selectModels({ strategy, requested: body.models, requestedAggregator: body.aggregator, plan, available });
      const maxOutputTokens = Math.min(body.max_output_tokens ?? plan.maxOutputTokens, plan.maxOutputTokens);
      const defaultRounds = strategy === "debate" ? 2 : 1;
      const rounds = Math.max(1, Math.min(body.rounds ?? defaultRounds, plan.maxDebateRounds));

      // 7. Cache: only for stateless, deterministic questions.
      const cacheable = !conversationId && messages.filter((m) => m.role !== "system").length === 1 && !body.temperature;
      const cacheKey = cacheable
        ? this.d.cache.key({ strategy, models: sel.ensemble.map((m) => m.id), messages, maxOutputTokens })
        : null;
      if (cacheKey) {
        const hit = await this.d.cache.get(cacheKey);
        if (hit) {
          metrics.cacheHits.inc();
          return await this.finish({
            principal, requestId, started, strategy, conversationId, newUserMessage, dropped, body, cached: true,
            answer: hit.answer, contributors: hit.contributors, rounds: 0, notes: ["Served from cache."],
            calls: [], usage: { inputTokens: 0, outputTokens: 0 }, costMicros: 0, priceMicros: 0,
          });
        }
      }

      // 8. Token rate + daily quota, using the worst-case estimate for this run.
      const n = strategy === "router" ? 1 : sel.ensemble.length;
      const estimatedTokens = estimateRunTokens(strategy, estimateMessagesTokens(messages), maxOutputTokens, n, rounds);
      await this.guard("tpm", () => this.d.limits.checkTokenRate(principal.orgId, plan, estimatedTokens));
      await this.guard("daily_tokens", () => this.d.limits.checkDailyTokens(principal.orgId, plan, estimatedTokens));

      // 9. Reserve worst-case spend for the customer AND for the platform.
      const maxPriceMicros = Math.min(usdToMicros(plan.maxRequestCostUsd), usdToMicros(body.max_cost_usd ?? Infinity));
      const reservation = await this.guard("monthly_spend", () => this.d.limits.reserveSpend(principal.orgId, plan, maxPriceMicros));
      let platformRes: { day: string; reservedMicros: number } | undefined;
      try {
        platformRes = await this.guard("platform_budget", () =>
          this.d.limits.reservePlatformBudget(Math.ceil(maxPriceMicros / plan.markup), this.d.env.PLATFORM_DAILY_BUDGET_USD),
        );
      } catch (err) {
        await this.d.limits.settle({ orgId: principal.orgId, plan, reservation, actualPriceMicros: 0, estimatedTokens, actualTokens: 0 });
        throw err;
      }

      // 10 + 11. Orchestrate, then ALWAYS settle with whatever was actually spent.
      let result: OrchestrationResult | undefined;
      let spent: Partial_ = { calls: [], usage: { inputTokens: 0, outputTokens: 0 }, costMicros: 0, priceMicros: 0 };
      try {
        result = await this.d.orchestrator.run({
          requestId,
          strategy,
          input: { messages, ensemble: sel.ensemble, aggregator: sel.aggregator, classifier: sel.classifier, rounds, maxOutputTokens, temperature: body.temperature },
          maxPriceMicros,
          markup: plan.markup,
          emit: ctx.emit,
          signal: ctx.signal,
        });
        spent = result;
      } catch (err) {
        spent = ((err as { partial?: Partial_ }).partial ?? spent);
        // Bill partial work, then record the failure.
        await this.settleAll(principal.orgId, plan, reservation, platformRes, spent, estimatedTokens);
        await this.record(principal, requestId, started, strategy, conversationId, spent, false, err);
        throw err;
      }
      await this.settleAll(principal.orgId, plan, reservation, platformRes, spent, estimatedTokens);

      // 12. Safety on the final answer.
      const answer = await this.d.safety.checkOutput(result.answer);
      if (cacheKey) await this.d.cache.set(cacheKey, { answer, strategy, contributors: result.contributors });

      return await this.finish({
        principal, requestId, started, strategy, conversationId, newUserMessage, dropped, body, cached: false,
        answer, contributors: result.contributors, rounds: result.roundsCompleted, notes: result.notes,
        calls: result.calls, usage: result.usage, costMicros: result.costMicros, priceMicros: result.priceMicros,
      });
    } catch (err) {
      metrics.requests.inc({ strategy, outcome: err instanceof AppError ? err.type : "internal_error" });
      throw err;
    } finally {
      await release();
    }
  }

  /** Run a limit check and count rejections by kind (for the "are limits too tight?" dashboard). */
  private async guard<T>(kind: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) metrics.limitRejections.inc({ type: kind });
      throw err;
    }
  }

  private async buildMessages(p: Principal, body: ChatBodyT): Promise<{ messages: ChatMessage[]; conversationId: string | null; newUserMessage: string }> {
    if (body.messages) {
      const last = body.messages[body.messages.length - 1];
      return { messages: body.messages, conversationId: null, newUserMessage: last?.role === "user" ? last.content : "" };
    }
    const text = body.message!;
    if (body.conversation_id) {
      const conv = await this.d.store.getConversation(body.conversation_id, p);
      if (!conv) throw new AppError(404, "invalid_request", "Conversation not found");
      return {
        messages: [...conv.messages.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: text }],
        conversationId: conv.id,
        newUserMessage: text,
      };
    }
    return { messages: [{ role: "user", content: text }], conversationId: null, newUserMessage: text };
  }

  private async settleAll(
    orgId: string,
    plan: PlanLimits,
    reservation: Awaited<ReturnType<LimitsService["reserveSpend"]>>,
    platformRes: { day: string; reservedMicros: number } | undefined,
    spent: Partial_,
    estimatedTokens: number,
  ): Promise<void> {
    const actualTokens = spent.usage.inputTokens + spent.usage.outputTokens;
    await Promise.all([
      this.d.limits.settle({ orgId, plan, reservation, actualPriceMicros: spent.priceMicros, estimatedTokens, actualTokens }),
      platformRes ? this.d.limits.settlePlatformBudget(platformRes, spent.costMicros) : Promise.resolve(),
    ]);
    metrics.costMicros.inc(spent.costMicros);
    metrics.priceMicros.inc(spent.priceMicros);
  }

  private async record(
    principal: Principal,
    requestId: string,
    started: number,
    strategy: string,
    conversationId: string | null,
    spent: Partial_,
    ok: boolean,
    err?: unknown,
    cacheHit = false,
  ): Promise<void> {
    try {
      await this.d.store.recordRequest({
        id: requestId,
        principal,
        conversationId,
        strategy,
        status: ok ? "ok" : "error",
        errorType: err instanceof AppError ? err.type : err ? "internal_error" : undefined,
        inputTokens: spent.usage.inputTokens,
        outputTokens: spent.usage.outputTokens,
        costMicros: spent.costMicros,
        priceMicros: spent.priceMicros,
        latencyMs: Date.now() - started,
        cacheHit,
        promptVersion: PROMPT_VERSION,
        calls: spent.calls,
      });
    } catch (e) {
      // Losing a ledger row must be loud (it's lost revenue), but must not fail the user's request.
      this.d.logger.error({ err: e, requestId }, "failed to record request in ledger");
    }
  }

  private async finish(a: {
    principal: Principal;
    requestId: string;
    started: number;
    strategy: ConcreteStrategy;
    conversationId: string | null;
    newUserMessage: string;
    dropped: number;
    body: ChatBodyT;
    cached: boolean;
    answer: string;
    contributors: string[];
    rounds: number;
    notes: string[];
    calls: CallRecord[];
    usage: { inputTokens: number; outputTokens: number };
    costMicros: number;
    priceMicros: number;
  }): Promise<ChatResponse> {
    // 13. Save the chat (website mode only). A new chat is created on its first successful answer.
    let conversationId = a.conversationId;
    if (a.body.message !== undefined) {
      conversationId ??= await this.d.store.createConversation(a.principal, titleFrom(a.newUserMessage));
      await this.d.store.appendMessages(
        conversationId,
        [
          { role: "user", content: a.newUserMessage },
          { role: "assistant", content: a.answer },
        ],
        a.requestId,
      );
    }
    await this.record(a.principal, a.requestId, a.started, a.strategy, conversationId, a, true, undefined, a.cached);

    metrics.requests.inc({ strategy: a.strategy, outcome: "ok" });
    metrics.requestLatency.observe({ strategy: a.strategy }, (Date.now() - a.started) / 1000);

    // 14. Respond.
    return {
      id: a.requestId,
      object: "chat.completion",
      conversation_id: conversationId,
      answer: a.answer,
      strategy: a.strategy,
      models: a.contributors,
      rounds: a.rounds,
      usage: {
        input_tokens: a.usage.inputTokens,
        output_tokens: a.usage.outputTokens,
        total_tokens: a.usage.inputTokens + a.usage.outputTokens,
        cost_usd: microsToUsd(a.priceMicros),
      },
      history_messages_dropped: a.dropped,
      cached: a.cached,
      notes: a.notes,
      ...(a.body.include_trace
        ? { trace: a.calls.map(({ stage, round, modelId, ok, text, error, latencyMs }) => ({ stage, round, modelId, ok, text, error, latencyMs })) }
        : {}),
    };
  }
}
