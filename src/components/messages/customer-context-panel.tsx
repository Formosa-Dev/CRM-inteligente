"use client";

import { useState } from "react";
import { Phone, Mail, MapPin, ShoppingBag, UserPlus, Bot, Shield, ChevronDown } from "lucide-react";
import { useCustomerProfile, useMessages } from "@/lib/conversations/queries";
import { LeadStatusBadge } from "./lead-status-badge";
import { TagList } from "./tag-list";
import { OrderHistory } from "./order-history";
import { cn } from "@/lib/utils";

interface CustomerContextPanelProps {
  conversationId: number;
  className?: string;
  onNewOrder?: (phone: string, name: string) => void;
}

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-xs text-foreground truncate max-w-[200px] text-right">{value}</span>
    </div>
  );
}

function formatDate(iso: string | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-AR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export function CustomerContextPanel({ conversationId, className, onNewOrder }: CustomerContextPanelProps) {
  const { data: profile, isLoading } = useCustomerProfile(conversationId);
  const { data: messages } = useMessages(conversationId);
  const [ordersOpen, setOrdersOpen] = useState(false);

  if (isLoading) {
    return (
      <div className={cn("flex items-center justify-center h-full text-xs text-muted-foreground", className)}>
        Cargando...
      </div>
    );
  }

  if (!profile) {
    return (
      <div className={cn("flex items-center justify-center h-full text-xs text-muted-foreground", className)}>
        Sin datos de cliente
      </div>
    );
  }

  const initials = (profile.name ?? "?")
    .split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);

  const messageCount = messages?.length ?? 0;
  const firstMsg = messages?.[0]?.createdAt;
  const lastMsg = messages?.[messages.length - 1]?.createdAt;

  return (
    <div className={cn("flex flex-col h-full overflow-y-auto bg-background", className)}>
      {/* ── Header: Avatar + Nombre + Status ───────────────────────────── */}
      <div className="flex flex-col items-center gap-2 px-4 py-6 border-b border-border">
        <div className="h-14 w-14 rounded-full bg-gradient-to-br from-primary/30 to-primary/10 flex items-center justify-center text-lg font-bold text-primary">
          {initials}
        </div>
        <div className="text-center">
          <h3 className="text-sm font-medium text-foreground">{profile.name ?? "Sin nombre"}</h3>
          <div className="flex items-center justify-center gap-2 mt-1">
            <LeadStatusBadge status={profile.status} />
            {profile.tags.length > 0 && <TagList tags={profile.tags} />}
          </div>
        </div>
      </div>

      {/* ── Stats ──────────────────────────────────────────────────────── */}
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center gap-4 text-center">
          <div className="flex-1">
            <p className="text-sm font-semibold text-foreground">{messageCount}</p>
            <p className="text-[10px] text-muted-foreground">Mensajes</p>
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-foreground">{formatDate(firstMsg)}</p>
            <p className="text-[10px] text-muted-foreground">Primer contacto</p>
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-foreground">{formatDate(lastMsg)}</p>
            <p className="text-[10px] text-muted-foreground">Último</p>
          </div>
        </div>
      </div>

      {/* ── Card: Estado del Bot ────────────────────────────────────────── */}
      <div className="px-4 py-3 border-b border-border">
        <div className="rounded-lg bg-muted/40 border border-border px-3.5 py-3">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-full bg-emerald-500/15 flex items-center justify-center">
              <Bot className="h-4 w-4 text-emerald-400" />
            </div>
            <div className="flex-1">
              <p className="text-xs font-medium text-foreground">IA Activa</p>
              <p className="text-[10px] text-muted-foreground">Atención automática</p>
            </div>
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
          </div>
        </div>
      </div>

      {/* ── Card: CONTACTO / DETALLES ──────────────────────────────────── */}
      <div className="px-4 py-3 border-b border-border">
        <p className="text-[10px] font-semibold text-muted-foreground tracking-wider mb-2.5">CONTACTO / DETALLES</p>
        <div className="rounded-lg bg-muted/40 border border-border divide-y divide-border">
          <div className="flex items-center gap-3 px-3.5 py-2.5">
            <UserPlus className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            <span className="text-xs text-foreground">{profile.name ?? "Sin nombre"}</span>
          </div>
          <div className="flex items-center gap-3 px-3.5 py-2.5">
            <Phone className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            <span className="text-xs text-foreground">{profile.phone}</span>
          </div>
          {profile.email && (
            <div className="flex items-center gap-3 px-3.5 py-2.5">
              <Mail className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              <span className="text-xs text-foreground">{profile.email}</span>
            </div>
          )}
          {profile.address && (
            <div className="flex items-center gap-3 px-3.5 py-2.5">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              <span className="text-xs text-foreground truncate">{profile.address}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Acciones Rápidas ────────────────────────────────────────────── */}
      <div className="px-4 py-3 border-b border-border space-y-2">
        <p className="text-[10px] font-semibold text-muted-foreground tracking-wider mb-2.5">ACCIONES</p>
        {onNewOrder ? (
          <button
            onClick={() => onNewOrder(profile.phone ?? "", profile.name ?? "")}
            className="flex items-center justify-center gap-2 w-full rounded-lg bg-primary/10 hover:bg-primary/20 border border-primary/20 px-4 py-2.5 text-xs font-medium text-primary transition-colors"
          >
            <ShoppingBag className="h-3.5 w-3.5" />
            + Nuevo Pedido
          </button>
        ) : (
          <a
            href="/admin/orders"
            className="flex items-center justify-center gap-2 w-full rounded-lg bg-muted/40 hover:bg-muted border border-border px-4 py-2.5 text-xs font-medium text-foreground transition-colors"
          >
            <ShoppingBag className="h-3.5 w-3.5" />
            Ir a pedidos
          </a>
        )}
        <a
          href={`/admin/clients?search=${encodeURIComponent(profile.phone ?? "")}`}
          className="flex items-center justify-center gap-2 w-full rounded-lg bg-muted/40 hover:bg-muted border border-border px-4 py-2.5 text-xs font-medium text-foreground transition-colors"
        >
          <Shield className="h-3.5 w-3.5" />
          Ver ficha completa
        </a>
      </div>

      {/* ── Historial de Pedidos ────────────────────────────────────────── */}
      <div className="px-4 py-3 border-b border-border">
        <button
          onClick={() => setOrdersOpen(!ordersOpen)}
          className="flex w-full items-center justify-between text-[10px] font-semibold text-muted-foreground tracking-wider mb-2.5"
        >
          <span>HISTORIAL DE PEDIDOS</span>
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${ordersOpen ? "rotate-180" : ""}`} />
        </button>
        <OrderHistory leadId={profile.id} expanded={ordersOpen} />
      </div>

      {/* ── Notes + Attribution (compactas) ────────────────────────────── */}
      {profile.notes && (
        <div className="px-4 py-3 border-b border-border">
          <p className="text-[10px] font-semibold text-muted-foreground tracking-wider mb-1.5">NOTAS</p>
          <p className="text-xs text-muted-foreground leading-relaxed">{profile.notes}</p>
        </div>
      )}

      {profile.platform && (
        <div className="px-4 py-3 border-b border-border">
          <p className="text-[10px] font-semibold text-muted-foreground tracking-wider mb-1.5">ATRIBUCIÓN</p>
          <InfoRow label="Origen" value={profile.platform} />
          <InfoRow label="Campaña" value={profile.utmCampaign} />
          <InfoRow label="UTM" value={profile.utmSource ? `${profile.utmSource} / ${profile.utmMedium}` : null} />
        </div>
      )}
    </div>
  );
}
