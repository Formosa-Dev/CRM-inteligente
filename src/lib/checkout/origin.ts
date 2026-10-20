function addConfiguredOrigin(origins: Set<string>, value: string | undefined) {
  if (!value) return;
  try {
    // Deployment URLs may arrive with or without a scheme
    // (RENDER_EXTERNAL_URL is a bare host on some setups).
    const url = value.includes("://") ? value : `https://${value}`;
    origins.add(new URL(url).origin);
  } catch {
    // A malformed optional deployment URL must not disable the checkout.
  }
}

/**
 * Render terminates TLS before forwarding requests to the Next server. In that
 * setup request.url points at the internal container, while Origin keeps the
 * public domain — so the allowlist is built from the CONFIGURED public
 * origins: NEXT_PUBLIC_APP_URL / NEXTAUTH_URL / AUTH_URL, plus
 * RENDER_EXTERNAL_URL which Render injects on every web service.
 *
 * x-forwarded-host/proto are client-supplied unless a trusted proxy sits in
 * front; they are deliberately NOT consulted. request.url itself is built
 * from the client-controlled Host header, so in production it is not enough
 * to legitimize an Origin either — an attacker can send a matching
 * Host/Origin pair. A production deployment without a configured public
 * origin therefore fails closed; outside production (dev/test) request.url
 * remains the only signal and is allowed.
 */
export function isAllowedCheckoutOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  const allowed = new Set<string>();
  addConfiguredOrigin(allowed, process.env.NEXT_PUBLIC_APP_URL);
  addConfiguredOrigin(allowed, process.env.NEXTAUTH_URL);
  addConfiguredOrigin(allowed, process.env.AUTH_URL);
  addConfiguredOrigin(allowed, process.env.RENDER_EXTERNAL_URL);

  if (process.env.NODE_ENV === "production") {
    // Fail closed when no public origin is configured — never widen the
    // allowlist with attacker-influenced headers.
    return allowed.size > 0 && allowed.has(origin);
  }

  allowed.add(new URL(request.url).origin);
  return allowed.has(origin);
}
