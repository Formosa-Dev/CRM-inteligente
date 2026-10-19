/**
 * Canonical public origin for this install, used to build absolute URLs
 * in root metadata (metadataBase), robots.txt and the sitemap.
 * NEXT_PUBLIC_APP_URL is the deploy-time source of truth; the localhost
 * fallback keeps dev builds emitting resolvable URLs.
 */
export function getSiteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!raw) return "http://localhost:3000";
  try {
    return new URL(raw.startsWith("http") ? raw : `https://${raw}`).origin;
  } catch {
    return "http://localhost:3000";
  }
}
