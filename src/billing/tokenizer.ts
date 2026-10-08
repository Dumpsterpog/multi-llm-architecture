/**
 * TOKEN ESTIMATION
 *
 * A "token" is the unit LLMs read and write: roughly 3 to 4 characters of
 * English, or about 0.75 words. Vendors bill per token, and context windows
 * and limits are measured in tokens, so tokens are the currency of this
 * whole platform.
 *
 * There are two kinds of token count, and both matter:
 *
 *  - ESTIMATED (this file): computed by us BEFORE a call, to decide if a
 *    request fits the context window, the rate limit and the budget.
 *    It must be fast and slightly pessimistic (over-estimate, never under).
 *
 *  - ACTUAL: reported by the vendor AFTER the call (CompletionResult.usage).
 *    This is what we bill on. Estimates are reconciled against it.
 *
 * Each vendor uses a different tokenizer, so an exact pre-count would need
 * three tokenizer libraries (or the vendors' count-tokens endpoints). A
 * conservative character-based heuristic is the industry-standard first
 * version; swap in exact tokenizers per provider later if margins need it.
 */
import type { ChatMessage } from "../providers/types.js";

/** ~3.5 chars per token is slightly pessimistic for English, which is what we want. */
const CHARS_PER_TOKEN = 3.5;
/** Each message carries some formatting overhead (role markers etc.). */
const PER_MESSAGE_OVERHEAD = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + PER_MESSAGE_OVERHEAD, 0);
}
