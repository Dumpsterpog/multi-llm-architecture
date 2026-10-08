/**
 * PER-REQUEST BUDGET
 *
 * A multi-model run is a loop of model calls whose total cost isn't known
 * in advance (a debate might converge in 1 round or need 3). The Budget is
 * the circuit breaker on spend for ONE request: before every model call the
 * orchestrator asks "can we afford the worst case of this call?" and, if
 * not, stops calling models and returns the best answer it has so far.
 *
 * Parallel calls are the tricky part. If three calls start at once, each
 * one alone may fit, but together they don't. So each call first takes a
 * HOLD for its worst-case price (begin), and swaps it for the actual price
 * when it finishes (end). Same reservation idea as limits.ts, in miniature.
 *
 * All amounts are CUSTOMER PRICE in micro-dollars (vendor cost * markup),
 * so the cap matches the plan's `maxRequestCostUsd` the customer sees.
 */
import type { ModelSpec } from "../config/models.js";
import { costMicros, maxCostMicros, priceMicros } from "../billing/pricing.js";
import type { TokenUsage } from "../providers/types.js";

export class BudgetExceededError extends Error {
  constructor(readonly modelId: string) {
    super(`request budget exhausted before calling ${modelId}`);
    this.name = "BudgetExceededError";
  }
}

export interface BudgetHold {
  readonly amount: number;
}

export class Budget {
  private spent = 0;
  private held = 0;
  inputTokens = 0;
  outputTokens = 0;
  /** Vendor cost (before markup) for margin reporting. */
  costMicros = 0;

  constructor(
    readonly maxPriceMicros: number,
    private readonly markup: number,
  ) {}

  /** Reserve the worst-case price of a call, or throw if it won't fit. */
  begin(model: ModelSpec, inputTokens: number, maxOutputTokens: number): BudgetHold {
    const amount = priceMicros(maxCostMicros(model, inputTokens, maxOutputTokens), this.markup);
    if (this.spent + this.held + amount > this.maxPriceMicros) {
      throw new BudgetExceededError(model.id);
    }
    this.held += amount;
    return { amount };
  }

  /** Release the hold and record what the call really cost (usage may be undefined if it failed). */
  end(hold: BudgetHold, model: ModelSpec, usage?: TokenUsage): void {
    this.held -= hold.amount;
    if (!usage) return; // failed calls are not billed by vendors (no usage returned)
    const cost = costMicros(model, usage);
    this.costMicros += cost;
    this.spent += priceMicros(cost, this.markup);
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
  }

  get spentPriceMicros(): number {
    return this.spent;
  }

  get remainingMicros(): number {
    return this.maxPriceMicros - this.spent - this.held;
  }
}
