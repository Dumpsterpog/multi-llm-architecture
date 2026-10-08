/**
 * The ModelCaller every strategy uses. One model call goes through:
 *
 *   budget hold  ->  emit start  ->  resilient provider call (timeout,
 *   retries, breaker)  ->  budget settle  ->  record  ->  emit done
 *
 * Centralising this means strategies contain ONLY collaboration logic
 * ("who talks to whom, in what order"), never plumbing.
 */
import type { ModelSpec } from "../config/models.js";
import { costMicros } from "../billing/pricing.js";
import { estimateMessagesTokens } from "../billing/tokenizer.js";
import { metrics } from "../observability/metrics.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ResilientCaller } from "../providers/resilience.js";
import type { ChatMessage, CompletionResult } from "../providers/types.js";
import type { Budget } from "./budget.js";
import type { CallOptions, CallRecord, ModelCaller, OrchestrationEvent } from "./types.js";

export class RecordingCaller implements ModelCaller {
  readonly records: CallRecord[] = [];

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly resilient: ResilientCaller,
    private readonly budget: Budget,
    private readonly emit: (e: OrchestrationEvent) => void,
    private readonly signal?: AbortSignal,
  ) {}

  async call(model: ModelSpec, messages: ChatMessage[], opts: CallOptions): Promise<CompletionResult> {
    const provider = this.registry.get(model.provider);
    if (!provider) throw new Error(`provider ${model.provider} not configured`);

    // Never ask for more output than the model supports.
    const maxOutputTokens = Math.min(opts.maxOutputTokens, model.maxOutputTokens);
    const inputEstimate = estimateMessagesTokens(messages);
    if (inputEstimate > model.contextWindow - maxOutputTokens) {
      throw new Error(`prompt (~${inputEstimate} tokens) exceeds ${model.id} context window`);
    }

    // Throws BudgetExceededError if the worst case doesn't fit. Strategies catch it.
    const hold = this.budget.begin(model, inputEstimate, maxOutputTokens);
    this.emit({ type: "model_start", stage: opts.stage, round: opts.round, modelId: model.id });
    const started = Date.now();

    try {
      const result = await this.resilient.call(
        provider,
        {
          model,
          messages,
          maxOutputTokens,
          temperature: opts.temperature,
          signal: this.signal,
        },
        { timeoutMs: opts.timeoutMs, maxRetries: opts.maxRetries },
      );
      this.budget.end(hold, model, result.usage);
      const cost = costMicros(model, result.usage);
      this.records.push({
        stage: opts.stage,
        round: opts.round,
        modelId: model.id,
        provider: model.provider,
        ok: true,
        usage: result.usage,
        costMicros: cost,
        latencyMs: result.latencyMs,
        finishReason: result.finishReason,
        text: result.text,
      });
      metrics.modelCalls.inc({ model: model.id, stage: opts.stage, outcome: "ok" });
      metrics.modelLatency.observe({ model: model.id }, result.latencyMs / 1000);
      metrics.tokens.inc({ model: model.id, direction: "input" }, result.usage.inputTokens);
      metrics.tokens.inc({ model: model.id, direction: "output" }, result.usage.outputTokens);
      this.emit({
        type: "model_done",
        stage: opts.stage,
        round: opts.round,
        modelId: model.id,
        ok: true,
        latencyMs: result.latencyMs,
        outputTokens: result.usage.outputTokens,
      });
      return result;
    } catch (err) {
      this.budget.end(hold, model);
      const latencyMs = Date.now() - started;
      const message = (err as Error).message;
      this.records.push({
        stage: opts.stage,
        round: opts.round,
        modelId: model.id,
        provider: model.provider,
        ok: false,
        error: message,
        costMicros: 0,
        latencyMs,
      });
      metrics.modelCalls.inc({ model: model.id, stage: opts.stage, outcome: "error" });
      this.emit({ type: "model_done", stage: opts.stage, round: opts.round, modelId: model.id, ok: false, latencyMs, error: message });
      throw err;
    }
  }
}
