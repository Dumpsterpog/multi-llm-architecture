/**
 * THE ORCHESTRATOR
 *
 * Takes a resolved plan for a request (strategy, models, budget) and runs
 * the matching collaboration strategy. It knows nothing about HTTP, auth,
 * or billing; the gateway pipeline handles those around it. Keeping it
 * pure like this means it can later run in a background worker fed by a
 * queue (docs section 9, stage 2) without changes.
 */
import type { ProviderRegistry } from "../providers/registry.js";
import type { ResilientCaller } from "../providers/resilience.js";
import { Budget } from "./budget.js";
import { RecordingCaller } from "./caller.js";
import { runCritique } from "./strategies/critique.js";
import { runDebate } from "./strategies/debate.js";
import { runParallel } from "./strategies/parallel.js";
import { runRouter } from "./strategies/router.js";
import type { CallRecord, ConcreteStrategy, OrchestrationEvent, RunContext, StrategyInput, StrategyOutput } from "./types.js";

const STRATEGIES: Record<ConcreteStrategy, (i: StrategyInput, c: RunContext) => Promise<StrategyOutput>> = {
  router: runRouter,
  parallel: runParallel,
  debate: runDebate,
  critique: runCritique,
};

export interface OrchestrationResult extends StrategyOutput {
  strategy: ConcreteStrategy;
  calls: CallRecord[];
  usage: { inputTokens: number; outputTokens: number };
  /** Vendor cost (what we pay). */
  costMicros: number;
  /** Customer price (what they pay). */
  priceMicros: number;
}

export class Orchestrator {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly resilient: ResilientCaller,
  ) {}

  async run(args: {
    requestId: string;
    strategy: ConcreteStrategy;
    input: StrategyInput;
    maxPriceMicros: number;
    markup: number;
    emit?: (e: OrchestrationEvent) => void;
    signal?: AbortSignal;
  }): Promise<OrchestrationResult> {
    const emit = args.emit ?? (() => {});
    const budget = new Budget(args.maxPriceMicros, args.markup);
    const caller = new RecordingCaller(this.registry, this.resilient, budget, emit, args.signal);
    const ctx: RunContext = { requestId: args.requestId, budget, caller, emit };

    emit({
      type: "strategy",
      strategy: args.strategy,
      models: args.input.ensemble.map((m) => m.id),
      aggregator: args.input.aggregator.id,
    });

    // Even if the strategy throws, the caller still needs the call records
    // and spend so it can bill the partial work. Attach them to the error.
    try {
      const out = await STRATEGIES[args.strategy](args.input, ctx);
      return {
        ...out,
        strategy: args.strategy,
        calls: caller.records,
        usage: { inputTokens: budget.inputTokens, outputTokens: budget.outputTokens },
        costMicros: budget.costMicros,
        priceMicros: budget.spentPriceMicros,
      };
    } catch (err) {
      (err as { partial?: unknown }).partial = {
        calls: caller.records,
        usage: { inputTokens: budget.inputTokens, outputTokens: budget.outputTokens },
        costMicros: budget.costMicros,
        priceMicros: budget.spentPriceMicros,
      };
      throw err;
    }
  }
}
