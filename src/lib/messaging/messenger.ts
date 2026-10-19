/**
 * Send facade — the single outbound entry point (execution-control §4, S4).
 *
 * `messenger.send()` resolves channel → provider through the registry (v1
 * hard-wires whatsapp → ycloud) and delegates to `provider.sendMessage()`;
 * `type: "template"` prefers `provider.sendTemplate()` when the adapter
 * implements it. Telegram's internal bot is NOT routed through here.
 *
 * Credential modes:
 * - `account`: a fully-resolved `channel_accounts` row (via
 *   `resolveChannelAccount`/`resolveChannelAccountById`). The send is bound
 *   to the account's own provider — a mismatched or unregistered provider
 *   fails closed rather than re-routing to the channel default.
 * - `credentials`: caller-resolved apiKey + sender — the legacy
 *   `ycloud-client` call sites that pull them up-front (agent_config for
 *   the key, env-first for the sender number). The provider sends with
 *   exactly those credentials.
 * - default: a placeholder account with no secrets — the provider's
 *   delegated senders keep resolving credentials agent_config → env.
 */

import { getProvider, hasProvider, providerForChannel } from "./registry";
import type {
  ChannelAccount,
  ChannelKind,
  OutboundMessage,
  ProviderId,
  SendResult,
} from "./types";

export interface ExplicitCredentials {
  apiKey: string;
  /** Sender E.164 (WhatsApp) — the caller's own resolution, kept verbatim. */
  senderAddress: string;
}

export interface SendOptions {
  /** Delivery surface. Defaults to the account's channel, else "whatsapp". */
  channel?: ChannelKind;
  /**
   * Full account override — wins over `credentials`. The send is routed by
   * the account's `provider`, not by the channel's default route.
   */
  account?: ChannelAccount;
  /** Caller-resolved credentials (see file header). */
  credentials?: ExplicitCredentials;
}

/** Carries no secrets: the delegated senders resolve credentials internally. */
function placeholderAccount(
  channel: ChannelKind,
  provider: ProviderId
): ChannelAccount {
  return {
    id: `${channel}:agent-config`,
    tenantId: "default",
    provider,
    channel,
    providerAccountId: "",
    senderAddress: "",
    credentials: { apiKey: "", webhookSecret: "" },
    status: "active",
  };
}

function callerResolvedAccount(
  channel: ChannelKind,
  provider: ProviderId,
  creds: ExplicitCredentials
): ChannelAccount {
  return {
    id: `${channel}:caller-resolved`,
    tenantId: "default",
    provider,
    channel,
    providerAccountId: "",
    senderAddress: creds.senderAddress,
    credentials: { apiKey: creds.apiKey, webhookSecret: "" },
    status: "active",
  };
}

function resolveAccount(
  opts: SendOptions,
  channel: ChannelKind,
  provider: ProviderId
): ChannelAccount {
  if (opts.account) return opts.account;
  if (opts.credentials) {
    return callerResolvedAccount(channel, provider, opts.credentials);
  }
  return placeholderAccount(channel, provider);
}

async function send(
  msg: OutboundMessage,
  opts: SendOptions = {}
): Promise<SendResult> {
  const channel = opts.channel ?? opts.account?.channel ?? "whatsapp";
  // An explicit account binds its own provider — a `kapso` whatsapp account
  // must never be sent through the channel-default adapter, and an
  // unregistered account provider fails closed instead of silently
  // re-routing to `providerForChannel`.
  const provider = opts.account
    ? hasProvider(opts.account.provider)
      ? getProvider(opts.account.provider)
      : undefined
    : providerForChannel(channel);
  if (!provider) {
    return {
      ok: false,
      error: opts.account
        ? `no messaging provider registered for provider '${opts.account.provider}'`
        : `no messaging provider registered for channel '${channel}'`,
      retryable: false,
    };
  }
  const account = resolveAccount(opts, channel, provider.id);
  if (msg.type === "template" && provider.sendTemplate) {
    return provider.sendTemplate(account, msg);
  }
  return provider.sendMessage(account, msg);
}

async function sendTemplate(
  msg: OutboundMessage,
  opts: SendOptions = {}
): Promise<SendResult> {
  return send({ ...msg, type: "template" }, opts);
}

export const messenger = { send, sendTemplate };
