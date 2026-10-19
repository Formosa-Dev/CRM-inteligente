import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import {
  getConversation,
  getConversations,
  getCustomerOrders,
  getCustomerProfile,
  getMessages,
  sendReply,
  type GetConversationsParams,
} from "@/app/(admin)/admin/conversations/actions";
import type { ConversationSummary, ChatMessage } from "@/types/chat";

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
    // Keep showing the previous result while a changed filter fetches —
    // without it the list flashes the unfiltered SSR fallback on every switch.
    placeholderData: keepPreviousData,
    // Smart polling: 5s si hay activas, 30s si idle, pausa en hidden
    refetchInterval: (_query) => {
      if (typeof document !== "undefined" && document.hidden) return false;
      return 5000;
    },
    staleTime: 3000,
    refetchIntervalInBackground: false,
  });
}

// ─── Single Conversation ──────────────────────────────────────────────────────

/**
 * Fetches one conversation by id — used when ?sel=<id> points to a row that
 * isn't on the current list page (older page, or filtered out by channel).
 */
export function useConversation(conversationId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: async () => {
      if (!conversationId) return null;
      const row = await getConversation(conversationId);
      return row ? mapToSummary(row as unknown as Record<string, unknown>) : null;
    },
    enabled: enabled && !!conversationId,
    staleTime: 10000,
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
    // Server action — la sesión se valida server-side; el browser no puede
    // consultar Drizzle directamente (no hay DATABASE_URL en el bundle).
    queryFn: () =>
      conversationId ? getCustomerProfile(conversationId) : null,
    enabled: !!conversationId,
    staleTime: 30000, // 30s cache — no polling needed
  });
}

export function useCustomerOrders(leadId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: ["customer-orders", leadId],
    // Server action — devuelve las 20 órdenes más recientes (DESC).
    queryFn: () => (leadId ? getCustomerOrders(leadId) : []),
    enabled: enabled && !!leadId,
    staleTime: 60000, // 1min cache
  });
}
