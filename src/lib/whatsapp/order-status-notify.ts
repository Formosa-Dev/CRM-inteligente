/**
 * Order-status notification transport used by admin server actions.
 *
 * Extracted so the fail-closed behavior is testable without a database:
 * bound conversation -> that account; otherwise the single active account;
 * ambiguous/missing account -> explicit failure (never a global send).
 */

import type {
  BoundAccountResolution,
  DefaultAccountResolution,
} from "@/lib/channels/router";
import type { ChannelAccount, SendResult } from "@/lib/messaging/types";

export interface OrderStatusNotifyDeps {
  resolveBinding(phone: string): Promise<BoundAccountResolution>;
  resolveDefaultAccount(): Promise<DefaultAccountResolution>;
  send(
    message: { to: string; type: "text"; text: string },
    options: { channel?: "whatsapp"; account?: ChannelAccount }
  ): Promise<SendResult>;
}

export type OrderStatusNotifyResult =
  | { ok: true; providerMessageId?: string }
  | { ok: false; error: string; retryable: boolean };

export async function sendOrderStatusNotification(
  input: { phoneNumber: string; message: string },
  deps: OrderStatusNotifyDeps
): Promise<OrderStatusNotifyResult> {
  const to = input.phoneNumber.startsWith("+")
    ? input.phoneNumber
    : `+${input.phoneNumber}`;

  const binding = await deps.resolveBinding(to);
  if (binding.kind === "error") {
    return {
      ok: false,
      error: "no se pudo resolver la cuenta del canal (error transitorio)",
      retryable: binding.retryable,
    };
  }
  if (binding.kind === "ambiguous") {
    return {
      ok: false,
      error: `el teléfono está vinculado a varias cuentas (${binding.accountIds.join(", ")})`,
      retryable: false,
    };
  }
  if (binding.kind === "unresolvable") {
    return {
      ok: false,
      error: `la cuenta de canal #${binding.accountId} no es resoluble (${binding.reason})`,
      retryable: false,
    };
  }

  let account: ChannelAccount | undefined;
  if (binding.kind === "resolved") {
    account = binding.account;
  } else {
    const fallback = await deps.resolveDefaultAccount();
    if (fallback.kind === "db-error") {
      return {
        ok: false,
        error: "no se pudo resolver la cuenta por defecto (error transitorio)",
        retryable: true,
      };
    }
    if (fallback.kind === "ambiguous") {
      return {
        ok: false,
        error: `hay varias cuentas activas y ninguna vinculada al teléfono (${fallback.reason})`,
        retryable: false,
      };
    }
    if (fallback.kind === "resolved") account = fallback.account;
  }

  const result = await deps.send(
    { to, type: "text", text: input.message },
    account ? { channel: "whatsapp", account } : {}
  );
  return result.ok
    ? { ok: true, providerMessageId: result.providerMessageId || undefined }
    : { ok: false, error: result.error, retryable: result.retryable };
}
