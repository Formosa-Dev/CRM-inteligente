/**
 * Order-status notification transport used by admin server actions.
 *
 * S5 outbound-correctness port (AH `order-status-notify` adapted to SC's
 * integer ids and leads model):
 *
 * - deterministic send idempotency `order-status:<orderId>:<status>` — a
 *   repeated transition retries the SAME provider send instead of minting a
 *   new one (manual re-notify keeps a random key: a deliberate re-send is
 *   not a retry);
 * - the sending account comes from the shared fail-closed decision
 *   (`decideSendAccount`): bound conversation → its account, unbound → the
 *   single active account, ambiguous/missing → drop, never a global send;
 * - an account whose channel is not whatsapp is a provisioning bug —
 *   `account_provider_mismatch`, fail closed;
 * - every attempted send persists an outbound fact, sent or failed, stamped
 *   `sender_kind:"agent"` + `sender_ref:"order-status-notify"` (automated
 *   sends must never read as operator activity);
 * - F-02 24h window gate: outside the window only the configured
 *   `wa_template_fallback` template is deliverable;
 * - conversation-scoped providers (zernio) send into the stored
 *   `externalThreadId`.
 *
 * Notifications are best-effort side effects: a customer who cannot be
 * reached never blocks the status transition itself.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { conversations, leads, leadIdentities } from "@/db/schema";
import { looksLikePhone, normalizePhone } from "@/lib/phone-utils";
import { isSchemaNotReady } from "@/lib/messaging/errors";
import {
  decideSendAccount,
  type SendAccountDeps,
} from "@/lib/messaging/send-account";
import type {
  ChannelAccount,
  OutboundMessage,
  SendResult,
} from "@/lib/messaging/types";
import {
  findOrCreateConversation,
  insertMessage,
} from "@/lib/channels/router";
import {
  decideCustomerWindowSend,
  resolveTemplateFallback,
  type WindowSendDecision,
} from "./outbound-window";

export interface OrderStatusNotifyDeps extends SendAccountDeps {
  send(
    message: OutboundMessage,
    options: { channel?: "whatsapp"; account?: ChannelAccount }
  ): Promise<SendResult>;
}

export type OrderStatusNotifyResult =
  | {
      ok: true;
      providerMessageId?: string;
      conversationId?: number;
      channelAccountId: number | null;
      /** false when the transcript row could not be written. */
      persisted?: boolean;
    }
  | { ok: false; error: string; retryable: boolean };

export interface OrderStatusNotificationInput {
  phoneNumber: string;
  message: string;
  /**
   * Order + status scope the deterministic idempotency key
   * (`order-status:<orderId>:<status>`). Without them a random key is used.
   */
  orderId?: number;
  status?: string;
  /** Explicit key wins over the derived one. */
  idempotencyKey?: string;
}

type NotificationThread = { id: number; externalThreadId: string | null };

/**
 * The whatsapp conversation that owns (conversationId | digits, account).
 * The bound conversation id from `decideSendAccount` wins; otherwise the
 * newest account-scoped row for the phone.
 */
async function findNotificationThread(opts: {
  conversationId?: number;
  digits: string;
  channelAccountId: number | null;
}): Promise<NotificationThread | undefined> {
  if (opts.conversationId != null) {
    const [row] = await db
      .select({
        id: conversations.id,
        externalThreadId: conversations.externalThreadId,
      })
      .from(conversations)
      .where(eq(conversations.id, opts.conversationId))
      .limit(1);
    if (row) return row;
  }

  const [row] = await db
    .select({
      id: conversations.id,
      externalThreadId: conversations.externalThreadId,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.channel, "whatsapp"),
        opts.channelAccountId != null
          ? eq(conversations.channelAccountId, opts.channelAccountId)
          : isNull(conversations.channelAccountId),
        or(
          eq(conversations.externalUserIdNormalized, opts.digits),
          eq(conversations.whatsappId, opts.digits),
          eq(conversations.whatsappId, `+${opts.digits}`)
        )
      )
    )
    .orderBy(desc(conversations.id))
    .limit(1);
  return row;
}

/**
 * Persists the outbound fact — sent or failed — on the owning conversation,
 * creating the thread when the phone has none. Stamped agent + a dedicated
 * sender_ref so automated notifications can never be mistaken for operator
 * activity. `role:"system"` keeps the legacy transcript convention (the
 * agent's anti-duplicate-order guard recognizes `system` + "Pedido #").
 */
async function persistOutboundFact(input: {
  digits: string;
  thread?: NotificationThread;
  channelAccountId: number | null;
  platformMessageId: string;
  content: string;
  sentAsTemplate: boolean;
  templateName?: string;
  deliveryState: "sent" | "failed";
  providerConversationId: string | null;
}): Promise<{ conversationId: number } | undefined> {
  try {
    const conversationId =
      input.thread?.id ??
      (
        await findOrCreateConversation(
          "whatsapp",
          `+${input.digits}`,
          undefined,
          `+${input.digits}`,
          input.channelAccountId
        )
      ).id;
    await insertMessage(
      conversationId,
      "system",
      input.sentAsTemplate
        ? `[template:${input.templateName}] ${input.content}`
        : input.content,
      undefined,
      input.platformMessageId,
      input.channelAccountId,
      {
        direction: "outbound",
        senderKind: "agent",
        senderRef: "order-status-notify",
        deliveryState: input.deliveryState,
        providerConversationId: input.providerConversationId,
        contentType: "text",
      }
    );
    return { conversationId };
  } catch (error) {
    console.warn("[order-status-notify] outbound fact persist failed:", error);
    return undefined;
  }
}

export async function sendOrderStatusNotification(
  input: OrderStatusNotificationInput,
  deps: OrderStatusNotifyDeps
): Promise<OrderStatusNotifyResult> {
  const digits = normalizePhone(input.phoneNumber);
  if (digits.length < 7) {
    return { ok: false, error: "invalid_phone", retryable: false };
  }
  const to = `+${digits}`;

  const decision = await decideSendAccount(to, deps);
  if (decision.kind === "retry") {
    return {
      ok: false,
      error: `no se pudo resolver la cuenta del canal (${decision.reason})`,
      retryable: true,
    };
  }
  if (decision.kind === "drop") {
    return { ok: false, error: decision.reason, retryable: false };
  }

  const account = decision.account;
  // messenger only routes through messaging providers (ycloud/zernio/kapso);
  // a whatsapp notification bound to another channel's account is a
  // provisioning bug — drop it, never send on the wrong surface.
  if (account && account.channel !== "whatsapp") {
    return { ok: false, error: "account_provider_mismatch", retryable: false };
  }

  // Resolve the thread BEFORE deciding: the 24h window needs the
  // conversation, and conversation-scoped providers need the stored
  // externalThreadId or every send opens a NEW conversation.
  const thread = await findNotificationThread({
    conversationId: decision.conversationId,
    digits,
    channelAccountId: decision.channelAccountId,
  });

  // F-02 gate: order notifications usually fire days after the customer's
  // last inbound — outside the window Meta rejects free-form text and only
  // the configured fallback template is deliverable. No thread → no customer
  // inbound ever → the window is closed by definition.
  let windowDecision: WindowSendDecision;
  if (thread) {
    windowDecision = await decideCustomerWindowSend(thread.id, {
      channelAccountId: decision.channelAccountId,
    }).catch(() => ({ kind: "text", windowOpen: true }) as WindowSendDecision);
  } else {
    const template = await resolveTemplateFallback({
      channel: "whatsapp",
      channelAccountId: decision.channelAccountId,
    });
    windowDecision = template
      ? { kind: "template", template, lastInboundAt: null }
      : { kind: "text", windowOpen: false, reason: "no_template" };
  }
  const windowClosedWithoutTemplate =
    windowDecision.kind === "text" && !windowDecision.windowOpen;

  const idempotencyKey =
    input.idempotencyKey ??
    `order-status:${input.orderId ?? randomUUID()}:${input.status ?? randomUUID()}`;

  const msg: OutboundMessage =
    windowDecision.kind === "template"
      ? {
          to,
          type: "template",
          template: windowDecision.template,
          idempotencyKey,
        }
      : { to, type: "text", text: input.message, idempotencyKey };
  if (thread?.externalThreadId) {
    msg.providerConversationId = thread.externalThreadId;
  }

  const result = await deps.send(
    msg,
    account ? { channel: "whatsapp", account } : {}
  );
  if (windowClosedWithoutTemplate) {
    console.warn(
      `[order-status-notify] 24h window closed and wa_template_fallback is not configured — text send attempted, delivery may be rejected`
    );
  }

  // The fact is per send: the deterministic key guards the SEND, while a
  // fresh pmid suffix keeps a repeated same-status notification recordable
  // rather than deduped into the first fact.
  const platformMessageId = result.ok
    ? result.providerMessageId || `${idempotencyKey}:${randomUUID()}`
    : `${idempotencyKey}:${randomUUID()}:failed`;
  const persisted = await persistOutboundFact({
    digits,
    thread,
    channelAccountId: decision.channelAccountId,
    platformMessageId,
    content: input.message,
    sentAsTemplate: windowDecision.kind === "template",
    templateName:
      windowDecision.kind === "template" ? windowDecision.template.name : undefined,
    deliveryState: result.ok ? "sent" : "failed",
    providerConversationId: thread?.externalThreadId ?? null,
  });

  if (!result.ok) {
    return { ok: false, error: result.error, retryable: result.retryable };
  }
  return {
    ok: true,
    providerMessageId: result.providerMessageId || undefined,
    conversationId: persisted?.conversationId ?? thread?.id,
    channelAccountId: decision.channelAccountId,
    persisted: persisted !== undefined,
  };
}

/**
 * Resolves the customer phone for an order through SC's leads model —
 * `orders.leadId → lead_identities(channel='whatsapp', newest first) →
 * leads.phone` — falling back to the order's own phone column.
 *
 * BSUID guard: only phone-shaped identities are sendable numbers — a
 * non-phone externalId (provider user id like `waba-2`, numeric-looking
 * BSUIDs) is never digit-stripped into a destination.
 */
export async function resolveOrderNotificationPhone(order: {
  id: number;
  leadId: number | null;
  phoneNumber: string | null;
}): Promise<string> {
  if (order.leadId != null) {
    try {
      // Newest identity first — `.limit(1)` without ORDER BY returns
      // whichever row the index scan finds, nondeterministically wrong when
      // a lead carries several whatsapp identities.
      const [identity] = await db
        .select({ externalId: leadIdentities.externalId })
        .from(leadIdentities)
        .where(
          and(
            eq(leadIdentities.leadId, order.leadId),
            eq(leadIdentities.channel, "whatsapp")
          )
        )
        .orderBy(desc(leadIdentities.createdAt))
        .limit(1);
      if (identity?.externalId && looksLikePhone(identity.externalId)) {
        return normalizePhone(identity.externalId);
      }
    } catch (error) {
      // Un-migrated install: lead_identities doesn't exist — fall through
      // to the lead/order phone. Any other failure is surfaced.
      if (!isSchemaNotReady(error)) throw error;
    }
    const [lead] = await db
      .select({ phone: leads.phone })
      .from(leads)
      .where(eq(leads.id, order.leadId))
      .limit(1);
    if (lead?.phone && looksLikePhone(lead.phone)) {
      return normalizePhone(lead.phone);
    }
  }
  return order.phoneNumber ?? "";
}
