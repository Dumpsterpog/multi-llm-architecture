/**
 * PERSISTENT STORE INTERFACE (Postgres in production, memory in dev)
 *
 * Everything that must survive restarts lives behind this interface:
 * users, API keys, conversations (for the chat website), and the request
 * ledger (for billing and analytics). See db/schema.sql for the tables.
 */
import type { PlanId, PlanLimits } from "../config/plans.js";
import type { CallRecord } from "../orchestrator/types.js";
import type { Role } from "../providers/types.js";

/** Who is making the request, after authentication. */
export interface Principal {
  kind: "api_key" | "web_user";
  orgId: string;
  userId: string | null;
  apiKeyId: string | null;
  plan: PlanId;
  limitOverrides: Partial<PlanLimits> | null;
}

export interface StoredMessage {
  role: Role;
  content: string;
  createdAt?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface Conversation extends ConversationSummary {
  messages: StoredMessage[];
}

export interface RequestRecord {
  id: string;
  principal: Principal;
  conversationId: string | null;
  strategy: string;
  status: "ok" | "error";
  errorType?: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  priceMicros: number;
  latencyMs: number;
  cacheHit: boolean;
  promptVersion: string;
  calls: CallRecord[];
}

export interface Store {
  findApiKeyByHash(hash: string): Promise<Principal | null>;
  /** First login creates the user and a personal org on the free plan. */
  upsertWebUser(externalId: string, email: string | null): Promise<Principal>;

  createConversation(p: Principal, title: string): Promise<string>;
  getConversation(id: string, p: Principal): Promise<Conversation | null>;
  listConversations(p: Principal, limit: number, before?: string): Promise<ConversationSummary[]>;
  deleteConversation(id: string, p: Principal): Promise<boolean>;
  appendMessages(conversationId: string, messages: StoredMessage[], requestId: string): Promise<void>;

  /** Writes request + model calls + ledger row atomically (one transaction). */
  recordRequest(r: RequestRecord): Promise<void>;
  usageSince(orgId: string, since: Date): Promise<{ requests: number; inputTokens: number; outputTokens: number; priceMicros: number }>;

  ping(): Promise<boolean>;
  close(): Promise<void>;
}
