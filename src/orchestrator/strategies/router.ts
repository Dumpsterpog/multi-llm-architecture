/**
 * STRATEGY: SMART ROUTER  (one model, chosen per request)
 *
 *   user ──> cheap classifier ──> "coding, complex" ──> best coding model ──> answer
 *
 * Not every request needs three models. "What's the capital of France?"
 * answered by a debate is pure waste. The router asks a cheap, fast model
 * to classify the request, then sends it to the single model best suited
 * (by strengths and tier). This is the cost-saving default for simple
 * traffic, and how most production AI products keep margins healthy.
 *
 * Cost: 1 tiny classification call + 1 call.
 *
 * Upgrade path: replace the LLM classifier with a small trained model
 * (embedding + logistic regression) learned from your own eval data:
 * faster, cheaper and better (docs section 13).
 */
import type { ModelSpec, TaskCategory } from "../../config/models.js";
import { CLASSIFY_INSTRUCTION, ENSEMBLE_SYSTEM, withFinalUserTurn, withSystem } from "../prompts.js";
import type { RunContext, StrategyInput, StrategyOutput } from "../types.js";
import { fanOut, requireAny, type FanOutResult } from "./common.js";
import { heuristicClassify, type Classification } from "../selection.js";

const CATEGORIES: TaskCategory[] = ["reasoning", "coding", "math", "writing", "factual", "multilingual", "general"];

export async function classify(input: StrategyInput, ctx: RunContext): Promise<Classification> {
  const fallback = heuristicClassify(input.messages);
  try {
    const r = await ctx.caller.call(input.classifier, withFinalUserTurn(input.messages, CLASSIFY_INSTRUCTION), {
      stage: "classify",
      round: 0,
      maxOutputTokens: 60,
      temperature: 0,
    });
    // Models sometimes wrap JSON in prose or code fences; grab the first {...}.
    const json = r.text.match(/\{[\s\S]*?\}/)?.[0];
    if (!json) return fallback;
    const parsed = JSON.parse(json) as Partial<Classification>;
    return {
      category: CATEGORIES.includes(parsed.category as TaskCategory) ? (parsed.category as TaskCategory) : fallback.category,
      complexity: ["simple", "medium", "complex"].includes(parsed.complexity as string)
        ? (parsed.complexity as Classification["complexity"])
        : fallback.complexity,
    };
  } catch {
    // Classifier down or over budget: the heuristic is good enough to route.
    return fallback;
  }
}

/** Score each candidate: right strengths + right tier for the complexity. */
export function pickModel(pool: ModelSpec[], c: Classification): ModelSpec {
  const wantTier = c.complexity === "simple" ? "fast" : c.complexity === "medium" ? "balanced" : "flagship";
  const score = (m: ModelSpec) =>
    (m.strengths.includes(c.category) ? 3 : 0) + (m.tier === wantTier ? 2 : 0) + (m.strengths.includes("general") ? 0.5 : 0);
  return [...pool].sort((a, b) => score(b) - score(a))[0]!;
}

export async function runRouter(input: StrategyInput, ctx: RunContext): Promise<StrategyOutput> {
  const classification = await classify(input, ctx);
  const chosen = pickModel(input.ensemble, classification);
  const notes = [`Routed as ${classification.category}/${classification.complexity} to ${chosen.id}.`];

  // If the chosen model fails, fall back to the next best ones (max 3 attempts).
  const ranked = [chosen, ...input.ensemble.filter((m) => m.id !== chosen.id)].slice(0, 3);
  const failed: FanOutResult["failed"] = [];
  for (const model of ranked) {
    const r = await fanOut([model], () => withSystem(input.messages, ENSEMBLE_SYSTEM), ctx, input, "answer", 1);
    if (r.ok.length) {
      return { answer: r.ok[0]!.text, finishReason: "stop", roundsCompleted: 1, contributors: [model.id], notes };
    }
    failed.push(...r.failed);
    notes.push(`${model.id} failed (${r.failed[0]?.reason}), falling back.`);
  }
  requireAny({ ok: [], failed }); // always throws here: nobody answered
  throw new Error("unreachable");
}
