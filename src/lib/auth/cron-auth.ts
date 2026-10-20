import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import {
  checkRateLimit,
  clientIpFromRequest,
  getRateLimitHeaders,
} from "@/lib/infra/rate-limit";
import { getIntegrationSecrets } from "@/lib/integrations";

/**
 * F12: shared auth for /api/cron/* endpoints.
 *
 * The secret travels in `Authorization: Bearer <secret>` — never in the query
 * string, where it would land in proxy/access logs, shell history, referers
 * and any URL that gets bookmarked or prefetched. Requests are rate-limited
 * per client IP before the secret compare so guessing gets throttled.
 *
 * Legacy `?key=` is honored ONLY when CRON_ALLOW_QUERY_KEY=1 is set — a
 * documented escape hatch for schedulers that cannot send headers. With the
 * flag unset a query key is rejected even when valid, so leaked URLs are
 * inert. Render cron (render.yaml) calls with POST + Bearer.
 */

const UNAUTHORIZED = () =>
  NextResponse.json({ error: "No autorizado" }, { status: 401 });

/** Constant-time compare; an unset/empty expected secret fails closed. */
export function cronSecretMatches(
  provided: string | null | undefined,
  expected: string | null | undefined
): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function queryKeyAllowed(): boolean {
  return process.env.CRON_ALLOW_QUERY_KEY === "1";
}

/**
 * Returns null when the request is authorized, or the NextResponse to send
 * (401 on missing/bad secret, 429 when the client IP is over the limit).
 */
export async function authorizeCronRequest(
  request: Request
): Promise<NextResponse | null> {
  const limit = await checkRateLimit(`cron:${clientIpFromRequest(request)}`);
  if (!limit.success) {
    return NextResponse.json(
      { error: "Demasiados pedidos" },
      { status: 429, headers: getRateLimitHeaders(false, 0, limit.limit) }
    );
  }

  const { cronSecret } = await getIntegrationSecrets();

  if (cronSecretMatches(bearerToken(request), cronSecret)) return null;

  // Query-string secret: only as an explicit opt-in for headerless callers.
  if (queryKeyAllowed()) {
    const key = new URL(request.url).searchParams.get("key");
    if (cronSecretMatches(key, cronSecret)) return null;
  }

  return UNAUTHORIZED();
}
