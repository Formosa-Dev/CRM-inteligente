"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useCallback } from "react";
import { motion } from "framer-motion";
import { fadeUpSmall } from "@/lib/animation-variants";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectOption } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ShoppingBag, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { CreateOrderModal } from "@/components/orders/create-order-modal";
import { deleteLead } from "@/app/(admin)/admin/clients/actions";

// ─── Types ────────────────────────────────────────────────────────────────────

type LeadStatus = "new" | "contacted" | "converted" | "lost";

interface Lead {
  id: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  firstMessage: string | null;
  refCode: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  adId: string | null;
  campaignId: string | null;
  adsetId: string | null;
  platform: string | null;
  notes: string | null;
  status: LeadStatus;
  conversationId: number | null;
  createdAt: Date;
}

interface LeadsTableProps {
  leads: Lead[];
  currentPage: number;
  totalPages: number;
  currentStatus: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "Nuevo",
  contacted: "Contactado",
  converted: "Convertido",
  lost: "Perdido",
};

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning";

const STATUS_VARIANTS: Record<LeadStatus, BadgeVariant> = {
  new: "default",
  contacted: "warning",
  converted: "success",
  lost: "destructive",
};

const dateFormatter = new Intl.DateTimeFormat("es-AR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(date: Date): string {
  return dateFormatter.format(new Date(date));
}

// ─── Detail field ─────────────────────────────────────────────────────────────

function DetailField({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  if (!value && value !== 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {label}
      </span>
      <span className="text-sm text-foreground break-words">{value}</span>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function LeadsTable({
  leads,
  currentPage,
  totalPages,
  currentStatus,
}: LeadsTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [orderModalOpen, setOrderModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const buildUrl = useCallback(
    (overrides: Record<string, string | undefined>) => {
      const params = new URLSearchParams(searchParams.toString());
      Object.entries(overrides).forEach(([key, value]) => {
        if (value === undefined || value === "") {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      });
      return `?${params.toString()}`;
    },
    [searchParams]
  );

  function handleStatusChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    router.push(buildUrl({ status: value || undefined, page: undefined }));
  }

  function handlePrev() {
    if (currentPage <= 1) return;
    router.push(buildUrl({ page: String(currentPage - 1) }));
  }

  function handleNext() {
    if (currentPage >= totalPages) return;
    router.push(buildUrl({ page: String(currentPage + 1) }));
  }

  function openDetail(lead: Lead) {
    setSelectedLead(lead);
    setSheetOpen(true);
  }

  return (
    <>
      {/* Filtro de estado */}
      <motion.div
        variants={fadeUpSmall}
        initial="hidden"
        animate="visible"
        className="flex items-center gap-3"
      >
        <label
          htmlFor="status-filter"
          className="text-sm font-medium text-foreground whitespace-nowrap"
        >
          Filtrar por estado
        </label>
        <div className="w-48">
          <Select
            id="status-filter"
            value={currentStatus}
            onChange={handleStatusChange}
          >
            <SelectOption value="">Todos</SelectOption>
            <SelectOption value="new">Nuevo</SelectOption>
            <SelectOption value="contacted">Contactado</SelectOption>
            <SelectOption value="converted">Convertido</SelectOption>
            <SelectOption value="lost">Perdido</SelectOption>
          </Select>
        </div>
      </motion.div>

      {/* Tabla */}
      <motion.div
        variants={fadeUpSmall}
        initial="hidden"
        animate="visible"
        className="rounded-lg border border-border bg-card"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>Teléfono</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Fuente UTM</TableHead>
              <TableHead>Campaña</TableHead>
              <TableHead>Creado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-10 text-center text-muted-foreground"
                >
                  No hay leads para mostrar
                </TableCell>
              </TableRow>
            ) : (
              leads.map((lead) => (
                <TableRow
                  key={lead.id}
                  className="cursor-pointer hover:bg-muted/20 transition-colors"
                  onClick={() => openDetail(lead)}
                >
                  <TableCell className="font-medium">
                    {lead.name ?? <span className="text-muted-foreground italic">Sin nombre</span>}
                  </TableCell>
                  <TableCell>{lead.phone}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANTS[lead.status]}>
                      {STATUS_LABELS[lead.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {lead.utmSource ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {lead.utmCampaign ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(lead.createdAt)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </motion.div>

      {/* Paginación */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Página{" "}
          <span className="font-medium text-foreground">{currentPage}</span> de{" "}
          <span className="font-medium text-foreground">{totalPages}</span>
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handlePrev}
            disabled={currentPage <= 1}
            className="transition-opacity hover:opacity-80"
          >
            Anterior
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleNext}
            disabled={currentPage >= totalPages}
            className="transition-opacity hover:opacity-80"
          >
            Siguiente
          </Button>
        </div>
      </div>

      {/* Sheet de detalle */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto p-0">
          {selectedLead && (
            <>
              <SheetHeader className="p-6 pb-4 border-b border-border bg-card/50">
                <SheetTitle className="text-gold-gradient text-xl">
                  {selectedLead.name ?? "Lead sin nombre"}
                </SheetTitle>
                <div className="mt-2 flex items-center gap-2">
                  <Badge variant={STATUS_VARIANTS[selectedLead.status]}>
                    {STATUS_LABELS[selectedLead.status]}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    ID #{selectedLead.id}
                  </span>
                </div>
              </SheetHeader>

              <div className="p-6 flex flex-col gap-6">
                {/* Identificación */}
                <section className="flex flex-col gap-3">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground border-b border-border pb-1.5">
                    Contacto
                  </h3>
                  <DetailField label="Nombre" value={selectedLead.name} />
                  <DetailField label="Teléfono" value={selectedLead.phone} />
                  <DetailField label="Email" value={selectedLead.email} />
                  <DetailField
                    label="Primer mensaje"
                    value={selectedLead.firstMessage}
                  />
                  <DetailField label="Notas" value={selectedLead.notes} />
                  <DetailField
                    label="Creado"
                    value={formatDate(selectedLead.createdAt)}
                  />
                </section>

                {/* Atribución */}
                <section className="flex flex-col gap-3">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground border-b border-border pb-1.5">
                    Atribución
                  </h3>
                  <DetailField
                    label="Código de referido"
                    value={selectedLead.refCode}
                  />
                  <DetailField label="Plataforma" value={selectedLead.platform} />
                  <DetailField
                    label="UTM Source"
                    value={selectedLead.utmSource}
                  />
                  <DetailField
                    label="UTM Medium"
                    value={selectedLead.utmMedium}
                  />
                  <DetailField
                    label="UTM Campaign"
                    value={selectedLead.utmCampaign}
                  />
                  <DetailField
                    label="UTM Content"
                    value={selectedLead.utmContent}
                  />
                </section>

                {/* IDs de campaña */}
                <section className="flex flex-col gap-3">
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground border-b border-border pb-1.5">
                    IDs de campaña
                  </h3>
                  <DetailField label="Ad ID" value={selectedLead.adId} />
                  <DetailField
                    label="Campaign ID"
                    value={selectedLead.campaignId}
                  />
                  <DetailField label="Adset ID" value={selectedLead.adsetId} />
                  <DetailField
                    label="Conversación ID"
                    value={selectedLead.conversationId}
                  />
                </section>

                {/* Botón convertir a cliente */}
                {selectedLead?.status !== "converted" && (
                  <div className="pt-2">
                    <button
                      onClick={() => { setSheetOpen(false); setOrderModalOpen(true); }}
                      className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground px-4 py-2.5 text-xs font-semibold hover:bg-gold-bright transition-colors"
                    >
                      <ShoppingBag className="h-3.5 w-3.5" />
                      Convertir a Cliente — Crear Pedido
                    </button>
                  </div>
                )}

                {/* Botón eliminar lead */}
                <div className="pt-2 border-t border-border">
                  {confirmDelete ? (
                    <div className="flex gap-2">
                      <button
                        onClick={async () => {
                          setDeleting(true);
                          const result = selectedLead?.phone
                            ? await deleteLead(selectedLead.phone)
                            : { success: false, error: "Este lead no tiene teléfono" };
                          setDeleting(false);
                          if (!result.success) {
                            toast.error(result.error ?? "No se pudo eliminar el lead");
                            return;
                          }
                          toast.success("Lead eliminado");
                          setSheetOpen(false);
                          setConfirmDelete(false);
                          router.refresh();
                        }}
                        disabled={deleting}
                        className="flex-1 rounded-lg bg-red-500/20 text-red-400 px-4 py-2.5 text-xs font-semibold hover:bg-red-500/30 transition-colors"
                      >
                        {deleting ? "Eliminando..." : "Confirmar eliminación"}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(false)}
                        className="rounded-lg bg-muted/40 text-foreground/60 px-4 py-2.5 text-xs hover:bg-muted transition-colors"
                      >
                        Cancelar
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="w-full rounded-lg bg-muted/20 text-red-400/60 px-4 py-2.5 text-xs font-medium hover:bg-red-500/10 hover:text-red-400 transition-colors border border-red-500/10"
                    >
                      <Trash2 size={12} aria-hidden="true" className="inline mr-1.5 -mt-0.5" />Eliminar lead
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Modal de pedido */}
      {selectedLead && (
        <CreateOrderModal
          open={orderModalOpen}
          onClose={() => setOrderModalOpen(false)}
          clientName={selectedLead.name ?? undefined}
          clientPhone={selectedLead.phone ?? undefined}
        />
      )}
    </>
  );
}
