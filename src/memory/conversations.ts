/**
 * CONVERSATION MEMORY for the chat website.
 *
 * LLMs are stateless: to "remember" a chat, we re-send the history on every
 * turn. That's why long chats get expensive: turn 40 pays for turns 1-39
 * again, times every model in the ensemble.
 *
 * trimHistory() keeps the newest messages that fit in the plan's
 * `maxHistoryTokens`, always keeping the latest user message. This one
 * function is the biggest cost control in a ChatGPT-style product.
 *
 * Upgrade path (docs section 13): instead of dropping old turns, replace
 * them with a running summary written by a cheap model, so the chat
 * "remembers" the gist at a fraction of the tokens.
 */
import { estimateTokens } from "../billing/tokenizer.js";
import { AppError } from "../errors.js";
import type { ChatMessage } from "../providers/types.js";

export function trimHistory(messages: ChatMessage[], maxHistoryTokens: number, maxInputTokens: number): {
  messages: ChatMessage[];
  dropped: number;
} {
  const system = messages.filter((m) => m.role === "system");
  const turns = messages.filter((m) => m.role !== "system");
  const last = turns[turns.length - 1];
  if (!last || last.role !== "user") {
    throw new AppError(400, "invalid_request", "The last message must be from the user.");
  }

  const lastTokens = estimateTokens(last.content);
  if (lastTokens > maxInputTokens) {
    throw new AppError(
      413,
      "context_length_exceeded",
      `Your message is ~${lastTokens} tokens; your plan allows ${maxInputTokens} per message.`,
    );
  }

  // Walk backwards from the newest turn, keeping turns while they fit.
  const budget = Math.min(maxHistoryTokens, maxInputTokens);
  let used = system.reduce((s, m) => s + estimateTokens(m.content), 0) + lastTokens;
  const kept: ChatMessage[] = [last];
  for (let i = turns.length - 2; i >= 0; i--) {
    const t = estimateTokens(turns[i]!.content);
    if (used + t > budget) break;
    used += t;
    kept.unshift(turns[i]!);
  }
  // Conversations must start with a user turn for some vendors.
  while (kept.length > 1 && kept[0]!.role !== "user") kept.shift();

  return { messages: [...system, ...kept], dropped: turns.length - kept.length };
}

/** Sidebar title from the first message (a cheap model could write a nicer one later). */
export function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine || "New chat";
}
