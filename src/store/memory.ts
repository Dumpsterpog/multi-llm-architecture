/**
 * In-memory Store for local development and tests. Mirrors the Postgres
 * behaviour closely enough to build the website against it with zero setup.
 * State is lost on restart.
 */
import { createHash, randomUUID } from "node:crypto";
import type { PlanId } from "../config/plans.js";
import type { Conversation, ConversationSummary, Principal, RequestRecord, Store, StoredMessage } from "./types.js";

export class MemoryStore implements Store {
  private apiKeys = new Map<string, Principal>();
  private webUsers = new Map<string, Principal>();
  private conversations = new Map<string, Conversation & { userId: string | null; orgId: string; deleted: boolean }>();
  readonly requests: RequestRecord[] = [];

  /** Register a raw API key (dev bootstrap / tests). */
  addApiKey(rawKey: string, plan: PlanId, orgId = "org_dev"): void {
    const hash = createHash("sha256").update(rawKey).digest("hex");
    this.apiKeys.set(hash, { kind: "api_key", orgId, userId: null, apiKeyId: `key_${hash.slice(0, 8)}`, plan, limitOverrides: null });
  }

  async findApiKeyByHash(hash: string): Promise<Principal | null> {
    return this.apiKeys.get(hash) ?? null;
  }

  async upsertWebUser(externalId: string): Promise<Principal> {
    let p = this.webUsers.get(externalId);
    if (!p) {
      const userId = randomUUID();
      p = { kind: "web_user", orgId: `org_${userId}`, userId, apiKeyId: null, plan: "free", limitOverrides: null };
      this.webUsers.set(externalId, p);
    }
    return p;
  }

  /** Test helper: change a web user's plan (what the payment webhook would do). */
  setWebUserPlan(externalId: string, plan: PlanId): void {
    const p = this.webUsers.get(externalId);
    if (p) p.plan = plan;
  }

  async createConversation(p: Principal, title: string): Promise<string> {
    const id = randomUUID();
    this.conversations.set(id, {
      id,
      title,
      updatedAt: new Date().toISOString(),
      messages: [],
      userId: p.userId,
      orgId: p.orgId,
      deleted: false,
    });
    return id;
  }

  private owned(id: string, p: Principal) {
    const c = this.conversations.get(id);
    // Ownership check: a user can only ever see their own conversations.
    if (!c || c.deleted || c.orgId !== p.orgId || (p.userId && c.userId !== p.userId)) return null;
    return c;
  }

  async getConversation(id: string, p: Principal): Promise<Conversation | null> {
    const c = this.owned(id, p);
    return c ? { id: c.id, title: c.title, updatedAt: c.updatedAt, messages: [...c.messages] } : null;
  }

  async listConversations(p: Principal, limit: number, before?: string): Promise<ConversationSummary[]> {
    return [...this.conversations.values()]
      .filter((c) => this.owned(c.id, p) && (!before || c.updatedAt < before))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  }

  async deleteConversation(id: string, p: Principal): Promise<boolean> {
    const c = this.owned(id, p);
    if (!c) return false;
    c.deleted = true;
    return true;
  }

  async appendMessages(conversationId: string, messages: StoredMessage[]): Promise<void> {
    const c = this.conversations.get(conversationId);
    if (!c) return;
    const now = new Date().toISOString();
    c.messages.push(...messages.map((m) => ({ ...m, createdAt: now })));
    c.updatedAt = now;
  }

  async recordRequest(r: RequestRecord): Promise<void> {
    this.requests.push(r);
  }

  async usageSince(orgId: string, since: Date) {
    const rows = this.requests.filter((r) => r.principal.orgId === orgId);
    void since; // memory store keeps everything; fine for dev
    return {
      requests: rows.length,
      inputTokens: rows.reduce((s, r) => s + r.inputTokens, 0),
      outputTokens: rows.reduce((s, r) => s + r.outputTokens, 0),
      priceMicros: rows.reduce((s, r) => s + r.priceMicros, 0),
    };
  }

  async ping() {
    return true;
  }
  async close() {}
}
