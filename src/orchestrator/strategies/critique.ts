/**
 * STRATEGY: DRAFT, CRITIQUE, REFINE  ("author and reviewers")
 *
 *   author (model 1) writes a draft
 *   reviewers (models 2..N) critique it in parallel
 *   author rewrites using the valid feedback
 *   ... repeat up to `rounds` times, or stop when every reviewer says NO_ISSUES
 *
 * Unlike parallel/debate, there is ONE author voice, so the result reads
 * as a single coherent piece. Best for long-form writing, code, and
 * documents, where merging three different drafts would be messy.
 *
 * Cost: 1 + (N-1) + 1 calls per cycle. Reviewers output short lists, so
 * it's cheaper than a debate.
 */
import { BudgetExceededError } from "../budget.js";
import { critiqueInstruction, ENSEMBLE_SYSTEM, refineInstruction, withFinalUserTurn, withSystem } from "../prompts.js";
import type { RunContext, StrategyInput, StrategyOutput } from "../types.js";
import { failureNotes, fanOut, requireAny } from "./common.js";
import type { FinishReason } from "../../providers/types.js";

export async function runCritique(input: StrategyInput, ctx: RunContext): Promise<StrategyOutput> {
  const [author, ...reviewers] = input.ensemble;
  if (!author) throw new Error("critique needs at least one model");

  const draftRun = await fanOut([author], () => withSystem(input.messages, ENSEMBLE_SYSTEM), ctx, input, "draft", 1);
  requireAny(draftRun);
  let draft = draftRun.ok[0]!.text;
  let finishReason: FinishReason = "stop";
  const notes: string[] = [];
  const contributors = new Set([author.id]);
  let roundsCompleted = 0;

  for (let round = 1; round <= input.rounds && reviewers.length > 0; round++) {
    const reviews = await fanOut(
      reviewers,
      () => withFinalUserTurn(input.messages, critiqueInstruction(draft)),
      ctx,
      input,
      "critique",
      round,
    );
    notes.push(...failureNotes(reviews));
    roundsCompleted = round;
    reviews.ok.forEach((r) => contributors.add(r.model.id));

    const issues = reviews.ok.map((r) => r.text.trim()).filter((t) => !t.startsWith("NO_ISSUES"));
    if (issues.length === 0) {
      if (reviews.ok.length > 0) {
        ctx.emit({ type: "consensus", round });
        notes.push(`Reviewers found no issues in round ${round}.`);
      }
      break;
    }

    try {
      const refined = await ctx.caller.call(author, withSystem(withFinalUserTurn(input.messages, refineInstruction(draft, issues)), ENSEMBLE_SYSTEM), {
        stage: "refine",
        round,
        maxOutputTokens: input.maxOutputTokens,
        temperature: input.temperature,
      });
      if (refined.text.trim()) {
        draft = refined.text;
        finishReason = refined.finishReason;
      }
    } catch (err) {
      // Keep the current draft; a failed refine shouldn't lose the answer we have.
      notes.push(err instanceof BudgetExceededError ? `Budget reached before refine round ${round}.` : `Refine round ${round} failed.`);
      break;
    }
  }

  return { answer: draft, finishReason, roundsCompleted, contributors: [...contributors], notes };
}
