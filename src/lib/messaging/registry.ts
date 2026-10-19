/**
 * Provider registry — explicit map, no magic discovery.
 *
 * v1 wires exactly one route: channel 'whatsapp' → provider 'ycloud'
 * (evidence doc §5). Kapso and Zernio are registered (reachable via
 * POST /api/webhooks/ingress/{kapso,zernio}) but not channel-routed — the
 * whatsapp binding stays ycloud in v1 and social channels resolve through
 * `channel_accounts` rows, not this map. `channel_accounts` rows replace the
 * hard-coded channel route in B3.
 */

import { kapsoProvider } from "./providers/kapso";
import { ycloudProvider } from "./providers/ycloud";
import { zernioProvider } from "./providers/zernio";
import type { ChannelKind, MessagingProvider, ProviderId } from "./types";

const PROVIDERS = new Map<ProviderId, MessagingProvider>([
  [ycloudProvider.id, ycloudProvider],
  [kapsoProvider.id, kapsoProvider],
  [zernioProvider.id, zernioProvider],
]);

const CHANNEL_PROVIDER = new Map<ChannelKind, ProviderId>([
  ["whatsapp", "ycloud"],
]);

/** All contract provider ids — registered or not (evidence §4 union). */
export const PROVIDER_IDS: ProviderId[] = ["ycloud", "zernio", "kapso"];

/** All contract channels — kept in sync with `channelEnum` (schema) and `ChannelKind`. */
export const CHANNEL_KINDS: ChannelKind[] = [
  "whatsapp",
  "instagram",
  "facebook",
  "telegram",
  "sms",
  "reddit",
];

export function isProviderId(value: string): value is ProviderId {
  return PROVIDER_IDS.includes(value as ProviderId);
}

export function isChannelKind(value: string): value is ChannelKind {
  return CHANNEL_KINDS.includes(value as ChannelKind);
}

export function getProvider(id: ProviderId): MessagingProvider {
  const provider = PROVIDERS.get(id);
  if (!provider) {
    throw new Error(`No messaging provider registered for '${id}'`);
  }
  return provider;
}

export function hasProvider(id: string): boolean {
  return PROVIDERS.has(id as ProviderId);
}

/**
 * Inverse of CHANNEL_PROVIDER — first channel routed to this provider.
 * Unambiguous in v1 (whatsapp → ycloud only); when one provider serves
 * several channels, event-level channel hints win (see ingress.ts).
 */
export function channelForProvider(id: ProviderId): ChannelKind | undefined {
  for (const [channel, providerId] of CHANNEL_PROVIDER) {
    if (providerId === id) return channel;
  }
  return undefined;
}

export function listProviders(): MessagingProvider[] {
  return [...PROVIDERS.values()];
}

/** Hard-coded channel → provider routing (single install, v1). */
export function providerForChannel(
  channel: ChannelKind
): MessagingProvider | undefined {
  const id = CHANNEL_PROVIDER.get(channel);
  return id ? PROVIDERS.get(id) : undefined;
}
