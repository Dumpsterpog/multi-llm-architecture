/**
 * STRATEGY: MULTI-ROUND DEBATE
 *
 *   round 1:  A, B, C answer independently
 *   round 2:  A sees B+C and revises;  B sees A+C;  C sees A+B
 *   round N:  ... repeat until consensus, max rounds, or budget runs out
 *   final:    aggregator synthesises the final positions
 *
 * This is the "models talk to each other" mode. Each model must defend or
 * update its answer given its peers' reasoning, which is especially good
 * at catching reasoning and math errors that a single pass misses.
 *
 * Cost: N * rounds + 1 calls, and prompts grow each round (they carry
 * the other answers), so this is the most expensive strategy. Plans cap
 * `maxDebateRounds`, and the Budget stops it early if needed.
 *
 * EARLY STOP on consensus: each revision ends with "CHANGED: yes|no".
 * If nobody changed their answer in a round, further rounds would just
 * burn tokens, so we stop and synthesise.
 */
import { BudgetExceededError } from "../budget.js";
import { debateInstruction, ENSEMBLE_SYSTEM, parseChanged, withFinalUserTurn, withSystem } from "../prompts.js";
import type { Candidate, RunContext, StrategyInput, StrategyOutput } from "../types.js";
import { failureNotes, fanOut, requireAny, synthesize } from "./common.js";

export async function runDebate(input: StrategyInput, ctx: RunContext): Promise<StrategyOutput> {
  const first = await fanOut(input.ensemble, () => withSystem(input.messages, ENSEMBLE_SYSTEM), ctx, input, "answer", 1);
  requireAny(first);
  const notes = failureNotes(first);

  // Only models that answered in round 1 continue the debate.
  let current: Candidate[] = first.ok;
  let roundsCompleted = 1;

  for (let round = 2; round <= input.rounds && current.length >= 2; round++) {
    const revised = await fanOut(
      current.map((c) => c.model),
      (model) => {
        const own = current.find((c) => c.model.id === model.id)!;
        const others = current.filter((c) => c.model.id !== model.id);
        return withSystem(withFinalUserTurn(input.messages, debateInstruction(own.text, others)), ENSEMBLE_SYSTEM);
      },
      ctx,
      input,
      "revise",
      round,
    );

    if (revised.ok.length === 0) {
      // Whole round failed or no budget: keep last round's answers and stop.
      const budgetHit = revised.failed.some((f) => f.reason.startsWith("skipped"));
      if (budgetHit) ctx.emit({ type: "budget_stop", reason: `budget reached in debate round ${round}` });
      notes.push(`Debate stopped at round ${round}: ${budgetHit ? "budget reached" : "all revisions failed"}.`);
      break;
    }

    // A model whose revision failed keeps its previous answer rather than dropping out.
    let anyChanged = false;
    current = current.map((prev) => {
      const r = revised.ok.find((x) => x.model.id === prev.model.id);
      if (!r) return prev;
      const parsed = parseChanged(r.text);
      if (parsed.changed) anyChanged = true;
      return { model: prev.model, text: parsed.text };
    });
    roundsCompleted = round;

    if (!anyChanged) {
      ctx.emit({ type: "consensus", round });
      notes.push(`Consensus reached after round ${round}.`);
      break;
    }
  }

  let final;
  try {
    final = await synthesize(current, ctx, input, roundsCompleted + 1, notes);
  } catch (err) {
    if (!(err instanceof BudgetExceededError)) throw err;
    final = { text: current[0]!.text, finishReason: "stop" as const, by: current[0]!.model.id };
  }

  return {
    answer: final.text,
    finishReason: final.finishReason,
    roundsCompleted,
    contributors: current.map((c) => c.model.id),
    notes,
  };
}
