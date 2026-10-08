/**
 * In-memory KV for development and tests. Same semantics as the Redis
 * version, but state lives in this process only (lost on restart and NOT
 * shared between instances). env.ts refuses to run this in production.
 *
 * JavaScript is single-threaded and none of these methods await between
 * read and write, so each operation is atomic just like the Lua scripts.
 */
import type { BucketResult, KV } from "./types.js";

type Entry = { value: number; expiresAt: number };

export class MemoryKV implements KV {
  private nums = new Map<string, Entry>();
  private strs = new Map<string, { value: string; expiresAt: number }>();
  private buckets = new Map<string, { tokens: number; ts: number }>();

  async tokenBucket(key: string, capacity: number, refillPerSec: number, cost: number, force = false): Promise<BucketResult> {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: capacity, ts: now };
    // Refill proportionally to elapsed time, never above capacity.
    b.tokens = Math.min(capacity, b.tokens + ((now - b.ts) / 1000) * refillPerSec);
    b.ts = now;
    let allowed = false;
    if (force || b.tokens >= cost) {
      b.tokens = Math.min(capacity, b.tokens - cost);
      allowed = true;
    }
    this.buckets.set(key, b);
    const deficit = cost - b.tokens;
    return {
      allowed,
      remaining: Math.floor(b.tokens),
      retryAfterMs: allowed ? 0 : Math.ceil((deficit / refillPerSec) * 1000),
    };
  }

  async incrBy(key: string, amount: number, ttlSec: number): Promise<number> {
    const e = this.liveNum(key) ?? { value: 0, expiresAt: Date.now() + ttlSec * 1000 };
    e.value += amount;
    this.nums.set(key, e);
    return e.value;
  }

  async getNumber(key: string): Promise<number> {
    return this.liveNum(key)?.value ?? 0;
  }

  async reserve(spentKey: string, reservedKey: string, amount: number, limit: number, ttlSec: number): Promise<boolean> {
    const spent = this.liveNum(spentKey)?.value ?? 0;
    const reserved = this.liveNum(reservedKey)?.value ?? 0;
    if (spent + reserved + amount > limit) return false;
    await this.incrBy(reservedKey, amount, ttlSec);
    return true;
  }

  async acquireSlot(key: string, limit: number, ttlSec: number): Promise<boolean> {
    const current = this.liveNum(key)?.value ?? 0;
    if (current >= limit) return false;
    await this.incrBy(key, 1, ttlSec);
    return true;
  }

  async releaseSlot(key: string): Promise<void> {
    const e = this.liveNum(key);
    if (e) e.value = Math.max(0, e.value - 1);
  }

  async getString(key: string): Promise<string | null> {
    const e = this.strs.get(key);
    if (!e || e.expiresAt <= Date.now()) return null;
    return e.value;
  }

  async setString(key: string, value: string, ttlSec: number): Promise<void> {
    this.strs.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}

  private liveNum(key: string): Entry | undefined {
    const e = this.nums.get(key);
    if (e && e.expiresAt <= Date.now()) {
      this.nums.delete(key);
      return undefined;
    }
    return e;
  }
}
