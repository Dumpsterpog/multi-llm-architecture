/**
 * Firestore-backed KV: rate-limit and quota counters with only Firebase,
 * no extra service to run.
 *
 * Every compound operation is a Firestore TRANSACTION, which gives the same
 * guarantee as the Redis Lua scripts: read-check-write happens atomically,
 * so two servers can't both slip under a limit at the same moment.
 *
 * Expiry: each doc has an `expiresAt` field. The code treats expired docs as
 * empty, and a Firestore TTL policy deletes them in the background.
 * One-time setup (Firebase console > Firestore > TTL, or gcloud):
 *   collection group "llm_kv", field "expiresAt"
 *
 * WHEN TO MOVE TO REDIS: Firestore handles roughly 1 sustained write per
 * second on any SINGLE document. Per-user counters are fine (one person
 * doesn't send a message every second). The platform-wide daily budget is
 * one shared document written on every request, so past about one chat
 * request per second across the whole site, transactions on it start to
 * contend and slow down. At that point create a Redis database at Upstash
 * (serverless, pay per use) and set KV=redis + REDIS_URL. No code changes.
 */
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import type { BucketResult, KV } from "./types.js";

interface KvDoc {
  n?: number; // counters
  tokens?: number; // token bucket
  ts?: number; // token bucket last refill (ms)
  s?: string; // cached strings
  expiresAt?: Timestamp;
}

export class FirestoreKV implements KV {
  constructor(
    private readonly db: Firestore,
    prefix: string,
  ) {
    this.collection = `${prefix}kv`;
  }

  private readonly collection: string;

  private ref(key: string) {
    // Doc ids can't contain "/", our keys use ":" so they're safe; encode anyway.
    return this.db.collection(this.collection).doc(encodeURIComponent(key));
  }

  private static live(d: KvDoc | undefined): KvDoc | undefined {
    if (!d) return undefined;
    if (d.expiresAt && d.expiresAt.toMillis() <= Date.now()) return undefined;
    return d;
  }

  private static expiry(ttlSec: number): Timestamp {
    return Timestamp.fromMillis(Date.now() + ttlSec * 1000);
  }

  async tokenBucket(key: string, capacity: number, refillPerSec: number, cost: number, force = false): Promise<BucketResult> {
    const ref = this.ref(key);
    return this.db.runTransaction(async (tx) => {
      const now = Date.now();
      const d = FirestoreKV.live((await tx.get(ref)).data() as KvDoc | undefined);
      let tokens = d?.tokens ?? capacity;
      const ts = d?.ts ?? now;
      tokens = Math.min(capacity, tokens + ((now - ts) / 1000) * refillPerSec);
      let allowed = false;
      if (force || tokens >= cost) {
        tokens = Math.min(capacity, tokens - cost);
        allowed = true;
      }
      // Idle buckets expire once they'd be full again anyway (+1 min slack).
      tx.set(ref, { tokens, ts: now, expiresAt: FirestoreKV.expiry(capacity / refillPerSec + 60) });
      return {
        allowed,
        remaining: Math.floor(tokens),
        retryAfterMs: allowed ? 0 : Math.ceil(((cost - tokens) / refillPerSec) * 1000),
      };
    });
  }

  async incrBy(key: string, amount: number, ttlSec: number): Promise<number> {
    const ref = this.ref(key);
    return this.db.runTransaction(async (tx) => {
      const d = FirestoreKV.live((await tx.get(ref)).data() as KvDoc | undefined);
      const n = (d?.n ?? 0) + amount;
      // TTL is set when the counter is created and kept afterwards (same as Redis version).
      tx.set(ref, { n, expiresAt: d?.expiresAt ?? FirestoreKV.expiry(ttlSec) });
      return n;
    });
  }

  async getNumber(key: string): Promise<number> {
    const d = FirestoreKV.live((await this.ref(key).get()).data() as KvDoc | undefined);
    return d?.n ?? 0;
  }

  async reserve(spentKey: string, reservedKey: string, amount: number, limit: number, ttlSec: number): Promise<boolean> {
    const spentRef = this.ref(spentKey);
    const reservedRef = this.ref(reservedKey);
    return this.db.runTransaction(async (tx) => {
      const [s, r] = await Promise.all([tx.get(spentRef), tx.get(reservedRef)]);
      const spent = FirestoreKV.live(s.data() as KvDoc | undefined)?.n ?? 0;
      const rd = FirestoreKV.live(r.data() as KvDoc | undefined);
      const reserved = rd?.n ?? 0;
      if (spent + reserved + amount > limit) return false;
      tx.set(reservedRef, { n: reserved + amount, expiresAt: rd?.expiresAt ?? FirestoreKV.expiry(ttlSec) });
      return true;
    });
  }

  async acquireSlot(key: string, limit: number, ttlSec: number): Promise<boolean> {
    const ref = this.ref(key);
    return this.db.runTransaction(async (tx) => {
      const d = FirestoreKV.live((await tx.get(ref)).data() as KvDoc | undefined);
      const cur = d?.n ?? 0;
      if (cur >= limit) return false;
      // TTL refreshed on each acquire: a slot leaked by a crashed server frees itself.
      tx.set(ref, { n: cur + 1, expiresAt: FirestoreKV.expiry(ttlSec) });
      return true;
    });
  }

  async releaseSlot(key: string): Promise<void> {
    const ref = this.ref(key);
    await this.db.runTransaction(async (tx) => {
      const d = FirestoreKV.live((await tx.get(ref)).data() as KvDoc | undefined);
      if (!d?.n) return;
      tx.update(ref, { n: Math.max(0, d.n - 1) });
    });
  }

  async getString(key: string): Promise<string | null> {
    const d = FirestoreKV.live((await this.ref(key).get()).data() as KvDoc | undefined);
    return d?.s ?? null;
  }

  async setString(key: string, value: string, ttlSec: number): Promise<void> {
    await this.ref(key).set({ s: value, expiresAt: FirestoreKV.expiry(ttlSec) });
  }

  async ping(): Promise<boolean> {
    try {
      await this.ref("__ping__").get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // The Firestore client is shared with the store, which closes it.
  }
}
