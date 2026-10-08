/**
 * Building blocks shared by the strategies: fan-out to many models in
 * parallel, and synthesise many answers into one.
 *
 * GRACEFUL DEGRADATION is the core rule here. With 3 vendors, partial
 * failure is normal, not exceptional. If 1 of 3 models fails, the user
 * should still get a good answer from the other 2, not an error.
 */
import type { ModelSpec } from "../../config/models.js";
import { AppError } from "../../errors.js";
import type { ChatMessage, FinishReason } from "../../providers/types.js";
import { BudgetExceededError } from "../budget.js";
import { synthesisInstruction, withFinalUserTurn } from "../prompts.js";
import type { Candidate, RunContext, StrategyInput } from "../types.js";

export interface FanOutResult {
  ok: Candidate[];
  failed: { model: ModelSpec; reason: string }[];
}

/**
 * Ask several models in parallel. `buildMessages` lets each model get a
 * different prompt (debate: each sees the OTHER answers, not its own).
 */
export async function fanOut(
  models: ModelSpec[],
  buildMessages: (model: ModelSpec) => ChatMessage[],
  ctx: RunContext,
  input: StrategyInput,
  stage: string,
  round: number,
): Promise<FanOutResult> {
  ctx.emit({ type: "stage", stage, round });
  const settled = await Promise.allSettled(
    models.map((model) =>
      ctx.caller.call(model, buildMessages(model), {
        stage,
        round,
        maxOutputTokens: input.maxOutputTokens,
        temperature: input.temperature,
      }),
    ),
  );

  const ok: Candidate[] = [];
  const failed: FanOutResult["failed"] = [];
  settled.forEach((s, i) => {
    const model = models[i]!;
    if (s.status === "fulfilled" && s.value.text.trim()) {
      ok.push({ model, text: s.value.text });
    } else {
      const reason =
        s.status === "rejected"
          ? s.reason instanceof BudgetExceededError
            ? "skipped: request budget reached"
            : String((s.reason as Error)?.message ?? s.reason)
          : "empty response";
      failed.push({ model, reason });
    }
  });
  return { ok, failed };
}

/** Throw a clean API error if nobody answered. */
export function requireAny(r: FanOutResult): void {
  if (r.ok.length > 0) return;
  const allBudget = r.failed.every((f) => f.reason.startsWith("skipped"));
  if (allBudget) {
    throw new AppError(402, "budget_exceeded", "Request budget too small for even one model call. Raise max_cost_usd or shorten the prompt.");
  }
  throw new AppError(502, "upstream_error", `All models failed: ${r.failed.map((f) => `${f.model.id} (${f.reason})`).join("; ")}`);
}

const TIER_RANK = { flagship: 3, balanced: 2, fast: 1 } as const;

/** Fallback when synthesis isn't possible: the answer from the strongest model. */
export function bestSingle(candidates: Candidate[]): Candidate {
  return [...candidates].sort((a, b) => TIER_RANK[b.model.tier] - TIER_RANK[a.model.tier])[0]!;
}

/**
 * Merge candidates into one final answer using the aggregator model.
 * Fallback chain: aggregator -> other ensemble models -> best single answer.
 * The user always gets SOMETHING if at least one model answered.
 */
export async function synthesize(
  candidates: Candidate[],
  ctx: RunContext,
  input: StrategyInput,
  round: number,
  notes: string[],
): Promise<{ text: string; finishReason: FinishReason; by: string }> {
  if (candidates.length === 1) {
    // Nothing to merge. Skipping the synthesis call saves a full model call.
    return { text: candidates[0]!.text, finishReason: "stop", by: candidates[0]!.model.id };
  }

  const messages = withFinalUserTurn(input.messages, synthesisInstruction(candidates));
  const order = [input.aggregator, ...input.ensemble.filter((m) => m.id !== input.aggregator.id)];
  ctx.emit({ type: "stage", stage: "synthesize", round });

  for (const model of order) {
    try {
      const r = await ctx.caller.call(model, messages, {
        stage: "synthesize",
        round,
        maxOutputTokens: input.maxOutputTokens,
        // Low temperature: synthesis should be faithful, not creative.
        temperature: 0.2,
      });
      if (r.text.trim()) return { text: r.text, finishReason: r.finishReason, by: model.id };
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        ctx.emit({ type: "budget_stop", reason: "no budget left for synthesis" });
        notes.push("Budget reached before synthesis; returned the strongest single answer.");
        break;
      }
      notes.push(`Synthesis by ${model.id} failed, trying next model.`);
    }
  }
  const best = bestSingle(candidates);
  return { text: best.text, finishReason: "stop", by: best.model.id };
}

export function failureNotes(r: FanOutResult): string[] {
  return r.failed.map((f) => `${f.model.id} did not contribute (${f.reason}).`);
}
