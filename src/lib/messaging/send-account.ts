/**
 * Shared phone-addressed send-account decision.
 *
 * Used by cron/queue/admin send paths so they agree on the fail-closed rules:
 * bound conversation → its account; unbound → exactly one active account;
 * ambiguous/not-found/unresolvable → drop; transient lookup errors → retry.
 * A legacy send (no account) is allowed ONLY when the channel is genuinely
 * unprovisioned or the schema is positively not ready.
 */

import type {
  BoundAccountResolution,
  DefaultAccountResolution,
} from "@/lib/channels/router";
import type { ChannelAccount } from "./types";

export interface SendAccountDeps {
  resolveBinding(phone: string): Promise<BoundAccountResolution>;
  resolveDefaultAccount(): Promise<DefaultAccountResolution>;
}

export type SendAccountDecision =
  | {
      kind: "send";
      account?: ChannelAccount;
      conversationId?: number;
      channelAccountId: number | null;
    }
  | { kind: "retry"; reason: string; error?: unknown }
  | { kind: "drop"; reason: string };

function accountIdOf(account: ChannelAccount | undefined): number | null {
  if (!account) return null;
  const id = Number(account.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function decideSendAccount(
  phone: string,
  deps: SendAccountDeps
): Promise<SendAccountDecision> {
  const binding = await deps.resolveBinding(phone);
  switch (binding.kind) {
    case "error":
      return binding.retryable
        ? { kind: "retry", reason: "binding lookup failed", error: binding.error }
        : { kind: "drop", reason: "binding lookup failed (permanent)" };
    case "ambiguous":
      return {
        kind: "drop",
        reason: `phone is bound to multiple accounts (${binding.accountIds.join(", ")})`,
      };
    case "unresolvable":
      return {
        kind: "drop",
        reason: `channel account #${binding.accountId} is not resolvable (${binding.reason})`,
      };
    case "resolved":
      return {
        kind: "send",
        account: binding.account,
        conversationId: binding.conversationId,
        channelAccountId: accountIdOf(binding.account),
      };
    case "unbound":
      break;
  }

  const fallback = await deps.resolveDefaultAccount();
  switch (fallback.kind) {
    case "resolved":
      return {
        kind: "send",
        account: fallback.account,
        channelAccountId: accountIdOf(fallback.account),
      };
    case "unprovisioned":
      // Genuine legacy install: no account exists to choose.
      return { kind: "send", channelAccountId: null };
    case "db-error":
      return { kind: "retry", reason: "default account lookup failed", error: fallback.error };
    case "ambiguous":
      return {
        kind: "drop",
        reason: `multiple active accounts and no binding (${fallback.reason})`,
      };
    case "not-found":
      return {
        kind: "drop",
        reason: `provisioned channel has no active account (${fallback.reason})`,
      };
  }
}
