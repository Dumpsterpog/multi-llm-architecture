/**
 * Postgres implementation of Store. Tables: db/schema.sql.
 *
 * All queries are parameterised ($1, $2...). Never build SQL by string
 * concatenation with user input: that is how SQL injection happens.
 */
import pg from "pg";
import type { PlanId, PlanLimits } from "../config/plans.js";
import type { Conversation, ConversationSummary, Principal, RequestRecord, Store, StoredMessage } from "./types.js";

export class PostgresStore implements Store {
  private readonly pool: pg.Pool;

  constructor(url: string) {
    // Pool size: (instances * max) must stay under Postgres max_connections.
    // At scale put PgBouncer in front.
    this.pool = new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000 });
  }

  async findApiKeyByHash(hash: string): Promise<Principal | null> {
    const { rows } = await this.pool.query<{ id: string; org_id: string; user_id: string | null; plan: PlanId; limit_overrides: Partial<PlanLimits> | null }>(
      `SELECT k.id, k.org_id, k.user_id, o.plan, o.limit_overrides
         FROM api_keys k JOIN organizations o ON o.id = k.org_id
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
      [hash],
    );
    const r = rows[0];
    if (!r) return null;
    // Fire-and-forget: last_used_at is informational and must not slow the request.
    this.pool.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [r.id]).catch(() => {});
    return { kind: "api_key", orgId: r.org_id, userId: r.user_id, apiKeyId: r.id, plan: r.plan, limitOverrides: r.limit_overrides };
  }

  async upsertWebUser(externalId: string, email: string | null): Promise<Principal> {
    const existing = await this.pool.query<{ id: string; org_id: string; plan: PlanId; limit_overrides: Partial<PlanLimits> | null }>(
      `SELECT u.id, u.org_id, o.plan, o.limit_overrides
         FROM users u JOIN organizations o ON o.id = u.org_id
        WHERE u.external_auth_id = $1`,
      [externalId],
    );
    let r = existing.rows[0];
    if (!r) {
      // First login: create a personal org on the free plan + the user, atomically.
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const org = await client.query<{ id: string }>(`INSERT INTO organizations(name) VALUES ($1) RETURNING id`, [email ?? externalId]);
        const orgId = org.rows[0]!.id;
        const user = await client.query<{ id: string; org_id: string }>(
          `INSERT INTO users(org_id, external_auth_id, email) VALUES ($1, $2, $3)
           ON CONFLICT (external_auth_id) DO UPDATE SET last_seen_at = now()
           RETURNING id, org_id`,
          [orgId, externalId, email],
        );
        await client.query("COMMIT");
        r = { id: user.rows[0]!.id, org_id: user.rows[0]!.org_id, plan: "free", limit_overrides: null };
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
    return { kind: "web_user", orgId: r.org_id, userId: r.id, apiKeyId: null, plan: r.plan, limitOverrides: r.limit_overrides };
  }

  async createConversation(p: Principal, title: string): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO conversations(org_id, user_id, title) VALUES ($1, $2, $3) RETURNING id`,
      [p.orgId, p.userId, title],
    );
    return rows[0]!.id;
  }

  async getConversation(id: string, p: Principal): Promise<Conversation | null> {
    // The ownership check lives in the WHERE clause, so a guessed id returns nothing.
    const conv = await this.pool.query<{ id: string; title: string; updated_at: Date }>(
      `SELECT id, title, updated_at FROM conversations
        WHERE id = $1 AND org_id = $2 AND ($3::uuid IS NULL OR user_id = $3) AND deleted_at IS NULL`,
      [id, p.orgId, p.userId],
    );
    const c = conv.rows[0];
    if (!c) return null;
    const msgs = await this.pool.query<{ role: StoredMessage["role"]; content: string; created_at: Date }>(
      `SELECT role, content, created_at FROM messages WHERE conversation_id = $1 ORDER BY id`,
      [id],
    );
    return {
      id: c.id,
      title: c.title,
      updatedAt: c.updated_at.toISOString(),
      messages: msgs.rows.map((m) => ({ role: m.role, content: m.content, createdAt: m.created_at.toISOString() })),
    };
  }

  async listConversations(p: Principal, limit: number, before?: string): Promise<ConversationSummary[]> {
    // Cursor pagination on updated_at (stable and fast, unlike OFFSET on big tables).
    const { rows } = await this.pool.query<{ id: string; title: string; updated_at: Date }>(
      `SELECT id, title, updated_at FROM conversations
        WHERE org_id = $1 AND ($2::uuid IS NULL OR user_id = $2) AND deleted_at IS NULL
          AND ($3::timestamptz IS NULL OR updated_at < $3)
        ORDER BY updated_at DESC LIMIT $4`,
      [p.orgId, p.userId, before ?? null, limit],
    );
    return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at.toISOString() }));
  }

  async deleteConversation(id: string, p: Principal): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE conversations SET deleted_at = now()
        WHERE id = $1 AND org_id = $2 AND ($3::uuid IS NULL OR user_id = $3) AND deleted_at IS NULL`,
      [id, p.orgId, p.userId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async appendMessages(conversationId: string, messages: StoredMessage[], requestId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const m of messages) {
        await client.query(`INSERT INTO messages(conversation_id, role, content, request_id) VALUES ($1, $2, $3, $4)`, [
          conversationId,
          m.role,
          m.content,
          requestId,
        ]);
      }
      await client.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [conversationId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async recordRequest(r: RequestRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO requests(id, org_id, user_id, api_key_id, conversation_id, strategy, status, error_type,
                              input_tokens, output_tokens, cost_micros, price_micros, latency_ms, cache_hit, prompt_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (id) DO NOTHING`,
        [
          r.id, r.principal.orgId, r.principal.userId, r.principal.apiKeyId, r.conversationId, r.strategy, r.status,
          r.errorType ?? null, r.inputTokens, r.outputTokens, r.costMicros, r.priceMicros, r.latencyMs, r.cacheHit, r.promptVersion,
        ],
      );
      for (const c of r.calls) {
        await client.query(
          `INSERT INTO model_calls(request_id, stage, round, model_id, provider, ok, error, input_tokens, output_tokens,
                                   cached_input_tokens, cost_micros, latency_ms, finish_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            r.id, c.stage, c.round, c.modelId, c.provider, c.ok, c.error?.slice(0, 500) ?? null, c.usage?.inputTokens ?? null,
            c.usage?.outputTokens ?? null, c.usage?.cachedInputTokens ?? null, c.costMicros, c.latencyMs, c.finishReason ?? null,
          ],
        );
      }
      if (r.priceMicros > 0 || r.costMicros > 0) {
        await client.query(
          `INSERT INTO usage_ledger(org_id, request_id, kind, price_micros, cost_micros)
           VALUES ($1, $2, 'usage', $3, $4) ON CONFLICT (request_id, kind) DO NOTHING`,
          [r.principal.orgId, r.id, r.priceMicros, r.costMicros],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async usageSince(orgId: string, since: Date) {
    const { rows } = await this.pool.query<{ requests: string; input_tokens: string; output_tokens: string; price_micros: string }>(
      `SELECT count(*) AS requests, coalesce(sum(input_tokens),0) AS input_tokens,
              coalesce(sum(output_tokens),0) AS output_tokens, coalesce(sum(price_micros),0) AS price_micros
         FROM requests WHERE org_id = $1 AND created_at >= $2`,
      [orgId, since],
    );
    const r = rows[0]!;
    return {
      requests: Number(r.requests),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      priceMicros: Number(r.price_micros),
    };
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
