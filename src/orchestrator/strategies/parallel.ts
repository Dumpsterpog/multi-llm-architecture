/**
 * STRATEGY: PARALLEL + SYNTHESIS  ("mixture of agents")
 *
 *          ┌──> Claude ──┐
 *   user ──┼──> GPT    ──┼──> aggregator ──> one answer
 *          └──> Gemini ──┘
 *
 * Every model answers independently and at the same time, then one
 * aggregator model reads all answers and writes the final one.
 *
 * Cost: N + 1 calls.  Latency: slowest model + synthesis.
 * Best for: most questions. Independent answers catch each other's
 * mistakes, and it's only ~2 sequential steps so it stays fast.
 */
import { ENSEMBLE_SYSTEM, withSystem } from "../prompts.js";
import type { RunContext, StrategyInput, StrategyOutput } from "../types.js";
import { failureNotes, fanOut, requireAny, synthesize } from "./common.js";

export async function runParallel(input: StrategyInput, ctx: RunContext): Promise<StrategyOutput> {
  const answers = await fanOut(
    input.ensemble,
    () => withSystem(input.messages, ENSEMBLE_SYSTEM),
    ctx,
    input,
    "answer",
    1,
  );
  requireAny(answers);
  const notes = failureNotes(answers);

  const final = await synthesize(answers.ok, ctx, input, 1, notes);
  return {
    answer: final.text,
    finishReason: final.finishReason,
    roundsCompleted: 1,
    contributors: answers.ok.map((c) => c.model.id),
    notes,
  };
}
