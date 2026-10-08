/**
 * Redis-backed KV for production. Each compound operation is a Lua script,
 * which Redis runs atomically (nothing else executes in between). That is
 * what makes limits correct across many API servers at once.
 */
import { Redis } from "ioredis";
import type { BucketResult, KV } from "./types.js";

// KEYS[1] = bucket key
// ARGV    = capacity, refillPerSec, cost, nowMs, force(0|1)
// Stores {tokens, ts} in a hash. Refills by elapsed time, then tries to take `cost`.
const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local refill   = tonumber(ARGV[2])
local cost     = tonumber(ARGV[3])
local now      = tonumber(ARGV[4])
local force    = tonumber(ARGV[5])
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1]) or capacity
local ts     = tonumber(b[2]) or now
tokens = math.min(capacity, tokens + ((now - ts) / 1000) * refill)
local allowed = 0
if force == 1 or tokens >= cost then
  tokens = math.min(capacity, tokens - cost)
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
-- Expire idle buckets once they'd be full again anyway (+1 min slack).
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / refill * 1000) + 60000)
return {allowed, tostring(tokens)}
`;

// KEYS[1]=counter  ARGV: amount, ttlSec. Sets TTL only when the key is new.
const INCR_TTL_LUA = `
local v = redis.call('INCRBY', KEYS[1], ARGV[1])
if v == tonumber(ARGV[1]) then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return v
`;

// KEYS[1]=spent KEYS[2]=reserved  ARGV: amount, limit, ttlSec
const RESERVE_LUA = `
local spent    = tonumber(redis.call('GET', KEYS[1]) or '0')
local reserved = tonumber(redis.call('GET', KEYS[2]) or '0')
local amount   = tonumber(ARGV[1])
if spent + reserved + amount > tonumber(ARGV[2]) then return 0 end
local v = redis.call('INCRBY', KEYS[2], amount)
if v == amount then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
return 1
`;

// KEYS[1]=slots  ARGV: limit, ttlSec. TTL is a safety net if a server crashes mid-request.
const ACQUIRE_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if cur >= tonumber(ARGV[1]) then return 0 end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

// Never let the slot counter go below zero.
const RELEASE_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if cur > 0 then redis.call('DECR', KEYS[1]) end
return 1
`;

export class RedisKV implements KV {
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 2, enableAutoPipelining: true });
  }

  async tokenBucket(key: string, capacity: number, refillPerSec: number, cost: number, force = false): Promise<BucketResult> {
    const [allowed, tokensStr] = (await this.redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      key,
      capacity,
      refillPerSec,
      cost,
      Date.now(),
      force ? 1 : 0,
    )) as [number, string];
    const tokens = Number(tokensStr);
    return {
      allowed: allowed === 1,
      remaining: Math.floor(tokens),
      retryAfterMs: allowed === 1 ? 0 : Math.ceil(((cost - tokens) / refillPerSec) * 1000),
    };
  }

  async incrBy(key: string, amount: number, ttlSec: number): Promise<number> {
    return Number(await this.redis.eval(INCR_TTL_LUA, 1, key, amount, ttlSec));
  }

  async getNumber(key: string): Promise<number> {
    return Number((await this.redis.get(key)) ?? 0);
  }

  async reserve(spentKey: string, reservedKey: string, amount: number, limit: number, ttlSec: number): Promise<boolean> {
    return (await this.redis.eval(RESERVE_LUA, 2, spentKey, reservedKey, amount, limit, ttlSec)) === 1;
  }

  async acquireSlot(key: string, limit: number, ttlSec: number): Promise<boolean> {
    return (await this.redis.eval(ACQUIRE_LUA, 1, key, limit, ttlSec)) === 1;
  }

  async releaseSlot(key: string): Promise<void> {
    await this.redis.eval(RELEASE_LUA, 1, key);
  }

  async getString(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async setString(key: string, value: string, ttlSec: number): Promise<void> {
    await this.redis.set(key, value, "EX", ttlSec);
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
