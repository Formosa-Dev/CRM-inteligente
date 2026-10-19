/**
 * Provider registry — explicit map, no magic discovery.
 *
 * v1 wires exactly one route: channel 'whatsapp' → provider 'ycloud'
 * (evidence doc §5). Zernio/Kapso land here when their adapters exist;
 * `channel_accounts` rows replace the hard-coded channel route in B3.
 */

import { ycloudProvider } from "./providers/ycloud";
import type { ChannelKind, MessagingProvider, ProviderId } from "./types";

const PROVIDERS = new Map<ProviderId, MessagingProvider>([
  [ycloudProvider.id, ycloudProvider],
]);

const CHANNEL_PROVIDER = new Map<ChannelKind, ProviderId>([
  ["whatsapp", "ycloud"],
]);

export function getProvider(id: ProviderId): MessagingProvider {
  const provider = PROVIDERS.get(id);
  if (!provider) {
    throw new Error(`No messaging provider registered for '${id}'`);
  }
  return provider;
}

export function hasProvider(id: ProviderId): boolean {
  return PROVIDERS.has(id);
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
