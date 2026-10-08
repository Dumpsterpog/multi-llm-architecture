/**
 * PLANS, TIERS AND LIMITS
 *
 * Every customer (organisation) is on exactly one plan. The plan decides
 * HOW MUCH they can use (rate limits, quotas, spend) and WHAT they can use
 * (strategies, model tiers, number of models in an ensemble).
 *
 * There are three different kinds of limit here, and they protect different
 * things. It is worth understanding the difference:
 *
 * 1. RATE LIMITS (per minute: RPM, TPM, concurrency)
 *    Protect the PLATFORM from bursts. One customer hammering us must not
 *    burn through our own vendor rate limits and break everyone else.
 *    Enforced with token buckets in Redis (limits/rateLimiter.ts).
 *
 * 2. QUOTAS (per day / per month: tokens, dollars)
 *    Protect the BUSINESS. A $20/month customer must not cost us $500.
 *    Enforced with counters + a reservation system (limits/quota.ts).
 *
 * 3. PER-REQUEST CAPS (max input, max output, max cost, max rounds)
 *    Protect against a SINGLE runaway request, e.g. a 5-round debate across
 *    5 flagship models on a 150k-token prompt. Enforced by the orchestrator's
 *    Budget (orchestrator/budget.ts), which stops the run when it's spent.
 *
 * Multi-LLM note: one user request fans out into MANY model calls
 * (3 models x 3 debate rounds + 1 synthesis = 10 calls). So limits are
 * counted in TOKENS and DOLLARS, never in "requests" alone.
 */
import type { ModelTier } from "./models.js";
import type { OrchestrationTier } from "./tiers.js";

export type PlanId = "free" | "pro" | "team" | "enterprise";

/** The collaboration patterns the orchestrator supports. See docs/ARCHITECTURE.md section 5. */
export type Strategy = "auto" | "router" | "parallel" | "debate" | "critique";

export interface PlanLimits {
  id: PlanId;
  displayName: string;
  /** Monthly subscription price in USD (for display / billing integration). */
  priceUsdPerMonth: number;

  // --- 1. Rate limits (protect the platform) ---
  requestsPerMinute: number;
  /** Tokens per minute, summed across ALL model calls a request triggers. */
  tokensPerMinute: number;
  /** In-flight requests at the same time. Debates are long, so this matters. */
  maxConcurrentRequests: number;

  // --- 2. Quotas (protect the business) ---
  /** Hard daily token cap. Resets at 00:00 UTC. */
  dailyTokenLimit: number;
  /** Spend included in the subscription, in USD (customer price, after markup). */
  monthlyIncludedUsd: number;
  /** If true, usage past the included amount is billed as overage instead of blocked. */
  allowOverage: boolean;
  /** Absolute monthly ceiling even with overage, so a bug can't cost a customer $50k. */
  monthlyHardCapUsd: number;

  // --- 3. Per-request caps (protect against runaway requests) ---
  maxInputTokens: number;
  maxOutputTokens: number;
  /** The orchestrator stops calling models once a single request costs this much. */
  maxRequestCostUsd: number;
  maxModelsPerRequest: number;
  maxDebateRounds: number;

  /**
   * Max tokens of conversation HISTORY re-sent to the models each turn.
   * In a chat site every new message re-sends the whole conversation, so a
   * 50-message chat costs 50x more per turn than a fresh one. Older messages
   * past this cap are dropped (memory/conversations.ts). Biggest single
   * cost lever for a ChatGPT-style product.
   */
  maxHistoryTokens: number;

  // --- Feature access ---
  /**
   * Strategy used when the client sends nothing. "auto" = the SUPERVISOR
   * decides (config/tiers.ts): simple messages go to one model, the rest to
   * an orchestration tier no higher than `maxOrchestrationTier`.
   */
  defaultStrategy: Strategy;
  /** Highest orchestration tier this plan can reach: free = lite, pro = standard, team+ = max. */
  maxOrchestrationTier: OrchestrationTier;
  allowedStrategies: Strategy[];
  allowedModelTiers: ModelTier[];
  /** Multiplier on our vendor cost. 1.4 = 40% gross margin on tokens. */
  markup: number;
  /** Days we keep conversation history (data retention policy). */
  historyRetentionDays: number;
}

export const PLANS: Record<PlanId, PlanLimits> = {
  free: {
    id: "free",
    displayName: "Free",
    priceUsdPerMonth: 0,
    requestsPerMinute: 5,
    tokensPerMinute: 20_000,
    maxConcurrentRequests: 1,
    dailyTokenLimit: 100_000,
    monthlyIncludedUsd: 1,
    allowOverage: false,
    monthlyHardCapUsd: 1,
    maxInputTokens: 8_000,
    maxOutputTokens: 1_024,
    maxRequestCostUsd: 0.05,
    maxModelsPerRequest: 2,
    maxDebateRounds: 1,
    // Free users get cheap single-model routing and a small 2-model ensemble.
    maxHistoryTokens: 4_000,
    defaultStrategy: "auto",
    maxOrchestrationTier: "lite",
    allowedStrategies: ["auto", "router", "parallel"],
    allowedModelTiers: ["fast", "balanced"],
    markup: 1.0,
    historyRetentionDays: 7,
  },
  pro: {
    id: "pro",
    displayName: "Pro",
    priceUsdPerMonth: 20,
    requestsPerMinute: 30,
    tokensPerMinute: 200_000,
    maxConcurrentRequests: 3,
    dailyTokenLimit: 2_000_000,
    monthlyIncludedUsd: 15,
    allowOverage: false,
    monthlyHardCapUsd: 15,
    maxInputTokens: 64_000,
    maxOutputTokens: 4_096,
    maxRequestCostUsd: 0.75,
    maxModelsPerRequest: 3,
    maxDebateRounds: 2,
    maxHistoryTokens: 24_000,
    defaultStrategy: "auto",
    maxOrchestrationTier: "standard",
    allowedStrategies: ["auto", "router", "parallel", "debate", "critique"],
    allowedModelTiers: ["fast", "balanced", "flagship"],
    markup: 1.3,
    historyRetentionDays: 90,
  },
  team: {
    id: "team",
    displayName: "Team",
    priceUsdPerMonth: 100,
    requestsPerMinute: 120,
    tokensPerMinute: 1_000_000,
    maxConcurrentRequests: 10,
    dailyTokenLimit: 20_000_000,
    monthlyIncludedUsd: 80,
    allowOverage: true,
    monthlyHardCapUsd: 1_000,
    maxInputTokens: 150_000,
    maxOutputTokens: 8_192,
    maxRequestCostUsd: 3,
    maxModelsPerRequest: 4,
    maxDebateRounds: 3,
    maxHistoryTokens: 64_000,
    defaultStrategy: "auto",
    maxOrchestrationTier: "max",
    allowedStrategies: ["auto", "router", "parallel", "debate", "critique"],
    allowedModelTiers: ["fast", "balanced", "flagship"],
    markup: 1.3,
    historyRetentionDays: 365,
  },
  enterprise: {
    // Enterprise values are defaults; real contracts override them per org
    // (the `limitOverrides` field on the org doc in Firestore).
    id: "enterprise",
    displayName: "Enterprise",
    priceUsdPerMonth: 0, // negotiated
    requestsPerMinute: 600,
    tokensPerMinute: 5_000_000,
    maxConcurrentRequests: 50,
    dailyTokenLimit: 200_000_000,
    monthlyIncludedUsd: 0,
    allowOverage: true,
    monthlyHardCapUsd: 50_000,
    maxInputTokens: 190_000,
    maxOutputTokens: 16_384,
    maxRequestCostUsd: 10,
    maxModelsPerRequest: 6,
    maxDebateRounds: 4,
    maxHistoryTokens: 120_000,
    defaultStrategy: "auto",
    maxOrchestrationTier: "max",
    allowedStrategies: ["auto", "router", "parallel", "debate", "critique"],
    allowedModelTiers: ["fast", "balanced", "flagship"],
    markup: 1.2,
    historyRetentionDays: 730,
  },
};

/**
 * Merge an org's contract overrides on top of its plan defaults.
 * Enterprise deals always end up with custom numbers; this keeps that
 * out of the code (overrides live in the database).
 */
export function resolveLimits(plan: PlanId, overrides?: Partial<PlanLimits> | null): PlanLimits {
  return { ...PLANS[plan], ...(overrides ?? {}) };
}
