"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { CheckCircle, Clock, DollarSign, Inbox, MessageSquare, Target, Truck, UserPlus } from "lucide-react";
import { fadeUpSmall, staggerContainer, cardEntrance } from "@/lib/animation-variants";
import type { ActionCard } from "./page";
import { updateOrderStatus, markPaidAndDelivered } from "@/app/(admin)/admin/orders/actions";
import { triggerAgentForConversation } from "./dashboard-actions-server";

// ─── Single gold accent (D8: oro, no multi-hue) ────────────────────────────

const GOLD_STYLE: { border: string; bg: string; btn: string; btnHover: string } = {
  border: "border-primary/20",
  bg: "bg-primary/[0.03]",
  btn: "bg-primary/15 text-primary border border-primary/20",
  btnHover: "hover:bg-primary/25",
};

// Emoji → lucide icon names (server passes a semantic key, not an emoji).
const ICON_MAP: Record<string, typeof Truck> = {
  truck: Truck,
  check: CheckCircle,
  clock: Clock,
  message: MessageSquare,
  dollar: DollarSign,
  userplus: UserPlus,
  inbox: Inbox,
};

function CardIcon({ name }: { name: string }) {
  const Icon = ICON_MAP[name] ?? Inbox;
  return <Icon size={16} aria-hidden="true" />;
}

// ─── Action Button ────────────────────────────────────────────────────────

function ActionButton({
  label,
  onClick,
  style,
  loading,
}: {
  label: string;
  onClick: () => void;
  style: { btn: string; btnHover: string };
  loading?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all ${style.btn} ${style.btnHover} disabled:opacity-40 disabled:pointer-events-none flex items-center gap-1.5`}
    >
      {loading && (
        <span className="inline-block size-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
      )}
      {label}
    </button>
  );
}

// ─── Action Card ──────────────────────────────────────────────────────────

function ActionCardComponent({
  card,
  router,
}: {
  card: ActionCard;
  router: ReturnType<typeof useRouter>;
}) {
  const [loadingItems, setLoadingItems] = useState<Record<string, Record<string, boolean>>>({});

  const styles = GOLD_STYLE;

  async function handleAction(itemId: string | number, action: string, item: (typeof card.items)[0]) {
    setLoadingItems((prev) => ({
      ...prev,
      [itemId]: { ...(prev[itemId] || {}), [action]: true },
    }));

    try {
      switch (action) {
        case "mark-delivered":
          await updateOrderStatus(Number(itemId), "delivered");
          break;
        case "mark-ready":
          await updateOrderStatus(Number(itemId), "ready");
          break;
        case "mark-paid":
          await markPaidAndDelivered(Number(itemId));
          break;
        case "open-chat":
          if (item.conversationId) {
            router.push(`/admin/conversations/${item.conversationId}`);
          }
          break;
        case "trigger-agent":
          if (item.conversationId && item.phone) {
            const result = await triggerAgentForConversation(item.conversationId, item.phone);
            if (!result.success) {
              console.warn("[dashboard] triggerAgent failed:", result.message);
            }
          }
          break;
        case "view-lead":
          if (item.phone) {
            router.push(`/admin/clients/${encodeURIComponent(item.phone)}`);
          }
          break;
      }
      // Re-cargar la página para refrescar datos
      router.refresh();
    } catch (err) {
      console.warn(`[dashboard] Action ${action} failed:`, err);
    } finally {
      setLoadingItems((prev) => ({
        ...prev,
        [itemId]: { ...(prev[itemId] || {}), [action]: false },
      }));
    }
  }

  return (
    <motion.div
      variants={cardEntrance}
      className={`rounded-xl border ${styles.border} ${styles.bg} overflow-hidden`}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground/90 flex items-center gap-2"><CardIcon name={card.icon} /> {card.title}</h3>
        <p className="text-[11px] text-foreground/30 mt-0.5">{card.items.length} pendiente{card.items.length !== 1 ? "s" : ""}</p>
      </div>

      {/* Items */}
      <div className="divide-y divide-border">
        {card.items.map((item) => {
          const itemLoading = loadingItems[item.id] || {};
          return (
            <div key={item.id} className="px-4 py-2.5 flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-foreground/80 truncate">{item.label}</p>
                <p className="text-[11px] text-foreground/30 truncate">{item.subtitle}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {card.actions.map((action) => (
                  <ActionButton
                    key={action.action}
                    label={action.label}
                    onClick={() => handleAction(item.id, action.action, item)}
                    style={styles}
                    loading={itemLoading[action.action]}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

// ─── Dashboard Actions ────────────────────────────────────────────────────

export function DashboardActions({ actionCards }: { actionCards: ActionCard[] }) {
  const router = useRouter();

  if (actionCards.length === 0) return null;

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-4"
    >
      {/* Section header */}
      <motion.div variants={fadeUpSmall}>
        <h2 className="text-base font-semibold text-gold-gradient flex items-center gap-2"><Target size={16} aria-hidden="true" /> Acciones del día</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Insights y acciones rápidas basadas en datos en vivo
        </p>
      </motion.div>

      {/* Cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {actionCards.map((card) => (
          <ActionCardComponent key={card.id} card={card} router={router} />
        ))}
      </div>
    </motion.div>
  );
}