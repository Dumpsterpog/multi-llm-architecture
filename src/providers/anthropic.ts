/**
 * Anthropic (Claude) adapter. Messages API: POST /v1/messages
 * Docs: https://docs.anthropic.com/en/api/messages
 *
 * Quirks handled here:
 *  - system prompt is a top-level `system` field, not a message
 *  - `max_tokens` is REQUIRED
 *  - usage is `input_tokens` / `output_tokens`
 */
import { postJson, splitSystem } from "./http.js";
import type { CompletionRequest, CompletionResult, FinishReason, LLMProvider } from "./types.js";

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.anthropic.com",
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const { system, rest } = splitSystem(req.messages);
    const data = await postJson<AnthropicResponse>(
      this.name,
      `${this.baseUrl}/v1/messages`,
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      {
        model: req.model.providerModelId,
        max_tokens: req.maxOutputTokens,
        temperature: req.temperature,
        system,
        messages: rest.map((m) => ({ role: m.role, content: m.content })),
      },
      req.signal,
    );

    const text = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const finishReason: FinishReason =
      data.stop_reason === "end_turn" || data.stop_reason === "stop_sequence"
        ? "stop"
        : data.stop_reason === "max_tokens"
          ? "length"
          : data.stop_reason === "refusal"
            ? "content_filter"
            : "other";

    return {
      modelId: req.model.id,
      provider: this.name,
      text,
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
        cachedInputTokens: data.usage.cache_read_input_tokens,
      },
      finishReason,
      latencyMs: Date.now() - started,
    };
  }
}
