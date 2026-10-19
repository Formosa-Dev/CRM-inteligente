"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { fadeUpSmall, staggerContainer } from "@/lib/animation-variants";
import type { ClientSummary } from "./actions";
import { updateClient } from "./actions";
import { useIsAdmin } from "@/components/admin/role-context";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { X, Save, User, Pencil, Sandwich, Wheat, Package } from "lucide-react";
import { Badge } from "@/components/ui/badge";

function leadStatusBadge(status: string | null): { label: string; cls: string } | null {
  if (!status) return null;
  const map: Record<string, { label: string; cls: string }> = {
    new: { label: "Nuevo", cls: "bg-blue-500/10 text-blue-300 border border-blue-500/20" },
    contacted: { label: "Contactado", cls: "bg-amber-500/10 text-amber-300 border border-amber-500/20" },
    converted: { label: "Convertido", cls: "bg-green-500/10 text-green-300 border border-green-500/20" },
    lost: { label: "Perdido", cls: "bg-red-500/10 text-red-300/60 border border-red-500/20" },
  };
  return map[status] ?? null;
}

function clientTypeBadge(type: string | null): { label: string; cls: string } | null {
  if (!type) return null;
  return type === "b2b"
    ? { label: "B2B", cls: "bg-purple-500/10 text-purple-300 border border-purple-500/20 text-[10px] px-2 py-0.5 rounded-full" }
    : { label: "B2C", cls: "bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 text-[10px] px-2 py-0.5 rounded-full" };
}

function OrderTypeIcon({ type }: { type: string | null }) {
  const Icon = type === "hamburguesas" ? Sandwich : type === "pan_mayorista" ? Wheat : Package;
  return <Icon size={14} aria-hidden="true" />;
}

function formatClientDate(d: Date | string | null): string {
  if (!d) return "—";
  const date = new Date(d);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "hoy";
  if (days === 1) return "ayer";
  return date.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" });
}

export function ClientsView({
  clients,
  total,
  currentPage,
  totalPages,
  currentSearch,
}: {
  clients: ClientSummary[];
  total: number;
  currentPage: number;
  totalPages: number;
  currentSearch: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(currentSearch);
  const [editClient, setEditClient] = useState<ClientSummary | null>(null);
  const [editName, setEditName] = useState("");
  const [editType, setEditType] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [localClients, setLocalClients] = useState(clients);
  const [savingEdit, setSavingEdit] = useState(false);
  const isAdmin = useIsAdmin();

  const navigate = useCallback(
    (params: Record<string, string>) => {
      const sp = new URLSearchParams();
      if (params.search) sp.set("search", params.search);
      if (params.page) sp.set("page", params.page);
      router.push(`/admin/clients?${sp.toString()}`);
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
      {/* Search */}
      <motion.div variants={fadeUpSmall} className="flex gap-2 max-w-sm">
        <Input
          placeholder="Buscar por teléfono o nombre..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && navigate({ search, page: "" })}
          className="h-8 text-xs bg-muted/40 border-border"
        />
        <Button
          type="button"
          size="sm"
          onClick={() => navigate({ search, page: "" })}
          className="h-8 text-xs bg-muted/60 hover:bg-muted text-foreground/60"
        >
          Buscar
        </Button>
      </motion.div>

      {/* Stats */}
      <motion.div variants={fadeUpSmall} className="text-xs text-foreground/20">
        {total > 0 ? `${total} clientes` : "..."}
        {totalPages > 1 && total > 0 && (
          <span className="text-foreground/10"> · Pág. {currentPage}/{totalPages}</span>
        )}
      </motion.div>

      {/* Client Cards */}
      <motion.div variants={fadeUpSmall} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {localClients.length === 0 ? (
          <div className="col-span-full flex flex-col items-center justify-center py-20 text-foreground/20">
            <span className="text-4xl mb-3 opacity-30">👥</span>
            <p className="text-sm">
              {currentSearch
                ? `No se encontraron clientes para "${currentSearch}"`
                : "Todavía no hay clientes registrados"}
            </p>
          </div>
        ) : (
          localClients.map((client, i) => (
            <Link key={client.phone} href={`/admin/clients/${encodeURIComponent(client.phone)}`} className="block">
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: (i % 10) * 0.03 }}
                className="rounded-xl border border-border p-4 flex flex-col gap-3 bg-card hover:border-primary/30 hover:bg-muted/20 transition-all duration-200 cursor-pointer"
              >
                <div className="flex items-start justify-between">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-medium text-foreground/90 truncate">{client.name || "Sin nombre"}</span>
                    <span className="text-xs text-foreground/40 font-mono">{client.phone}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {clientTypeBadge(client.type) && (
                      <span className={clientTypeBadge(client.type)!.cls}>{clientTypeBadge(client.type)!.label}</span>
                    )}
                    {leadStatusBadge(client.leadStatus) && (
                      <span className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 ${leadStatusBadge(client.leadStatus)!.cls}`}>
                        {leadStatusBadge(client.leadStatus)!.label}
                      </span>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
                  <div className="rounded-md bg-muted/40 p-2">
                    <div className="font-medium text-foreground/70">{client.totalOrders}</div>
                    <div className="text-foreground/30">Pedidos</div>
                  </div>
                  <div className="rounded-md bg-muted/40 p-2">
                    <div className="font-medium text-foreground/70">{client.totalConversations}</div>
                    <div className="text-foreground/30">Chats</div>
                  </div>
                  <div className="rounded-md bg-muted/40 p-2">
                    <div className="font-medium text-foreground/70">{client.lastOrderType ? <OrderTypeIcon type={client.lastOrderType} /> : "—"}</div>
                    <div className="text-foreground/30">Tipo</div>
                  </div>
                </div>

                {client.tags && client.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {client.tags.map((tag) => (
                      <button key={tag} type="button" onClick={() => navigate({ search: tag, page: "" })} className="border-none bg-transparent p-0">
                        <Badge variant="secondary" className="text-[10px] px-2 sm:px-1.5 py-1 sm:py-0 cursor-pointer hover:opacity-80 transition-opacity">{tag}</Badge>
                      </button>
                    ))}
                  </div>
                )}

                <div className="flex items-center justify-between mt-1">
                  <span className="text-[10px] text-foreground/20">
                    {client.lastOrderDate ? `Últ. pedido: ${formatClientDate(client.lastOrderDate)}` : "Sin pedidos"}
                  </span>
                  <div className="flex items-center gap-1">
                    <Link href={`/admin/clients/${encodeURIComponent(client.phone)}`}
                      className="text-xs text-foreground/30 hover:text-primary transition-colors px-2.5 py-1.5 sm:px-1.5 sm:py-0.5" aria-label="Ver cliente"><User size={14} aria-hidden="true" /></Link>
                    {isAdmin && (
                      <button onClick={(e) => { e.preventDefault(); setEditClient(client); setEditName(client.name || ""); setEditType(client.type || ""); setEditNotes(""); }}
                        className="text-xs text-foreground/20 hover:text-gold-bright transition-colors px-2.5 py-1.5 sm:px-1.5 sm:py-0.5" title="Editar cliente" aria-label="Editar cliente"><Pencil size={13} aria-hidden="true" /></button>
                    )}
                  </div>
                </div>
              </motion.div>
            </Link>
          ))
        )}
      </motion.div>

      {/* ── Pagination ───────────────────────────────────────────────── */}
      {totalPages > 1 && (
        <motion.div variants={fadeUpSmall} className="flex items-center justify-center gap-2 mt-4">
          <button
            onClick={() => navigate({ search: currentSearch, page: String(currentPage - 1) })}
            disabled={currentPage <= 1}
            className="px-3 py-1.5 rounded-lg text-xs bg-muted/40 border border-border text-foreground/50 hover:text-foreground/80 hover:bg-muted disabled:opacity-20 disabled:pointer-events-none transition-all"
          >
            ← Anterior
          </button>

          {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => {
            // Show first, last, and pages around current
            const isCurrent = page === currentPage;
            const isNear = Math.abs(page - currentPage) <= 2;
            const isEdge = page === 1 || page === totalPages;
            if (!isNear && !isEdge) return null;

            // Ellipsis
            const prev = page - 1;
            if (page > 1 && prev !== currentPage && prev !== currentPage - 1 && prev !== currentPage + 1 && prev !== 1) {
              return null; // ellipsis handled by next iteration
            }

            return (
              <button
                key={page}
                onClick={() => navigate({ search: currentSearch, page: String(page) })}
                className={`w-8 h-8 rounded-lg text-xs font-medium transition-all ${
                  isCurrent
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted/40 border border-border text-foreground/50 hover:text-foreground/80 hover:bg-muted"
                }`}
              >
                {page}
              </button>
            );
          })}

          <button
            onClick={() => navigate({ search: currentSearch, page: String(currentPage + 1) })}
            disabled={currentPage >= totalPages}
            className="px-3 py-1.5 rounded-lg text-xs bg-muted/40 border border-border text-foreground/50 hover:text-foreground/80 hover:bg-muted disabled:opacity-20 disabled:pointer-events-none transition-all"
          >
            Siguiente →
          </button>
        </motion.div>
      )}

      {/* ── Edit Modal ───────────────────────────────────────────────── */}
      {editClient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setEditClient(null)} />
          <div className="relative z-10 w-full max-w-md mx-4 bg-card border border-border rounded-2xl shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <span className="text-sm font-semibold text-foreground">Editar {editClient.name || "cliente"}</span>
              <button onClick={() => setEditClient(null)} className="p-1 rounded-lg hover:bg-muted text-muted-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="text-[10px] text-muted-foreground uppercase font-semibold">Nombre</label>
                <input value={editName} onChange={(e) => setEditName(e.target.value)}
                  className="w-full mt-1 px-3 py-2 rounded-lg bg-muted/40 border border-border text-sm text-foreground focus:outline-none focus:border-primary/40" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase font-semibold">Teléfono</label>
                  <input value={editClient.phone} disabled
                    className="w-full mt-1 px-3 py-2 rounded-lg bg-muted/20 border border-border text-sm text-muted-foreground cursor-not-allowed" />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase font-semibold">Tipo</label>
                  <select value={editType} onChange={(e) => setEditType(e.target.value)}
                    className="w-full mt-1 px-3 py-2 rounded-lg bg-muted/40 border border-border text-sm text-foreground focus:outline-none focus:border-primary/40">
                    <option value="">—</option>
                    <option value="b2c">B2C (Consumidor)</option>
                    <option value="b2b">B2B (Mayorista)</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground uppercase font-semibold">Notas</label>
                <textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} rows={3} placeholder="Notas internas..."
                  className="w-full mt-1 px-3 py-2 rounded-lg bg-muted/40 border border-border text-sm text-foreground focus:outline-none focus:border-primary/40 resize-none" />
              </div>
            </div>
                <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
                <button onClick={() => setEditClient(null)} className="px-5 py-2.5 sm:px-4 sm:py-2 rounded-lg text-xs text-muted-foreground hover:bg-muted">
                  Cancelar
                </button>
                <button onClick={async () => {
                setSavingEdit(true);
                try {
                  const result = await updateClient(editClient.phone, {
                    name: editName,
                    type: editType === "b2c" || editType === "b2b" ? editType : null,
                    notes: editNotes || undefined,
                  });

                  if (result.success) {
                    // Actualizar estado local INMEDIATAMENTE
                    setLocalClients((prev) =>
                      prev.map((c) =>
                        c.phone === editClient.phone
                          ? { ...c, name: editName, type: editType === "b2c" || editType === "b2b" ? editType : c.type }
                          : c
                      )
                    );
                    setEditClient(null);
                  } else {
                    toast.error(result.error ?? "No se pudo guardar el cliente");
                  }
                } catch {
                  toast.error("No se pudo guardar el cliente");
                }
                setSavingEdit(false);
              }} disabled={savingEdit}
                className="flex items-center gap-1.5 px-6 py-2.5 sm:px-5 sm:py-2 rounded-lg text-xs font-semibold bg-primary text-primary-foreground hover:bg-gold-bright disabled:opacity-40">
                <Save className="h-3 w-3" />
                {savingEdit ? "Guardando..." : "Guardar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
