/**
 * Provider registry: builds one adapter per configured vendor and answers
 * "which models can this deployment actually call right now?".
 *
 * A model is callable only if:
 *   1. it is `enabled` in config/models.ts (kill switch), AND
 *   2. its vendor's API key is configured (or it's the mock in dev), AND
 *   3. its circuit breaker is closed (checked at call time).
 */
import type { Env } from "../config/env.js";
import { MODELS, type ModelSpec } from "../config/models.js";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { MockProvider } from "./mock.js";
import { OpenAIProvider } from "./openai.js";
import type { LLMProvider, ProviderName } from "./types.js";

export class ProviderRegistry {
  private readonly providers = new Map<ProviderName, LLMProvider>();

  constructor(env: Env) {
    if (env.ANTHROPIC_API_KEY) this.providers.set("anthropic", new AnthropicProvider(env.ANTHROPIC_API_KEY));
    if (env.OPENAI_API_KEY) this.providers.set("openai", new OpenAIProvider(env.OPENAI_API_KEY));
    if (env.GOOGLE_API_KEY) this.providers.set("google", new GoogleProvider(env.GOOGLE_API_KEY));
    if (env.ENABLE_MOCK_PROVIDER) this.providers.set("mock", new MockProvider());
  }

  get(name: ProviderName): LLMProvider | undefined {
    return this.providers.get(name);
  }

  /** Models that are enabled AND whose vendor is configured. */
  availableModels(): ModelSpec[] {
    return MODELS.filter((m) => m.enabled && this.providers.has(m.provider));
  }

  configuredProviders(): ProviderName[] {
    return [...this.providers.keys()];
  }
}
