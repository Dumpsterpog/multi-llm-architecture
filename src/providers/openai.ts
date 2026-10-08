/**
 * OpenAI (GPT) adapter. Chat Completions API: POST /v1/chat/completions
 * Docs: https://platform.openai.com/docs/api-reference/chat
 *
 * Quirks handled here:
 *  - system prompt is just a message with role "system"
 *  - newer models take `max_completion_tokens` (not `max_tokens`)
 *  - usage is `prompt_tokens` / `completion_tokens`
 *
 * The same adapter works for any OpenAI-compatible server (Azure OpenAI,
 * vLLM, Together, Groq, a self-hosted Llama...) by changing `baseUrl`.
 * That is the cheapest way to add open-source models later.
 */
import { postJson } from "./http.js";
import type { CompletionRequest, CompletionResult, FinishReason, LLMProvider } from "./types.js";

interface OpenAIResponse {
  choices: Array<{ message: { content: string | null }; finish_reason: string }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai" as const;
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const data = await postJson<OpenAIResponse>(
      this.name,
      `${this.baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: req.model.providerModelId,
        messages: req.messages,
        max_completion_tokens: req.maxOutputTokens,
        // Some reasoning models reject a custom temperature; only send it when set.
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      },
      req.signal,
    );

    const choice = data.choices[0];
    const finishReason: FinishReason =
      choice?.finish_reason === "stop"
        ? "stop"
        : choice?.finish_reason === "length"
          ? "length"
          : choice?.finish_reason === "content_filter"
            ? "content_filter"
            : "other";

    return {
      modelId: req.model.id,
      provider: this.name,
      text: choice?.message.content ?? "",
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
        cachedInputTokens: data.usage.prompt_tokens_details?.cached_tokens,
      },
      finishReason,
      latencyMs: Date.now() - started,
    };
  }
}
