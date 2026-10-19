"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { fadeUpSmall, staggerContainer } from "@/lib/animation-variants";
import { updateOrderStatus, notifyCustomer, deleteOrder, markPaidAndDelivered, type OrderRow, type OrderStatus } from "./actions";
import { computeOrderTotal } from "@/lib/client-utils";
import { OrderEditModal } from "./order-edit-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Bell, X, Trash2, Pencil, Sandwich, Wheat, Package, ClipboardList } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StatusConfig {
  label: string;
  color: string;
  dot: string;
}

const STATUSES: Record<string, StatusConfig> = {
  pending: { label: "Pendiente", color: "text-amber-400 border-amber-500/30", dot: "bg-amber-400" },
  preparing: { label: "Preparando", color: "text-blue-400 border-blue-500/30", dot: "bg-blue-400" },
  ready: { label: "Listo", color: "text-green-400 border-green-500/30", dot: "bg-green-400" },
  delivered: { label: "Entregado", color: "text-foreground/40 border-border", dot: "bg-foreground/20" },
  cancelled: { label: "Cancelado", color: "text-red-400/60 border-red-500/20", dot: "bg-red-400/50" },
};

const NEXT_STATUS: Record<string, string> = {
  pending: "preparing",
  preparing: "ready",
  ready: "delivered",
};

function notifyResult(result: { success: boolean; message?: string; error?: string }) {
  if (result.success) toast.success(result.message ?? "Listo");
  else toast.error(result.message ?? result.error ?? "La acción falló");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(d: Date): string {
  const date = new Date(d);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);

  if (mins < 1) return "Ahora";
  if (mins < 60) return `Hace ${mins} min`;
  if (mins < 120) return "Hace 1 hora";

  return date.toLocaleString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  });
}

function orderTypeBadge(type: string | null): { label: string; cls: string; Icon: typeof Sandwich } {
  if (type === "hamburguesas") return { label: "Hamburguesas", Icon: Sandwich, cls: "bg-amber-500/10 text-amber-300 border border-amber-500/20" };
  if (type === "pan_mayorista") return { label: "Pan Mayorista", Icon: Wheat, cls: "bg-emerald-500/10 text-emerald-300 border border-emerald-500/20" };
  return { label: "Gral", Icon: Package, cls: "bg-muted/40 text-foreground/50 border border-border" };
}

// ─── Order Card ───────────────────────────────────────────────────────────────

function OrderCard({
  order,
  onStatusChange,
  onDelete,
}: {
  order: OrderRow;
  onStatusChange: (id: number, status: string) => void;
  onDelete: (id: number) => void;
}) {
  const [changing, setChanging] = useState(false);
  const [notifying, setNotifying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const statusCfg = STATUSES[order.status] ?? STATUSES.pending;
  const typeBadge = orderTypeBadge(order.orderType);
  const items: Array<{ name?: string; quantity?: number; productName?: string; price?: number; unitPrice?: number }> =
    Array.isArray(order.items) ? order.items : [];
  const total = computeOrderTotal(items, order.deliveryFee);

  const handleNext = useCallback(async () => {
    const next = NEXT_STATUS[order.status];
    if (!next) return;
    setChanging(true);
    const result = await updateOrderStatus(order.id, next as OrderStatus);
    notifyResult(result);
    if (result.success) onStatusChange(order.id, next);
    setChanging(false);
  }, [order.id, order.status, onStatusChange]);

  const handleCancel = useCallback(async () => {
    setChanging(true);
    const result = await updateOrderStatus(order.id, "cancelled");
    notifyResult(result);
    if (result.success) onStatusChange(order.id, "cancelled");
    setChanging(false);
  }, [order.id, onStatusChange]);

  return (
    <>
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      onClick={() => setEditOpen(true)}
      className={`rounded-xl border p-4 flex flex-col gap-3 bg-card transition-all duration-200 hover:border-primary/40 cursor-pointer ${
        order.status === "pending" ? "border-primary/30" : "border-border"
      }`}
    >
      {/* Header: ID + Order Type */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-foreground/30">#{order.id}</span>
        <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full ${typeBadge.cls}`}>
          <typeBadge.Icon size={10} aria-hidden="true" />
          {typeBadge.label}
        </span>
      </div>

      {/* Customer */}
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground/90">
          {order.customerName || "Sin nombre"}
        </span>
        <span className="text-xs text-foreground/40">{order.phoneNumber}</span>
      </div>

      {/* Items */}
      <div className="text-xs text-foreground/60 leading-relaxed">
        {items.length === 0 ? (
          <span className="italic text-foreground/30">Sin items</span>
        ) : (
          items.map((item, i) => (
            <span key={i} className="block">
              {item.quantity ?? 1}x {item.name ?? item.productName ?? "Producto"}
            </span>
          ))
        )}
      </div>

      {/* Hero total — only when something is priced (spec: render iff > 0) */}
      {total > 0 && (
        <div className="flex items-baseline justify-between gap-2 border-t border-border pt-2">
          <span className="text-[10px] uppercase tracking-wider text-foreground/30">Total</span>
          <span className="font-mono font-black tabular-nums text-xl text-foreground/90">
            ${total.toLocaleString("es-AR")}
          </span>
        </div>
      )}

      {/* Notes */}
      {order.notes && (
        <div className="text-[11px] text-foreground/40 italic border-t border-border pt-2">
          {order.notes}
        </div>
      )}

      {/* Tags */}
      {Array.isArray(order.tags) && order.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {order.tags.filter(tag => !tag.startsWith("web-checkout:") && !tag.startsWith("web-payload:")).map((tag) => (
            <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      {/* Footer: Status + Time + Actions */}
      <div className="flex items-center justify-between mt-1">
        <div className="flex items-center gap-2">
          <span className={`inline-flex h-2 w-2 rounded-full ${statusCfg.dot}`} />
          <span className={`text-[11px] font-medium ${statusCfg.color}`}>
            {statusCfg.label}
          </span>
          <span className="text-[10px] text-foreground/20">
            {formatTime(order.createdAt)}
          </span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {NEXT_STATUS[order.status] && (
            <Button
              type="button"
              size="sm"
              disabled={changing}
              onClick={(e) => { e.stopPropagation(); handleNext(); }}
              className="h-8 sm:h-7 text-xs px-2.5 sm:px-3 bg-muted/60 hover:bg-muted text-foreground/70"
            >
              → {STATUSES[NEXT_STATUS[order.status]]?.label}
            </Button>
          )}
          {/* Pagado + Entregado directo (sin mensaje) */}
          {order.status !== "delivered" && order.status !== "cancelled" && (
            <Button
              type="button"
              size="sm"
              disabled={changing}
              onClick={async (e) => {
                e.stopPropagation();
                setChanging(true);
                const result = await markPaidAndDelivered(order.id);
                notifyResult(result);
                if (result.success) onStatusChange(order.id, "delivered");
                setChanging(false);
              }}
              className="h-8 sm:h-7 text-xs px-2.5 sm:px-2 bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/20"
              title="Marcar como pagado + entregado (sin notificar)"
            >
              ✓ Pagado
            </Button>
          )}
          {(order.status === "pending" || order.status === "preparing") && (
            <Button
              type="button"
              size="sm"
              disabled={notifying}
              onClick={async (e) => {
                e.stopPropagation();
                setNotifying(true);
                notifyResult(await notifyCustomer(order.id));
                setNotifying(false);
              }}
              variant="ghost"
              className="h-8 sm:h-7 w-8 sm:w-7 text-xs flex items-center justify-center text-foreground/30 hover:text-gold-bright"
              title="Notificar al cliente"
              aria-label="Notificar al cliente"
            >
              <Bell size={14} aria-hidden="true" />
            </Button>
          )}
          {order.status === "pending" && (
            <Button
              type="button"
              size="sm"
              disabled={changing}
              onClick={(e) => { e.stopPropagation(); handleCancel(); }}
              variant="ghost"
              className="h-8 sm:h-7 w-8 sm:w-7 text-xs flex items-center justify-center text-red-400/50 hover:text-red-400"
              title="Cancelar pedido"
              aria-label="Cancelar pedido"
            >
              <X size={14} aria-hidden="true" />
            </Button>
          )}
          {/* Delete button - visible on delivered/cancelled or always with confirm */}
          {confirmDelete ? (
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                disabled={deleting}
                onClick={async (e) => {
                  e.stopPropagation();
                  setDeleting(true);
                  const result = await deleteOrder(order.id);
                  notifyResult(result);
                  if (result.success) {
                    setConfirmDelete(false);
                    onDelete(order.id);
                  }
                  setDeleting(false);
                }}
                className="h-8 sm:h-7 text-xs px-2.5 sm:px-2 bg-red-500/20 text-red-400 hover:bg-red-500/30"
              >
                {deleting ? "..." : "Eliminar"}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
                variant="ghost"
                className="h-8 sm:h-7 text-xs px-2 text-foreground/30"
                title="Cancelar eliminación"
                aria-label="Cancelar eliminación"
              >
                <X size={13} aria-hidden="true" />
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
              variant="ghost"
              className="h-8 sm:h-7 w-8 sm:w-7 text-xs flex items-center justify-center text-foreground/20 hover:text-red-400"
              title="Eliminar pedido"
              aria-label="Eliminar pedido"
            >
              <Trash2 size={14} aria-hidden="true" />
            </Button>
          )}
          {/* Edit button */}
          <Button
            type="button"
            size="sm"
            onClick={(e) => { e.stopPropagation(); setEditOpen(true); }}
            variant="ghost"
            className="h-8 sm:h-7 w-8 sm:w-7 text-xs flex items-center justify-center text-foreground/20 hover:text-gold-bright"
            title="Editar pedido"
            aria-label="Editar pedido"
          >
            <Pencil size={14} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </motion.div>
    <OrderEditModal order={order} open={editOpen} onClose={() => setEditOpen(false)} />
    </>
  );
}

// ─── Empty State ──────────────────────────────────────────────────────────────

function EmptyState({ label }: { label: string }) {
  return (
    <div className="col-span-full flex flex-col items-center justify-center py-20 text-foreground/20">
      <ClipboardList size={36} strokeWidth={1.25} aria-hidden="true" className="mb-3 opacity-30" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

// ─── Main View ────────────────────────────────────────────────────────────────

export function OrdersView({
  orders,
  counts,
  currentPage,
  totalPages,
  currentStatus,
  currentType,
  currentSearch,
}: {
  orders: OrderRow[];
  counts: Record<string, number>;
  currentPage: number;
  totalPages: number;
  currentStatus: string;
  currentType: string;
  currentSearch: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(currentSearch);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") router.refresh(); };
    const interval = window.setInterval(refresh, 15000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", refresh); };
  }, [router]);

  const allStatuses = ["", "pending", "preparing", "ready", "delivered", "cancelled"];

  const navigate = useCallback(
    (params: Record<string, string>) => {
      const sp = new URLSearchParams();
      if (params.status) sp.set("status", params.status);
      if (params.type) sp.set("type", params.type);
      if (params.search) sp.set("search", params.search);
      if (params.page) sp.set("page", params.page);
      router.push(`/admin/orders?${sp.toString()}`);
    },
    [router]
  );

  const handleSearch = useCallback(() => {
    navigate({ status: currentStatus, type: currentType, search, page: "" });
  }, [navigate, currentStatus, currentType, search]);

  const onStatusChange = useCallback(
    async (_id: number, _newStatus: string) => {
      router.refresh();
    },
    [router]
  );

  const onDelete = useCallback(
    async (_id: number) => {
      router.refresh();
    },
    [router]
  );

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-5"
    >
      {/* Status Filter Tabs */}
      <motion.div variants={fadeUpSmall}>
        <SegmentedControl
          id="orders-status"
          className="flex-wrap"
          value={currentStatus}
          onChange={(s) => navigate({ status: s, type: currentType, search: currentSearch, page: "" })}
          options={allStatuses.map((s) => ({
            id: s,
            label: s === "" ? "Todos" : STATUSES[s]?.label ?? s,
            count: counts[s] ?? 0,
          }))}
        />
      </motion.div>

      {/* Type Filter + Search */}
      <motion.div variants={fadeUpSmall} className="flex flex-col sm:flex-row gap-3">
        <SegmentedControl
          id="orders-type"
          value={currentType}
          onChange={(t) => navigate({ status: currentStatus, type: t, search: currentSearch, page: "" })}
          options={[
            { id: "", label: "Todos" },
            { id: "hamburguesas", label: (<><Sandwich size={12} aria-hidden="true" />Hamburguesas</>) },
            { id: "pan_mayorista", label: (<><Wheat size={12} aria-hidden="true" />Pan Mayorista</>) },
          ]}
        />
        <div className="flex gap-2 flex-1 sm:max-w-xs">
          <Input
            placeholder="Buscar por teléfono, nombre..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="h-8 text-xs bg-muted/40 border-border"
          />
          <Button
            type="button"
            size="sm"
            onClick={handleSearch}
            className="h-8 text-xs bg-muted/60 hover:bg-muted text-foreground/60"
          >
            Buscar
          </Button>
        </div>
      </motion.div>

      {/* Stats Bar */}
      <motion.div variants={fadeUpSmall} className="flex gap-4 text-xs text-foreground/20">
        <span>Total: {counts.total ?? 0}</span>
        <span>Pendientes: {counts.pending ?? 0}</span>
        <span>Preparando: {counts.preparing ?? 0}</span>
        <span>Listos: {counts.ready ?? 0}</span>
      </motion.div>

      {/* Order Cards Grid */}
      <motion.div
        variants={fadeUpSmall}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
      >
        {orders.length === 0 ? (
          <EmptyState
            label={
              currentStatus
                ? `No hay pedidos con estado "${STATUSES[currentStatus]?.label ?? currentStatus}"`
                : "No hay pedidos todavía. Los pedidos aparecen cuando el agente de WhatsApp los registra."
            }
          />
        ) : (
          orders.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              onStatusChange={onStatusChange}
              onDelete={onDelete}
            />
          ))
        )}
      </motion.div>

      {/* Pagination */}
      {totalPages > 1 && (
        <motion.div variants={fadeUpSmall} className="flex items-center justify-center gap-2 pt-2">
          <Button
            type="button"
            size="sm"
            disabled={currentPage <= 1}
            onClick={() =>
              navigate({
                status: currentStatus,
                type: currentType,
                search: currentSearch,
                page: String(currentPage - 1),
              })
            }
            variant="outline"
            className="h-8 text-xs border-border"
          >
            ← Anterior
          </Button>
          <span className="text-xs text-foreground/30">
            {currentPage} / {totalPages}
          </span>
          <Button
            type="button"
            size="sm"
            disabled={currentPage >= totalPages}
            onClick={() =>
              navigate({
                status: currentStatus,
                type: currentType,
                search: currentSearch,
                page: String(currentPage + 1),
              })
            }
            variant="outline"
            className="h-8 text-xs border-border"
          >
            Siguiente →
          </Button>
        </motion.div>
      )}
    </motion.div>
  );
}
