/**
 * YCloud adapter — wraps the existing provider modules; nothing moves.
 *
 * Delegation map (`docs/socialcrm/provider-integration-evidence.md` §6):
 * - verifyWebhook → `src/lib/whatsapp/signature.ts` (`t,s` HMAC-SHA256,
 *   timingSafeEqual, 300s tolerance — kept as-is)
 * - sendMessage   → `src/lib/ycloud.ts` sendText/sendImage/sendDocument
 *   (sendDirectly + retry-on-5xx + 20s timeout + wamid capture, unchanged;
 *   credentials still resolve agent_config → env inside those functions
 *   until `channel_accounts` lands in slice B3)
 * - parseWebhook  → normalizes the payloads handled today by
 *   `src/app/api/whatsapp/webhook/route.ts` (inbound, echo, status)
 * - resolveMedia  → same metadata step as `downloadYCloudMedia` in
 *   `src/lib/media/downloader.ts` (GET /v2/whatsapp/media/{id})
 */

import { sendDocument, sendImage, sendText } from "@/lib/ycloud";
import { verifyYCloudSignature } from "@/lib/whatsapp/signature";
import { ECHO_EVENT_TYPES } from "@/lib/whatsapp/webhook-pipeline";
import type {
  MessagingProvider,
  NormalizedInboundEvent,
  SendResult,
} from "../types";

const SIGNATURE_HEADER = "ycloud-signature";
const INBOUND_EVENT_TYPE = "whatsapp.inbound_message.received";
const STATUS_EVENT_TYPE = "whatsapp.message.updated";
const MAX_SIGNATURE_AGE_SEC = 300;

// Same candidate keys the webhook route searches for the echoed message.
const ECHO_MESSAGE_KEYS = [
  "whatsappMessage",
  "whatsappSmbMessageEcho",
  "whatsappSmbMessageEchoes",
  "smbMessage",
  "message",
  "whatsappMessageEcho",
] as const;

const EVENT_ENVELOPE_KEYS = new Set([
  "type",
  "id",
  "createTime",
  "sendTime",
  "apiVersion",
]);

const SUPPORTED_INBOUND_TYPES = new Set([
  "text",
  "image",
  "audio",
  "document",
  "video",
  "location",
  "sticker",
  "interactive",
  "reaction",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getHeader(
  headers: Record<string, string>,
  name: string
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function parseSignatureParts(
  header: string
): { timestamp: string; signature: string } | null {
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const idx = p.indexOf("=");
      if (idx === -1) return [p, ""];
      return [p.slice(0, idx), p.slice(idx + 1)];
    })
  );
  if (!parts["t"] || !parts["s"]) return null;
  return { timestamp: parts["t"], signature: parts["s"] };
}

function classifySignatureFailure(
  header: string | undefined,
  secret: string
): string {
  if (!secret) return "missing_secret";
  if (!header) return "missing_signature_header";
  const parsed = parseSignatureParts(header);
  if (!parsed) return "malformed_signature_header";
  const timestamp = Number.parseInt(parsed.timestamp, 10);
  if (Number.isNaN(timestamp)) return "malformed_signature_header";
  if (Math.abs(Date.now() / 1000 - timestamp) > MAX_SIGNATURE_AGE_SEC) {
    return "expired_timestamp";
  }
  return "signature_mismatch";
}

/** Mirrors the route's multi-key echo extraction (see webhook-pipeline.ts). */
function extractEchoMessage(
  event: Record<string, unknown>
): Record<string, unknown> | undefined {
  for (const key of ECHO_MESSAGE_KEYS) {
    const candidate = event[key];
    if (isRecord(candidate)) return candidate;
  }
  for (const [key, value] of Object.entries(event)) {
    if (EVENT_ENVELOPE_KEYS.has(key)) continue;
    if (isRecord(value) && (value.to !== undefined || value.from !== undefined)) {
      return value;
    }
  }
  return undefined;
}

function normalizeType(
  msgType: unknown
): NonNullable<NormalizedInboundEvent["type"]> {
  const t = asString(msgType);
  if (!t) return "unknown";
  return SUPPORTED_INBOUND_TYPES.has(t)
    ? (t as NonNullable<NormalizedInboundEvent["type"]>)
    : "unknown";
}

function extractMediaRefs(
  message: Record<string, unknown>,
  msgType: string
): NormalizedInboundEvent["mediaRefs"] {
  const media = message[msgType];
  if (!isRecord(media)) return undefined;
  const ref = {
    id: asString(media.id),
    url: asString(media.link) ?? asString(media.url),
    mimeType: asString(media.mime_type) ?? asString(media.mimeType),
    filename: asString(media.file_name) ?? asString(media.filename),
  };
  return ref.id || ref.url ? [ref] : undefined;
}

function extractContextReplyId(
  message: Record<string, unknown>
): string | undefined {
  const ctx = message.context;
  if (!isRecord(ctx)) return undefined;
  return asString(ctx.wamid) ?? asString(ctx.id);
}

function mapStatus(status: unknown): NormalizedInboundEvent["status"] {
  const s = asString(status)?.toLowerCase();
  if (s === "sent" || s === "delivered" || s === "read" || s === "failed") {
    return s;
  }
  return undefined;
}

function baseEvent(
  payload: Record<string, unknown>,
  kind: NormalizedInboundEvent["kind"],
  direction: NormalizedInboundEvent["direction"]
): NormalizedInboundEvent {
  return {
    provider: "ycloud",
    deliveryId: asString(payload.id) ?? "",
    kind,
    direction,
    providerAccountId: "",
    sender: {},
    timestamp:
      asString(payload.sendTime) ??
      asString(payload.createTime) ??
      new Date().toISOString(),
    raw: payload,
  };
}

function normalizeInbound(
  payload: Record<string, unknown>
): NormalizedInboundEvent {
  const event = baseEvent(payload, "message.received", "inbound");
  const message = payload.whatsappInboundMessage;
  if (!isRecord(message)) {
    event.kind = "other";
    return event;
  }

  const profile = isRecord(message.customerProfile)
    ? message.customerProfile
    : undefined;
  const msgType = asString(message.type) ?? "unknown";

  event.deliveryId =
    asString(payload.id) ?? asString(message.wamid) ?? asString(message.id) ?? "";
  event.providerAccountId = asString(message.wabaId) ?? "";
  event.platformMessageId = asString(message.wamid) ?? asString(message.id);
  event.sender = {
    phone: asString(message.from),
    bsuid: asString(message.fromUserId),
    parentBsuid: asString(message.fromParentUserId),
    name: profile ? asString(profile.name) : undefined,
    username: profile ? asString(profile.username) : undefined,
  };
  event.type = normalizeType(message.type);
  event.timestamp = asString(message.sendTime) ?? event.timestamp;

  if (msgType === "text" && isRecord(message.text)) {
    event.text = asString(message.text.body);
  } else {
    const refs = extractMediaRefs(message, msgType);
    if (refs) event.mediaRefs = refs;
    const media = message[msgType];
    const caption = isRecord(media) ? asString(media.caption) : undefined;
    if (caption) event.text = caption;
  }

  const replyTo = extractContextReplyId(message);
  if (replyTo) event.replyToMessageId = replyTo;

  return event;
}

function normalizeEcho(payload: Record<string, unknown>): NormalizedInboundEvent {
  const event = baseEvent(payload, "message.echo", "outbound");
  const message = extractEchoMessage(payload);
  if (!message) return event;

  event.deliveryId =
    asString(payload.id) ?? asString(message.wamid) ?? asString(message.id) ?? "";
  event.providerAccountId = asString(message.wabaId) ?? "";
  event.platformMessageId = asString(message.wamid) ?? asString(message.id);
  // On echoes the business is the sender; the customer lives in `to` (raw).
  event.sender = { phone: asString(message.from) };

  const msgType = asString(message.type) ?? "text";
  event.type = normalizeType(msgType);
  event.timestamp = asString(message.sendTime) ?? event.timestamp;

  if (msgType === "text" && isRecord(message.text)) {
    event.text = asString(message.text.body);
  } else {
    const refs = extractMediaRefs(message, msgType);
    if (refs) event.mediaRefs = refs;
    const media = message[msgType];
    const caption = isRecord(media) ? asString(media.caption) : undefined;
    if (caption) event.text = caption;
  }

  return event;
}

function normalizeStatus(
  payload: Record<string, unknown>
): NormalizedInboundEvent {
  const event = baseEvent(payload, "message.status", "outbound");
  const message =
    ["whatsappMessage", "whatsappMessageUpdated", "message", "status"]
      .map((key) => payload[key])
      .find(isRecord) ?? payload;

  event.platformMessageId = asString(message.wamid) ?? asString(message.id);
  event.providerAccountId = asString(message.wabaId) ?? "";
  event.status = mapStatus(message.status);
  event.timestamp =
    asString(message.updateTime) ?? asString(message.sendTime) ?? event.timestamp;

  return event;
}

function toSendResult(
  res: { ok: true; wamid?: string } | { ok: false; error: string }
): SendResult {
  if (res.ok) {
    // image/document sends return ok without a wamid today (see ycloud.ts).
    return { ok: true, providerMessageId: res.wamid ?? "", status: "sent" };
  }
  // Missing credentials/config is not retryable; upstream 5xx/fetch failures
  // already exhausted their retry budget and may be retried by the caller.
  return {
    ok: false,
    error: res.error,
    retryable: !res.error.startsWith("Missing "),
  };
}

export const ycloudProvider: MessagingProvider = {
  id: "ycloud",
  signatureScheme: "timestamped-hmac",

  verifyWebhook({ headers, rawBody, secret }) {
    const header = getHeader(headers, SIGNATURE_HEADER) ?? "";
    if (!verifyYCloudSignature(rawBody, header, secret)) {
      return { ok: false, reason: classifySignatureFailure(header, secret) };
    }
    return { ok: true };
  },

  parseWebhook({ rawBody }) {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return [];
    }
    if (!isRecord(payload)) return [];

    const type = asString(payload.type);
    if (type === INBOUND_EVENT_TYPE) return [normalizeInbound(payload)];
    if ((ECHO_EVENT_TYPES as readonly string[]).includes(type ?? "")) {
      return [normalizeEcho(payload)];
    }
    if (type === STATUS_EVENT_TYPE) return [normalizeStatus(payload)];
    return [baseEvent(payload, "other", "na")];
  },

  // `_account` is contract-required but unused in v1: credentials keep
  // resolving agent_config → env inside the delegated senders until
  // `channel_accounts` exists (roadmap §2.3 / execution-control §2.3).
  async sendMessage(_account, msg) {
    switch (msg.type) {
      case "text": {
        if (!msg.text) {
          return {
            ok: false,
            error: "text message requires msg.text",
            retryable: false,
          };
        }
        return toSendResult(await sendText(msg.to, msg.text));
      }
      case "image": {
        if (!msg.mediaUrl) {
          return {
            ok: false,
            error: "image message requires msg.mediaUrl",
            retryable: false,
          };
        }
        return toSendResult(await sendImage(msg.to, msg.mediaUrl, msg.text));
      }
      case "document": {
        if (!msg.mediaUrl) {
          return {
            ok: false,
            error: "document message requires msg.mediaUrl",
            retryable: false,
          };
        }
        return toSendResult(await sendDocument(msg.to, msg.mediaUrl, msg.text));
      }
      default:
        return {
          ok: false,
          error: `ycloud adapter does not support outbound type '${msg.type}' yet`,
          retryable: false,
        };
    }
  },

  async resolveMedia(account, ref) {
    if (ref.url && !ref.id) {
      // Allowlist enforcement stays downstream in downloadMedia.
      return { url: ref.url };
    }
    if (!ref.id) {
      throw new Error("resolveMedia requires ref.id or ref.url");
    }
    const apiKey = account.credentials.apiKey;
    if (!apiKey) {
      throw new Error("resolveMedia requires account.credentials.apiKey");
    }

    // Same metadata request as downloadYCloudMedia step 1.
    const metaResp = await fetch(
      `https://api.ycloud.com/v2/whatsapp/media/${ref.id}`,
      {
        headers: { "X-API-Key": apiKey },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!metaResp.ok) {
      throw new Error(`YCloud media metadata failed: ${metaResp.status}`);
    }
    const meta = (await metaResp.json()) as {
      url?: string;
      mime_type?: string;
      file_name?: string;
    };
    if (!meta.url) throw new Error("No media URL returned by YCloud");
    return {
      url: meta.url,
      mimeType: meta.mime_type,
      filename: meta.file_name,
    };
  },
};
