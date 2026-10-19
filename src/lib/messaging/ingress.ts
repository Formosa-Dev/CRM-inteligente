/**
 * Webhook ingress seam (slice S12) — provider-agnostic glue between
 * `POST /api/webhooks/ingress/[provider]` and the shared inbound pipeline.
 *
 * Responsibilities:
 * - resolveWebhookSecret: per-provider webhook secret. YCloud keeps the
 *   existing `agent_config → env` path via getIntegrationSecrets(); new
 *   providers resolve `${PROVIDER}_WEBHOOK_SECRET` from env until their
 *   agent_config fields land (evidence §5/§6 — zernioApiKey/zernioWebhookSecret
 *   are deferred until the Zernio adapter ships).
 * - resolveEventChannel: NormalizedInboundEvent has no `channel` field (the
 *   contract is frozen per evidence §4). Channel is derived from a raw
 *   `channel`/`platform` hint when the adapter stamps one, else by inverting
 *   the registry's channel→provider map (unambiguous in v1: ycloud→whatsapp).
 * - resolveIngressContext: strict channel_accounts resolution per event.
 *   Tries the event's routing key (`providerAccountId` — wabaId | zernio
 *   accountId | kapso phone_number_id), then the business self-address found
 *   in the raw payload (ycloud `whatsappInboundMessage.to`, echo `from`) so a
 *   row provisioned by sender E.164 still matches. Unmatched on a provisioned
 *   channel resolves `undefined` — fail-closed, never bind a foreign account.
 * - handlePassiveChannelEvent: passive persistence for channels the WhatsApp
 *   app-pipeline can't consume (non-ycloud envelopes). Messages/comments/
 *   echoes persist to conversations + chat_messages stamped with the account;
 *   statuses/lifecycle/other kinds get a structured log + 200 — there is no
 *   `channel_events` table today and schema changes belong to another worker.
 *   The agent/buffer stack stays WhatsApp-bound until S15 generalizes it.
 */

import { NextResponse } from "next/server";

import {
  findOrCreateConversation,
  insertMessage,
  isMessageDuplicate,
} from "@/lib/channels/router";

import { resolveChannelAccount } from "./accounts";
import { channelForProvider, isChannelKind } from "./registry";
import type {
  ChannelAccount,
  ChannelKind,
  MessagingProvider,
  NormalizedInboundEvent,
  ProviderId,
} from "./types";

/** Context threaded through the inbound pipeline for account-aware stamping. */
export interface IngressContext {
  channel: ChannelKind;
  account: ChannelAccount;
  /** Numeric channel_accounts.id — undefined for placeholder accounts. */
  channelAccountId?: number;
}

/**
 * Webhook secret per provider. `ycloud` keeps today's resolution
 * (agent_config → YCLOUD_WEBHOOK_SECRET); other providers read
 * `<PROVIDER>_WEBHOOK_SECRET` from env. Empty string = caller must 401.
 */
export async function resolveWebhookSecret(provider: ProviderId): Promise<string> {
  if (provider === "ycloud") {
    const { getIntegrationSecrets } = await import("@/lib/integrations");
    return (await getIntegrationSecrets()).ycloudWebhookSecret;
  }
  return process.env[`${provider.toUpperCase()}_WEBHOOK_SECRET`] ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `channel_accounts.id` is numeric only for real rows — the placeholder
 * (`{channel}:agent-config`) and caller-resolved ids are strings, which map
 * to undefined so legacy behavior (null columns) is preserved byte-for-byte.
 */
export function channelAccountRowId(
  account: ChannelAccount | undefined
): number | undefined {
  if (!account) return undefined;
  const id = Number(account.id);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

/**
 * Channel for an inbound event: explicit adapter hint on `raw.channel` /
 * `raw.platform` wins; otherwise the channel routed to this provider in the
 * registry. Returns undefined when neither source names a channel.
 */
export function resolveEventChannel(
  provider: MessagingProvider,
  event: NormalizedInboundEvent
): ChannelKind | undefined {
  const raw = isRecord(event.raw) ? event.raw : undefined;
  const hint =
    asNonEmptyString(raw?.channel) ?? asNonEmptyString(raw?.platform);
  if (hint && isChannelKind(hint)) return hint;
  return channelForProvider(provider.id);
}

/**
 * Candidate business-side routing keys for account resolution, after the
 * event's own `providerAccountId`. YCloud echoes expose the sender as the
 * business (`sender.phone`); inbound envelopes carry the business number at
 * `<payload>.whatsappInboundMessage.to`. Kept generic — new providers add
 * their extraction here.
 */
function eventSelfAddresses(event: NormalizedInboundEvent): string[] {
  const out: string[] = [];
  if (event.direction === "outbound" && event.sender.phone) {
    out.push(event.sender.phone);
  }
  const raw = isRecord(event.raw) ? event.raw : undefined;
  for (const key of ["whatsappInboundMessage", "whatsappMessage", "message"]) {
    const node = raw?.[key];
    if (!isRecord(node)) continue;
    const to = asNonEmptyString(node.to);
    if (to) out.push(to);
    if (event.direction === "outbound") {
      const from = asNonEmptyString(node.from);
      if (from) out.push(from);
    }
  }
  return [...new Set(out)];
}

/**
 * Resolve the channel + channel account an event belongs to. Returns
 * undefined when the channel can't be derived or no account matches on a
 * provisioned channel (fail-closed: log + caller acks and skips).
 */
export async function resolveIngressContext(
  provider: MessagingProvider,
  event: NormalizedInboundEvent
): Promise<IngressContext | undefined> {
  const channel = resolveEventChannel(provider, event);
  if (!channel) {
    console.warn(
      `[ingress] ${provider.id} event ${event.deliveryId} skipped — ` +
        `cannot derive channel (kind=${event.kind})`
    );
    return undefined;
  }

  const keys = [
    event.providerAccountId,
    ...eventSelfAddresses(event),
  ].filter((k): k is string => typeof k === "string" && k.length > 0);

  let account: ChannelAccount | undefined;
  if (keys.length === 0) {
    // No routing key at all — unspecified resolution (first active row, or
    // the legacy agent_config placeholder when the channel is unprovisioned).
    account = await resolveChannelAccount(channel);
  } else {
    for (const key of [...new Set(keys)]) {
      account = await resolveChannelAccount(channel, key);
      if (account) break;
    }
  }

  if (!account) {
    console.warn(
      `[ingress] ${provider.id}/${channel} event ${event.deliveryId} skipped — ` +
        `no channel_accounts row matches ` +
        `(providerAccountId=${event.providerAccountId || "n/a"}); fail-closed`
    );
    return undefined;
  }

  return {
    channel,
    account,
    channelAccountId: channelAccountRowId(account),
  };
}

/**
 * Structured ack log for events that are accepted but have no persistence
 * target. Exists because no `channel_events` table exists yet — this is the
 * seam where those rows land once schema work adds the table.
 */
export function logAckedWithoutPersistence(
  event: NormalizedInboundEvent,
  reason?: string
): void {
  console.log(
    `[ingress] ${event.provider} kind=${event.kind} deliveryId=${event.deliveryId}` +
      ` platformMessageId=${event.platformMessageId ?? "n/a"} — acknowledged without persistence` +
      (reason ? ` (${reason})` : "")
  );
}

const PASSIVE_PERSISTED_KINDS = new Set<NormalizedInboundEvent["kind"]>([
  "message.received",
  "message.echo",
  "comment.received",
]);

/**
 * Passive persistence for inbound events on channels other than the
 * WhatsApp/YCloud app pipeline: find-or-create the conversation keyed by
 * (channel, externalUserId), dedup on platformMessageId, and store the
 * content. Echoes persist as role "human" (dedup on the original message id
 * absorbs own-AI echoes). No agent run — agent dispatch for non-WhatsApp
 * channels is deferred until the agent layer is provider-generalized (S15).
 * Never throws: every event is acknowledged 200 so providers don't retry.
 */
export async function handlePassiveChannelEvent(
  event: NormalizedInboundEvent,
  ctx: IngressContext
): Promise<NextResponse> {
  try {
    if (!PASSIVE_PERSISTED_KINDS.has(event.kind)) {
      logAckedWithoutPersistence(
        event,
        `kind '${event.kind}' has no persistence table yet`
      );
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    const externalUserId =
      event.sender.phone ??
      event.sender.socialId ??
      event.sender.bsuid ??
      event.sender.username ??
      event.providerConversationId;
    if (!externalUserId) {
      logAckedWithoutPersistence(event, "no sender identity to key a conversation");
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    if (event.platformMessageId && (await isMessageDuplicate(event.platformMessageId))) {
      console.log(
        `[ingress] Duplicate ${event.kind} ${event.platformMessageId} on ${ctx.channel} — skipping`
      );
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    const { id: conversationId } = await findOrCreateConversation(
      ctx.channel,
      externalUserId,
      event.sender.name ?? event.sender.username ?? undefined,
      event.sender.phone,
      ctx.channelAccountId ?? null
    );

    const text = event.text?.trim() || `[${event.type ?? event.kind}]`;
    const content =
      event.kind === "comment.received" ? `[Comentario]: ${text}` : text;
    const role = event.kind === "message.echo" ? "human" : "user";

    const inserted = await insertMessage(
      conversationId,
      role,
      content,
      undefined,
      event.platformMessageId || undefined,
      ctx.channelAccountId ?? null
    );
    console.log(
      inserted.wasDuplicate
        ? `[ingress] Duplicate ${event.kind} ${event.platformMessageId} — already persisted`
        : `[ingress] Persisted ${event.kind} on ${ctx.channel} conv=${conversationId} account=${ctx.account.id}`
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    // Passive path must never break the webhook ack — provider retries would
    // replay the event; dedup on platformMessageId keeps replays idempotent.
    console.error(
      `[ingress] ${event.provider} kind=${event.kind} deliveryId=${event.deliveryId} — persistence failed, acked:`,
      error
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  }
}
