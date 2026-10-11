import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getConversations,
  getMessages,
  sendReply,
  type GetConversationsParams,
} from "@/app/(admin)/admin/conversations/actions";
import type { ConversationSummary, ChatMessage, CustomerProfile, OrderSummary } from "@/types/chat";
import { db } from "@/db";
import { leads, orders } from "@/db/schema";
import { eq } from "drizzle-orm";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapToSummary(row: Record<string, unknown>): ConversationSummary {
  return {
    id: row.id as number,
    channel: row.channel as ConversationSummary["channel"],
    customerName: row.customerName as string | null,
    customerPhone: row.customerPhone as string,
    lastMessagePreview: row.lastMessagePreview as string | null,
    lastMessageAt: row.lastMessageAt instanceof Date
      ? (row.lastMessageAt as Date).toISOString()
      : (row.lastMessageAt as string | null),
    status: row.status as ConversationSummary["status"],
    messageCount: row.messageCount as number | undefined,
    humanOverrideUntil: row.humanOverrideUntil instanceof Date
      ? (row.humanOverrideUntil as Date).toISOString()
      : (row.humanOverrideUntil as string | null),
  };
}

function mapToMessages(rows: Record<string, unknown>[]): ChatMessage[] {
  return rows.map((row) => ({
    id: row.id as number,
    conversationId: row.conversationId as number,
    role: row.role as ChatMessage["role"],
    content: row.content as string,
    contentAttributes: row.contentAttributes as ChatMessage["contentAttributes"],
    createdAt: row.createdAt instanceof Date
      ? (row.createdAt as Date).toISOString()
      : (row.createdAt as string),
  }));
}

// ─── Conversation Queries ────────────────────────────────────────────────────

export function useConversations(params: GetConversationsParams) {
  return useQuery({
    queryKey: ["conversations", params],
    queryFn: async () => {
      const result = await getConversations(params);
      return {
        conversations: result.conversations.map(mapToSummary),
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      };
    },
    // Smart polling: 5s si hay activas, 30s si idle, pausa en hidden
    refetchInterval: (_query) => {
      if (typeof document !== "undefined" && document.hidden) return false;
      return 5000;
    },
    staleTime: 3000,
    refetchIntervalInBackground: false,
  });
}

// ─── Message Queries ─────────────────────────────────────────────────────────

export function useMessages(conversationId: number | null) {
  return useQuery({
    queryKey: ["messages", conversationId],
    queryFn: async () => {
      if (!conversationId) return [];
      const rows = await getMessages(conversationId);
      return mapToMessages(rows as unknown as Record<string, unknown>[]);
    },
    enabled: !!conversationId,
    refetchInterval: (_query) => {
      if (typeof document !== "undefined" && document.hidden) return false;
      if (!conversationId) return false;
      return 3000;
    },
    staleTime: 2000,
    refetchIntervalInBackground: false,
  });
}

// ─── Send Reply Mutation ─────────────────────────────────────────────────────

export function useSendReply(conversationId: number | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (content: string) => {
      if (!conversationId) throw new Error("No conversation selected");
      const result = await sendReply(conversationId, content);
      if (!result.success) throw new Error(result.error ?? "Failed to send");
    },
    onSuccess: () => {
      // Refetch messages after send succeeds
      queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
    },
  });
}

// ─── Customer Context Queries ────────────────────────────────────────────────

export function useCustomerProfile(conversationId: number | null) {
  return useQuery({
    queryKey: ["customer-profile", conversationId],
    queryFn: async (): Promise<CustomerProfile | null> => {
      if (!conversationId) return null;

      // Try 1: Find lead by conversationId (auto-linked)
      let [lead] = await db
        .select()
        .from(leads)
        .where(eq(leads.conversationId, conversationId))
        .limit(1);

      // Try 2: Fallback — buscar por teléfono de la conversación
      if (!lead) {
        const { conversations: convTable } = await import("@/db/schema");
        const [conv] = await db
          .select({ phone: convTable.customerPhone })
          .from(convTable)
          .where(eq(convTable.id, conversationId))
          .limit(1);

        if (conv?.phone) {
          [lead] = await db
            .select()
            .from(leads)
            .where(eq(leads.phone, conv.phone))
            .limit(1);
        }
      }

      if (!lead) return null;

      return {
        id: lead.id,
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        address: lead.address,
        status: lead.status as CustomerProfile["status"],
        tags: (lead.tags ?? []) as string[],
        notes: lead.notes,
        platform: lead.platform,
        utmSource: lead.utmSource,
        utmMedium: lead.utmMedium,
        utmCampaign: lead.utmCampaign,
        utmContent: lead.utmContent,
        adId: lead.adId,
        campaignId: lead.campaignId,
        conversationId: lead.conversationId,
        createdAt: lead.createdAt instanceof Date
          ? lead.createdAt.toISOString()
          : String(lead.createdAt),
      };
    },
    enabled: !!conversationId,
    staleTime: 30000, // 30s cache — no polling needed
  });
}

export function useCustomerOrders(leadId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: ["customer-orders", leadId],
    queryFn: async (): Promise<OrderSummary[]> => {
      if (!leadId) return [];

      const rows = await db
        .select({
          id: orders.id,
          orderType: orders.orderType,
          status: orders.status,
          total: orders.items,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(eq(orders.leadId, leadId))
        .orderBy(orders.createdAt)
        .limit(20);

      return rows.map((r) => ({
        id: r.id,
        orderType: r.orderType,
        status: r.status,
        total: null, // items is JSONB, extract total if needed
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      }));
    },
    enabled: enabled && !!leadId,
    staleTime: 60000, // 1min cache
  });
}
