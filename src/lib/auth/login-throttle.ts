import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/**
 * F11: login throttling.
 *
 * The old limiter counted 5 attempts per 10 minutes keyed only by email in a
 * single unbounded in-memory map: anyone could lock the admin out with 5
 * requests, there was no per-IP bound, and unknown emails returned instantly
 * (no bcrypt) which leaked account existence through timing.
 *
 * Three fixed-window buckets now gate every attempt:
 *   - pair  (ip + email): 5/10min — same strictness as before for a single
 *     client hammering one account.
 *   - ip    (any email):   20/10min — bounds credential stuffing from one
 *     source across accounts.
 *   - email (any ip):      30/10min — bounds distributed guessing on one
 *     account while making a sustained admin lockout cost ≥30 attempts from
 *     ≥2 IPs per window (was: 5 attempts from anywhere).
 *
 * Redis (Upstash) is used when configured so limits survive redeploys and are
 * shared across instances; otherwise bounded in-memory maps with periodic
 * cleanup take over — same pattern as src/lib/infra/rate-limit.ts.
 */
const WINDOW_MS = 10 * 60 * 1000;
const WINDOW_LABEL = "10 m";
const PAIR_LIMIT = 5;
const IP_LIMIT = 20;
const EMAIL_LIMIT = 30;
const MAP_MAX_ENTRIES = 5000;

interface WindowEntry {
  count: number;
  resetAt: number;
}

export interface LoginThrottleVerdict {
  allowed: boolean;
  /** true when the distributed per-email bucket rejected the attempt. */
  emailLimited: boolean;
  /** true when a per-IP bucket rejected the attempt. */
  ipLimited: boolean;
}

export interface MemoryThrottle {
  check(ip: string, email: string): LoginThrottleVerdict;
  sweep(): void;
}

export function createMemoryThrottle(
  deps: {
    now?: () => number;
    windowMs?: number;
    maxEntries?: number;
    limits?: { pair: number; ip: number; email: number };
  } = {}
): MemoryThrottle {
  const now = deps.now ?? (() => Date.now());
  const windowMs = deps.windowMs ?? WINDOW_MS;
  const maxEntries = deps.maxEntries ?? MAP_MAX_ENTRIES;
  const limits = deps.limits ?? {
    pair: PAIR_LIMIT,
    ip: IP_LIMIT,
    email: EMAIL_LIMIT,
  };

  const ipMap = new Map<string, WindowEntry>();
  const pairMap = new Map<string, WindowEntry>();
  const emailMap = new Map<string, WindowEntry>();

  function evictExpired(map: Map<string, WindowEntry>, at: number) {
    for (const [key, entry] of map) {
      if (at >= entry.resetAt) map.delete(key);
    }
  }

  function checkWindow(
    map: Map<string, WindowEntry>,
    key: string,
    limit: number
  ): boolean {
    const at = now();
    const entry = map.get(key);
    if (!entry || at >= entry.resetAt) {
      if (map.size >= maxEntries) evictExpired(map, at);
      if (map.size >= maxEntries) {
        // Hard bound: evict oldest-reset entries so uniques cannot grow the
        // map without limit between sweeps.
        const oldest = [...map.entries()]
          .sort((a, b) => a[1].resetAt - b[1].resetAt)
          .slice(0, map.size - maxEntries + 1);
        for (const [oldKey] of oldest) map.delete(oldKey);
      }
      map.set(key, { count: 1, resetAt: at + windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= limit;
  }

  return {
    check(ip, email) {
      const key = email.toLowerCase();
      const pairOk = checkWindow(pairMap, `${ip}|${key}`, limits.pair);
      const ipOk = checkWindow(ipMap, ip, limits.ip);
      const emailOk = checkWindow(emailMap, key, limits.email);
      return {
        allowed: pairOk && ipOk && emailOk,
        ipLimited: !pairOk || !ipOk,
        emailLimited: !emailOk,
      };
    },
    sweep() {
      const at = now();
      evictExpired(ipMap, at);
      evictExpired(pairMap, at);
      evictExpired(emailMap, at);
    },
  };
}

const memoryThrottle = createMemoryThrottle();

const sweeper = setInterval(() => memoryThrottle.sweep(), WINDOW_MS);
sweeper.unref?.();

const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const hasRedis = !!(redisUrl && redisToken && redisUrl.startsWith("https://"));

let redisLimiters: { ip: Ratelimit; pair: Ratelimit; email: Ratelimit } | null =
  null;

if (hasRedis) {
  const redis = new Redis({ url: redisUrl!, token: redisToken! });
  redisLimiters = {
    ip: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(IP_LIMIT, WINDOW_LABEL),
      prefix: "ratelimit:login:ip",
    }),
    pair: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(PAIR_LIMIT, WINDOW_LABEL),
      prefix: "ratelimit:login:pair",
    }),
    email: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(EMAIL_LIMIT, WINDOW_LABEL),
      prefix: "ratelimit:login:email",
    }),
  };
}

/**
 * Returns whether a login attempt for (ip, email) may proceed. Callers must
 * still run the credential check so throttled and invalid attempts are
 * indistinguishable (same generic null + constant-ish bcrypt timing).
 */
export async function checkLoginThrottle(
  ip: string,
  email: string
): Promise<LoginThrottleVerdict> {
  const key = email.toLowerCase();
  if (redisLimiters) {
    try {
      const [ipRes, pairRes, emailRes] = await Promise.all([
        redisLimiters.ip.limit(ip),
        redisLimiters.pair.limit(`${ip}|${key}`),
        redisLimiters.email.limit(key),
      ]);
      return {
        allowed: ipRes.success && pairRes.success && emailRes.success,
        ipLimited: !ipRes.success || !pairRes.success,
        emailLimited: !emailRes.success,
      };
    } catch (err) {
      // A Redis outage degrades to the in-memory buckets, never drops the
      // attempt — same contract as the generic API limiter.
      console.warn(
        "[login-throttle] Upstash check failed — in-memory fallback",
        err
      );
    }
  }
  return memoryThrottle.check(ip, key);
}
