/**
 * Shared types for the orchestration layer.
 */
import type { ModelSpec, TaskCategory } from "../config/models.js";
import type { Strategy } from "../config/plans.js";
import type { ChatMessage, CompletionResult, FinishReason, ProviderName, TokenUsage } from "../providers/types.js";
import type { Budget } from "./budget.js";

/** Strategies after "auto" has been resolved into a concrete choice. */
export type ConcreteStrategy = Exclude<Strategy, "auto">;

/** One model call, as recorded for logs, billing and the optional trace. */
export interface CallRecord {
  stage: string; // "answer" | "revise" | "synthesize" | "critique" | "refine" | "classify" | "draft"
  round: number;
  modelId: string;
  provider: ProviderName;
  ok: boolean;
  error?: string;
  usage?: TokenUsage;
  costMicros: number;
  latencyMs: number;
  finishReason?: FinishReason;
  /** The model's text. Kept so `include_trace` can show each model's view. */
  text?: string;
}

/**
 * Progress events, streamed to the client over SSE when `stream: true`.
 * This is what lets a UI show "Claude is answering... GPT done... synthesising".
 */
export type OrchestrationEvent =
  | {
      type: "supervisor";
      route: "direct" | "lite" | "standard" | "max";
      category: string;
      complexity: string;
      reason: string;
      decidedBy: string;
    }
  | { type: "strategy"; strategy: ConcreteStrategy; models: string[]; aggregator: string }
  | { type: "stage"; stage: string; round: number }
  | { type: "model_start"; stage: string; round: number; modelId: string }
  | { type: "model_done"; stage: string; round: number; modelId: string; ok: boolean; latencyMs: number; outputTokens?: number; error?: string }
  | { type: "budget_stop"; reason: string }
  | { type: "consensus"; round: number };

export interface CallOptions {
  stage: string;
  round: number;
  maxOutputTokens: number;
  temperature?: number;
  /** Per-call overrides of the provider timeout / retry defaults. */
  timeoutMs?: number;
  maxRetries?: number;
}

/** The only way strategies talk to models. Handles budget, retries, events and recording. */
export interface ModelCaller {
  call(model: ModelSpec, messages: ChatMessage[], opts: CallOptions): Promise<CompletionResult>;
}

export interface RunContext {
  requestId: string;
  budget: Budget;
  caller: ModelCaller;
  emit: (e: OrchestrationEvent) => void;
}

export interface StrategyInput {
  /** Full conversation, ending with the user's latest message. */
  messages: ChatMessage[];
  /** The models taking part (or, for router, the pool to choose from). */
  ensemble: ModelSpec[];
  /** Model that merges candidates into the final answer. */
  aggregator: ModelSpec;
  /** Cheap model used for classification decisions. */
  classifier: ModelSpec;
  /** Debate rounds / critique cycles. */
  rounds: number;
  maxOutputTokens: number;
  temperature?: number;
  /** Already known (from the supervisor): the router skips its own classifier call. */
  classification?: { category: TaskCategory; complexity: "simple" | "medium" | "complex" };
}

export interface Candidate {
  model: ModelSpec;
  text: string;
}

export interface StrategyOutput {
  answer: string;
  finishReason: FinishReason;
  /** How many rounds actually ran (debate may stop early on consensus or budget). */
  roundsCompleted: number;
  /** Which models contributed to the final answer. */
  contributors: string[];
  /** Human-readable notes, e.g. "beta failed, continued with 2 models". */
  notes: string[];
}
