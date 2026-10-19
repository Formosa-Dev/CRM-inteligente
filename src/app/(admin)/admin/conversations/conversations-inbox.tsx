"use client";

import { useState, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationSidebar } from "@/components/messages/conversation-sidebar";
import { ChatPanel } from "@/components/messages/chat-panel";
import { CustomerContextPanel } from "@/components/messages/customer-context-panel";
import { CreateOrderModal } from "@/components/orders/create-order-modal";
import { ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import { useIsAdmin } from "@/components/admin/role-context";
import {
  useConversation,
  useConversations,
  useMessages,
  useSendReply,
} from "@/lib/conversations/queries";
import {
  normalizeAccountParam,
  normalizeChannelParam,
  type ChannelAccountOption,
} from "@/lib/conversations/filters";
import { toggleHumanOverride } from "./actions";
import type { ConversationSummary } from "@/types/chat";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true },
  },
});

interface Props {
  initialConversations: ConversationSummary[];
  sellerPhones: string[];
  channelAccounts: ChannelAccountOption[];
}

function ConversationsInboxInner({ initialConversations, sellerPhones, channelAccounts }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Deep link: /admin/conversations?sel=<id> opens that conversation
  // directly (redirección desde la ruta legacy /admin/conversations/[id]).
  const selFromUrl = Number.parseInt(searchParams.get("sel") ?? "", 10);
  const initialSel = Number.isFinite(selFromUrl) ? selFromUrl : null;

  const [selectedId, setSelectedId] = useState<number | null>(initialSel);
  const [currentView, setCurrentView] = useState<"list" | "chat" | "context">(
    initialSel !== null ? "chat" : "list"
  );
  const [orderModal, setOrderModal] = useState<{ phone: string; name: string } | null>(null);
  const isAdmin = useIsAdmin();

  // Channel/account filters live in the URL so a filtered inbox is shareable.
  const channelFilter = normalizeChannelParam(searchParams.get("channel"));
  const accountFilter = normalizeAccountParam(searchParams.get("account"));
  const page = Math.max(
    1,
    Number.parseInt(searchParams.get("page") ?? "1", 10) || 1
  );

  const { data: convData } = useConversations({
    page,
    channel: channelFilter,
    account:
      accountFilter === "all" || accountFilter === "unassigned"
        ? accountFilter
        : String(accountFilter),
  });

  const applyFilter = useCallback(
    (key: "channel" | "account", value: string) => {
      const next = new URLSearchParams(searchParams.toString());
      // Canonical URLs: only true defaults leave the query string. Channel's
      // default is whatsapp — "all" is an explicit filter and must persist,
      // since a missing param normalizes back to whatsapp-only.
      if (
        (key === "account" && value === "all") ||
        (key === "channel" && value === "whatsapp")
      ) {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      next.delete("page");
      const qs = next.toString();
      router.replace(qs ? `/admin/conversations?${qs}` : "/admin/conversations");
    },
    [router, searchParams]
  );

  const handleChannelFilterChange = useCallback(
    (value: string) => applyFilter("channel", value),
    [applyFilter]
  );
  const handleAccountFilterChange = useCallback(
    (value: string) => applyFilter("account", value),
    [applyFilter]
  );
  const { data: messages = [] } = useMessages(selectedId);
  const sendMutation = useSendReply(selectedId);

  const conversations: ConversationSummary[] =
    convData?.conversations ?? initialConversations;

  const handleSelect = useCallback((id: number) => {
    setSelectedId(id);
    setCurrentView("chat");
    // Sync ?sel= so the open chat survives refresh/share — preserves filters.
    const next = new URLSearchParams(searchParams.toString());
    next.set("sel", String(id));
    router.replace(`/admin/conversations?${next.toString()}`);
  }, [router, searchParams]);

  const handleSend = useCallback(
    // mutateAsync propaga el error al ReplyInput, que mantiene el borrador.
    (content: string) => sendMutation.mutateAsync(content),
    [sendMutation]
  );

  const handleOpenContext = useCallback(() => setCurrentView("context"), []);
  const handleBackToList = useCallback(() => setCurrentView("list"), []);
  const handleBackToChat = useCallback(() => setCurrentView("chat"), []);

  // The selected row may not be on the current page/filter — fetch it by id.
  const listedConversation = conversations.find((c) => c.id === selectedId);
  const { data: fetchedConversation } = useConversation(
    selectedId,
    !!selectedId && !listedConversation
  );
  const selectedConversation = listedConversation ?? fetchedConversation ?? undefined;
  const isHumanOverride = selectedConversation?.humanOverrideUntil
    ? new Date(selectedConversation.humanOverrideUntil) > new Date()
    : false;

  const handleHumanOverride = useCallback(async () => {
    if (!selectedId) return;
    const result = await toggleHumanOverride(selectedId, !isHumanOverride);
    if (!result.success) {
      toast.error("No se pudo cambiar el modo manual");
      return;
    }
    toast.success(
      isHumanOverride ? "Bot reactivado" : "Control manual activado por 24h"
    );
    queryClient.invalidateQueries({ queryKey: ["conversations"] });
  }, [selectedId, isHumanOverride]);

  const handleNewOrder = useCallback((phone: string, name: string) => {
    setOrderModal({ phone, name });
  }, []);

  const contextPanel = selectedId ? (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border xl:hidden">
        <button
          onClick={handleBackToChat}
          className="p-1.5 -ml-1.5 rounded-lg hover:bg-muted text-muted-foreground"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <span className="text-sm font-medium text-foreground">Perfil del Cliente</span>
      </div>
      <CustomerContextPanel
        conversationId={selectedId}
        onNewOrder={isAdmin ? handleNewOrder : undefined}
      />
    </div>
  ) : null;

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden bg-card">
      {/* Col 1: Listado de Chats */}
      <div
        className={`flex-shrink-0 border-r border-border overflow-hidden ${
          currentView === "list" ? "flex flex-col w-full md:w-80" : "hidden md:flex md:flex-col md:w-80"
        }`}
      >
        <ConversationSidebar
          conversations={conversations}
          activeId={selectedId}
          onSelect={handleSelect}
          sellerPhones={sellerPhones}
          channelAccounts={channelAccounts}
          channelFilter={channelFilter ?? "whatsapp"}
          accountFilter={String(accountFilter)}
          onChannelFilterChange={handleChannelFilterChange}
          onAccountFilterChange={handleAccountFilterChange}
        />
      </div>

      {/* Col 2: Chat Activo */}
      <div
        className={`flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden ${
          currentView === "chat" ? "flex" : "hidden md:flex"
        }`}
      >
        {!selectedId || !selectedConversation ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <p>Seleccioná una conversación</p>
          </div>
        ) : (
          <ChatPanel
            conversation={selectedConversation}
            messages={messages}
            onSend={handleSend}
            onBack={handleBackToList}
            onShowContext={handleOpenContext}
            onHumanOverride={isAdmin ? handleHumanOverride : undefined}
            humanOverrideActive={isHumanOverride}
            readOnly={!isAdmin}
          />
        )}
      </div>

      {/* Col 3: Contexto/Perfil del Cliente (desktop xl+) */}
      {selectedId && (
        <div className="hidden xl:flex xl:w-[380px] flex-shrink-0 border-l border-border h-full">
          {contextPanel}
        </div>
      )}

      {/* Mobile: overlay fullscreen para contexto */}
      {selectedId && (
        <div
          className={`absolute inset-0 z-40 bg-card xl:hidden ${
            currentView === "context" ? "flex flex-col" : "hidden"
          }`}
        >
          {contextPanel}
        </div>
      )}

      {/* Modal de Nuevo Pedido desde el chat */}
      <CreateOrderModal
        open={orderModal !== null}
        onClose={() => setOrderModal(null)}
        clientName={orderModal?.name ?? ""}
        clientPhone={orderModal?.phone ?? ""}
      />
    </div>
  );
}

export function ConversationsInbox(props: Props) {
  return (
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={null}>
        <ConversationsInboxInner {...props} />
      </Suspense>
    </QueryClientProvider>
  );
}
