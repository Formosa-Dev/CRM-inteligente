/**
 * Messaging provider abstraction — frozen contract.
 *
 * Follows `docs/socialcrm/provider-integration-evidence.md` §4 verbatim,
 * including the `ChannelAccount` field list. Account defaulting is a
 * schema/resolver concern (not a contract field) and `senderAddress`
 * covers the display role — execution-control §2.2 / final-review R-1.
 */

export type ProviderId = "ycloud" | "zernio" | "kapso";

/** Channels are destinations; `comment`/`messenger` are event kinds, not channels. */
export type ChannelKind =
  | "whatsapp"
  | "instagram"
  | "facebook"
  | "telegram"
  | "sms"
  | "reddit";

export interface ChannelAccount {
  id: string;
  provider: ProviderId;
  channel: ChannelKind;
  /** ycloud: sender E.164 · zernio: accountId · kapso: phoneNumberId */
  providerAccountId: string;
  /** E.164 phone (WhatsApp/SMS) or page/handle id (social) */
  senderAddress: string;
  credentials: {
    apiKey: string;
    webhookSecret: string;
    accessToken?: string;
  };
  status: "active" | "disconnected" | "error";
  /** Single install: always the constant "default". Never build tenancy logic. */
  tenantId: string;
}

export interface OutboundMessage {
  to: string; // E.164 phone, BSUID, or social user id
  type: "text" | "image" | "document" | "template" | "interactive";
  text?: string;
  mediaUrl?: string; // public link; adapters may upload first
  template?: { name: string; language: string; components?: unknown[] };
  interactive?: unknown; // provider-native passthrough
  replyToMessageId?: string;
  idempotencyKey?: string; // → ycloud externalId / zernio Idempotency-Key
  /**
   * Provider-native thread to send into (zernio conversationId, from
   * conversations.external_thread_id). When absent, conversation-scoped
   * providers open a new conversation addressed to `to` instead.
   */
  providerConversationId?: string;
}

export type SendResult =
  | { ok: true; providerMessageId: string; status: string }
  | { ok: false; error: string; retryable: boolean };

export interface NormalizedInboundEvent {
  provider: ProviderId;
  /**
   * delivery-level dedup key: evt_* | X-Zernio-Event-Id | X-Idempotency-Key.
   * Adapters must synthesize a deterministic `{provider}:synth:<hash>` key
   * when the envelope carries no id — never leave it empty, or id-less
   * events would collapse into a single dedup bucket.
   */
  deliveryId: string;
  kind:
    | "message.received"
    | "message.echo"
    | "message.status"
    | "comment.received"
    | "account.lifecycle"
    | "other";
  direction: "inbound" | "outbound" | "na";
  /** routing key: wabaId | zernio accountId | kapso phone_number_id */
  providerAccountId: string;
  providerConversationId?: string; // zernio conversationId / kapso conv.id
  /**
   * Provider-native thread id when `providerConversationId` carries a
   * customer routing key instead (zernio echoes key by participantId; the
   * zernio conversation.id lands here). Persisted to
   * conversations.external_thread_id for conversation-scoped sends.
   */
  providerThreadId?: string;
  platformMessageId?: string; // wamid / mid — durable message dedup
  sender: {
    phone?: string;
    bsuid?: string;
    parentBsuid?: string;
    username?: string;
    socialId?: string;
    name?: string;
  };
  type?:
    | "text"
    | "image"
    | "audio"
    | "video"
    | "document"
    | "location"
    | "sticker"
    | "interactive"
    | "reaction"
    | "unknown";
  text?: string;
  mediaRefs?: {
    id?: string;
    url?: string;
    refreshUrl?: string;
    mimeType?: string;
    filename?: string;
  }[];
  replyToMessageId?: string;
  status?: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  raw: unknown;
}

export interface MessagingProvider {
  readonly id: ProviderId;
  /** 'timestamped-hmac' (ycloud t.s) vs 'raw-body-hmac' (zernio, kapso) */
  readonly signatureScheme: "timestamped-hmac" | "raw-body-hmac";
  verifyWebhook(input: {
    headers: Record<string, string>;
    rawBody: string;
    secret: string;
  }): { ok: boolean; reason?: string };
  /** Returns an ARRAY — Kapso can deliver batched envelopes. */
  parseWebhook(input: {
    headers: Record<string, string>;
    rawBody: string;
  }): NormalizedInboundEvent[];
  sendMessage(
    account: ChannelAccount,
    msg: OutboundMessage
  ): Promise<SendResult>;
  sendTemplate?(
    account: ChannelAccount,
    msg: OutboundMessage
  ): Promise<SendResult>;
  resolveMedia?(
    account: ChannelAccount,
    ref: { id?: string; url?: string; refreshUrl?: string }
  ): Promise<{ url: string; mimeType?: string; filename?: string }>;
}
