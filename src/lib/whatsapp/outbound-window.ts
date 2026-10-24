import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { chatMessages } from "@/db/schema";
import { isSchemaNotReady } from "@/lib/messaging/errors";
import type { AgentConfigScope } from "@/lib/agent-config-scope";

/**
 * WhatsApp 24h customer-service window (F-02 port from AH Sports).
 *
 * Meta only accepts free-form text within 24 hours of the customer's last
 * inbound message. Outside that window the only deliverable message is an
 * approved template. This module is the single send-decision seam for that
 * rule:
 *
 * - inside the window → normal text reply;
 * - outside → template from `agent_config.wa_template_fallback` (scoped:
 *   account row wins over channel row over global);
 * - outside with no template configured → keep the text send (the caller may
 *   still attempt it) but report the decision truthfully so the delivery row
 *   and logs never pretend the window was handled.
 */

export const WHATSAPP_CUSTOMER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TEMPLATE_LANGUAGE = "es_AR";

export type TemplateFallback = { name: string; language: string };

export type WindowSendDecision =
  | { kind: "text"; windowOpen: true }
  | { kind: "text"; windowOpen: false; reason: "no_template" }
  | {
      kind: "template";
      template: TemplateFallback;
      lastInboundAt: Date | null;
    };

async function lastInboundByRole(conversationId: number): Promise<Date | null> {
  const [row] = await db
    .select({ createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.conversationId, conversationId),
        eq(chatMessages.role, "user")
      )
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(1);
  return row?.createdAt ?? null;
}

/**
 * Latest customer-authored inbound for the conversation, or null. Prefers
 * the S0 sender columns (direction='inbound' + sender_kind='customer') and
 * falls back to the legacy role model for rows written before the columns
 * existed — and for the whole table on un-migrated installs (42703).
 */
export async function lastCustomerInboundAt(
  conversationId: number
): Promise<Date | null> {
  try {
    const [row] = await db
      .select({ createdAt: chatMessages.createdAt })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.conversationId, conversationId),
          or(
            and(
              eq(chatMessages.direction, "inbound"),
              eq(chatMessages.senderKind, "customer")
            ),
            and(
              isNull(chatMessages.direction),
              eq(chatMessages.role, "user")
            )
          )
        )
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(1);
    return row?.createdAt ?? null;
  } catch (error) {
    // Positively identified un-migrated install: role-only lookup.
    if (!isSchemaNotReady(error)) throw error;
    return lastInboundByRole(conversationId);
  }
}

/** A thread without any customer inbound has no open window. */
export function isCustomerWindowOpen(
  lastInboundAt: Date | null,
  now: Date = new Date()
): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < WHATSAPP_CUSTOMER_WINDOW_MS;
}

function parseTemplateFallback(value: unknown): TemplateFallback | null {
  if (typeof value === "string") {
    const name = value.trim();
    return name ? { name, language: DEFAULT_TEMPLATE_LANGUAGE } : null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) return null;
    const language =
      typeof record.language === "string" && record.language.trim()
        ? record.language.trim()
        : DEFAULT_TEMPLATE_LANGUAGE;
    return { name, language };
  }
  return null;
}

/**
 * Reads the configured fallback template. Supports a plain string
 * (`"order_update"`, default language) or `{ name, language }`. Any read
 * failure degrades to "not configured" — a config hiccup must never break
 * the reply path.
 */
export async function resolveTemplateFallback(
  scope: AgentConfigScope = { channel: "whatsapp" }
): Promise<TemplateFallback | null> {
  try {
    const { resolveAgentConfig } = await import("@/lib/agent-config-scope");
    const row = await resolveAgentConfig(scope);
    return parseTemplateFallback(row?.waTemplateFallback);
  } catch {
    return null;
  }
}

/**
 * Decides how a customer-facing reply may be sent. Outside the window the
 * caller routes the reply through `messenger.send` as `type:"template"` when
 * a template is configured; otherwise it keeps the text send and records the
 * honest `no_template` outcome.
 */
export async function decideCustomerWindowSend(
  conversationId: number,
  opts: { channelAccountId?: number | null; now?: Date } = {}
): Promise<WindowSendDecision> {
  const now = opts.now ?? new Date();
  const lastInbound = await lastCustomerInboundAt(conversationId);
  if (isCustomerWindowOpen(lastInbound, now)) {
    return { kind: "text", windowOpen: true };
  }
  const template = await resolveTemplateFallback({
    channel: "whatsapp",
    channelAccountId: opts.channelAccountId ?? null,
  });
  if (template) {
    return { kind: "template", template, lastInboundAt: lastInbound };
  }
  return { kind: "text", windowOpen: false, reason: "no_template" };
}
