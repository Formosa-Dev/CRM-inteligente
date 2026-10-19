import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  limit: number;
}

interface WindowEntry {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60_000;
const USER_LIMIT = 20;
const GLOBAL_LIMIT = 100;

const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const hasRedis = !!(redisUrl && redisToken && redisUrl.startsWith("https://"));

let redis: Redis | null = null;
let userRatelimit: Ratelimit | null = null;
let globalRatelimit: Ratelimit | null = null;

if (hasRedis) {
  redis = new Redis({
    url: redisUrl!,
    token: redisToken!,
  });

  userRatelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(USER_LIMIT, "1 m"),
    prefix: "ratelimit:user",
  });

  globalRatelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(GLOBAL_LIMIT, "1 m"),
    prefix: "ratelimit:global",
  });
}

const userMap = new Map<string, WindowEntry>();
const globalMap = new Map<string, WindowEntry>();

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
  for (const [key, entry] of userMap) {
    if (now - entry.windowStart >= WINDOW_MS) userMap.delete(key);
  }
  for (const [key, entry] of globalMap) {
    if (now - entry.windowStart >= WINDOW_MS) globalMap.delete(key);
  }
}

if (typeof setInterval !== "undefined") {
  setInterval(cleanup, WINDOW_MS);
}

export async function checkRateLimit(key: string): Promise<RateLimitResult> {
  if (redis && userRatelimit && globalRatelimit) {
    try {
      const user = await userRatelimit.limit(key);
      if (!user.success) {
        return { success: false, remaining: 0, limit: USER_LIMIT };
      }

      const global = await globalRatelimit.limit("global");
      return {
        success: global.success,
        remaining: global.success ? user.remaining : 0,
        limit: GLOBAL_LIMIT,
      };
    } catch (err) {
      // A Redis outage must degrade to the in-memory limiter, never drop the
      // request — callers fail closed on thrown errors and inbound messages
      // would silently stop being processed.
      console.warn("[rate-limit] Upstash check failed — using in-memory fallback", err);
    }
  }

  const user = checkWindow(userMap, key, USER_LIMIT);
  if (!user.success) return user;

  return checkWindow(globalMap, "global", GLOBAL_LIMIT);
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
