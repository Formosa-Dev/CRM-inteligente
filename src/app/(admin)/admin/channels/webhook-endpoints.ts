import type { ProviderId } from "@/lib/messaging/types";

/** Public base URL — same fallback chain as telegram/meta actions. */
export function publicBaseUrl(): string | null {
  const raw =
    process.env.AUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
    process.env.RENDER_EXTERNAL_URL;
  return raw ? raw.replace(/\/$/, "") : null;
}

/**
 * Webhook endpoints to paste into each provider's console. Shown on
 * /admin/channels — the values need the public URL to be reachable from
 * the internet (AUTH_URL / NEXT_PUBLIC_APP_URL / VERCEL_URL /
 * RENDER_EXTERNAL_URL).
 */
export function webhookEndpoints(baseUrl: string): {
  provider: ProviderId;
  url: string;
  note?: string;
}[] {
  return [
    {
      provider: "ycloud",
      url: `${baseUrl}/api/webhooks/ingress/ycloud`,
      note: "También sigue funcionando el endpoint legado /api/whatsapp/webhook",
    },
    { provider: "zernio", url: `${baseUrl}/api/webhooks/ingress/zernio` },
    { provider: "kapso", url: `${baseUrl}/api/webhooks/ingress/kapso` },
  ];
}
