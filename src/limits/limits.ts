/**
 * LIMITS SERVICE: rate limits, concurrency, daily tokens, monthly spend.
 *
 * See config/plans.ts for WHY each limit exists. This file is HOW they are
 * enforced. The order of checks in a request (see gateway/pipeline.ts):
 *
 *   1. requests per minute     cheap, rejects floods before any work
 *   2. concurrency slot        caps parallel in-flight requests
 *   3. tokens per minute       uses the ESTIMATED token count of the run
 *   4. daily token quota       hard daily cap
 *   5. monthly spend reserve   reserves the WORST-CASE price up front
 *   ... orchestration runs ...
 *   6. settle                  replace estimates with ACTUAL usage
 *
 * THE RESERVATION PATTERN (step 5 and 6) is how card payments work: put a
 * hold for the maximum possible amount, then capture the real amount and
 * release the rest. Without it, 10 expensive requests started at the same
 * moment could each see "$1 left" and together spend $10.
 *
 * Redis counters here are a FAST MIRROR for enforcement. The durable source
 * of truth for billing is the `usage_ledger` table in Postgres; a periodic
 * reconciler job can rebuild the Redis counters from it (docs section 7).
 */
import type { PlanLimits } from "../config/plans.js";
import { AppError } from "../errors.js";
import type { KV } from "../kv/types.js";
import { microsToUsd, usdToMicros } from "../billing/pricing.js";

const DAY_SEC = 86_400;
const MONTH_TTL_SEC = 40 * DAY_SEC; // outlives the month, then self-cleans
/** Safety TTL on a concurrency slot in case a server dies mid-request. */
const SLOT_TTL_SEC = 300;

function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10); // 2026-10-08 (UTC)
}
function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7); // 2026-10
}

export interface SpendReservation {
  orgId: string;
  month: string;
  reservedMicros: number;
}

export interface UsageSnapshot {
  dailyTokensUsed: number;
  dailyTokenLimit: number;
  monthSpendUsd: number;
  monthLimitUsd: number;
}

export class LimitsService {
  constructor(private readonly kv: KV) {}

  /** 1. Requests per minute (token bucket, 1 token per request). */
  async checkRequestRate(orgId: string, plan: PlanLimits): Promise<{ remaining: number }> {
    const r = await this.kv.tokenBucket(`rl:rpm:${orgId}`, plan.requestsPerMinute, plan.requestsPerMinute / 60, 1);
    if (!r.allowed) {
      throw new AppError(429, "rate_limit_exceeded", `Rate limit: ${plan.requestsPerMinute} requests/minute`, r.retryAfterMs);
    }
    return { remaining: r.remaining };
  }

  /** 2. Concurrency: returns a release function the caller MUST run in `finally`. */
  async acquireConcurrency(orgId: string, plan: PlanLimits): Promise<() => Promise<void>> {
    const key = `rl:conc:${orgId}`;
    const ok = await this.kv.acquireSlot(key, plan.maxConcurrentRequests, SLOT_TTL_SEC);
    if (!ok) {
      throw new AppError(
        429,
        "rate_limit_exceeded",
        `Too many requests in flight (max ${plan.maxConcurrentRequests}). Wait for one to finish.`,
        1_000,
      );
    }
    let released = false;
    return async () => {
      if (released) return; // idempotent: safe to call twice
      released = true;
      await this.kv.releaseSlot(key);
    };
  }

  /** 3. Tokens per minute, charged with the ESTIMATE before the run. */
  async checkTokenRate(orgId: string, plan: PlanLimits, estimatedTokens: number): Promise<void> {
    if (estimatedTokens > plan.tokensPerMinute) {
      // Would never fit even with a full bucket; tell the client clearly instead of retry-looping.
      throw new AppError(
        400,
        "invalid_request",
        `This request needs ~${estimatedTokens} tokens but your plan allows ${plan.tokensPerMinute}/minute. Use fewer models, rounds or a shorter prompt.`,
      );
    }
    const r = await this.kv.tokenBucket(`rl:tpm:${orgId}`, plan.tokensPerMinute, plan.tokensPerMinute / 60, estimatedTokens);
    if (!r.allowed) {
      throw new AppError(429, "rate_limit_exceeded", `Token rate limit: ${plan.tokensPerMinute} tokens/minute`, r.retryAfterMs);
    }
  }

  /** 4. Daily token quota (check only; usage is added in settle()). */
  async checkDailyTokens(orgId: string, plan: PlanLimits, estimatedTokens: number): Promise<void> {
    const used = await this.kv.getNumber(`q:day:${orgId}:${dayKey()}`);
    if (used + estimatedTokens > plan.dailyTokenLimit) {
      throw new AppError(429, "quota_exceeded", `Daily token quota reached (${plan.dailyTokenLimit} tokens). Resets 00:00 UTC.`);
    }
  }

  /** 5. Reserve the worst-case customer price of this request against the monthly cap. */
  async reserveSpend(orgId: string, plan: PlanLimits, maxPriceMicros: number): Promise<SpendReservation> {
    const month = monthKey();
    const limitUsd = plan.allowOverage ? plan.monthlyHardCapUsd : plan.monthlyIncludedUsd;
    const ok = await this.kv.reserve(
      `q:spend:${orgId}:${month}`,
      `q:reserved:${orgId}:${month}`,
      maxPriceMicros,
      usdToMicros(limitUsd),
      MONTH_TTL_SEC,
    );
    if (!ok) {
      throw new AppError(
        402,
        "quota_exceeded",
        plan.allowOverage
          ? `Monthly spend cap of $${limitUsd} reached.`
          : `Monthly included usage of $${limitUsd} used up. Upgrade your plan for more.`,
      );
    }
    return { orgId, month, reservedMicros: maxPriceMicros };
  }

  /**
   * 6. Settle: release the reservation, record actual spend and tokens, and
   * correct the TPM bucket by (actual - estimated). Always called, even when
   * the orchestration failed half-way (partial work still cost us money).
   */
  async settle(args: {
    orgId: string;
    plan: PlanLimits;
    reservation: SpendReservation;
    actualPriceMicros: number;
    estimatedTokens: number;
    actualTokens: number;
  }): Promise<void> {
    const { orgId, plan, reservation } = args;
    await Promise.all([
      this.kv.incrBy(`q:reserved:${orgId}:${reservation.month}`, -reservation.reservedMicros, MONTH_TTL_SEC),
      this.kv.incrBy(`q:spend:${orgId}:${reservation.month}`, args.actualPriceMicros, MONTH_TTL_SEC),
      this.kv.incrBy(`q:day:${orgId}:${dayKey()}`, args.actualTokens, 2 * DAY_SEC),
      this.kv.tokenBucket(
        `rl:tpm:${orgId}`,
        plan.tokensPerMinute,
        plan.tokensPerMinute / 60,
        args.actualTokens - args.estimatedTokens,
        true, // forced: refunds if we over-estimated, charges extra if we under-estimated
      ),
    ]);
  }

  // -------------------------------------------------------------------------
  // Platform-level guards: these protect YOUR bill, not one customer's.
  // -------------------------------------------------------------------------

  /** Per-IP request rate. Catches one person farming many free accounts. */
  async checkIpRate(ip: string, perMinute: number): Promise<void> {
    const r = await this.kv.tokenBucket(`rl:ip:${ip}`, perMinute, perMinute / 60, 1);
    if (!r.allowed) {
      throw new AppError(429, "rate_limit_exceeded", "Too many requests from your network. Slow down.", r.retryAfterMs);
    }
  }

  /**
   * GLOBAL DAILY KILL SWITCH. Reserve this request's worst-case VENDOR cost
   * against the platform's daily budget (PLATFORM_DAILY_BUDGET_USD). If the
   * whole service has spent its daily budget, new requests are refused
   * until midnight UTC, no matter which user sends them. Without this, a
   * viral moment or an abuse wave on the free tier can cost thousands
   * overnight. Returns the reservation to settle afterwards.
   */
  async reservePlatformBudget(maxCostMicros: number, dailyBudgetUsd: number): Promise<{ day: string; reservedMicros: number }> {
    const day = dayKey();
    const ok = await this.kv.reserve(`p:spend:${day}`, `p:reserved:${day}`, maxCostMicros, usdToMicros(dailyBudgetUsd), 2 * DAY_SEC);
    if (!ok) {
      throw new AppError(503, "rate_limit_exceeded", "We're at capacity right now. Please try again later.", 60_000);
    }
    return { day, reservedMicros: maxCostMicros };
  }

  async settlePlatformBudget(res: { day: string; reservedMicros: number }, actualCostMicros: number): Promise<void> {
    await Promise.all([
      this.kv.incrBy(`p:reserved:${res.day}`, -res.reservedMicros, 2 * DAY_SEC),
      this.kv.incrBy(`p:spend:${res.day}`, actualCostMicros, 2 * DAY_SEC),
    ]);
  }

  async platformSpendTodayUsd(): Promise<number> {
    return microsToUsd(await this.kv.getNumber(`p:spend:${dayKey()}`));
  }

  async snapshot(orgId: string, plan: PlanLimits): Promise<UsageSnapshot> {
    const [dayUsed, spent] = await Promise.all([
      this.kv.getNumber(`q:day:${orgId}:${dayKey()}`),
      this.kv.getNumber(`q:spend:${orgId}:${monthKey()}`),
    ]);
    return {
      dailyTokensUsed: dayUsed,
      dailyTokenLimit: plan.dailyTokenLimit,
      monthSpendUsd: microsToUsd(spent),
      monthLimitUsd: plan.allowOverage ? plan.monthlyHardCapUsd : plan.monthlyIncludedUsd,
    };
  }
}
