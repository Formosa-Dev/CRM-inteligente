import { createHash } from "crypto";
import type { NormalizedInboundEvent, ProviderId } from "@/lib/messaging";

/**
 * Meta → NormalizedInboundEvent. The envelope's routing key is
 * metadata.phone_number_id; the wamid becomes both deliveryId and
 * platformMessageId (durable dedup). The pipeline reads the provider message
 * off `raw.whatsappInboundMessage` — Meta's message object already uses the
 * same field names (type / text.body / location / media objects), so it is
 * passed through unchanged. `raw.type` carries the inbound envelope marker:
 * without it `isProtocolArtifact` would drop the event before persistence.
 */

/** Meta message object shape the helpers read (media objects pass through). */
export type MetaMessageShape = {
  id?: string;
  from?: string;
  to?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  caption?: string;
  context?: { id?: string; from?: string };
} & Record<string, unknown>;

/** Meta status object under change.value.statuses. */
export type MetaStatusShape = {
  id?: string;
  recipient_id?: string;
  status?: string;
  timestamp?: string;
} & Record<string, unknown>;

const META_MEDIA_TYPES = new Set(["image", "audio", "video", "document", "sticker"]);

const META_EVENT_TYPES = new Set([
  "text",
  "image",
  "audio",
  "video",
  "document",
  "location",
  "sticker",
  "interactive",
  "reaction",
]);

const META_STATUS_VALUES = new Set(["sent", "delivered", "read", "failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metaEventType(
  msg: MetaMessageShape,
  fallbackText: string
): NormalizedInboundEvent["type"] {
  if (msg.type && META_EVENT_TYPES.has(msg.type)) {
    return msg.type as NormalizedInboundEvent["type"];
  }
  return fallbackText ? "text" : "unknown";
}

/** Body for a text message; caption for media; "" otherwise. */
export function metaMessageText(msg: MetaMessageShape): string {
  if (msg.text?.body) return msg.text.body;
  const media = msg.type ? msg[msg.type] : undefined;
  if (isRecord(media) && typeof media.caption === "string") return media.caption;
  return asNonEmptyString(msg.caption) ?? "";
}

/** Meta media objects carry {id, mime_type, sha256, filename?, caption?}. */
function metaMediaRefs(
  msg: MetaMessageShape
): NormalizedInboundEvent["mediaRefs"] {
  if (!msg.type || !META_MEDIA_TYPES.has(msg.type)) return undefined;
  const media = msg[msg.type];
  if (!isRecord(media)) return undefined;
  const id = asNonEmptyString(media.id);
  if (!id) return undefined;
  return [
    {
      id,
      mimeType: asNonEmptyString(media.mime_type),
      filename: asNonEmptyString(media.filename),
    },
  ];
}

function metaTimestamp(timestamp: string | undefined): string {
  const epochSeconds = Number(timestamp);
  return Number.isFinite(epochSeconds)
    ? new Date(epochSeconds * 1000).toISOString()
    : new Date().toISOString();
}

export function metaMessageToInboundEvent(
  msg: MetaMessageShape,
  input: {
    providerAccountId: string;
    senderName?: string;
    text: string;
    provider: ProviderId;
  }
): NormalizedInboundEvent {
  return {
    provider: input.provider,
    deliveryId: msg.id
      ? `meta:${msg.id}`
      : `meta:synth:${createHash("sha256")
          .update(`${msg.from ?? ""}|${msg.timestamp ?? ""}|${input.text}`)
          .digest("hex")
          .slice(0, 24)}`,
    kind: "message.received",
    direction: "inbound",
    providerAccountId: input.providerAccountId,
    platformMessageId: msg.id,
    sender: { phone: msg.from, name: input.senderName },
    type: metaEventType(msg, input.text),
    text: input.text,
    mediaRefs: metaMediaRefs(msg),
    replyToMessageId: msg.context?.id,
    timestamp: metaTimestamp(msg.timestamp),
    raw: { type: "whatsapp.inbound_message.received", whatsappInboundMessage: msg },
  };
}

/**
 * smb_message_echoes — a message sent from the WhatsApp Business app by a
 * human operator, reported to the API app for coexistence. The normalized
 * echo contract: `sender.phone` = the business/operator (`from`),
 * `providerConversationId` = the customer routing key (`to`). raw.type uses
 * the ycloud-shape SMB echo envelope marker so the shared echo extractor
 * (ECHO_MESSAGE_KEYS includes whatsappSmbMessageEchoes) and the
 * protocol-artifact gate (ECHO_EVENT_TYPES) handle it like any other echo.
 */
export function metaEchoToInboundEvent(
  msg: MetaMessageShape,
  input: {
    providerAccountId: string;
    senderName?: string;
    provider: ProviderId;
  }
): NormalizedInboundEvent {
  const text = metaMessageText(msg);
  return {
    provider: input.provider,
    deliveryId: msg.id
      ? `meta:echo:${msg.id}`
      : `meta:echo:synth:${createHash("sha256")
          .update(`${msg.from ?? ""}|${msg.to ?? ""}|${msg.timestamp ?? ""}|${text}`)
          .digest("hex")
          .slice(0, 24)}`,
    kind: "message.echo",
    direction: "outbound",
    providerAccountId: input.providerAccountId,
    providerConversationId: msg.to,
    platformMessageId: msg.id,
    sender: { phone: msg.from, name: input.senderName },
    type: metaEventType(msg, text),
    text,
    mediaRefs: metaMediaRefs(msg),
    replyToMessageId: msg.context?.id,
    timestamp: metaTimestamp(msg.timestamp),
    raw: { type: "whatsapp.smb.message.echoes", whatsappSmbMessageEchoes: msg },
  };
}

/**
 * change.value.statuses — delivery receipt for an outbound message. The
 * status `id` is the wamid of the ORIGINAL message, so the same wamid can
 * produce several status events (sent → delivered → read); the deliveryId
 * discriminates on the status value to keep each deterministic and
 * dedup-safe per (provider, account, deliveryId). Statuses persist to
 * channel_events only — they never drive the agent.
 */
export function metaStatusToInboundEvent(
  status: MetaStatusShape,
  input: {
    providerAccountId: string;
    provider: ProviderId;
  }
): NormalizedInboundEvent {
  const statusValue = asNonEmptyString(status.status);
  return {
    provider: input.provider,
    deliveryId: `meta:status:${status.id ?? "no-id"}:${statusValue ?? "unknown"}`,
    kind: "message.status",
    direction: "outbound",
    providerAccountId: input.providerAccountId,
    providerConversationId: asNonEmptyString(status.recipient_id),
    platformMessageId: status.id,
    sender: { phone: asNonEmptyString(status.recipient_id) },
    type: "unknown",
    status: META_STATUS_VALUES.has(statusValue ?? "")
      ? (statusValue as NormalizedInboundEvent["status"])
      : undefined,
    timestamp: metaTimestamp(status.timestamp),
    raw: { type: "whatsapp.message.status", whatsappInboundMessage: status },
  };
}
