import { getConversations } from "./actions";
import { ConversationsInbox } from "./conversations-inbox";
import { db } from "@/db";
import { agentConfig, channelAccounts } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { isSchemaNotReady } from "@/lib/messaging/errors";
import type { ChannelAccountOption } from "@/lib/conversations/filters";
import type { ConversationSummary } from "@/types/chat";

export const metadata = { title: "Mensajes — Admin" };

interface ConversationsPageProps {
  searchParams: Promise<{
    channel?: string;
    account?: string;
    page?: string;
  }>;
}

export default async function ConversationsPage({
  searchParams,
}: ConversationsPageProps) {
  const params = await searchParams;
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  const result = await getConversations({
    page,
    channel: params.channel,
    account: params.account,
  });

  // Cargar lista de teléfonos de vendedores para diferenciar en UI
  const [config] = await db
    .select({ sellerPhoneIds: agentConfig.sellerPhoneIds })
    .from(agentConfig)
    .where(eq(agentConfig.id, 1))
    .limit(1);
  const sellerPhones: string[] = ((config?.sellerPhoneIds ?? []) as { name: string; phone: string }[]).map(s => s.phone);

  // Cuentas conectadas para el filtro por número. Un-migrated installs have no
  // `channel_accounts` table — the selector renders disabled in that case;
  // any other DB failure surfaces instead of degrading silently.
  let accounts: ChannelAccountOption[] = [];
  try {
    accounts = await db
      .select({
        id: channelAccounts.id,
        provider: channelAccounts.provider,
        channel: channelAccounts.channel,
        providerAccountId: channelAccounts.providerAccountId,
        senderAddress: channelAccounts.senderAddress,
        displayName: channelAccounts.displayName,
        status: channelAccounts.status,
      })
      .from(channelAccounts)
      .orderBy(asc(channelAccounts.channel), asc(channelAccounts.senderAddress));
  } catch (error) {
    if (!isSchemaNotReady(error)) throw error;
  }

  const initialConversations: ConversationSummary[] = result.conversations.map(
    (r) => ({
      id: r.id,
      channel: r.channel ?? "whatsapp",
      customerName: r.customerName ?? null,
      customerPhone: r.customerPhone ?? "",
      lastMessagePreview: r.lastMessagePreview ?? null,
      lastMessageAt:
        r.lastMessageAt instanceof Date
          ? r.lastMessageAt.toISOString()
          : (r.lastMessageAt ?? null),
      status: r.status ?? "active",
      humanOverrideUntil:
        r.humanOverrideUntil instanceof Date
          ? r.humanOverrideUntil.toISOString()
          : (r.humanOverrideUntil ?? null),
    })
  );

  return (
    <ConversationsInbox
      initialConversations={initialConversations}
      sellerPhones={sellerPhones}
      channelAccounts={accounts}
    />
  );
}
