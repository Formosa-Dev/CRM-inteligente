/**
 * Order-status notification transport used by admin server actions.
 *
 * Extracted so the fail-closed behavior is testable without a database:
 * bound conversation -> that account; otherwise the single active account;
 * ambiguous/missing account -> explicit failure (never a global send).
 */

import {
  decideSendAccount,
  type SendAccountDeps,
} from "@/lib/messaging/send-account";
import type { ChannelAccount, SendResult } from "@/lib/messaging/types";

export interface OrderStatusNotifyDeps extends SendAccountDeps {
  send(
    message: { to: string; type: "text"; text: string },
    options: { channel?: "whatsapp"; account?: ChannelAccount }
  ): Promise<SendResult>;
}

export type OrderStatusNotifyResult =
  | {
      ok: true;
      providerMessageId?: string;
      conversationId?: number;
      channelAccountId: number | null;
    }
  | { ok: false; error: string; retryable: boolean };

export async function sendOrderStatusNotification(
  input: { phoneNumber: string; message: string },
  deps: OrderStatusNotifyDeps
): Promise<OrderStatusNotifyResult> {
  const to = input.phoneNumber.startsWith("+")
    ? input.phoneNumber
    : `+${input.phoneNumber}`;

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

  const result = await deps.send(
    { to, type: "text", text: input.message },
    decision.account
      ? { channel: "whatsapp", account: decision.account }
      : {}
  );
  return result.ok
    ? {
        ok: true,
        providerMessageId: result.providerMessageId || undefined,
        conversationId: decision.conversationId,
        channelAccountId: decision.channelAccountId,
      }
    : { ok: false, error: result.error, retryable: result.retryable };
}
