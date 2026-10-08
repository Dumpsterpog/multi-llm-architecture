/**
 * Mock provider: a fake LLM for local development and tests.
 *
 * It returns deterministic text and realistic-looking token counts so the
 * full pipeline (rate limits, budgets, billing, debate rounds, synthesis)
 * can be exercised offline and for free. It also understands the special
 * markers our orchestration prompts use, so debate/critique behave sensibly.
 *
 * Tip: send a prompt containing "[[fail:mock-beta]]" to make that model throw,
 * which is how the tests check partial-failure handling.
 */
import { estimateTokens } from "../billing/tokenizer.js";
import { heuristicDecision } from "../orchestrator/supervisor.js";
import { ProviderError, type CompletionRequest, type CompletionResult, type LLMProvider } from "./types.js";

export class MockProvider implements LLMProvider {
  readonly name = "mock" as const;

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const all = req.messages.map((m) => m.content).join("\n");
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";

    if (all.includes(`[[fail:${req.model.id}]]`)) {
      throw new ProviderError(`mock forced failure for ${req.model.id}`, this.name, 503, false);
    }
    if (req.signal?.aborted) {
      throw new ProviderError("mock aborted", this.name, undefined, false);
    }

    let text: string;
    const routing = lastUser.match(/<routing_request>\n([\s\S]*)\n<\/routing_request>/);
    if (routing) {
      // Acting as the SUPERVISOR: decide with the same keyword rules the real
      // fallback uses, so routing in dev behaves like it will with Gemini.
      const d = heuristicDecision([{ role: "user", content: routing[1]! }]);
      text = JSON.stringify({ route: d.route, category: d.category, complexity: d.complexity, reason: `mock supervisor: ${d.reason}` });
    } else if (lastUser.includes("Classify the request")) {
      text = '{"category":"general","complexity":"medium"}';
    } else if (lastUser.includes("NO_ISSUES")) {
      // Critique prompt: mock reviewers are easy to please.
      text = "NO_ISSUES";
    } else if (lastUser.includes("<candidate_answers>")) {
      text = `[${req.model.displayName} synthesis] Combined answer drawing on all candidates.`;
    } else if (lastUser.includes("<other_answers>")) {
      text = `[${req.model.displayName} revised] I considered the other answers and refined mine.\nCHANGED: no`;
    } else {
      text = `[${req.model.displayName}] Answer to: ${lastUser.slice(0, 80)}`;
    }

    // Respect the output cap like a real model would.
    const outTokens = Math.min(estimateTokens(text), req.maxOutputTokens);
    return {
      modelId: req.model.id,
      provider: this.name,
      text,
      usage: { inputTokens: estimateTokens(all), outputTokens: outTokens },
      finishReason: "stop",
      latencyMs: Date.now() - started,
    };
  }
}
