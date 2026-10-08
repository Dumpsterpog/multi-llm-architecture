/**
 * RESILIENCE: retries, timeouts and circuit breakers.
 *
 * Calling three vendors per request means three times the chance that
 * something is down or rate-limited at any moment. This layer makes model
 * calls survivable:
 *
 *  - TIMEOUT: every call has a hard deadline. A hung vendor must not hold a
 *    user's request (and a concurrency slot) forever.
 *
 *  - RETRY with exponential backoff + jitter: transient errors (429, 5xx,
 *    network blips) are retried a few times. Jitter spreads retries out so
 *    thousands of clients don't all retry at the same millisecond.
 *
 *  - CIRCUIT BREAKER (per model): if a model fails N times in a row we stop
 *    calling it for a cool-down period and fail fast instead. During a vendor
 *    outage this saves latency and money, and the orchestrator simply
 *    continues with the models that are healthy.
 */
import { ProviderError, type CompletionRequest, type CompletionResult, type LLMProvider } from "./types.js";

export interface ResilienceOptions {
  timeoutMs: number;
  maxRetries: number;
  /** First backoff delay; doubles each attempt. */
  baseDelayMs?: number;
  /** Consecutive failures that open the breaker. */
  breakerThreshold?: number;
  /** How long the breaker stays open before letting a trial call through. */
  breakerCooldownMs?: number;
}

type BreakerState = { failures: number; openUntil: number };

export class CircuitOpenError extends Error {
  constructor(readonly modelId: string) {
    super(`circuit open for model ${modelId}`);
    this.name = "CircuitOpenError";
  }
}

/**
 * Per-process breaker state. In a multi-instance deployment each instance
 * learns independently, which is fine (and simpler) for breakers. A shared
 * Redis-backed breaker is a later optimisation.
 */
export class ResilientCaller {
  private readonly breakers = new Map<string, BreakerState>();
  private readonly baseDelayMs: number;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;

  constructor(private readonly opts: ResilienceOptions) {
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.breakerThreshold = opts.breakerThreshold ?? 5;
    this.breakerCooldownMs = opts.breakerCooldownMs ?? 30_000;
  }

  /** True if the model is currently believed healthy. Used to skip dead models up front. */
  isAvailable(modelId: string): boolean {
    const b = this.breakers.get(modelId);
    return !b || b.openUntil <= Date.now();
  }

  /**
   * `override` lets one call use a shorter timeout / fewer retries than the
   * default. The supervisor uses it: a slow routing decision is worse than a
   * quick fallback to the heuristic.
   */
  async call(
    provider: LLMProvider,
    req: CompletionRequest,
    override: { timeoutMs?: number; maxRetries?: number } = {},
  ): Promise<CompletionResult> {
    const modelId = req.model.id;
    const timeoutMs = override.timeoutMs ?? this.opts.timeoutMs;
    const maxRetries = override.maxRetries ?? this.opts.maxRetries;
    if (!this.isAvailable(modelId)) throw new CircuitOpenError(modelId);

    let attempt = 0;
    for (;;) {
      // Combine the caller's signal (client disconnect / budget stop) with
      // our per-attempt timeout. Whichever fires first aborts the fetch.
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      try {
        const result = await provider.complete({ ...req, signal });
        this.breakers.delete(modelId); // success closes the breaker
        return result;
      } catch (err) {
        const retryable = err instanceof ProviderError ? err.retryable : false;
        const callerAborted = req.signal?.aborted ?? false;
        if (!retryable || callerAborted || attempt >= maxRetries) {
          this.recordFailure(modelId, err);
          throw err;
        }
        // Honour the vendor's Retry-After when given, else exponential backoff with full jitter.
        const hinted = err instanceof ProviderError && err.retryAfterSec ? err.retryAfterSec * 1000 : 0;
        const backoff = Math.random() * this.baseDelayMs * 2 ** attempt;
        await sleep(Math.max(hinted, backoff), req.signal);
        attempt++;
      }
    }
  }

  private recordFailure(modelId: string, err: unknown): void {
    // Client errors (400, 401...) mean OUR request was bad, not that the model
    // is down, so they don't count toward opening the breaker.
    if (err instanceof ProviderError && err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
      return;
    }
    const b = this.breakers.get(modelId) ?? { failures: 0, openUntil: 0 };
    b.failures++;
    if (b.failures >= this.breakerThreshold) {
      b.openUntil = Date.now() + this.breakerCooldownMs;
      b.failures = 0;
    }
    this.breakers.set(modelId, b);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
