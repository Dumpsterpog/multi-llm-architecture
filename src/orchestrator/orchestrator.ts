/**
 * THE ORCHESTRATOR
 *
 * Runs one request in two phases, under ONE per-request budget:
 *
 *   1. prepare()  decide what to run. In auto mode this is where the
 *                 SUPERVISOR model reads the message and dispatch.ts turns
 *                 its decision into a route/tier/strategy/models. Its tokens
 *                 go through the same budget and billing as everything else.
 *   2. strategy   run the chosen collaboration strategy.
 *
 * It knows nothing about HTTP, auth, or billing; the gateway pipeline
 * handles those around it. Keeping it
 * pure like this means it can later run in a background worker fed by a
 * queue (docs section 9, stage 2) without changes.
 */
import type { ProviderRegistry } from "../providers/registry.js";
import type { ResilientCaller } from "../providers/resilience.js";
import { Budget } from "./budget.js";
import type { Dispatch } from "./dispatch.js";
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

/** What prepare() returns: the concrete run, plus the dispatch if the supervisor decided it. */
export interface PreparedRun {
  strategy: ConcreteStrategy;
  input: StrategyInput;
  dispatch?: Dispatch;
}

export interface OrchestrationResult extends StrategyOutput {
  strategy: ConcreteStrategy;
  dispatch?: Dispatch;
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
    /** Decides the run. May call models (the supervisor) through ctx.caller. */
    prepare: (ctx: RunContext) => Promise<PreparedRun>;
    maxPriceMicros: number;
    markup: number;
    emit?: (e: OrchestrationEvent) => void;
    signal?: AbortSignal;
  }): Promise<OrchestrationResult> {
    const emit = args.emit ?? (() => {});
    const budget = new Budget(args.maxPriceMicros, args.markup);
    const caller = new RecordingCaller(this.registry, this.resilient, budget, emit, args.signal);
    const ctx: RunContext = { requestId: args.requestId, budget, caller, emit };

    // Even if anything throws, the caller still needs the call records
    // and spend so it can bill the partial work. Attach them to the error.
    try {
      const run = await args.prepare(ctx);
      emit({
        type: "strategy",
        strategy: run.strategy,
        models: run.input.ensemble.map((m) => m.id),
        aggregator: run.input.aggregator.id,
      });
      const out = await STRATEGIES[run.strategy](run.input, ctx);
      return {
        ...out,
        strategy: run.strategy,
        dispatch: run.dispatch,
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
