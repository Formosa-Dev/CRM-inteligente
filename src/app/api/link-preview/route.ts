import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/require-admin";
import dns from "dns/promises";
import http from "node:http";
import https from "node:https";

interface OgData {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

const MAX_HTML_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 5000;

const PRIVATE_HOSTNAME = /^(localhost|.*\.localhost|.*\.internal|.*\.local)$/i;

// Loopback, RFC1918, link-local, CGNAT (100.64/10), unspecified/broadcast
// and multicast/reserved space.
const PRIVATE_V4 =
  /^(0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|^2([2-9][4-9]|[3-5]\d)\./;

export function isPrivateIp(ip: string): boolean {
  let v = ip.trim().toLowerCase();
  if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1);
  // IPv4-mapped IPv6 (::ffff:1.2.3.4 / [::ffff:1.2.3.4]) — evaluate the
  // embedded IPv4 against the same ranges instead of missing it entirely.
  const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) v = mapped[1];
  else if (v.includes(":")) {
    // IPv6: unspecified (::), loopback (::1), link-local fe80::/10,
    // ULA fc00::/7, multicast ff00::/8 and any leftover mapped/hex form.
    return (
      v === "::" ||
      v === "::1" ||
      /^fe[89ab]/.test(v) ||
      /^f[cd]/.test(v) ||
      v.startsWith("ff") ||
      v.startsWith("::ffff:")
    );
  }
  return PRIVATE_V4.test(v);
}

interface ResolvedTarget {
  address: string;
  family: 4 | 6;
}

/**
 * Resolves the hostname and validates EVERY answer — a multi-record rotation
 * must not smuggle an internal IP past a single lookup. Returns the address
 * the connection will be pinned to, or null when the target is unsafe.
 */
async function resolveSafeTarget(hostname: string): Promise<ResolvedTarget | null> {
  if (PRIVATE_HOSTNAME.test(hostname) || isPrivateIp(hostname)) return null;
  try {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0) return null;
    if (addresses.some((a) => isPrivateIp(a.address))) return null;
    const first = addresses[0];
    return { address: first.address, family: first.family as 4 | 6 };
  } catch {
    return null;
  }
}

/**
 * Fetches `url` with DNS pinned to the already-validated address: the
 * socket's lookup() is overridden, closing the rebind window between "check"
 * and "connect" that a separate fetch() re-resolution leaves open. TLS SNI
 * and cert validation still use the URL hostname — servername comes from the
 * request options, not the lookup result. Redirects are refused and the body
 * is capped at MAX_HTML_BYTES (declared or actual).
 */
function fetchPinned(
  url: URL,
  target: ResolvedTarget
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      url,
      {
        lookup: (_hostname, _options, callback) =>
          callback(null, target.address, target.family),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; MuzappBot/1.0; +https://muzapp.com)",
          Accept: "text/html",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          reject(new Error(`redirect refused (${status})`));
          return;
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) {
          res.resume();
          reject(new Error("content-length exceeds cap"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_HTML_BYTES) {
            req.destroy(new Error("response exceeds cap"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({ status, body: Buffer.concat(chunks).toString("utf8") })
        );
        res.on("error", reject);
      }
    );
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Fetch OG metadata from a URL for link previews.
 * Requires an authenticated admin session — it is a server-side fetch (SSRF surface).
 */
export async function GET(request: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const url = request.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return NextResponse.json({ error: "Invalid url scheme" }, { status: 400 });
  }

  const target = await resolveSafeTarget(parsed.hostname);
  if (!target) {
    return NextResponse.json({ error: "URL not allowed" }, { status: 403 });
  }

  try {
    const { status, body: html } = await fetchPinned(parsed, target);

    if (status < 200 || status >= 300) {
      return NextResponse.json({ url, title: null, description: null, image: null, siteName: null });
    }

    const og: OgData = {
      url,
      title: extractMeta(html, "og:title") || extractMeta(html, "twitter:title") || "",
      description: extractMeta(html, "og:description") || extractMeta(html, "twitter:description") || "",
      image: extractMeta(html, "og:image") || extractMeta(html, "twitter:image") || null,
      siteName: extractMeta(html, "og:site_name") || null,
    };

    // Fallback: use <title> if no OG title
    if (!og.title) {
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      og.title = titleMatch?.[1]?.trim() ?? null;
    }

    return NextResponse.json(og, {
      headers: { "Cache-Control": "private, max-age=3600" },
    });
  } catch {
    return NextResponse.json({ url, title: null, description: null, image: null, siteName: null });
  }
}

function extractMeta(html: string, property: string): string | null {
  // Try property="..." first (OG standard), then name="..." (Twitter)
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`, "i"),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}
