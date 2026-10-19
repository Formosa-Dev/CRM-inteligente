/**
 * Kapso adapter — WhatsApp provider behind the canonical messaging contract.
 *
 * Evidence base: docs/socialcrm/provider-integration-evidence.md §2.3/§4 plus
 * docs.kapso.ai (fetched 2026-10-19). Kapso sends are Meta Graph API-shaped
 * through Kapso's proxy; inbound events are Kapso v2 payloads.
 *
 * Credential rules (unlike ycloud — see accounts.ts):
 * - account.credentials come ONLY from the `channel_accounts` row's
 *   `credentialsRef` (typically `env:KAPSO_*` → KAPSO_API_KEY /
 *   KAPSO_WEBHOOK_SECRET / KAPSO_ACCESS_TOKEN). The adapter never touches
 *   `agent_config` or global env vars — empty credentials fail closed.
 * - The webhook secret at ingress resolves through the existing per-provider
 *   seam `resolveWebhookSecret("kapso")` → `KAPSO_WEBHOOK_SECRET` (same
 *   install-level seam ycloud uses, keyed per provider; absent → route 401s).
 *
 * Id rules (C6): WhatsApp wamids stay BARE in `platformMessageId` — the
 * namespace is Meta-global and echo matching across providers depends on the
 * exact stored form. `deliveryId` = `X-Idempotency-Key` (delivery-level dedup)
 * or a deterministic `kapso:synth:<hash>` fallback.
 *
 * Channel hint: kapso is whatsapp-capable but `whatsapp → ycloud` stays the
 * registry route, so `channelForProvider("kapso")` is undefined. Events stamp
 * `channel: "whatsapp"` on `raw` — the designed `resolveEventChannel` hint —
 * so ingress can derive the channel without touching the registry map.
 *
 * Echo origin: `whatsapp.message.sent` items stamp `echoOrigin: "api"` on
 * `raw` when `message.kapso.origin === "cloud_api"` (API/agent-authored
 * send). Passive persistence maps that to role "assistant"; absent/other
 * origins (business_app) keep role "human".
 *
 * Batch detection: `X-Webhook-Batch` truthy ("true"/"1"/"yes"/"on"),
 * `body.batch` truthy, or a top-level `data[]` all flatten. A flagged
 * envelope without `data[]` warns and falls through to the single-event
 * parse — un-parsed items are never silently acked.
 *
 * [RESEARCH] — open evidence items kept as named seams (one-line corrections):
 * - KAPSO_GRAPH_PROXY_BASE: canonical proxy host (docs show api.kapso.ai/meta/
 *   whatsapp; SDK quickstart shows app.kapso.ai/api/meta/).
 * - kapsoSendIdempotencyHeaders: send idempotency is not documented.
 * - KAPSO_MEDIA_DOMAINS: media CDN host list beyond api.kapso.ai + Meta CDN.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type {
  ChannelAccount,
  MessagingProvider,
  NormalizedInboundEvent,
  OutboundMessage,
  SendResult,
} from "../types";

const SIGNATURE_HEADER = "x-webhook-signature";
const EVENT_HEADER = "x-webhook-event";
const IDEMPOTENCY_HEADER = "x-idempotency-key";
const BATCH_HEADER = "x-webhook-batch";

/** [RESEARCH] canonical Graph-proxy host (evidence §3 open item). */
const KAPSO_GRAPH_PROXY_BASE = "https://api.kapso.ai/meta/whatsapp/v24.0";

/**
 * [RESEARCH] media download allowlist for kapso-resolved media only (C12).
 * `api.kapso.ai` serves `message.kapso.media_url`; Graph media metadata can
 * point at Meta's CDN (`lookaside.fbsbx.com`). Passed to `downloadMedia` as
 * per-call extra domains — never added to the global allowlist.
 */
export const KAPSO_MEDIA_DOMAINS = ["api.kapso.ai", "lookaside.fbsbx.com"];

const SEND_TIMEOUT_MS = 20_000;
const MEDIA_META_TIMEOUT_MS = 10_000;

const MESSAGE_EVENT_KINDS: Record<
  string,
  { kind: NormalizedInboundEvent["kind"]; direction: NormalizedInboundEvent["direction"] }
> = {
  "whatsapp.message.received": { kind: "message.received", direction: "inbound" },
  "whatsapp.message.sent": { kind: "message.echo", direction: "outbound" },
  "whatsapp.message.delivered": { kind: "message.status", direction: "outbound" },
  "whatsapp.message.read": { kind: "message.status", direction: "outbound" },
  "whatsapp.message.failed": { kind: "message.status", direction: "outbound" },
};

const SUPPORTED_MESSAGE_TYPES = new Set([
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

function normalizeType(
  msgType: unknown
): NonNullable<NormalizedInboundEvent["type"]> {
  const t = asString(msgType);
  if (!t || !SUPPORTED_MESSAGE_TYPES.has(t)) return "unknown";
  return t as NonNullable<NormalizedInboundEvent["type"]>;
}

function mapStatus(status: unknown): NormalizedInboundEvent["status"] {
  const s = asString(status)?.toLowerCase();
  if (s === "sent" || s === "delivered" || s === "read" || s === "failed") {
    return s;
  }
  return undefined;
}

/** `message.timestamp` is a Unix epoch string; other fields carry ISO offsets. */
function toIsoTimestamp(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const epoch = Number(raw);
  const date = Number.isFinite(epoch) && /^\d+(\.\d+)?$/.test(raw)
    ? new Date(epoch * 1000)
    : new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Deterministic fallback when no `X-Idempotency-Key` is present: a stable hash
 * over fields that survive redelivery. Keeps id-less events dedupable instead
 * of collapsing onto an empty key (contract §deliveryId).
 */
function syntheticDeliveryId(
  eventName: string | undefined,
  item: Record<string, unknown>,
  batchIndex?: number
): string {
  const message = isRecord(item.message) ? item.message : {};
  const conversation = isRecord(item.conversation) ? item.conversation : {};
  const kapso = isRecord(message.kapso) ? message.kapso : {};
  const basis = JSON.stringify([
    eventName ?? "",
    asString(item.phone_number_id),
    asString(message.id),
    asString(conversation.id),
    asString(message.timestamp) ?? asString(item.timestamp),
    asString(kapso.status),
    batchIndex ?? -1,
  ]);
  return `kapso:synth:${createHash("sha256").update(basis).digest("hex").slice(0, 16)}`;
}

/**
 * Delivery-level dedup key per event. `X-Idempotency-Key` is per DELIVERY, so
 * batch items sharing one key get a stable per-item discriminator (the wamid
 * is Meta-global and survives the batch→individual retry fallback).
 */
function deliveryIdFor(
  deliveryKey: string | undefined,
  eventName: string | undefined,
  item: Record<string, unknown>,
  batchIndex?: number
): string {
  if (!deliveryKey) return syntheticDeliveryId(eventName, item, batchIndex);
  if (batchIndex === undefined) return deliveryKey;
  const message = isRecord(item.message) ? item.message : undefined;
  const discriminator =
    asString(message?.id) ??
    asString(isRecord(item.conversation) ? item.conversation?.id : undefined) ??
    `idx${batchIndex}`;
  return `${deliveryKey}:${discriminator}`;
}

function extractText(
  message: Record<string, unknown>,
  msgType: string
): string | undefined {
  const text = message[msgType];
  if (msgType === "text" && isRecord(message.text)) {
    return asString(message.text.body);
  }
  if (isRecord(text)) {
    const caption = asString(text.caption);
    if (caption) return caption;
  }
  const kapso = isRecord(message.kapso) ? message.kapso : undefined;
  const typeData = isRecord(kapso?.message_type_data)
    ? kapso?.message_type_data
    : undefined;
  const typeCaption = asString(typeData?.caption);
  if (typeCaption) return typeCaption;
  const transcript = isRecord(kapso?.transcript) ? kapso?.transcript : undefined;
  return asString(transcript?.text);
}

function extractMediaRefs(
  message: Record<string, unknown>,
  msgType: string
): NormalizedInboundEvent["mediaRefs"] {
  const kapso = isRecord(message.kapso) ? message.kapso : undefined;
  const mediaData = isRecord(kapso?.media_data) ? kapso?.media_data : undefined;
  const media = isRecord(message[msgType]) ? message[msgType] : undefined;
  const ref = {
    id: asString(media?.id),
    url: asString(kapso?.media_url) ?? asString(mediaData?.url) ?? asString(media?.url),
    mimeType: asString(mediaData?.content_type) ?? asString(media?.mime_type),
    filename: asString(mediaData?.filename) ?? asString(media?.filename),
  };
  return ref.id || ref.url ? [ref] : undefined;
}

function kapsoDirection(
  message: Record<string, unknown>,
  fallback: NormalizedInboundEvent["direction"]
): NormalizedInboundEvent["direction"] {
  const kapso = isRecord(message.kapso) ? message.kapso : undefined;
  const direction = asString(kapso?.direction);
  return direction === "inbound" || direction === "outbound"
    ? direction
    : fallback;
}

function messageSender(
  item: Record<string, unknown>,
  direction: NormalizedInboundEvent["direction"]
): NormalizedInboundEvent["sender"] {
  const message = isRecord(item.message) ? item.message : {};
  const conversation = isRecord(item.conversation) ? item.conversation : {};
  if (direction === "outbound") {
    // Business is the sender on echoes/statuses; the account is identified by
    // providerAccountId (phone_number_id) — no business phone in the payload.
    return {};
  }
  return {
    phone: asString(message.from) ?? asString(conversation.phone_number),
    bsuid:
      asString(message.from_user_id) ??
      asString(conversation.business_scoped_user_id),
    parentBsuid:
      asString(message.from_parent_user_id) ??
      asString(conversation.parent_business_scoped_user_id),
    username: asString(message.username) ?? asString(conversation.username),
    name: asString(conversation.contact_name),
  };
}

function contactSender(item: Record<string, unknown>): NormalizedInboundEvent["sender"] {
  const contact = isRecord(item.contact) ? item.contact : {};
  const conversation = isRecord(item.conversation) ? item.conversation : {};
  return {
    phone: asString(contact.wa_id) ?? asString(conversation.phone_number),
    bsuid:
      asString(contact.business_scoped_user_id) ??
      asString(conversation.business_scoped_user_id),
    parentBsuid:
      asString(contact.parent_business_scoped_user_id) ??
      asString(conversation.parent_business_scoped_user_id),
    username: asString(contact.username) ?? asString(conversation.username),
    name:
      asString(contact.display_name) ??
      asString(contact.profile_name) ??
      asString(conversation.contact_name),
  };
}

function classifyKind(
  eventName: string | undefined
): { kind: NormalizedInboundEvent["kind"]; direction: NormalizedInboundEvent["direction"] } {
  const known = eventName ? MESSAGE_EVENT_KINDS[eventName] : undefined;
  if (known) return known;
  if (eventName?.startsWith("whatsapp.contact.")) {
    return { kind: "account.lifecycle", direction: "na" };
  }
  return { kind: "other", direction: "na" };
}

function normalizeItem(
  item: Record<string, unknown>,
  eventName: string | undefined,
  deliveryKey: string | undefined,
  batchIndex?: number
): NormalizedInboundEvent {
  const { kind, direction: fallbackDirection } = classifyKind(eventName);
  const message = isRecord(item.message) ? item.message : {};
  const conversation = isRecord(item.conversation) ? item.conversation : {};
  const direction =
    kind === "message.received" || kind === "message.echo"
      ? kapsoDirection(message, fallbackDirection)
      : fallbackDirection;
  const msgType = asString(message.type) ?? "unknown";

  const event: NormalizedInboundEvent = {
    provider: "kapso",
    deliveryId: deliveryIdFor(deliveryKey, eventName, item, batchIndex),
    kind,
    direction,
    providerAccountId:
      asString(item.phone_number_id) ?? asString(conversation.phone_number_id) ?? "",
    providerConversationId: asString(conversation.id),
    platformMessageId: asString(message.id), // bare wamid — Meta-global (C6)
    sender:
      kind === "account.lifecycle" || kind === "other"
        ? contactSender(item)
        : messageSender(item, direction),
    type: kind === "other" || kind === "account.lifecycle" ? undefined : normalizeType(msgType),
    timestamp:
      toIsoTimestamp(message.timestamp) ??
      toIsoTimestamp(conversation.last_active_at) ??
      toIsoTimestamp(conversation.updated_at) ??
      new Date().toISOString(),
    // Channel hint for resolveEventChannel — kapso isn't in the
    // channel→provider map (whatsapp stays bound to ycloud in v1).
    raw: { channel: "whatsapp", ...item },
  };

  if (kind === "message.status") {
    const kapso = isRecord(message.kapso) ? message.kapso : undefined;
    event.status =
      mapStatus(kapso?.status) ??
      mapStatus(eventName?.split(".").pop()) ??
      (Array.isArray(kapso?.statuses)
        ? mapStatus(kapso.statuses[kapso.statuses.length - 1]?.status)
        : undefined);
  }

  if (kind === "message.echo") {
    // Like ycloud: the customer is the conversation routing key on echoes.
    event.providerConversationId =
      asString(message.to) ?? asString(conversation.phone_number) ?? event.providerConversationId;
    // kapso.origin separates API-authored sends ("cloud_api") from human
    // Business-app sends — stamped as a normalized raw hint (same seam as
    // raw.channel) so persistence maps agent-authored echoes to role
    // "assistant" instead of a foreign "human" sender.
    const kapso = isRecord(message.kapso) ? message.kapso : undefined;
    if (asString(kapso?.origin) === "cloud_api") {
      (event.raw as Record<string, unknown>).echoOrigin = "api";
    }
  }

  if (kind === "message.received" || kind === "message.echo") {
    const text = extractText(message, msgType);
    if (text) event.text = text;
    const refs = extractMediaRefs(message, msgType);
    if (refs) event.mediaRefs = refs;
    const ctx = isRecord(message.context) ? message.context : undefined;
    const replyTo = asString(ctx?.id) ?? asString(ctx?.message_id);
    if (replyTo) event.replyToMessageId = replyTo;
  }

  return event;
}

function itemEventName(
  item: Record<string, unknown>,
  fallback: string | undefined
): string | undefined {
  return asString(item.event) ?? asString(item.type) ?? fallback;
}

/** "true"/"1"/"yes"/"on" — tolerates non-standard batch-flag values. */
function isTruthyFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "1" || v === "yes" || v === "on";
  }
  return false;
}

/** [RESEARCH] send idempotency — not documented for the Graph proxy. The
 *  standard `Idempotency-Key` header is forwarded only when the caller
 *  provides a key; Kapso silently ignores it if unsupported. Correcting the
 *  mechanism is a one-line change here. */
function kapsoSendIdempotencyHeaders(
  idempotencyKey?: string
): Record<string, string> {
  return idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {};
}

/** [RESEARCH] media metadata path on the proxy — mirrors Meta Graph
 *  `GET /{version}/{media-id}?phone_number_id=…`. */
function kapsoMediaMetadataUrl(mediaId: string, phoneNumberId: string): string {
  const query = phoneNumberId ? `?phone_number_id=${encodeURIComponent(phoneNumberId)}` : "";
  return `${KAPSO_GRAPH_PROXY_BASE}/${encodeURIComponent(mediaId)}${query}`;
}

/** Meta Graph recipient: phones go in `to` (digits), BSUIDs in `recipient`. */
function recipientField(to: string): Record<string, string> {
  const digits = to.replace(/[^\d]/g, "");
  return /^\+?[\d\s()-]+$/.test(to) && digits.length >= 6
    ? { to: digits }
    : { recipient: to };
}

function buildGraphBody(
  msg: OutboundMessage
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const base: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...recipientField(msg.to),
    type: msg.type,
  };
  if (msg.replyToMessageId) {
    base.context = { message_id: msg.replyToMessageId };
  }
  switch (msg.type) {
    case "text": {
      if (!msg.text) return { ok: false, error: "text message requires msg.text" };
      return { ok: true, body: { ...base, text: { body: msg.text } } };
    }
    case "image": {
      if (!msg.mediaUrl) return { ok: false, error: "image message requires msg.mediaUrl" };
      return {
        ok: true,
        body: { ...base, image: { link: msg.mediaUrl, caption: msg.text || "" } },
      };
    }
    case "document": {
      if (!msg.mediaUrl) return { ok: false, error: "document message requires msg.mediaUrl" };
      return {
        ok: true,
        body: {
          ...base,
          document: { link: msg.mediaUrl, caption: msg.text || "" },
        },
      };
    }
    case "interactive": {
      if (msg.interactive === undefined) {
        return { ok: false, error: "interactive message requires msg.interactive" };
      }
      return { ok: true, body: { ...base, interactive: msg.interactive } };
    }
    case "template": {
      const template = msg.template;
      if (!template?.name || !template.language) {
        return {
          ok: false,
          error: "template message requires msg.template.name and msg.template.language",
        };
      }
      return {
        ok: true,
        body: {
          ...base,
          template: {
            name: template.name,
            language: { code: template.language },
            ...(template.components ? { components: template.components } : {}),
          },
        },
      };
    }
    default:
      return { ok: false, error: `kapso adapter does not support outbound type '${msg.type}'` };
  }
}

function accountReadiness(account: ChannelAccount): string | undefined {
  if (!account.credentials.apiKey) {
    return "kapso adapter requires account.credentials.apiKey (channel_accounts row; no env/agent_config fallback)";
  }
  if (!account.providerAccountId) {
    return "kapso adapter requires account.providerAccountId (phone_number_id)";
  }
  return undefined;
}

async function postGraphMessage(
  account: ChannelAccount,
  body: Record<string, unknown>,
  idempotencyKey?: string
): Promise<SendResult> {
  const url = `${KAPSO_GRAPH_PROXY_BASE}/${encodeURIComponent(account.providerAccountId)}/messages`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": account.credentials.apiKey,
        ...kapsoSendIdempotencyHeaders(idempotencyKey),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, retryable: true };
  }

  if (!response.ok) {
    const error = await response.text();
    return {
      ok: false,
      error: `Kapso API error (${response.status}): ${error}`,
      retryable: response.status >= 500 || response.status === 429,
    };
  }

  // Meta Graph response: { messaging_product, contacts:[…], messages:[{id}] }.
  const result = (await response.json().catch(() => ({}))) as {
    messages?: { id?: string }[];
  };
  const providerMessageId = result.messages?.[0]?.id ?? "";
  if (!providerMessageId) {
    return {
      ok: false,
      error: "Kapso send returned no message id",
      retryable: true,
    };
  }
  return { ok: true, providerMessageId, status: "sent" };
}

export const kapsoProvider: MessagingProvider = {
  id: "kapso",
  signatureScheme: "raw-body-hmac",

  verifyWebhook({ headers, rawBody, secret }) {
    if (!secret) return { ok: false, reason: "missing_secret" };
    const header = getHeader(headers, SIGNATURE_HEADER);
    if (!header) return { ok: false, reason: "missing_signature_header" };
    const signature = header.trim().replace(/^sha256=/i, "");
    if (!/^[0-9a-f]{64}$/i.test(signature)) {
      return { ok: false, reason: "malformed_signature_header" };
    }
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature.toLowerCase(), "utf8");
    return a.length === b.length && timingSafeEqual(a, b)
      ? { ok: true }
      : { ok: false, reason: "signature_mismatch" };
  },

  parseWebhook({ headers, rawBody }) {
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return [];
    }
    if (!isRecord(body)) return [];

    const eventName =
      getHeader(headers, EVENT_HEADER) ?? asString(body.event) ?? asString(body.type);
    const deliveryKey = getHeader(headers, IDEMPOTENCY_HEADER);
    const batchHeader = getHeader(headers, BATCH_HEADER);
    const data = body.data;
    // Batch detection tolerates truthy header forms, the body flag, or a
    // bare data[] envelope — anything carrying items must flatten or the
    // route would ack un-parsed data[] entries as a single bogus event.
    if (isTruthyFlag(batchHeader) || isTruthyFlag(body.batch) || Array.isArray(data)) {
      if (!Array.isArray(data)) {
        // Flagged as batch but nothing flattenable — log and fall through
        // to the single-event parse so the envelope is still persisted.
        console.warn(
          `[kapso] batch-flagged delivery ${deliveryKey ?? "n/a"} carries no data[] ` +
            `(header=${batchHeader ?? "absent"} batch=${String(body.batch)}) — parsing as single event`
        );
      } else {
        const items = data.filter(isRecord);
        if (items.length !== data.length) {
          console.warn(
            `[kapso] batch delivery ${deliveryKey ?? "n/a"} — dropped ` +
              `${data.length - items.length} non-object item(s)`
          );
        }
        return items.map((item, index) =>
          normalizeItem(item, itemEventName(item, eventName), deliveryKey, index)
        );
      }
    }
    return [normalizeItem(body, eventName, deliveryKey)];
  },

  async sendMessage(account, msg) {
    const notReady = accountReadiness(account);
    if (notReady) return { ok: false, error: notReady, retryable: false };
    const built = buildGraphBody(msg);
    if (!built.ok) return { ok: false, error: built.error, retryable: false };
    return postGraphMessage(account, built.body, msg.idempotencyKey);
  },

  async sendTemplate(account, msg) {
    const notReady = accountReadiness(account);
    if (notReady) return { ok: false, error: notReady, retryable: false };
    const built = buildGraphBody({ ...msg, type: "template" });
    if (!built.ok) return { ok: false, error: built.error, retryable: false };
    return postGraphMessage(account, built.body, msg.idempotencyKey);
  },

  async resolveMedia(account, ref) {
    if (ref.url && !ref.id) {
      // Allowlist enforcement stays downstream in downloadMedia — callers
      // pass KAPSO_MEDIA_DOMAINS for kapso-resolved media (C12).
      return { url: ref.url };
    }
    if (!ref.id) {
      throw new Error("resolveMedia requires ref.id or ref.url");
    }
    const apiKey = account.credentials.apiKey;
    if (!apiKey) {
      throw new Error("resolveMedia requires account.credentials.apiKey");
    }

    // Graph media flow via the Kapso proxy: GET /{media-id} → {url,mime_type}.
    const metaResp = await fetch(
      kapsoMediaMetadataUrl(ref.id, account.providerAccountId),
      {
        headers: { "X-API-Key": apiKey },
        signal: AbortSignal.timeout(MEDIA_META_TIMEOUT_MS),
      }
    );
    if (!metaResp.ok) {
      throw new Error(`Kapso media metadata failed: ${metaResp.status}`);
    }
    const meta = (await metaResp.json()) as {
      url?: string;
      mime_type?: string;
      file_name?: string;
    };
    if (!meta.url) throw new Error("No media URL returned by Kapso");
    return {
      url: meta.url,
      mimeType: meta.mime_type,
      filename: meta.file_name,
    };
  },
};
