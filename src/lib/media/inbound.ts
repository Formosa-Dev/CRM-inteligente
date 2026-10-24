import "server-only";

import { KAPSO_MEDIA_DOMAINS } from "@/lib/messaging/providers/kapso";
import { ZERNIO_MEDIA_DOMAINS } from "@/lib/messaging/providers/zernio";
import { getProvider } from "@/lib/messaging/registry";
import type {
  ChannelAccount,
  ChannelKind,
  ProviderId,
} from "@/lib/messaging/types";

import { downloadMedia, saveMediaLocally } from "./downloader";

/**
 * Provider-neutral inbound media seam. Wires the normalized `mediaRefs` on
 * an inbound event through the shared media stack:
 *
 *   provider.resolveMedia → anchored allowlist → downloadMedia →
 *   saveMediaLocally → (caller enriches: transcribeAudio /
 *   processImageWithVision / analyzeVideo / extractDocumentText)
 *
 * Each provider's own `resolveMedia` handles its authenticated flow
 * (ycloud two-step, kapso Graph proxy, zernio re-mint Bearer). Domain
 * allowlists stay per-call — `PROVIDER_MEDIA_DOMAINS` feeds the
 * downloader's `extraAllowedDomains` seam, never the global list — and
 * this module re-checks the resolved URL with EXACT + `*.domain`
 * anchored matching before any credential or fetch leaves the process,
 * so `api.kapso.ai.evil.example` can never receive a provider key.
 *
 * Every failure is non-fatal by contract: this module throws, callers
 * catch and keep the `[type]` placeholder — the turn still reaches the
 * agent.
 */

/** Per-event cap on downloadable media refs (multi-file envelopes). */
export const MAX_MEDIA_REFS = 4;

export type InboundMediaRef = {
  id?: string;
  url?: string;
  refreshUrl?: string;
  mimeType?: string;
  filename?: string;
};

export interface DownloadedInboundMedia {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  /** Session-gated `/api/media/<conversationId>/<file>` URL. */
  mediaUrl: string;
}

// Domains the shared downloader already trusts globally — mirrored here so
// the anchored check in this module sees the same effective allowlist.
const GLOBAL_MEDIA_DOMAINS = [
  "api.ycloud.com",
  "cdn.ycloud.com",
  "api.telegram.org",
] as const;

const PROVIDER_MEDIA_DOMAINS: Record<ProviderId, readonly string[]> = {
  // ycloud media is covered by the downloader's global allowlist.
  ycloud: [],
  kapso: KAPSO_MEDIA_DOMAINS,
  zernio: ZERNIO_MEDIA_DOMAINS,
};

/**
 * Anchored suffix match — `host === domain` or a true subdomain.
 * `ycloud.com.attacker.example` must never receive the provider credential.
 */
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Throws unless the resolved URL's host is inside the effective allowlist
 * (global + provider-specific) with anchored matching. Runs BEFORE the
 * fetch so a resolveMedia returning an off-allowlist URL is rejected even
 * though downloadMedia performs its own (unanchored) check.
 */
function assertAllowedMediaUrl(
  provider: ProviderId,
  url: string
): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`Media URL is not parseable: ${url.slice(0, 80)}`);
  }
  const allowed = [...GLOBAL_MEDIA_DOMAINS, ...(PROVIDER_MEDIA_DOMAINS[provider] ?? [])];
  if (!allowed.some((d) => hostMatches(host, d))) {
    throw new Error(`Media host not allowed for ${provider}: ${host}`);
  }
}

/**
 * Auth headers for the resolved download URL, scoped per provider and per
 * host: credentials are sent only to the provider's own endpoints — Meta
 * CDN links arrive pre-signed and get no auth header.
 */
function mediaAuthHeaders(
  provider: ProviderId,
  url: string,
  apiKey: string
): Record<string, string> {
  if (!apiKey) return {};
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return {};
  }
  switch (provider) {
    case "ycloud":
      return hostMatches(host, "ycloud.com") ? { "X-API-Key": apiKey } : {};
    case "kapso":
      return host === "api.kapso.ai" ? { "X-API-Key": apiKey } : {};
    case "zernio":
      return hostMatches(host, "zernio.com")
        ? { Authorization: `Bearer ${apiKey}` }
        : {};
  }
}

/**
 * Media fetch key: the caller-supplied key first (the agent_config value
 * the legacy path already decrypts), then the resolved account's
 * credential, then the provider env scope (same `<PROVIDER>_API_KEY`
 * convention as accounts.ts) — a legacy env-materialized placeholder
 * carries no key and must still resolve media. Never logged.
 */
function mediaApiKey(
  explicit: string | undefined,
  account: ChannelAccount | undefined,
  provider: ProviderId
): string {
  return (
    explicit ||
    account?.credentials.apiKey ||
    process.env[`${provider.toUpperCase()}_API_KEY`] ||
    ""
  );
}

/**
 * The account `resolveMedia` runs against. When the pipeline resolved no
 * account (legacy installs), a synthetic one is built — adapters only read
 * `credentials.apiKey` + `providerAccountId` for media.
 */
function effectiveMediaAccount(input: {
  provider: ProviderId;
  channel: ChannelKind;
  account?: ChannelAccount;
  providerAccountId?: string;
  apiKey: string;
}): ChannelAccount {
  const { account } = input;
  return {
    id: account?.id ?? `${input.channel}:media`,
    tenantId: account?.tenantId ?? "default",
    provider: input.provider,
    channel: input.channel,
    providerAccountId: account?.providerAccountId ?? input.providerAccountId ?? "",
    senderAddress: account?.senderAddress ?? "",
    credentials: {
      apiKey: input.apiKey,
      webhookSecret: account?.credentials.webhookSecret ?? "",
    },
    status: "active",
  };
}

/**
 * Resolve one media ref and persist the bytes locally. Throws on any
 * failure — the caller's catch turns it into the non-fatal placeholder.
 */
export async function downloadInboundMedia(input: {
  provider: ProviderId;
  ref: InboundMediaRef;
  channel: ChannelKind;
  account?: ChannelAccount;
  providerAccountId?: string;
  /** Conversation id — scopes the private uploads dir. */
  conversationId: number;
  /** Legacy fallback key (agent_config.ycloudApiKey, already decrypted). */
  apiKey?: string;
}): Promise<DownloadedInboundMedia> {
  const { provider: providerId, ref } = input;
  const provider = getProvider(providerId);

  const apiKey = mediaApiKey(input.apiKey, input.account, providerId);
  const account = effectiveMediaAccount({ ...input, apiKey });

  let url = ref.url;
  let mimeType = ref.mimeType;
  let fileName = ref.filename;

  if (provider.resolveMedia && (ref.id || ref.refreshUrl || ref.url)) {
    const resolved = await provider.resolveMedia(account, ref);
    url = resolved.url;
    mimeType = resolved.mimeType ?? mimeType;
    fileName = resolved.filename ?? fileName;
  }
  if (!url) {
    throw new Error(`${providerId} media ref produced no download URL`);
  }

  assertAllowedMediaUrl(providerId, url);

  const buffer = await downloadMedia(
    url,
    mediaAuthHeaders(providerId, url, apiKey),
    PROVIDER_MEDIA_DOMAINS[providerId] ?? []
  );

  const effectiveMime = mimeType ?? "application/octet-stream";
  const name = fileName ?? `media-${ref.id ?? "inbound"}`;
  const mediaUrl = await saveMediaLocally(
    buffer,
    input.conversationId,
    name,
    effectiveMime === "application/octet-stream" ? undefined : effectiveMime
  );

  return { buffer, mimeType: effectiveMime, fileName: name, mediaUrl };
}
