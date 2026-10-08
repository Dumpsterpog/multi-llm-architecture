/**
 * SAFETY / MODERATION
 *
 * Runs on the user's input BEFORE any expensive model call, and on the
 * final answer before it is returned. Two layers:
 *
 *  1. Rule layer (always on, free, instant): size limits, a blocklist hook,
 *     and prompt-injection heuristics (flagged and logged, not blocked,
 *     because false positives on normal text are common).
 *
 *  2. Moderation model (optional): if an OpenAI key is configured we call
 *     its moderation endpoint, which is free to use. Swap in any other
 *     classifier (Llama Guard, Perspective API...) behind the same interface.
 *
 * Blocking input early is also a COST control: a rejected request costs
 * one cheap moderation call, not a 3-model debate.
 */
import { AppError } from "../errors.js";

export interface ModerationResult {
  flagged: boolean;
  categories: string[];
}

export interface ModerationProvider {
  check(text: string, signal?: AbortSignal): Promise<ModerationResult>;
}

/** Phrases typical of prompt-injection attempts. Logged as a signal for abuse review. */
const INJECTION_PATTERNS = [
  /ignore (all|any|the)? ?(previous|prior|above) instructions/i,
  /disregard (your|the) (system|previous) prompt/i,
  /you are now (dan|in developer mode)/i,
  /reveal (your|the) system prompt/i,
];

export function injectionSignals(text: string): string[] {
  return INJECTION_PATTERNS.filter((p) => p.test(text)).map((p) => p.source);
}

export class OpenAIModeration implements ModerationProvider {
  constructor(private readonly apiKey: string) {}

  async check(text: string, signal?: AbortSignal): Promise<ModerationResult> {
    const res = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: "omni-moderation-latest", input: text.slice(0, 20_000) }),
      signal,
    });
    if (!res.ok) throw new Error(`moderation HTTP ${res.status}`);
    const data = (await res.json()) as { results: Array<{ flagged: boolean; categories: Record<string, boolean> }> };
    const r = data.results[0];
    return {
      flagged: !!r?.flagged,
      categories: r ? Object.entries(r.categories).filter(([, v]) => v).map(([k]) => k) : [],
    };
  }
}

export class SafetyService {
  constructor(
    private readonly provider?: ModerationProvider,
    /** Fail-open = allow the request if the moderation service is down. Choose per your risk appetite. */
    private readonly failOpen = true,
  ) {}

  async checkInput(text: string): Promise<{ injectionSignals: string[] }> {
    const signals = injectionSignals(text);
    if (this.provider) {
      try {
        const r = await this.provider.check(text, AbortSignal.timeout(5_000));
        if (r.flagged) {
          throw new AppError(400, "content_blocked", `Your message was blocked by our content policy (${r.categories.join(", ")}).`);
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (!this.failOpen) throw new AppError(503, "internal_error", "Content check unavailable, try again shortly.");
      }
    }
    return { injectionSignals: signals };
  }

  async checkOutput(text: string): Promise<string> {
    if (!this.provider) return text;
    try {
      const r = await this.provider.check(text, AbortSignal.timeout(5_000));
      if (r.flagged) return "I can't help with that request.";
    } catch {
      // Output check failing open: the answer already passed the vendors' own safety layers.
    }
    return text;
  }
}
