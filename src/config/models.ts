/**
 * MODEL REGISTRY
 *
 * The single source of truth for every model the platform can call.
 *
 * Key idea: the rest of the system never uses a vendor's raw model string
 * ("claude-sonnet-5-5", "gpt-5", ...). It uses OUR stable internal id
 * ("claude-sonnet"). When a vendor ships a new version you change one line
 * here (`providerModelId`) and every customer, log line and invoice keeps
 * working. This is how AI companies upgrade models without breaking clients.
 *
 * !!! PRICES AND MODEL IDS BELOW ARE PLACEHOLDERS !!!
 * Vendors change prices and retire model ids often. Before launch, copy the
 * current values from each provider's pricing / models page. Billing math is
 * only as correct as these numbers.
 */
import type { ProviderName } from "../providers/types.js";

/** What a model is good at. Used by the router to pick the right model. */
export type TaskCategory =
  | "reasoning"
  | "coding"
  | "math"
  | "writing"
  | "factual"
  | "multilingual"
  | "general";

/**
 * flagship = smartest and most expensive
 * balanced = good quality per dollar (the default workhorse)
 * fast     = cheap and quick (classification, routing, simple Q&A)
 * Plans restrict which tiers a customer may use (see plans.ts).
 */
export type ModelTier = "flagship" | "balanced" | "fast";

export interface ModelSpec {
  /** Our stable id. Shown to API users. Never changes. */
  id: string;
  provider: ProviderName;
  /** The vendor's model string. Change this to upgrade a model version. */
  providerModelId: string;
  displayName: string;
  tier: ModelTier;
  /** Max tokens the model can read (prompt + history). */
  contextWindow: number;
  /** Max tokens the model can write in one response. */
  maxOutputTokens: number;
  /**
   * Vendor cost in USD per 1 MILLION tokens. This is OUR cost, not what we
   * charge. The customer price = cost * plan markup (see billing/pricing.ts).
   */
  pricing: { inputPerMTok: number; outputPerMTok: number };
  strengths: TaskCategory[];
  /** Kill switch: flip to false to pull a model instantly (bad outage, bad version). */
  enabled: boolean;
}

export const MODELS: readonly ModelSpec[] = [
  // ---------------- Anthropic ----------------
  {
    id: "claude-opus",
    provider: "anthropic",
    providerModelId: "claude-opus-5-5",
    displayName: "Claude Opus",
    tier: "flagship",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    pricing: { inputPerMTok: 5, outputPerMTok: 25 }, // PLACEHOLDER: verify
    strengths: ["reasoning", "coding", "writing"],
    enabled: true,
  },
  {
    id: "claude-sonnet",
    provider: "anthropic",
    providerModelId: "claude-sonnet-5-5",
    displayName: "Claude Sonnet",
    tier: "balanced",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerMTok: 3, outputPerMTok: 15 }, // PLACEHOLDER: verify
    strengths: ["coding", "writing", "reasoning", "general"],
    enabled: true,
  },
  {
    id: "claude-haiku",
    provider: "anthropic",
    providerModelId: "claude-haiku-5-5",
    displayName: "Claude Haiku",
    tier: "fast",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 5 }, // PLACEHOLDER: verify
    strengths: ["general", "coding"],
    enabled: true,
  },

  // ---------------- OpenAI ----------------
  {
    id: "gpt",
    provider: "openai",
    providerModelId: "gpt-5", // PLACEHOLDER: set to the current flagship id
    displayName: "GPT",
    tier: "flagship",
    contextWindow: 400_000,
    maxOutputTokens: 32_000,
    pricing: { inputPerMTok: 1.25, outputPerMTok: 10 }, // PLACEHOLDER: verify
    strengths: ["reasoning", "math", "coding", "general"],
    enabled: true,
  },
  {
    id: "gpt-mini",
    provider: "openai",
    providerModelId: "gpt-5-mini", // PLACEHOLDER
    displayName: "GPT Mini",
    tier: "fast",
    contextWindow: 400_000,
    maxOutputTokens: 32_000,
    pricing: { inputPerMTok: 0.25, outputPerMTok: 2 }, // PLACEHOLDER: verify
    strengths: ["general", "math"],
    enabled: true,
  },

  // ---------------- Google ----------------
  {
    id: "gemini-pro",
    provider: "google",
    providerModelId: "gemini-2.5-pro", // PLACEHOLDER: set to the current pro id
    displayName: "Gemini Pro",
    tier: "flagship",
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
    pricing: { inputPerMTok: 1.25, outputPerMTok: 10 }, // PLACEHOLDER: verify
    strengths: ["factual", "multilingual", "reasoning", "math"],
    enabled: true,
  },
  {
    id: "gemini-flash",
    provider: "google",
    providerModelId: "gemini-2.5-flash", // PLACEHOLDER
    displayName: "Gemini Flash",
    tier: "fast",
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
    pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 }, // PLACEHOLDER: verify
    strengths: ["general", "multilingual", "factual"],
    enabled: true,
  },

  // ---------------- Mock (dev / tests only) ----------------
  // Three fake models with different "personalities" so debate and
  // synthesis have something to disagree about. Free, instant, offline.
  ...(["mock-alpha", "mock-beta", "mock-gamma"] as const).map(
    (id, i): ModelSpec => ({
      id,
      provider: "mock",
      providerModelId: id,
      displayName: `Mock ${id.split("-")[1]}`,
      tier: i === 0 ? "flagship" : i === 1 ? "balanced" : "fast",
      contextWindow: 100_000,
      maxOutputTokens: 4_000,
      pricing: { inputPerMTok: 1, outputPerMTok: 2 }, // fake, so billing paths still run
      strengths: ["general", "reasoning", "coding"],
      enabled: true,
    }),
  ),
];

const byId = new Map(MODELS.map((m) => [m.id, m]));

export function getModel(id: string): ModelSpec | undefined {
  return byId.get(id);
}

/**
 * Default line-up per provider set. When a user doesn't name models we use
 * one balanced/flagship model per vendor: diversity across vendors is the
 * whole point (different training data = different blind spots).
 */
export const DEFAULT_ENSEMBLE: readonly string[] = ["claude-sonnet", "gpt", "gemini-pro"];
export const DEFAULT_AGGREGATOR = "claude-sonnet";
/** Cheap model used for routing / classification decisions. */
export const DEFAULT_CLASSIFIER = "gemini-flash";
export const MOCK_ENSEMBLE: readonly string[] = ["mock-alpha", "mock-beta", "mock-gamma"];
