/**
 * PRE-FLIGHT DECISIONS: which strategy, which models, and how many tokens
 * the run could use in the worst case.
 *
 * All of this runs BEFORE any model is called and costs nothing, so the
 * gateway can reject or downgrade a request before spending a cent.
 */
import {
  DEFAULT_AGGREGATOR,
  DEFAULT_CLASSIFIER,
  DEFAULT_ENSEMBLE,
  getModel,
  MOCK_ENSEMBLE,
  type ModelSpec,
  type TaskCategory,
} from "../config/models.js";
import type { PlanLimits, Strategy } from "../config/plans.js";
import { AppError } from "../errors.js";
import type { ChatMessage } from "../providers/types.js";
import type { ConcreteStrategy } from "./types.js";

export interface Classification {
  category: TaskCategory;
  complexity: "simple" | "medium" | "complex";
}

/**
 * Free, instant, keyword-based classification. Used to resolve "auto" and
 * as the router's fallback when the LLM classifier is unavailable.
 */
export function heuristicClassify(messages: ChatMessage[]): Classification {
  const text = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const t = text.toLowerCase();

  let category: TaskCategory = "general";
  if (/```|\bfunction\b|\bclass\b|\bbug\b|\bcompile|\bstack trace|\bregex|\bsql\b|\bapi\b/.test(t)) category = "coding";
  else if (/\bprove\b|\bequation|\bintegral|\bderivative|\bprobability|\d+\s*[\^*/]\s*\d+/.test(t)) category = "math";
  else if (/\bwhy\b|\banaly[sz]e|\bcompare|\btrade-?offs?\b|\bshould i\b|\bpros and cons/.test(t)) category = "reasoning";
  else if (/\bwrite\b|\bessay|\bemail|\bstory|\brewrite|\bpoem|\bblog/.test(t)) category = "writing";
  else if (/\btranslate|\bin (hindi|spanish|french|german|japanese|chinese)\b/.test(t)) category = "multilingual";
  else if (/^(what|who|when|where) (is|was|are|were)\b/.test(t)) category = "factual";

  // Complexity: length plus "this needs care" signals.
  let score = 0;
  if (text.length > 400) score++;
  if (text.length > 2000) score++;
  if (/step by step|in detail|thorough|design|architecture|prove|debug|edge cases|optimi[sz]e/.test(t)) score++;
  if (category === "math" || category === "reasoning" || category === "coding") score++;
  const complexity = score === 0 ? "simple" : score <= 2 ? "medium" : "complex";
  return { category, complexity };
}

/**
 * Turn the requested strategy into a concrete one the plan allows.
 * "auto": simple -> router (1 model), medium -> parallel, complex -> debate.
 */
export function selectStrategy(requested: Strategy | undefined, messages: ChatMessage[], plan: PlanLimits): ConcreteStrategy {
  const wanted = requested ?? plan.defaultStrategy;
  if (!plan.allowedStrategies.includes(wanted)) {
    throw new AppError(403, "permission_denied", `Strategy "${wanted}" is not available on the ${plan.displayName} plan.`);
  }
  if (wanted !== "auto") return wanted;

  const { complexity } = heuristicClassify(messages);
  const pick: ConcreteStrategy = complexity === "simple" ? "router" : complexity === "medium" ? "parallel" : "debate";
  // Downgrade gracefully if the plan doesn't include the ideal strategy.
  if (plan.allowedStrategies.includes(pick)) return pick;
  return plan.allowedStrategies.includes("parallel") ? "parallel" : "router";
}

export interface ModelSelection {
  ensemble: ModelSpec[];
  aggregator: ModelSpec;
  classifier: ModelSpec;
}

/**
 * Resolve which models take part, enforcing plan rules (tiers, count).
 * `available` = enabled models whose vendor is configured and breaker closed.
 */
export function selectModels(args: {
  strategy: ConcreteStrategy;
  requested?: string[];
  requestedAggregator?: string;
  plan: PlanLimits;
  available: ModelSpec[];
}): ModelSelection {
  const { plan, available, strategy } = args;
  const allowed = available.filter((m) => plan.allowedModelTiers.includes(m.tier));
  if (allowed.length === 0) {
    throw new AppError(503, "no_models_available", "No models are currently available for your plan.");
  }
  const isAllowed = (id: string) => allowed.find((m) => m.id === id);

  let ensemble: ModelSpec[];
  if (args.requested?.length) {
    ensemble = args.requested.map((id) => {
      const m = isAllowed(id);
      if (!m) {
        throw new AppError(getModel(id) ? 403 : 400, getModel(id) ? "permission_denied" : "invalid_request", `Model "${id}" is unknown, unavailable, or not in your plan.`);
      }
      return m;
    });
  } else if (strategy === "router") {
    // The router chooses from everything the plan allows.
    ensemble = allowed;
  } else {
    // Prefer one model per vendor (diversity), using the defaults when possible.
    const defaults = [...DEFAULT_ENSEMBLE, ...MOCK_ENSEMBLE].map(isAllowed).filter((m): m is ModelSpec => !!m);
    const seen = new Set<string>();
    ensemble = [...defaults, ...allowed].filter((m) => {
      if (seen.has(m.provider)) return false;
      seen.add(m.provider);
      return true;
    });
    // Only one vendor configured (e.g. dev with mocks)? Use several of its models.
    if (ensemble.length < 2) ensemble = [...new Set([...defaults, ...allowed])];
  }

  if (strategy !== "router") {
    ensemble = ensemble.slice(0, plan.maxModelsPerRequest);
  }

  const aggregator =
    (args.requestedAggregator && isAllowed(args.requestedAggregator)) ||
    isAllowed(DEFAULT_AGGREGATOR) ||
    ensemble.find((m) => m.tier !== "fast") ||
    ensemble[0]!;

  // Classifier: cheapest allowed model.
  const classifier =
    isAllowed(DEFAULT_CLASSIFIER) ??
    [...allowed].sort((a, b) => a.pricing.outputPerMTok - b.pricing.outputPerMTok)[0]!;

  return { ensemble, aggregator, classifier };
}

/**
 * Worst-case tokens a run could consume, for the TPM/daily checks.
 * in = prompt tokens, out = max output per call, n = models, r = rounds.
 * Over-estimating is safe: settle() refunds the difference afterwards.
 */
export function estimateRunTokens(strategy: ConcreteStrategy, inTok: number, outTok: number, n: number, rounds: number): number {
  const call = (input: number) => input + outTok;
  switch (strategy) {
    case "router":
      return call(inTok) + inTok + 60; // classifier + one answer
    case "parallel":
      return n * call(inTok) + call(inTok + n * outTok); // answers + synthesis
    case "debate": {
      const revise = n * call(inTok + n * outTok); // each sees all answers
      return n * call(inTok) + Math.max(0, rounds - 1) * revise + call(inTok + n * outTok);
    }
    case "critique": {
      const critics = Math.max(0, n - 1);
      const cycle = critics * call(inTok + outTok) + call(inTok + outTok + critics * outTok);
      return call(inTok) + rounds * cycle;
    }
  }
}
