/**
 * Google (Gemini) adapter. Generative Language API: models/{id}:generateContent
 * Docs: https://ai.google.dev/api/generate-content
 *
 * Quirks handled here:
 *  - roles are "user" and "model" (not "assistant")
 *  - messages are `contents[].parts[].text`
 *  - system prompt goes in `systemInstruction`
 *  - usage is `usageMetadata.promptTokenCount` / `candidatesTokenCount`
 */
import { postJson, splitSystem } from "./http.js";
import type { CompletionRequest, CompletionResult, FinishReason, LLMProvider } from "./types.js";

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

export class GoogleProvider implements LLMProvider {
  readonly name = "google" as const;
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta",
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const { system, rest } = splitSystem(req.messages);
    const data = await postJson<GeminiResponse>(
      this.name,
      `${this.baseUrl}/models/${encodeURIComponent(req.model.providerModelId)}:generateContent`,
      { "x-goog-api-key": this.apiKey },
      {
        contents: rest.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: {
          maxOutputTokens: req.maxOutputTokens,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        },
      },
      req.signal,
    );

    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    const fr = cand?.finishReason;
    const finishReason: FinishReason =
      fr === "STOP" ? "stop" : fr === "MAX_TOKENS" ? "length" : fr === "SAFETY" ? "content_filter" : "other";

    const u = data.usageMetadata ?? {};
    return {
      modelId: req.model.id,
      provider: this.name,
      text,
      usage: {
        inputTokens: u.promptTokenCount ?? 0,
        // "Thinking" tokens are billed as output, so count them as output.
        outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
        cachedInputTokens: u.cachedContentTokenCount,
      },
      finishReason,
      latencyMs: Date.now() - started,
    };
  }
}
