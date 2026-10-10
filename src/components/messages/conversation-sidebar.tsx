"use client";

import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, Filter } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConversationItem } from "./conversation-item";
import type { ConversationSummary, ConversationFilter } from "@/types/chat";

interface ConversationSidebarProps {
  conversations: ConversationSummary[];
  activeId: number | null;
  onSelect: (id: number) => void;
  sellerPhones?: string[];
  className?: string;
}

const filters: { value: ConversationFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "whatsapp", label: "WA" },
  { value: "telegram", label: "TG" },
  { value: "sellers", label: "VEN" },
  { value: "active", label: "Activos" },
  { value: "closed", label: "Cerrados" },
];

export function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  sellerPhones = [],
  className,
}: ConversationSidebarProps) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ConversationFilter>("all");

  const filtered = useMemo(() => {
    return conversations.filter((c) => {
      const q = search.toLowerCase();
      const matchesSearch =
        !q ||
        c.customerName?.toLowerCase().includes(q) ||
        c.customerPhone.includes(q) ||
        c.lastMessagePreview?.toLowerCase().includes(q);

      const matchesFilter =
        filter === "all" ||
        (filter === "active" ? c.status === "active" : false) ||
        (filter === "closed" ? c.status === "closed" : false) ||
        (filter === "whatsapp" ? c.channel === "whatsapp" : false) ||
        (filter === "sellers" ? sellerPhones.includes(c.customerPhone) : false) ||
        (filter === "telegram" ? c.channel === "telegram" : false);

      return matchesSearch && matchesFilter;
    });
  }, [conversations, search, filter, sellerPhones]);

  return (
    <div
      className={cn(
        "flex flex-col h-full",
        "bg-card border-r border-border",
        className
      )}
    >
      {/* Header */}
      <div className="p-4 space-y-3 border-b border-border">
        <h2 className="text-lg font-semibold text-foreground">Mensajes</h2>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Buscar conversación..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-muted/40 border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40 transition-colors"
          />
        </div>

        {/* Filter pills */}
        <div className="flex items-center gap-1 flex-wrap">
          <Filter className="h-3.5 w-3.5 text-muted-foreground mr-1" />
          {filters.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                filter === f.value
                  ? "bg-primary/20 text-primary border border-primary/30"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto">
        <AnimatePresence mode="popLayout">
          {filtered.length > 0 ? (
            filtered.map((conversation, i) => (
              <motion.div
                key={conversation.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.15, delay: i * 0.02 }}
              >
                <ConversationItem
                  conversation={conversation}
                  isActive={conversation.id === activeId}
                  onClick={onSelect}
                  isSeller={sellerPhones.includes(conversation.customerPhone)}
                />
              </motion.div>
            ))
          ) : (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-center text-sm text-muted-foreground py-8"
            >
              No se encontraron conversaciones
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {/* Footer count */}
      <div className="px-4 py-2 border-t border-border">
        <p className="text-[11px] text-muted-foreground">
          {filtered.length} conversación{filtered.length !== 1 ? "es" : ""}
        </p>
      </div>
    </div>
  );
}
