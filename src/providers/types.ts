/**
 * PROVIDER ABSTRACTION
 *
 * Every vendor (OpenAI, Anthropic, Google, ...) has a different API shape:
 * different JSON, different names for the same thing, different ways of
 * reporting tokens. The adapter pattern hides all of that behind ONE
 * interface, `LLMProvider`. The orchestrator only ever talks to this
 * interface, so adding a new vendor (Mistral, a self-hosted Llama, ...)
 * means writing one adapter file and touching nothing else.
 */
import type { ModelSpec } from "../config/models.js";

export type ProviderName = "openai" | "anthropic" | "google" | "mock";

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface CompletionRequest {
  model: ModelSpec;
  /** May include a leading "system" message; adapters move it where their vendor wants it. */
  messages: ChatMessage[];
  maxOutputTokens: number;
  temperature?: number;
  /** Cancels the HTTP call if the client disconnects or the budget runs out. */
  signal?: AbortSignal;
}

/**
 * Token usage as reported BY THE VENDOR. This is what we bill on.
 * Our own estimates (billing/tokenizer.ts) are only used before a call,
 * to decide whether a request is allowed to run at all.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the vendor's prompt cache (usually billed cheaper). */
  cachedInputTokens?: number;
}

export type FinishReason = "stop" | "length" | "content_filter" | "other";

export interface CompletionResult {
  modelId: string;
  provider: ProviderName;
  text: string;
  usage: TokenUsage;
  finishReason: FinishReason;
  latencyMs: number;
}

export interface LLMProvider {
  readonly name: ProviderName;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/**
 * Normalised error. `retryable` tells the resilience layer whether trying
 * again could help (429 rate limit, 5xx, network) or not (400 bad request,
 * 401 bad key: retrying those just wastes time).
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderName,
    readonly status: number | undefined,
    readonly retryable: boolean,
    /** Seconds the vendor asked us to wait (Retry-After header), if any. */
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Shared helper: classify an HTTP status into retryable / not retryable. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
