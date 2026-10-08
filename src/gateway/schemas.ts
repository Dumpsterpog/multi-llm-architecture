/**
 * Request validation. Every byte from the internet is untrusted until it
 * passes these schemas: types, lengths and ranges are all bounded here, so
 * the rest of the code can rely on them.
 */
import { z } from "zod";

const Message = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1).max(400_000),
});

export const ChatBody = z
  .object({
    // --- Website mode: send just the new message (+ conversation_id to continue a chat).
    message: z.string().min(1).max(400_000).optional(),
    conversation_id: z.string().uuid().optional(),

    // --- API mode: send the full message list yourself (stateless, like the vendor APIs).
    messages: z.array(Message).min(1).max(500).optional(),

    // --- Orchestration options (all optional; the plan decides the defaults).
    strategy: z.enum(["auto", "router", "parallel", "debate", "critique"]).optional(),
    models: z.array(z.string().max(64)).min(1).max(8).optional(),
    aggregator: z.string().max(64).optional(),
    rounds: z.number().int().min(1).max(10).optional(),
    max_output_tokens: z.number().int().min(16).max(100_000).optional(),
    /** Client-side spend cap for this one request (can only LOWER the plan cap). */
    max_cost_usd: z.number().positive().max(100).optional(),
    temperature: z.number().min(0).max(2).optional(),

    stream: z.boolean().default(false),
    /** Return each model's individual answer (for a "show how they debated" UI). */
    include_trace: z.boolean().default(false),
  })
  .refine((b) => !!b.message !== !!b.messages, {
    message: 'Send either "message" (website mode) or "messages" (API mode), not both.',
  })
  .refine((b) => !(b.messages && b.conversation_id), {
    message: '"conversation_id" only works with "message".',
  });

export type ChatBodyT = z.infer<typeof ChatBody>;

export const ListConversationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.string().datetime().optional(),
});

export const DevTokenBody = z.object({
  user_id: z.string().min(1).max(128).default("dev-user"),
  email: z.string().email().optional(),
});
