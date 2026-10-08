/**
 * KEY-VALUE STORE INTERFACE (Redis in production, in-memory in dev)
 *
 * Rate limits and quotas must be SHARED across every API server instance.
 * If you run 10 servers and each keeps its own counter, a customer gets 10x
 * their limit. Redis is the standard answer: fast, atomic, shared.
 *
 * Every operation here is ATOMIC (in Redis via Lua scripts). That matters:
 * "read counter, check, write counter" as three separate steps lets two
 * simultaneous requests both pass the check. Atomic ops close that race.
 */
export interface BucketResult {
  allowed: boolean;
  /** Tokens left in the bucket after this operation (can be negative after a forced charge). */
  remaining: number;
  /** If denied: how long until enough tokens refill. */
  retryAfterMs: number;
}

export interface KV {
  /**
   * TOKEN BUCKET. A bucket holds up to `capacity` tokens and refills at
   * `refillPerSec`. Each request takes `cost` tokens out; if there aren't
   * enough, it's denied. This allows short bursts while enforcing an
   * average rate, which is exactly how vendor rate limits behave too.
   *
   * `force: true` takes the tokens even if the bucket goes negative. We use
   * it to settle the difference between ESTIMATED and ACTUAL token usage
   * after a call (a negative cost refunds).
   */
  tokenBucket(key: string, capacity: number, refillPerSec: number, cost: number, force?: boolean): Promise<BucketResult>;

  /** Atomic add; sets a TTL when the key is created. Returns the new value. */
  incrBy(key: string, amount: number, ttlSec: number): Promise<number>;

  /** Read a numeric counter (0 if missing). */
  getNumber(key: string): Promise<number>;

  /**
   * RESERVE: atomically add `amount` to `reservedKey` only if
   * spent + reserved + amount <= limit. Used for spend quotas so two
   * parallel expensive requests can't both slip under the cap.
   */
  reserve(spentKey: string, reservedKey: string, amount: number, limit: number, ttlSec: number): Promise<boolean>;

  /** Concurrency slots: take one if fewer than `limit` are in use. */
  acquireSlot(key: string, limit: number, ttlSec: number): Promise<boolean>;
  releaseSlot(key: string): Promise<void>;

  /** Plain string cache (used by the response cache). */
  getString(key: string): Promise<string | null>;
  setString(key: string, value: string, ttlSec: number): Promise<void>;

  ping(): Promise<boolean>;
  close(): Promise<void>;
}
