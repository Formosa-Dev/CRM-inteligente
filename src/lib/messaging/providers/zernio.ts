/**
 * Zernio adapter — social-channel provider (Instagram/Facebook DMs, WhatsApp
 * alternative) behind the canonical messaging contract.
 *
 * Evidence base: docs/socialcrm/provider-integration-evidence.md §2.2/§4,
 * re-verified against docs.zernio.com MDX sources (webhooks/inbox.mdx,
 * messages/send-inbox-message.mdx, messages/create-inbox-conversation.mdx).
 *
 * Credential rules (same posture as kapso — no fallbacks):
 * - account.credentials come ONLY from the `channel_accounts` row's
 *   `credentialsRef` (typically `env:ZERNIO_*` → ZERNIO_API_KEY /
 *   ZERNIO_WEBHOOK_SECRET). The adapter never touches `agent_config` or
 *   global env vars — empty credentials fail closed.
 * - The webhook secret at ingress resolves through
 *   `resolveWebhookSecret("zernio")` → `ZERNIO_WEBHOOK_SECRET`.
 *
 * Signature: `X-Zernio-Signature` — lowercase hex HMAC-SHA256 over the RAW
 * body, no timestamp. Legacy alias `X-Late-Signature` (Zernio is the renamed
 * "Late" API). Because there is no timestamp, replay protection is the
 * deliveryId dedup on `X-Zernio-Event-Id`/`payload.id` (evidence §3).
 *
 * Channel hint: zernio is not in the channel→provider map; every event stamps
 * `raw.platform` with the payload's `message.platform`/`comment.platform`/
 * `account.platform`, and `resolveEventChannel` maps it through
 * `isChannelKind`. Platforms outside ChannelKind (twitter, google, …) derive
 * no channel → the event is skipped fail-closed by design.
 *
 * Conversation keying (mirrors kapso): inbound `message.received` carries the
 * zernio thread in `providerConversationId` (last-resort identity + thread
 * stamping). Echoes (`message.sent`) instead carry the CUSTOMER's
 * `conversation.participantId` there so `eventConversationExternalUserId`
 * keys echo and inbound into ONE conversation; the thread id then travels on
 * `providerThreadId` (same value on all events, always `conversation.id`).
 *
 * Media: webhook attachments carry NO `refreshUrl` — the durable handle is
 * the re-mint endpoint, whose inputs are all in the payload, so the adapter
 * synthesizes `refreshUrl` =
 *   /v1/inbox/conversations/{convId}/messages/{platformMessageId}/
 *     attachments/{index}?accountId={accountId}
 * and resolveMedia() GETs it with Bearer to obtain a fresh download URL.
 * WhatsApp attachment `url` already points at the authenticated
 * `/v1/whatsapp/media/{mediaId}` endpoint — kept verbatim, callers must send
 * the Bearer header when fetching it.
 *
 * Sends are conversation-scoped:
 * - `msg.providerConversationId` present → POST messages into that thread.
 * - Absent → POST /v1/inbox/conversations (participantId = msg.to). IG/FB
 *   threads cannot be opened API-side (upstream PLATFORM_NOT_SUPPORTED —
 *   surfaced as a non-retryable send error, matching Meta's rule that the
 *   customer must write first); WhatsApp opens REQUIRE a template
 *   (sendTemplate path), freeform open returns TEMPLATE_REQUIRED.
 *
 * [RESEARCH] — open evidence items kept as named seams:
 * - zernioMediaRefreshResponse: the attachment re-mint endpoint's response
 *   shape isn't documented (JSON {url} vs redirect); resolveMedia tolerates
 *   both.
 * - createTemplateParams mapping: `templateParams` is a flat positional
 *   array; we flatten Meta-shaped `template.components[].parameters[]` text
 *   values in order — verify against a real approved template.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type {
  ChannelAccount,
  MessagingProvider,
  NormalizedInboundEvent,
  OutboundMessage,
  SendResult,
} from "../types";

const API_BASE = "https://zernio.com/api/v1";
/**
 * Hosts a zernio-resolved media URL may legitimately point at: the re-mint
 * endpoint lives on zernio.com; minted/download links may land on Meta's
 * CDN family. Fed to the downloader via `extraAllowedDomains` — the
 * anchored check lives in `@/lib/media/inbound`.
 */
export const ZERNIO_MEDIA_DOMAINS = [
  "zernio.com",
  "lookaside.fbsbx.com",
  "cdninstagram.com",
  "fbcdn.net",
] as const;
const SIGNATURE_HEADERS = ["x-zernio-signature", "x-late-signature"];
const EVENT_ID_HEADERS = ["x-zernio-event-id", "x-late-event-id"];
const EVENT_NAME_HEADER = "x-zernio-event";
const SEND_TIMEOUT_MS = 20_000;
const MEDIA_REFRESH_TIMEOUT_MS = 10_000;

const KIND_MAP: Record<
  string,
  { kind: NormalizedInboundEvent["kind"]; direction: NormalizedInboundEvent["direction"] }
> = {
  "message.received": { kind: "message.received", direction: "inbound" },
  "message.sent": { kind: "message.echo", direction: "outbound" },
  "message.delivered": { kind: "message.status", direction: "outbound" },
  "message.read": { kind: "message.status", direction: "outbound" },
  "message.played": { kind: "message.status", direction: "outbound" },
  "message.failed": { kind: "message.status", direction: "outbound" },
  "comment.received": { kind: "comment.received", direction: "inbound" },
};

const API_SENT_VIA = new Set([
  "api",
  "broadcast",
  "sequence",
  "workflow",
  "comment_automation",
  "bulk-api",
]);

const ATTACHMENT_TYPE_MAP: Record<string, NonNullable<NormalizedInboundEvent["type"]>> = {
  image: "image",
  video: "video",
  audio: "audio",
  file: "document",
  sticker: "sticker",
  share: "unknown",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getHeader(
  headers: Record<string, string>,
  names: string | string[]
): string | undefined {
  const wanted = Array.isArray(names) ? names : [names];
  for (const [key, value] of Object.entries(headers)) {
    if (wanted.includes(key.toLowerCase())) return value;
  }
  return undefined;
}

function toIsoTimestamp(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Deterministic fallback when neither header nor payload carries an event id:
 * stable hash over fields that survive redelivery (contract §deliveryId —
 * id-less events must not collapse into one dedup bucket).
 */
function syntheticDeliveryId(
  eventName: string | undefined,
  body: Record<string, unknown>
): string {
  const message = isRecord(body.message) ? body.message : {};
  const comment = isRecord(body.comment) ? body.comment : {};
  const conversation = isRecord(body.conversation) ? body.conversation : {};
  const account = isRecord(body.account) ? body.account : {};
  const basis = JSON.stringify([
    eventName ?? "",
    asString(account.accountId) ?? asString(account.id),
    asString(message.id) ?? asString(comment.id),
    asString(conversation.id) ?? asString(message.conversationId),
    asString(message.platformMessageId) ?? asString(comment.id),
    asString(body.timestamp) ?? asString(message.sentAt),
  ]);
  return `zernio:synth:${createHash("sha256").update(basis).digest("hex").slice(0, 16)}`;
}

function classifyEvent(
  eventName: string | undefined
): { kind: NormalizedInboundEvent["kind"]; direction: NormalizedInboundEvent["direction"] } {
  const known = eventName ? KIND_MAP[eventName] : undefined;
  if (known) return known;
  if (eventName?.startsWith("account.") || eventName?.startsWith("whatsapp.")) {
    return { kind: "account.lifecycle", direction: "na" };
  }
  return { kind: "other", direction: "na" };
}

function statusFromEventName(
  eventName: string | undefined
): NormalizedInboundEvent["status"] {
  const tail = eventName?.split(".").pop();
  return tail === "delivered" || tail === "read" || tail === "failed" || tail === "sent"
    ? tail
    : tail === "played"
      ? "read"
      : undefined;
}

/** Echo origin: API/surface-authored sends map to role "assistant". */
function echoOrigin(message: Record<string, unknown>): "api" | undefined {
  const sentVia = asString(message.sentVia);
  const source = asString(message.source);
  if (sentVia && API_SENT_VIA.has(sentVia)) return "api";
  if (source === "cloud_api") return "api";
  return undefined;
}

/**
 * Sender identity on inbound message events. WhatsApp sender.id is the phone
 * (digits, no +) or the BSUID once Meta's rollout hides numbers; social
 * platforms' sender.id is the platform-scoped id (IGSID/PSID/…).
 */
function messageSender(
  message: Record<string, unknown>,
  platform: string | undefined
): NormalizedInboundEvent["sender"] {
  const sender = isRecord(message.sender) ? message.sender : {};
  const id = asString(sender.id);
  const phone = asString(sender.phoneNumber);
  return {
    // Prefer the explicit E.164 field; sender.id is the phone only on
    // whatsapp — never promote an IGSID/PSID into `phone`.
    phone: phone ?? (platform === "whatsapp" ? id : undefined),
    bsuid: asString(sender.businessScopedUserId),
    parentBsuid: asString(sender.parentBusinessScopedUserId),
    username: asString(sender.username) ?? asString(sender.whatsappUsername),
    socialId: platform === "whatsapp" ? undefined : id,
    name: asString(sender.name),
  };
}

function commentSender(comment: Record<string, unknown>): NormalizedInboundEvent["sender"] {
  const author = isRecord(comment.author) ? comment.author : {};
  return {
    socialId: asString(author.id),
    username: asString(author.username),
    name: asString(author.name),
  };
}

/**
 * Attachment refs. The webhook `url` is a signed CDN link that expires
 * (IG/FB) or an authenticated endpoint (WhatsApp); the durable handle is the
 * re-mint endpoint synthesized from payload fields (see file header).
 */
function mediaRefsFor(
  message: Record<string, unknown>,
  accountId: string | undefined
): NormalizedInboundEvent["mediaRefs"] {
  const attachments = message.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
  const conversationId = asString(message.conversationId);
  const platformMessageId = asString(message.platformMessageId);
  const refs = attachments
    .filter(isRecord)
    .map((att, index) => ({
      id: platformMessageId,
      url: asString(att.url),
      refreshUrl:
        conversationId && platformMessageId && accountId
          ? `${API_BASE}/inbox/conversations/${encodeURIComponent(conversationId)}` +
            `/messages/${encodeURIComponent(platformMessageId)}` +
            `/attachments/${index}?accountId=${encodeURIComponent(accountId)}`
          : undefined,
      mimeType: asString(att.mimeType),
    }));
  return refs.length > 0 ? refs : undefined;
}

function messageType(
  message: Record<string, unknown>
): NonNullable<NormalizedInboundEvent["type"]> {
  const attachments = message.attachments;
  if (Array.isArray(attachments)) {
    for (const att of attachments) {
      if (!isRecord(att)) continue;
      const mapped = ATTACHMENT_TYPE_MAP[asString(att.type) ?? ""];
      if (mapped) return mapped;
    }
  }
  // Interactive replies ride message.received via metadata.interactiveType.
  const metadata = isRecord(message.metadata) ? message.metadata : undefined;
  if (metadata && asString(metadata.interactiveType)) return "interactive";
  return "text";
}

function normalizeEvent(
  body: Record<string, unknown>,
  eventName: string | undefined,
  deliveryId: string
): NormalizedInboundEvent {
  const { kind, direction } = classifyEvent(eventName);
  const message = isRecord(body.message) ? body.message : {};
  const comment = isRecord(body.comment) ? body.comment : {};
  const conversation = isRecord(body.conversation) ? body.conversation : {};
  const account = isRecord(body.account) ? body.account : {};
  const platform =
    asString(message.platform) ?? asString(comment.platform) ?? asString(account.platform);
  const accountId = asString(account.accountId) ?? asString(account.id);

  const event: NormalizedInboundEvent = {
    provider: "zernio",
    deliveryId,
    kind,
    direction,
    providerAccountId: accountId ?? "",
    timestamp:
      toIsoTimestamp(message.sentAt) ??
      toIsoTimestamp(comment.createdAt) ??
      toIsoTimestamp(body.timestamp) ??
      new Date().toISOString(),
    sender: {},
    // Channel hint for resolveEventChannel: message.platform is already a
    // ChannelKind string for the channels we serve; anything else fails
    // closed through isChannelKind.
    raw: { ...body, platform },
  };

  if (kind === "comment.received") {
    event.providerConversationId = asString(comment.id);
    event.providerThreadId = asString(conversation.id);
    event.platformMessageId = asString(comment.id);
    event.sender = commentSender(comment);
    event.type = "text";
    event.text = asString(comment.text);
    const parent = asString(comment.parentCommentId);
    if (parent) event.replyToMessageId = parent;
    return event;
  }

  if (
    kind === "message.received" ||
    kind === "message.echo" ||
    kind === "message.status"
  ) {
    event.platformMessageId = asString(message.platformMessageId) ?? asString(message.id);
    if (kind === "message.echo") {
      // Customer is the routing key on echoes (kapso parity): participantId
      // — the other party's platform id — matches the inbound sender.id.
      event.providerConversationId =
        asString(conversation.participantId) ?? asString(conversation.id);
      const origin = echoOrigin(message);
      if (origin === "api") {
        (event.raw as Record<string, unknown>).echoOrigin = "api";
      }
    } else {
      event.providerConversationId = asString(conversation.id) ?? asString(message.conversationId);
    }
    event.providerThreadId = asString(conversation.id) ?? asString(message.conversationId);
    event.sender =
      direction === "outbound" ? {} : messageSender(message, platform);
  }

  if (kind === "message.status") {
    event.status = statusFromEventName(eventName);
    event.sender = {};
  }

  if (kind === "message.received" || kind === "message.echo") {
    event.type = messageType(message);
    const text = asString(message.text);
    if (text) event.text = text;
    const refs = mediaRefsFor(message, accountId);
    if (refs) event.mediaRefs = refs;
    const metadata = isRecord(body.metadata) ? body.metadata : undefined;
    const replyTo = asString(metadata?.quotedMessageId);
    if (replyTo) event.replyToMessageId = replyTo;
  }

  if (kind === "account.lifecycle" || kind === "other") {
    // Lifecycle/other events still carry account + (sometimes) sender context.
    event.providerAccountId = accountId ?? event.providerAccountId;
    event.sender = {};
    event.providerThreadId = asString(conversation.id);
  }

  return event;
}

function accountReadiness(account: ChannelAccount): string | undefined {
  if (!account.credentials.apiKey) {
    return "zernio adapter requires account.credentials.apiKey (channel_accounts row; no env/agent_config fallback)";
  }
  if (!account.providerAccountId) {
    return "zernio adapter requires account.providerAccountId (zernio accountId)";
  }
  return undefined;
}

interface ZernioResponseBody {
  success?: boolean;
  data?: { messageId?: string; conversationId?: string };
  error?: string;
  code?: string;
}

async function postJson(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  idempotencyKey?: string
): Promise<SendResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, retryable: true };
  }

  const payload = (await response.json().catch(() => ({}))) as ZernioResponseBody;
  if (!response.ok) {
    const code = payload.code ? ` [${payload.code}]` : "";
    const detail = payload.error ?? (await Promise.resolve(""));
    // 4xx platform/validation failures are not retryable; 5xx and 429 are.
    const retryable =
      response.status >= 500 || response.status === 429 || response.status === 409;
    return {
      ok: false,
      error: `Zernio API error (${response.status})${code}: ${detail}`,
      retryable,
    };
  }

  const providerMessageId = payload.data?.messageId;
  if (!providerMessageId) {
    // A-51: the request already reached the provider and got a 2xx — the
    // send may have been accepted. A retry here would risk a duplicate
    // delivery, so the failure is surfaced as non-retryable.
    return {
      ok: false,
      error: "Zernio send returned no message id",
      retryable: false,
    };
  }
  return { ok: true, providerMessageId, status: "sent" };
}

/**
 * Body for POST …/conversations/{id}/messages. Mirrors the verified request
 * shape (send-inbox-message.mdx): accountId + one content surface.
 */
function buildThreadBody(msg: OutboundMessage, accountId: string):
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string } {
  const base: Record<string, unknown> = { accountId };
  if (msg.replyToMessageId) base.replyTo = msg.replyToMessageId;
  switch (msg.type) {
    case "text": {
      if (!msg.text) return { ok: false, error: "text message requires msg.text" };
      return { ok: true, body: { ...base, message: msg.text } };
    }
    case "image": {
      if (!msg.mediaUrl) return { ok: false, error: "image message requires msg.mediaUrl" };
      return {
        ok: true,
        body: {
          ...base,
          message: msg.text || undefined,
          attachmentUrl: msg.mediaUrl,
          attachmentType: "image",
        },
      };
    }
    case "document": {
      if (!msg.mediaUrl) return { ok: false, error: "document message requires msg.mediaUrl" };
      return {
        ok: true,
        body: {
          ...base,
          message: msg.text || undefined,
          attachmentUrl: msg.mediaUrl,
          attachmentType: "file",
        },
      };
    }
    case "interactive": {
      if (msg.interactive === undefined) {
        return { ok: false, error: "interactive message requires msg.interactive" };
      }
      return {
        ok: true,
        body: { ...base, message: msg.text || undefined, interactive: msg.interactive },
      };
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
            elements: [
              {
                name: template.name,
                language: template.language,
                ...(template.components ? { components: template.components } : {}),
              },
            ],
          },
        },
      };
    }
    default:
      return { ok: false, error: `zernio adapter does not support outbound type '${msg.type}'` };
  }
}

/**
 * Flat `templateParams` for the create-conversation endpoint: Meta-shaped
 * `components[].parameters[]` flattened to positional text values, in order.
 * [RESEARCH] verify slot ordering against a real approved template.
 */
function createTemplateParams(components: unknown[] | undefined): string[] | undefined {
  if (!Array.isArray(components)) return undefined;
  const values: string[] = [];
  for (const component of components) {
    if (!isRecord(component)) continue;
    const parameters = component.parameters;
    if (!Array.isArray(parameters)) continue;
    for (const parameter of parameters) {
      if (!isRecord(parameter)) continue;
      const text = asString(parameter.text);
      if (parameter.type === "text" && text !== undefined) values.push(text);
    }
  }
  return values.length > 0 ? values : undefined;
}

/**
 * Body for POST /v1/inbox/conversations — the first-contact path.
 * participantId = msg.to (phone digits for WhatsApp, platform id elsewhere;
 * participantUsername is an alternative we don't resolve yet).
 */
function buildCreateBody(
  msg: OutboundMessage,
  accountId: string
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const base: Record<string, unknown> = {
    accountId,
    participantId: msg.to,
  };
  if (msg.type === "template") {
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
        templateName: template.name,
        templateLanguage: template.language,
        ...(createTemplateParams(template.components)
          ? { templateParams: createTemplateParams(template.components) }
          : {}),
      },
    };
  }
  if (msg.type !== "text" || !msg.text) {
    return {
      ok: false,
      error:
        "zernio conversation open supports only text or template " +
        `(got '${msg.type}')`,
    };
  }
  return { ok: true, body: { ...base, message: msg.text } };
}

export const zernioProvider: MessagingProvider = {
  id: "zernio",
  signatureScheme: "raw-body-hmac",

  verifyWebhook({ headers, rawBody, secret }) {
    if (!secret) return { ok: false, reason: "missing_secret" };
    const header = getHeader(headers, SIGNATURE_HEADERS);
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
      getHeader(headers, EVENT_NAME_HEADER) ??
      asString(body.event) ??
      asString(body.type);
    const deliveryId =
      getHeader(headers, EVENT_ID_HEADERS) ??
      asString(body.id) ??
      syntheticDeliveryId(eventName, body);
    return [normalizeEvent(body, eventName, deliveryId)];
  },

  async sendMessage(account, msg) {
    const notReady = accountReadiness(account);
    if (notReady) return { ok: false, error: notReady, retryable: false };
    if (msg.providerConversationId) {
      const built = buildThreadBody(msg, account.providerAccountId);
      if (!built.ok) return { ok: false, error: built.error, retryable: false };
      return postJson(
        `${API_BASE}/inbox/conversations/${encodeURIComponent(msg.providerConversationId)}/messages`,
        account.credentials.apiKey,
        built.body,
        msg.idempotencyKey
      );
    }
    const built = buildCreateBody(msg, account.providerAccountId);
    if (!built.ok) return { ok: false, error: built.error, retryable: false };
    return postJson(
      `${API_BASE}/inbox/conversations`,
      account.credentials.apiKey,
      built.body,
      msg.idempotencyKey
    );
  },

  async sendTemplate(account, msg) {
    const notReady = accountReadiness(account);
    if (notReady) return { ok: false, error: notReady, retryable: false };
    return zernioProvider.sendMessage(account, { ...msg, type: "template" });
  },

  async resolveMedia(account, ref) {
    // A fresh signed URL was already minted (or the caller passes a public
    // URL directly) — pass through. IG/FB urls expire; the durable handle is
    // refreshUrl (the re-mint endpoint synthesized at parse time).
    if (!ref.refreshUrl) {
      if (ref.url) return { url: ref.url };
      throw new Error("resolveMedia requires ref.refreshUrl or ref.url");
    }
    const apiKey = account.credentials.apiKey;
    if (!apiKey) {
      throw new Error("resolveMedia requires account.credentials.apiKey");
    }
    // [RESEARCH] zernioMediaRefreshResponse — re-mint endpoint response shape
    // isn't documented; tolerate {url}/{data:{url}} JSON and redirects.
    const response = await fetch(ref.refreshUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(MEDIA_REFRESH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Zernio media refresh failed: ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as {
        url?: string;
        data?: { url?: string; mimeType?: string; filename?: string };
      };
      const url = payload.data?.url ?? payload.url;
      if (!url) throw new Error("Zernio media refresh returned no url");
      return {
        url,
        mimeType: payload.data?.mimeType,
        filename: payload.data?.filename,
      };
    }
    // Redirect/binary: the response URL after redirects is the minted link.
    return { url: response.url || ref.refreshUrl };
  },
};
