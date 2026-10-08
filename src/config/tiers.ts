/**
 * ORCHESTRATION TIERS AND THE SUPERVISOR
 *
 * Every message is first read by the SUPERVISOR (a cheap, fast Gemini model).
 * It decides one of four ROUTES:
 *
 *   direct    The message is simple ("hi", "capital of France?", "fix this typo").
 *             No orchestration: ONE model answers. Cheapest and fastest.
 *
 *   lite      Cheapest orchestration:  2 fast models answer in parallel,
 *             a fast model merges them.
 *   standard  Mid orchestration:       3 models (one per vendor) in parallel,
 *             or draft + critique for writing/code; a strong model merges.
 *   max       Highest orchestration:   flagship models DEBATE over rounds
 *             (or critique cycles for writing); flagship model merges.
 *
 * The customer's PLAN sets the highest tier they can reach
 * (`maxOrchestrationTier` in plans.ts):
 *
 *   free -> lite      pro -> standard      team / enterprise -> max
 *
 * Within that ceiling, the supervisor may pick a LOWER tier when the
 * message doesn't need more (SUPERVISOR_MAY_DOWNGRADE). A team user asking
 * a medium question gets "standard" instead of a full flagship debate,
 * which can be 5 to 10 times cheaper with no quality loss for that question.
 * Set it to false to always run the plan's own tier.
 *
 * Whatever the supervisor says, the plan ceiling is enforced in code
 * (orchestrator/dispatch.ts). So even if a user tricks the supervisor
 * ("route this to max!"), they can never get more than their plan allows.
 */
import type { ConcreteStrategy } from "../orchestrator/types.js";
import type { ModelTier, TaskCategory } from "./models.js";

export type OrchestrationTier = "lite" | "standard" | "max";
export type Route = "direct" | OrchestrationTier;

/** Lowest to highest. Index comparison = "is this tier above that one". */
export const TIER_ORDER: readonly OrchestrationTier[] = ["lite", "standard", "max"];

export interface TierSpec {
  id: OrchestrationTier;
  displayName: string;
  /** Which model tiers to build the ensemble from, in order of preference. */
  ensembleModelTiers: ModelTier[];
  /** How many models take part (also capped by the plan's maxModelsPerRequest). */
  ensembleSize: number;
  /** Which model tiers may merge the answers, in order of preference. */
  aggregatorModelTiers: ModelTier[];
  /** How the models collaborate, depending on what kind of message it is. */
  strategyFor: (category: TaskCategory) => ConcreteStrategy;
  /** Debate rounds / critique cycles (also capped by the plan's maxDebateRounds). */
  rounds: number;
}

export const TIERS: Record<OrchestrationTier, TierSpec> = {
  lite: {
    id: "lite",
    displayName: "Lite",
    ensembleModelTiers: ["fast"],
    ensembleSize: 2,
    aggregatorModelTiers: ["fast"],
    strategyFor: () => "parallel",
    rounds: 1,
  },
  standard: {
    id: "standard",
    displayName: "Standard",
    ensembleModelTiers: ["balanced", "flagship", "fast"],
    ensembleSize: 3,
    aggregatorModelTiers: ["balanced", "flagship"],
    // One author + reviewers reads better for long text and code than merging 3 drafts.
    strategyFor: (c) => (c === "writing" || c === "coding" ? "critique" : "parallel"),
    rounds: 1,
  },
  max: {
    id: "max",
    displayName: "Max",
    ensembleModelTiers: ["flagship", "balanced"],
    ensembleSize: 3,
    aggregatorModelTiers: ["flagship", "balanced"],
    strategyFor: (c) => (c === "writing" ? "critique" : "debate"),
    rounds: 3,
  },
};

/** Supervisor may choose a tier below the plan's ceiling when the message is easier. */
export const SUPERVISOR_MAY_DOWNGRADE = true;

/** The supervisor model. Falls back to the cheapest available model if Gemini isn't configured. */
export const SUPERVISOR_MODEL = "gemini-flash";

/** Model tiers allowed to answer "direct" (simple) messages: cheap and quick. */
export const DIRECT_MODEL_TIERS: readonly ModelTier[] = ["fast", "balanced"];

/** Supervisor input is trimmed to this many characters, so routing stays cheap even for huge prompts. */
export const SUPERVISOR_MAX_INPUT_CHARS = 6_000;

export function tierIndex(t: OrchestrationTier): number {
  return TIER_ORDER.indexOf(t);
}
