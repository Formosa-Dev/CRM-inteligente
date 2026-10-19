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
 *   The legacy placeholder for unprovisioned/un-migrated installs applies
 *   only to ycloud — non-ycloud providers fail closed the same way.
 * - handlePassiveChannelEvent: passive persistence for channels the WhatsApp
 *   app-pipeline can't consume (non-ycloud envelopes). Messages/comments/
 *   echoes persist to conversations + chat_messages stamped with the account;
 *   status/lifecycle/other kinds persist to `channel_events` via
 *   persistChannelEvent (a positively identified missing schema acks 200;
 *   any other failure is retryable). The agent/buffer stack stays
 *   WhatsApp-bound until S15 generalizes it.
 */

import { NextResponse } from "next/server";

import {
  findOrCreateConversation,
  insertMessage,
  isMessageDuplicate,
  stampConversationThreadId,
} from "@/lib/channels/router";

import {
  ChannelAccountResolutionError,
  resolveChannelAccount,
  resolveChannelAccountStrict,
} from "./accounts";
import { isChannelDeliveryRecorded, persistChannelEvent } from "./channel-events";
import { classifyError } from "./errors";
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
 * event's own `providerAccountId`.
 *
 * Direction is load-bearing: on inbound events `to` is the business number;
 * on echoes/status events `to` is the CUSTOMER and only `from` (plus the
 * normalized `sender.phone`) may identify the business. A customer address
 * must never become an account-resolution candidate.
 */
export function eventSelfAddresses(event: NormalizedInboundEvent): string[] {
  const out: string[] = [];
  if (event.direction === "outbound" && event.sender.phone) {
    out.push(event.sender.phone);
  }
  const raw = isRecord(event.raw) ? event.raw : undefined;
  const outbound = event.direction === "outbound";
  for (const key of [
    "whatsappInboundMessage",
    "whatsappMessage",
    "whatsappMessageUpdated",
    "message",
    "status",
  ]) {
    const node = raw?.[key];
    if (!isRecord(node)) continue;
    if (outbound) {
      const from = asNonEmptyString(node.from);
      if (from) out.push(from);
    } else {
      const to = asNonEmptyString(node.to);
      if (to) out.push(to);
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

  const resolution = await resolveChannelAccountStrict(
    channel,
    keys,
    provider.id
  );

  if (resolution.kind === "db-error") {
    // Retryable: the route/pipeline maps this to 503, never a silent ack.
    throw new ChannelAccountResolutionError(resolution);
  }
  if (resolution.kind === "not-found" || resolution.kind === "mismatch") {
    console.warn(
      `[ingress] ${provider.id}/${channel} event ${event.deliveryId} skipped — ` +
        `${
          resolution.kind === "mismatch"
            ? resolution.reason
            : `no channel_accounts row matches providerAccountId=${event.providerAccountId || "n/a"}`
        }; fail-closed`
    );
    return undefined;
  }

  // resolved → the matched row. unprovisioned/schema-not-ready → the
  // secret-less legacy placeholder, which exists only for ycloud installs.
  // Non-ycloud providers have no legacy installs to protect — they take the
  // same fail-closed skip as not-found/mismatch.
  if (resolution.kind !== "resolved" && provider.id !== "ycloud") {
    console.warn(
      `[ingress] ${provider.id}/${channel} event ${event.deliveryId} skipped — ` +
        `channel_accounts ${resolution.kind}; legacy fallback is ycloud-only — fail-closed`
    );
    return undefined;
  }

  const account =
    resolution.kind === "resolved"
      ? resolution.account
      : await resolveChannelAccount(channel, undefined, provider.id);
  if (!account) {
    console.warn(
      `[ingress] ${provider.id}/${channel} event ${event.deliveryId} skipped — ` +
        `no registered provider for channel '${channel}'`
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
 * target (protocol artifacts, unsupported kinds, unresolvable account
 * identities). Status/lifecycle kinds DO have a target — they persist to
 * `channel_events` via persistChannelEvent before reaching here.
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

/**
 * Identity key for passive persistence. Echoes carry the BUSINESS in
 * `sender.phone` and the CUSTOMER in `providerConversationId` — keying an echo
 * by the business number would merge every customer into one conversation.
 */
export function eventConversationExternalUserId(
  event: NormalizedInboundEvent
): string | undefined {
  if (event.kind === "message.echo") {
    return (
      event.providerConversationId ??
      event.sender.socialId ??
      event.sender.bsuid ??
      event.sender.username
    );
  }
  return (
    event.sender.phone ??
    event.sender.socialId ??
    event.sender.bsuid ??
    event.sender.username ??
    event.providerConversationId
  );
}

const PASSIVE_PERSISTED_KINDS = new Set<NormalizedInboundEvent["kind"]>([
  "message.received",
  "message.echo",
  "comment.received",
]);

/**
 * Persisted role for passive message kinds. Echoes are operator-authored
 * ("human") unless the adapter stamped `raw.echoOrigin === "api"` — the
 * normalized hint for API/agent-authored sends (kapso `cloud_api`) —
 * which maps to "assistant" instead of a foreign human sender. Unknown or
 * absent origins keep "human" (status quo).
 */
export function passiveMessageRole(
  event: NormalizedInboundEvent
): "user" | "assistant" | "human" {
  if (event.kind !== "message.echo") return "user";
  const raw = isRecord(event.raw) ? event.raw : undefined;
  return asNonEmptyString(raw?.echoOrigin) === "api" ? "assistant" : "human";
}

/**
 * Thread id worth persisting to `conversations.external_thread_id` — the
 * send-routing handle for conversation-scoped providers (zernio). The
 * dedicated `providerThreadId` always wins; `providerConversationId` is only
 * a fallback on NON-echo events, where it is a true conversation id (kapso
 * conv.id, zernio conversation.id). Echoes carry the CUSTOMER key there —
 * stamping it would store a phone number as a thread id and mis-route
 * future thread-scoped sends.
 */
export function eventThreadId(
  event: NormalizedInboundEvent
): string | undefined {
  if (event.providerThreadId) return event.providerThreadId;
  if (event.kind === "message.echo") return undefined;
  return event.providerConversationId;
}

/**
 * Passive persistence for inbound events on channels other than the
 * WhatsApp/YCloud app pipeline: find-or-create the conversation keyed by
 * (channel, externalUserId), dedup on deliveryId (channel_events marker)
 * then platformMessageId (chat_messages), and store the content. Echoes
 * persist as role "human" unless the adapter stamped raw.echoOrigin="api"
 * (kapso cloud_api sends → "assistant"); own-API echoes are also absorbed
 * by the platformMessageId dedup. No agent run — agent dispatch for
 * non-WhatsApp channels is deferred until the agent layer is
 * provider-generalized (S15). Never throws: every event is acknowledged
 * 200 so providers don't retry.
 */
export async function handlePassiveChannelEvent(
  event: NormalizedInboundEvent,
  ctx: IngressContext
): Promise<NextResponse> {
  try {
    if (!PASSIVE_PERSISTED_KINDS.has(event.kind)) {
      const persisted = await persistChannelEvent(event, {
        channel: ctx.channel,
        account: ctx.account,
        channelAccountId: ctx.channelAccountId,
      });
      if (persisted.kind === "schema-not-ready") {
        console.warn(
          `[ingress] channel_events schema not ready — ${event.provider}/${event.kind} ` +
            `${event.deliveryId} acknowledged without persistence (migration pending)`
        );
      }
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    const externalUserId = eventConversationExternalUserId(event);
    if (!externalUserId) {
      logAckedWithoutPersistence(event, "no sender identity to key a conversation");
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    /** Delivery marker claimed in channel_events (provider+deliveryId unique)
     * after a handled delivery — best-effort: the message row is already
     * durable, so a failed marker only weakens deliveryId dedup (documented
     * residual for id-less replays under a rotated delivery key). */
    const markDeliveryHandled = async () => {
      try {
        const marker = await persistChannelEvent(event, {
          channel: ctx.channel,
          account: ctx.account,
          channelAccountId: ctx.channelAccountId,
        });
        if (marker.kind === "schema-not-ready") {
          console.warn(
            `[ingress] channel_events schema not ready — ${event.provider}/${event.deliveryId} ` +
              `dedups on platformMessageId only`
          );
        }
      } catch (markerError) {
        console.warn(
          `[ingress] delivery marker write failed for ${event.provider}/${event.deliveryId} — ` +
            `deliveryId dedup degraded`,
          markerError
        );
      }
    };

    // Delivery-level dedup first: the same X-Idempotency-Key redelivery is
    // already fully handled even when the message carried no wamid.
    if (
      await isChannelDeliveryRecorded(
        event.provider,
        event.deliveryId,
        ctx.channelAccountId ?? null
      )
    ) {
      console.log(
        `[ingress] Duplicate delivery ${event.provider}:${event.deliveryId} on ${ctx.channel} — skipping`
      );
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    if (event.platformMessageId && (await isMessageDuplicate(event.platformMessageId))) {
      console.log(
        `[ingress] Duplicate ${event.kind} ${event.platformMessageId} on ${ctx.channel} — skipping`
      );
      await markDeliveryHandled();
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    const { id: conversationId } = await findOrCreateConversation(
      ctx.channel,
      externalUserId,
      event.sender.name ?? event.sender.username ?? undefined,
      event.sender.phone,
      ctx.channelAccountId ?? null
    );

    // Provider-native thread id → conversations.external_thread_id, the
    // send-routing handle for conversation-scoped providers (zernio). Echoes
    // key providerConversationId by the customer, so the thread arrives on
    // providerThreadId instead.
    const threadId = eventThreadId(event);
    if (threadId) {
      await stampConversationThreadId(conversationId, threadId);
    }

    const text = event.text?.trim() || `[${event.type ?? event.kind}]`;
    const content =
      event.kind === "comment.received" ? `[Comentario]: ${text}` : text;
    const role = passiveMessageRole(event);

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
        : `[ingress] Persisted ${event.kind} on ${ctx.channel} conv=${conversationId} account=${ctx.account.id} role=${role}`
    );
    await markDeliveryHandled();
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    // Transient persistence failures must be retried, not acked/dropped.
    // Conversation/message dedup on platformMessageId keeps replays idempotent;
    // channel_events dedups on provider delivery id.
    console.error(
      `[ingress] ${event.provider} kind=${event.kind} deliveryId=${event.deliveryId} — persistence failed`,
      error
    );
    return NextResponse.json(
      { error: "event-persistence-failed" },
      { status: classifyError(error) === "retryable-db" ? 503 : 500 }
    );
  }
}
