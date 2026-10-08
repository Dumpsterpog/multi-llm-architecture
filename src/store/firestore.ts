/**
 * Firestore implementation of Store.
 *
 * COLLECTIONS (all prefixed with FIRESTORE_COLLECTION_PREFIX, default "llm_",
 * so they can live in the same Firebase project as another app):
 *
 *   llm_orgs/{orgId}                    billing unit: { name, plan, limitOverrides }
 *                                       a website user's personal org id = their Firebase uid
 *   llm_users/{firebaseUid}             { orgId, email, createdAt }
 *   llm_apiKeys/{sha256(key)}           developer keys, doc id is the HASH (raw key never stored)
 *   llm_conversations/{id}              { orgId, userId, title, createdAt, updatedAt, deleted }
 *     └─ messages/{autoId}              { role, content, requestId, seq, createdAt }
 *   llm_requests/{requestId}            one doc per chat request: tokens, cost, price,
 *                                       strategy, and the list of model calls (no text)
 *   llm_ledger/{requestId}_usage        append-only billing rows (doc id makes writes idempotent)
 *
 * Indexes needed: firestore.indexes.json. Security rules: firestore.rules
 * (browsers must NOT read these collections directly; only this server does,
 * through the Admin SDK).
 *
 * Firestore COST NOTE: you pay per document read/write. One chat message
 * here costs roughly: 2 reads (user + org, cached 30s), 1 read per history
 * message loaded, ~4 writes (2 messages, conversation, request, ledger).
 * That's a fraction of a cent, tiny next to the AI model cost.
 */
import { AggregateField, FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import type { PlanId, PlanLimits } from "../config/plans.js";
import type { Conversation, ConversationSummary, Principal, RequestRecord, Store, StoredMessage } from "./types.js";

interface OrgDoc {
  name: string;
  plan: PlanId;
  limitOverrides?: Partial<PlanLimits> | null;
}

/** Short in-process cache so every message doesn't re-read the user and org docs. */
const PRINCIPAL_CACHE_MS = 30_000;

export class FirestoreStore implements Store {
  private readonly principalCache = new Map<string, { p: Principal; at: number }>();

  constructor(
    private readonly db: Firestore,
    private readonly prefix: string,
  ) {}

  private col(name: string) {
    return this.db.collection(`${this.prefix}${name}`);
  }

  private cached(key: string): Principal | undefined {
    const hit = this.principalCache.get(key);
    if (hit && Date.now() - hit.at < PRINCIPAL_CACHE_MS) return hit.p;
    return undefined;
  }

  async findApiKeyByHash(hash: string): Promise<Principal | null> {
    const hit = this.cached(`key:${hash}`);
    if (hit) return hit;

    const keySnap = await this.col("apiKeys").doc(hash).get();
    const key = keySnap.data() as { orgId: string; userId?: string | null; revokedAt?: Timestamp | null } | undefined;
    if (!key || key.revokedAt) return null;

    const org = (await this.col("orgs").doc(key.orgId).get()).data() as OrgDoc | undefined;
    if (!org) return null;

    // Fire-and-forget: informational only, must not slow the request.
    keySnap.ref.update({ lastUsedAt: FieldValue.serverTimestamp() }).catch(() => {});

    const p: Principal = {
      kind: "api_key",
      orgId: key.orgId,
      userId: key.userId ?? null,
      apiKeyId: hash.slice(0, 16),
      plan: org.plan,
      limitOverrides: org.limitOverrides ?? null,
    };
    this.principalCache.set(`key:${hash}`, { p, at: Date.now() });
    return p;
  }

  async upsertWebUser(uid: string, email: string | null): Promise<Principal> {
    const hit = this.cached(`user:${uid}`);
    if (hit) return hit;

    const userRef = this.col("users").doc(uid);
    // Transaction: two first requests arriving at once must not create two orgs.
    const p = await this.db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (userSnap.exists) {
        const orgId = (userSnap.data() as { orgId: string }).orgId;
        const org = (await tx.get(this.col("orgs").doc(orgId))).data() as OrgDoc | undefined;
        return {
          kind: "web_user",
          orgId,
          userId: uid,
          apiKeyId: null,
          plan: org?.plan ?? "free",
          limitOverrides: org?.limitOverrides ?? null,
        } satisfies Principal;
      }
      // First login: personal org (id = uid) on the free plan.
      const now = FieldValue.serverTimestamp();
      tx.set(this.col("orgs").doc(uid), { name: email ?? uid, plan: "free", limitOverrides: null, createdAt: now });
      tx.set(userRef, { orgId: uid, email, createdAt: now });
      return { kind: "web_user", orgId: uid, userId: uid, apiKeyId: null, plan: "free", limitOverrides: null } satisfies Principal;
    });

    this.principalCache.set(`user:${uid}`, { p, at: Date.now() });
    return p;
  }

  async createConversation(p: Principal, title: string): Promise<string> {
    const now = Timestamp.now();
    const ref = await this.col("conversations").add({
      orgId: p.orgId,
      userId: p.userId,
      title,
      createdAt: now,
      updatedAt: now,
      deleted: false,
    });
    return ref.id;
  }

  /** Ownership check. A user can only ever reach their own conversations. */
  private async owned(id: string, p: Principal) {
    // Reject ids Firestore can't take as a doc id ("..", slashes...) before touching the DB.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    const snap = await this.col("conversations").doc(id).get();
    const c = snap.data() as { orgId: string; userId: string | null; title: string; updatedAt: Timestamp; deleted: boolean } | undefined;
    if (!c || c.deleted || c.orgId !== p.orgId || (p.userId && c.userId !== p.userId)) return null;
    return { ref: snap.ref, data: c };
  }

  async getConversation(id: string, p: Principal): Promise<Conversation | null> {
    const c = await this.owned(id, p);
    if (!c) return null;
    const msgs = await c.ref.collection("messages").orderBy("seq").get();
    return {
      id,
      title: c.data.title,
      updatedAt: c.data.updatedAt.toDate().toISOString(),
      messages: msgs.docs.map((d) => {
        const m = d.data() as { role: StoredMessage["role"]; content: string; createdAt: Timestamp };
        return { role: m.role, content: m.content, createdAt: m.createdAt.toDate().toISOString() };
      }),
    };
  }

  async listConversations(p: Principal, limit: number, before?: string): Promise<ConversationSummary[]> {
    // Website users list their own chats; API-key callers list their org's.
    let q = p.userId
      ? this.col("conversations").where("userId", "==", p.userId)
      : this.col("conversations").where("orgId", "==", p.orgId);
    q = q.where("deleted", "==", false).orderBy("updatedAt", "desc");
    if (before) q = q.where("updatedAt", "<", Timestamp.fromDate(new Date(before)));
    const snap = await q.limit(limit).get();
    return snap.docs.map((d) => {
      const c = d.data() as { title: string; updatedAt: Timestamp };
      return { id: d.id, title: c.title, updatedAt: c.updatedAt.toDate().toISOString() };
    });
  }

  async deleteConversation(id: string, p: Principal): Promise<boolean> {
    const c = await this.owned(id, p);
    if (!c) return false;
    // Soft delete. A scheduled job hard-deletes after the plan's retention period.
    await c.ref.update({ deleted: true, deletedAt: FieldValue.serverTimestamp() });
    return true;
  }

  async appendMessages(conversationId: string, messages: StoredMessage[], requestId: string): Promise<void> {
    const conv = this.col("conversations").doc(conversationId);
    const batch = this.db.batch(); // all-or-nothing: never save a question without its answer
    const base = Date.now() * 10; // seq keeps order even for writes in the same millisecond
    messages.forEach((m, i) => {
      batch.set(conv.collection("messages").doc(), {
        role: m.role,
        content: m.content,
        requestId,
        seq: base + i,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    batch.update(conv, { updatedAt: Timestamp.now() });
    await batch.commit();
  }

  async recordRequest(r: RequestRecord): Promise<void> {
    const batch = this.db.batch();
    const createdAt = FieldValue.serverTimestamp();
    batch.set(this.col("requests").doc(r.id), {
      orgId: r.principal.orgId,
      userId: r.principal.userId,
      apiKeyId: r.principal.apiKeyId,
      conversationId: r.conversationId,
      strategy: r.strategy,
      status: r.status,
      errorType: r.errorType ?? null,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costMicros: r.costMicros,
      priceMicros: r.priceMicros,
      latencyMs: r.latencyMs,
      cacheHit: r.cacheHit,
      promptVersion: r.promptVersion,
      // Model call stats only. Model output TEXT is deliberately not stored (privacy).
      calls: r.calls.map((c) => ({
        stage: c.stage,
        round: c.round,
        modelId: c.modelId,
        provider: c.provider,
        ok: c.ok,
        error: c.error?.slice(0, 300) ?? null,
        inputTokens: c.usage?.inputTokens ?? null,
        outputTokens: c.usage?.outputTokens ?? null,
        costMicros: c.costMicros,
        latencyMs: c.latencyMs,
        finishReason: c.finishReason ?? null,
      })),
      createdAt,
    });
    if (r.priceMicros > 0 || r.costMicros > 0) {
      // Doc id = request id + kind, so a retried write overwrites instead of double-billing.
      batch.set(this.col("ledger").doc(`${r.id}_usage`), {
        orgId: r.principal.orgId,
        requestId: r.id,
        kind: "usage",
        priceMicros: r.priceMicros,
        costMicros: r.costMicros,
        createdAt,
      });
    }
    await batch.commit();
  }

  async usageSince(orgId: string, since: Date) {
    // Server-side aggregation: Firestore sums the fields without us reading every doc.
    const snap = await this.col("requests")
      .where("orgId", "==", orgId)
      .where("createdAt", ">=", Timestamp.fromDate(since))
      .aggregate({
        requests: AggregateField.count(),
        inputTokens: AggregateField.sum("inputTokens"),
        outputTokens: AggregateField.sum("outputTokens"),
        priceMicros: AggregateField.sum("priceMicros"),
      })
      .get();
    const d = snap.data();
    return {
      requests: d.requests,
      inputTokens: d.inputTokens ?? 0,
      outputTokens: d.outputTokens ?? 0,
      priceMicros: d.priceMicros ?? 0,
    };
  }

  async ping(): Promise<boolean> {
    try {
      await this.col("orgs").limit(1).get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.db.terminate();
  }
}
