/**
 * DISPATCH: turn the supervisor's decision into a concrete, plan-safe run.
 *
 *   supervisor decision  +  customer's plan  +  models available right now
 *            ──────────────────────────►  route, tier, strategy, models, rounds
 *
 * This is plain deterministic code on purpose. The supervisor is an LLM and
 * can be wrong or manipulated; THIS is where the rules that protect your
 * money live:
 *   - tier never above the plan's maxOrchestrationTier
 *   - only model tiers the plan allows
 *   - ensemble size, rounds and strategy within plan limits
 */
import type { ModelSpec, ModelTier } from "../config/models.js";
import type { PlanLimits } from "../config/plans.js";
import {
  DIRECT_MODEL_TIERS,
  SUPERVISOR_MAY_DOWNGRADE,
  TIER_ORDER,
  TIERS,
  tierIndex,
  type OrchestrationTier,
  type Route,
} from "../config/tiers.js";
import { AppError } from "../errors.js";
import { pickModel } from "./strategies/router.js";
import type { SupervisorDecision } from "./supervisor.js";
import type { ConcreteStrategy } from "./types.js";

export interface Dispatch {
  route: Route;
  /** Set when route is an orchestration tier. */
  tier?: OrchestrationTier;
  strategy: ConcreteStrategy;
  ensemble: ModelSpec[];
  aggregator: ModelSpec;
  rounds: number;
  decision: SupervisorDecision;
}

/** Which tier the message NEEDS, before the plan ceiling is applied. */
export function neededTier(d: SupervisorDecision): OrchestrationTier {
  return d.complexity === "complex" ? "max" : d.complexity === "medium" ? "standard" : "lite";
}

/**
 * Choose up to `size` models, preferring the given model tiers in order and
 * one model per vendor (diversity is the point of an ensemble). If there
 * aren't enough distinct vendors, fill with any remaining allowed models.
 */
export function pickEnsemble(pool: ModelSpec[], preferredTiers: ModelTier[], size: number): ModelSpec[] {
  const ranked = [...pool].sort((a, b) => {
    const ta = preferredTiers.indexOf(a.tier);
    const tb = preferredTiers.indexOf(b.tier);
    return (ta === -1 ? 99 : ta) - (tb === -1 ? 99 : tb);
  });
  const chosen: ModelSpec[] = [];
  const vendors = new Set<string>();
  for (const m of ranked) {
    if (chosen.length >= size) break;
    if (preferredTiers.includes(m.tier) && !vendors.has(m.provider)) {
      chosen.push(m);
      vendors.add(m.provider);
    }
  }
  for (const m of ranked) {
    if (chosen.length >= size) break;
    if (!chosen.includes(m)) chosen.push(m);
  }
  return chosen;
}

export function buildDispatch(decision: SupervisorDecision, plan: PlanLimits, available: ModelSpec[]): Dispatch {
  const allowed = available.filter((m) => plan.allowedModelTiers.includes(m.tier));
  if (allowed.length === 0) {
    throw new AppError(503, "no_models_available", "No models are currently available for your plan.");
  }

  // ---- direct: one model, no orchestration ----
  const direct = (): Dispatch => {
    const pool = allowed.filter((m) => DIRECT_MODEL_TIERS.includes(m.tier));
    const candidates = pool.length ? pool : allowed;
    const chosen = pickModel(candidates, { category: decision.category, complexity: "simple" });
    // Fallbacks if the chosen model fails: cheapest first.
    const fallbacks = candidates
      .filter((m) => m.id !== chosen.id)
      .sort((a, b) => a.pricing.outputPerMTok - b.pricing.outputPerMTok);
    return { route: "direct", strategy: "router", ensemble: [chosen, ...fallbacks], aggregator: chosen, rounds: 1, decision };
  };
  if (decision.route === "direct") return direct();

  // ---- orchestrate: needed tier, capped by the plan ----
  const ceiling = plan.maxOrchestrationTier;
  const tier: OrchestrationTier = SUPERVISOR_MAY_DOWNGRADE
    ? TIER_ORDER[Math.min(tierIndex(neededTier(decision)), tierIndex(ceiling))]!
    : ceiling;
  const spec = TIERS[tier];

  const size = Math.min(spec.ensembleSize, plan.maxModelsPerRequest);
  const ensemble = pickEnsemble(allowed, spec.ensembleModelTiers, size);
  if (ensemble.length < 2) return direct(); // can't orchestrate with one model

  const aggregator =
    pickEnsemble(allowed, spec.aggregatorModelTiers, 1).find((m) => spec.aggregatorModelTiers.includes(m.tier)) ?? ensemble[0]!;

  let strategy = spec.strategyFor(decision.category);
  if (!plan.allowedStrategies.includes(strategy)) strategy = "parallel";

  return {
    route: tier,
    tier,
    strategy,
    ensemble,
    aggregator,
    rounds: Math.max(1, Math.min(spec.rounds, plan.maxDebateRounds)),
    decision,
  };
}
