"use client";

import { useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, Phone, MoreVertical, UserCheck, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChannelBadge } from "./channel-badge";
import { MessageBubble } from "./message-bubble";
import { ReplyInput } from "./reply-input";
import type { ChatMessage, ConversationSummary } from "@/types/chat";

interface ChatPanelProps {
  conversation: ConversationSummary;
  messages: ChatMessage[];
  onSend: (message: string) => Promise<void>;
  onBack?: () => void;
  onHumanOverride?: () => void;
  onShowContext?: () => void;
  humanOverrideActive?: boolean;
  className?: string;
}

function isSameDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function formatDateSeparator(dateStr: string): string {
  const d = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (isSameDay(dateStr, today.toISOString())) return "Hoy";
  if (isSameDay(dateStr, yesterday.toISOString())) return "Ayer";
  return d.toLocaleDateString("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function DateSeparator({ date }: { date: string }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="flex-1 h-px bg-border" />
      <span className="text-[11px] text-muted-foreground font-medium px-2">
        {formatDateSeparator(date)}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}

export function ChatPanel({
  conversation,
  messages,
  onSend,
  onBack,
  onHumanOverride,
  onShowContext,
  humanOverrideActive,
  className,
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const displayName = conversation.customerName || conversation.customerPhone;
  const initial = (conversation.customerName?.[0] || conversation.customerPhone?.slice(-2) || "?").toUpperCase();

  // Auto-scroll messages container to bottom (NUNCA scrollIntoView — scrollea la ventana)
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className={cn("flex flex-col flex-1 min-h-0 bg-background", className)}>
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-3 px-4 py-3 border-b border-border bg-black/60 backdrop-blur-lg"
      >
        {onBack && (
          <button
            onClick={onBack}
            className="p-1.5 -ml-1 rounded-lg hover:bg-muted text-muted-foreground lg:hidden"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}

        {/* Avatar */}
        <div className="h-9 w-9 rounded-full bg-gradient-to-br from-primary/30 to-primary/10 flex items-center justify-center text-sm font-semibold text-primary">
          {initial}
        </div>

        {/* Info — clickeable para abrir perfil en mobile */}
        <button
          onClick={onShowContext}
          className="flex-1 min-w-0 text-left"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate">
              {displayName}
            </span>
            <ChannelBadge channel={conversation.channel} size="sm" />
            {conversation.status === "active" && !humanOverrideActive && (
              <span className="h-2 w-2 rounded-full bg-emerald-400 flex-shrink-0" />
            )}
            {humanOverrideActive && (
              <span className="text-[10px] font-medium text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded flex-shrink-0">
                Manual
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground truncate">
            {conversation.customerPhone}
          </p>
        </button>

        {/* Actions */}
        <div className="flex items-center gap-1">
          {/* Customer context — visible en mobile (<xl) porque en xl+ está siempre visible */}
          {onShowContext && (
            <button
              onClick={onShowContext}
              className="p-2 rounded-lg hover:bg-muted text-muted-foreground transition-colors xl:hidden"
              title="Datos del cliente"
            >
              <UserRound className="h-4 w-4" />
            </button>
          )}
          {onHumanOverride && (
            <button
              onClick={onHumanOverride}
              className={`p-2 rounded-lg transition-colors ${
                humanOverrideActive
                  ? "bg-blue-500/20 text-blue-400 hover:bg-blue-500/30"
                  : "hover:bg-muted text-muted-foreground"
              }`}
              title={humanOverrideActive ? "Modo manual activo — desactivar" : "Tomar control manual"}
            >
              <UserCheck className="h-4 w-4" />
            </button>
          )}
          <button className="p-2 rounded-lg hover:bg-muted text-muted-foreground transition-colors">
            <Phone className="h-4 w-4" />
          </button>
          <button className="p-2 rounded-lg hover:bg-muted text-muted-foreground transition-colors">
            <MoreVertical className="h-4 w-4" />
          </button>
        </div>
      </motion.div>

      {/* Messages area */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto"
        style={{ scrollbarWidth: "thin" }}
      >
        <div className="px-4 py-4 space-y-1">
          <AnimatePresence mode="popLayout">
            {messages.map((msg, i) => {
              const showDate =
                i === 0 ||
                !isSameDay(messages[i - 1].createdAt, msg.createdAt);

              return (
                <div key={msg.id}>
                  {showDate && <DateSeparator date={msg.createdAt} />}
                  <div
                    className={cn(
                      "flex mb-2",
                      msg.role === "user" ? "justify-start" : "justify-end",
                      msg.role === "system" && "justify-center"
                    )}
                  >
                    <MessageBubble message={msg} />
                  </div>
                </div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>

      {/* Reply input */}
      <ReplyInput onSend={onSend} channel={conversation.channel} />
    </div>
  );
}
