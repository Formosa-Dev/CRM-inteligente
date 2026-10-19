import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  limit: number;
}

export interface RateLimitOptions {
  /**
   * Namespaced shared ceiling for a route/purpose (e.g. "leads",
   * "webhook:ycloud"). Defaults to the key prefix — everything before the
   * last ":" — so `leads:1.2.3.4` lands in bucket "leads". A dedicated bucket
   * is what stops an unauthenticated flood against one endpoint from
   * exhausting a global pool shared with inbound message processing (F3).
   */
  bucket?: string;
  /** Per-key limit within the window. Default 20/min. */
  limit?: number;
  /** Per-bucket shared limit within the window. Default 100/min. */
  bucketLimit?: number;
}

interface WindowEntry {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60_000;
const DEFAULT_KEY_LIMIT = 20;
const DEFAULT_BUCKET_LIMIT = 100;
const FALLBACK_BUCKET = "global";

const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const hasRedis = !!(redisUrl && redisToken && redisUrl.startsWith("https://"));

const redis = hasRedis
  ? new Redis({ url: redisUrl!, token: redisToken! })
  : null;

/**
 * Ratelimit instances are immutable per (window size, prefix) — cache them.
 * Per-key limiters share one prefix and are keyed by their token budget;
 * bucket limiters additionally scope the Redis prefix by bucket name so a
 * saturated bucket can never consume another purpose's allowance.
 */
const keyLimiters = new Map<number, Ratelimit>();
const bucketLimiters = new Map<string, Ratelimit>();

function keyLimiter(limit: number): Ratelimit {
  let limiter = keyLimiters.get(limit);
  if (!limiter) {
    limiter = new Ratelimit({
      redis: redis!,
      limiter: Ratelimit.slidingWindow(limit, "1 m"),
      prefix: "ratelimit:key",
    });
    keyLimiters.set(limit, limiter);
  }
  return limiter;
}

function bucketLimiter(bucket: string, limit: number): Ratelimit {
  const cacheKey = `${bucket}:${limit}`;
  let limiter = bucketLimiters.get(cacheKey);
  if (!limiter) {
    limiter = new Ratelimit({
      redis: redis!,
      limiter: Ratelimit.slidingWindow(limit, "1 m"),
      // Bucket names come from our own call sites (or a trusted key prefix),
      // never raw client input — safe inside the Redis prefix.
      prefix: `ratelimit:bucket:${bucket}`,
    });
    bucketLimiters.set(cacheKey, limiter);
  }
  return limiter;
}

const keyMap = new Map<string, WindowEntry>();
const bucketMap = new Map<string, WindowEntry>();

function checkWindow(
  map: Map<string, WindowEntry>,
  key: string,
  limit: number,
): RateLimitResult {
  const now = Date.now();
  const entry = map.get(key);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    map.set(key, { count: 1, windowStart: now });
    return { success: true, remaining: limit - 1, limit };
  }

  entry.count++;

  if (entry.count > limit) {
    return { success: false, remaining: 0, limit };
  }

  return { success: true, remaining: limit - entry.count, limit };
}

function cleanup() {
  const now = Date.now();
  for (const [key, entry] of keyMap) {
    if (now - entry.windowStart >= WINDOW_MS) keyMap.delete(key);
  }
  for (const [key, entry] of bucketMap) {
    if (now - entry.windowStart >= WINDOW_MS) bucketMap.delete(key);
  }
}

if (typeof setInterval !== "undefined") {
  setInterval(cleanup, WINDOW_MS);
}

/**
 * Shared-ceiling rate limit: every request consumes one unit of its own
 * per-key window AND one unit of a per-bucket window. Buckets isolate
 * failure domains — e.g. abuse of `/api/leads` saturates only the "leads"
 * bucket and can never starve "wa-inbound" message processing.
 *
 * Default bucket = the key's prefix (everything before the last ":"), so
 * callers get purpose isolation even without passing `bucket`.
 */
export async function checkRateLimit(
  key: string,
  options: RateLimitOptions = {},
): Promise<RateLimitResult> {
  const limit = options.limit ?? DEFAULT_KEY_LIMIT;
  const bucketLimit = options.bucketLimit ?? DEFAULT_BUCKET_LIMIT;
  const bucket =
    options.bucket ??
    (key.lastIndexOf(":") > 0
      ? key.slice(0, key.lastIndexOf(":"))
      : FALLBACK_BUCKET);

  if (redis) {
    try {
      const keyResult = await keyLimiter(limit).limit(key);
      if (!keyResult.success) {
        return { success: false, remaining: 0, limit };
      }

      const bucketResult = await bucketLimiter(bucket, bucketLimit).limit(
        bucket,
      );
      return {
        success: bucketResult.success,
        remaining: bucketResult.success ? keyResult.remaining : 0,
        limit: bucketLimit,
      };
    } catch (err) {
      // A Redis outage must degrade to the in-memory limiter, never drop the
      // request — callers fail closed on thrown errors and inbound messages
      // would silently stop being processed.
      console.warn("[rate-limit] Upstash check failed — using in-memory fallback", err);
    }
  }

  const keyResult = checkWindow(keyMap, key, limit);
  if (!keyResult.success) return keyResult;

  return checkWindow(bucketMap, bucket, bucketLimit);
}

/**
 * Client IP for rate limiting. Only the RIGHT-MOST x-forwarded-for hop is
 * trusted: earlier entries are client-supplied and freely rotatable; the last
 * one was appended by the edge proxy (Render's router) that actually saw the
 * peer. With no trusted proxy in front there is no reliable client IP — a
 * fixed "unknown" bucket beats a spoofable key.
 */
export function clientIpFromRequest(request: { headers: Headers }): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const last = forwarded
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  return last ?? request.headers.get("x-real-ip")?.trim() ?? "unknown";
}

export function getRateLimitHeaders(
  success: boolean,
  remaining: number,
  limit: number,
): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(Date.now() + WINDOW_MS),
  };
}
