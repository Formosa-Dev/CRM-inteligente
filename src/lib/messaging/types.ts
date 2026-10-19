/**
 * Messaging provider abstraction — frozen contract.
 *
 * Naming follows `docs/socialcrm/provider-integration-evidence.md` §4
 * verbatim; `ChannelAccount` additionally merges the `tenantId`,
 * `isDefault` and `displayAddress` fields from
 * `docs/socialcrm/architecture-roadmap.md` §2.2 (on conflicts, evidence
 * names win: `providerAccountId`, `deliveryId`).
 */

export type ProviderId = "ycloud" | "zernio" | "kapso";

export type ChannelKind =
  | "whatsapp"
  | "instagram"
  | "facebook"
  | "messenger"
  | "telegram"
  | "sms"
  | "comment";

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
  isDefault: boolean;
  /** E.164 phone or social handle shown to operators; null when unknown. */
  displayAddress: string | null;
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
}

export type SendResult =
  | { ok: true; providerMessageId: string; status: string }
  | { ok: false; error: string; retryable: boolean };

export interface NormalizedInboundEvent {
  provider: ProviderId;
  /** delivery-level dedup key: evt_* | X-Zernio-Event-Id | X-Idempotency-Key */
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
