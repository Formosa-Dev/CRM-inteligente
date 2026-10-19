/**
 * Zernio embedded-connect + webhook-provisioning helpers (S16).
 *
 * Evidence: docs.zernio.com/guides/connecting-accounts.mdx,
 * platforms/whatsapp.mdx, profiles/list-profiles.mdx, webhooks.mdx.
 *
 * Flow: `GET /v1/connect/{platform}?profileId&redirect_url` returns
 * `{authUrl}` — the operator's browser is sent there, and after approval
 * Zernio redirects back to `redirect_url` with
 * `connected={platform}&profileId&accountId&username` appended. WhatsApp
 * adds `onboarding=api` for the Embedded Signup variant. Facebook keeps
 * STANDARD mode: Zernio hosts the Page-selection screen itself, so the
 * callback still lands with a final `accountId`.
 *
 * Credentials: these calls use the same env API key the channel_accounts
 * row later references via `env:ZERNIO_` — nothing is stored in the DB.
 */

import type { ChannelKind } from "../types";

const API_BASE = "https://zernio.com/api/v1";
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * One-shot nonce cookie issued by startZernioConnect and verified on the
 * callback — the `state` param rides inside OUR redirect_url query string
 * (Zernio preserves it through the OAuth roundtrip).
 */
export const ZERNIO_CONNECT_STATE_COOKIE = "zernio_connect_state";

/**
 * Platforms offered a one-click connect button. Telegram/Bluesky etc. are
 * credential-connect platforms (bot token), not OAuth — they stay on the
 * manual form. Reddit is OAuth-capable per the scopes table.
 */
export const ZERNIO_CONNECT_PLATFORMS = [
  "whatsapp",
  "instagram",
  "facebook",
  "reddit",
] as const satisfies readonly ChannelKind[];

export type ZernioConnectPlatform = (typeof ZERNIO_CONNECT_PLATFORMS)[number];

export function isZernioConnectPlatform(
  value: string
): value is ZernioConnectPlatform {
  return (ZERNIO_CONNECT_PLATFORMS as readonly string[]).includes(value);
}

interface ZernioApiResult<T> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string;
}

async function zernioGet<T>(path: string, apiKey: string): Promise<ZernioApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };
  if (!response.ok) {
    const code = payload.code ? ` [${payload.code}]` : "";
    return {
      ok: false,
      status: response.status,
      error: `Zernio API error (${response.status})${code}: ${payload.error ?? ""}`.trim(),
    };
  }
  return { ok: true, status: response.status, data: payload as T };
}

/**
 * The profile that owns connected accounts. `ZERNIO_PROFILE_ID` env wins;
 * otherwise the first profile — the API sorts default-first.
 */
export async function resolveZernioProfileId(
  apiKey: string
): Promise<{ ok: true; profileId: string } | { ok: false; error: string }> {
  const envProfile = process.env.ZERNIO_PROFILE_ID?.trim();
  if (envProfile) return { ok: true, profileId: envProfile };
  const res = await zernioGet<{ profiles?: { id?: string }[] }>(
    "/profiles",
    apiKey
  );
  if (!res.ok) return { ok: false, error: res.error ?? "profiles list failed" };
  const profileId = res.data?.profiles?.[0]?.id;
  if (!profileId) {
    return {
      ok: false,
      error:
        "Zernio returned no profiles — create one in the Zernio dashboard or set ZERNIO_PROFILE_ID",
    };
  }
  return { ok: true, profileId };
}

/**
 * Start OAuth/embedded-signup: returns the `authUrl` the admin's browser
 * must visit. `whatsapp` uses `onboarding=api` (Embedded Signup).
 */
export async function getZernioConnectUrl(input: {
  platform: ZernioConnectPlatform;
  profileId: string;
  redirectUrl: string;
  apiKey: string;
}): Promise<{ ok: true; authUrl: string } | { ok: false; error: string }> {
  const params = new URLSearchParams({
    profileId: input.profileId,
    redirect_url: input.redirectUrl,
  });
  if (input.platform === "whatsapp") params.set("onboarding", "api");
  const res = await zernioGet<{ authUrl?: string }>(
    `/connect/${input.platform}?${params}`,
    input.apiKey
  );
  if (!res.ok) return { ok: false, error: res.error ?? "connect-url failed" };
  const authUrl = res.data?.authUrl;
  if (!authUrl) {
    return { ok: false, error: "Zernio connect response had no authUrl" };
  }
  return { ok: true, authUrl };
}

/**
 * Best-effort hydration of a just-connected account. `search` accepts an
 * exact account id; we pick the row whose own id matches. Used to fill
 * senderAddress/displayName — never fatal: the callback falls back to the
 * `username` param when this fails.
 */
export async function fetchZernioAccount(
  apiKey: string,
  accountId: string
): Promise<{
  username?: string;
  displayName?: string;
  platformUserId?: string;
  phoneNumber?: string;
} | null> {
  const res = await zernioGet<{
    accounts?: Record<string, unknown>[];
  }>(`/accounts?search=${encodeURIComponent(accountId)}`, apiKey);
  if (!res.ok) return null;
  const row = res.data?.accounts?.find(
    (a) => (a.id ?? a._id) === accountId
  );
  if (!row) return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    username: str(row.username),
    displayName: str(row.displayName ?? row.name),
    platformUserId: str(row.platformUserId ?? row.platform_user_id),
    phoneNumber: str(row.phoneNumber ?? row.phone_number),
  };
}

/** Events SocialCRM consumes — mirrored by ingress parsing (B5). */
const ZERNIO_WEBHOOK_EVENTS = [
  "message.received",
  "message.sent",
  "message.delivered",
  "message.read",
  "message.failed",
  "comment.received",
  "conversation.started",
  "account.connected",
  "account.disconnected",
] as const;

/**
 * Register our ingress endpoint inside Zernio (`POST /v1/webhooks/settings`).
 * The secret is caller-chosen — we send `ZERNIO_WEBHOOK_SECRET` so the same
 * value verifies inbound signatures. Idempotent by URL: an existing setting
 * for the same URL is reported, not duplicated.
 */
export async function registerZernioWebhook(input: {
  url: string;
  secret: string;
  apiKey: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/webhooks/settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        name: "socialcrm-ingress",
        url: input.url,
        secret: input.secret,
        events: [...ZERNIO_WEBHOOK_EVENTS],
      }),
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };
  if (!response.ok) {
    const code = payload.code ? ` [${payload.code}]` : "";
    return {
      ok: false,
      error: `Zernio API error (${response.status})${code}: ${payload.error ?? ""}`.trim(),
    };
  }
  return { ok: true };
}
