/**
 * RESPONSE CACHE (exact match)
 *
 * If the same stateless question arrives again with the same settings, serve
 * the stored answer: zero model calls, zero cost, instant. FAQ-style traffic
 * ("what is photosynthesis?") repeats a lot on consumer chat sites.
 *
 * Only cached when it is safe:
 *  - NOT part of a conversation (history makes every request unique, and
 *    one user's context must never leak into another user's answer)
 *  - temperature is 0 or unset (deterministic intent)
 *
 * The key includes the prompt version, so changing orchestration prompts
 * naturally invalidates old answers.
 *
 * Next step: a SEMANTIC cache (embed the question, reuse answers to
 * near-identical questions above a similarity threshold, via pgvector).
 */
import { createHash } from "node:crypto";
import type { KV } from "../kv/types.js";
import type { ChatMessage } from "../providers/types.js";
import { PROMPT_VERSION } from "../orchestrator/prompts.js";

export interface CachedAnswer {
  answer: string;
  strategy: string;
  contributors: string[];
}

export class ResponseCache {
  constructor(
    private readonly kv: KV,
    private readonly ttlSec: number,
  ) {}

  key(parts: { strategy: string; models: string[]; messages: ChatMessage[]; maxOutputTokens: number }): string {
    const h = createHash("sha256")
      .update(JSON.stringify({ v: PROMPT_VERSION, ...parts, models: [...parts.models].sort() }))
      .digest("hex");
    return `cache:resp:${h}`;
  }

  async get(key: string): Promise<CachedAnswer | null> {
    if (this.ttlSec === 0) return null;
    const raw = await this.kv.getString(key);
    return raw ? (JSON.parse(raw) as CachedAnswer) : null;
  }

  async set(key: string, value: CachedAnswer): Promise<void> {
    if (this.ttlSec === 0) return;
    await this.kv.setString(key, JSON.stringify(value), this.ttlSec);
  }
}
