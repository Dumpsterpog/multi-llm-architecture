/**
 * PRICING: turning tokens into money.
 *
 * Money rule #1: never use floating point dollars for accounting.
 * 0.1 + 0.2 !== 0.3 in JavaScript, and those errors add up over millions of
 * calls. Everything here is computed in MICRO-DOLLARS (1 USD = 1,000,000
 * micros) as integers. Convert to dollars only for display.
 *
 * Two prices exist for every call:
 *   cost  = what the VENDOR charges us       (model pricing)
 *   price = what WE charge the customer      (cost * plan markup)
 * Both are stored in the usage ledger so finance can compute margin.
 */
import type { ModelSpec } from "../config/models.js";
import type { TokenUsage } from "../providers/types.js";

export const MICROS_PER_USD = 1_000_000;

export function usdToMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD);
}

export function microsToUsd(micros: number): number {
  return micros / MICROS_PER_USD;
}

/**
 * Vendor cost of one call in micro-dollars.
 * pricing is USD per 1M tokens, so USD per token = price / 1e6, and
 * micros per token = price exactly. Neat, that's why we use micros.
 */
export function costMicros(model: ModelSpec, usage: TokenUsage): number {
  const input = usage.inputTokens * model.pricing.inputPerMTok;
  const output = usage.outputTokens * model.pricing.outputPerMTok;
  return Math.ceil(input + output);
}

/**
 * Worst-case cost of a call we are ABOUT to make: assumes the model writes
 * its full output allowance. Used to reserve budget up front.
 */
export function maxCostMicros(model: ModelSpec, inputTokens: number, maxOutputTokens: number): number {
  return costMicros(model, { inputTokens, outputTokens: maxOutputTokens });
}

/** Customer price = vendor cost * plan markup. */
export function priceMicros(cost: number, markup: number): number {
  return Math.ceil(cost * markup);
}
