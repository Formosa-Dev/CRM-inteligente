"use client";

import { motion } from "framer-motion";
import {
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BanknoteIcon,
  HistoryIcon,
  WalletIcon,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cardEntrance, fadeUpSmall, staggerContainer } from "@/lib/animation-variants";
import { formatCurrency } from "@/lib/client-utils";
import { addCashMovementAction } from "./actions";
import type { ClosedSessionLine, OpenSessionView } from "./queries";

interface CajaViewProps {
  open: OpenSessionView | null;
  history: ClosedSessionLine[];
}

function formatDateTime(date: Date): string {
  return new Date(date).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatTime(date: Date): string {
  return new Date(date).toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// ─── Stat cards ───────────────────────────────────────────────────────────────

function StatCard({
  title,
  value,
  description,
  icon: Icon,
}: {
  title: string;
  value: string;
  description: string;
  icon: typeof WalletIcon;
}) {
  return (
    <motion.div
      variants={cardEntrance}
      className="glass-card card-gold-glow rounded-xl p-5 flex flex-col gap-3 cursor-default"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">{title}</span>
        <div className="size-8 rounded-lg flex items-center justify-center bg-gradient-to-br from-primary/[0.18] to-gold-ember/[0.12] border border-primary/25">
          <Icon className="size-4 text-primary" />
        </div>
      </div>
      <div>
        <p className="text-4xl font-black tabular-nums text-gold-gradient">
          {value}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
    </motion.div>
  );
}

// ─── Movimientos ──────────────────────────────────────────────────────────────

function MovementForm() {
  return (
    <form
      action={async (formData) => {
        await addCashMovementAction(formData);
      }}
      className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3"
    >
      <select
        name="direction"
        defaultValue="out"
        className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
      >
        <option value="out">Salida</option>
        <option value="in">Entrada</option>
      </select>
      <input
        name="amount"
        type="number"
        min="1"
        step="0.01"
        required
        placeholder="Monto"
        className="h-9 w-28 rounded-lg border border-border bg-background px-3 text-sm text-foreground tabular-nums"
      />
      <input
        name="reason"
        type="text"
        required
        placeholder="Motivo — ej: insumos, pago delivery, retiro"
        className="h-9 min-w-52 flex-1 rounded-lg border border-border bg-background px-3 text-sm text-foreground"
      />
      <button
        type="submit"
        className="h-9 rounded-lg border border-primary/30 bg-primary/10 px-4 text-sm font-medium text-primary transition-colors hover:bg-primary/20"
      >
        Cargar
      </button>
    </form>
  );
}

function MovementsTable({ movements }: { movements: OpenSessionView["movements"] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="border-border/40 hover:bg-transparent border-b border-border">
          <TableHead className="px-6 text-muted-foreground font-medium">Hora</TableHead>
          <TableHead className="px-4 text-muted-foreground font-medium">Movimiento</TableHead>
          <TableHead className="px-4 text-muted-foreground font-medium">Motivo</TableHead>
          <TableHead className="px-4 text-muted-foreground font-medium">Cargado por</TableHead>
          <TableHead className="px-6 text-muted-foreground font-medium text-right">Monto</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {movements.length === 0 ? (
          <TableRow className="border-0 hover:bg-transparent">
            <TableCell
              colSpan={5}
              className="px-6 py-8 text-center text-sm text-muted-foreground"
            >
              Todavía no hay movimientos cargados en esta sesión
            </TableCell>
          </TableRow>
        ) : (
          movements.map((m) => (
            <TableRow
              key={m.id}
              className="border-border/40 transition-colors hover:bg-primary/[0.04]"
            >
              <TableCell className="px-6 tabular-nums text-muted-foreground">
                {formatTime(m.createdAt)}
              </TableCell>
              <TableCell className="px-4">
                {m.direction === "in" ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-green-500/20 bg-green-500/10 px-2.5 py-0.5 text-xs font-medium text-green-400">
                    <ArrowDownIcon className="size-3" />
                    Entrada
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive">
                    <ArrowUpIcon className="size-3" />
                    Salida
                  </span>
                )}
              </TableCell>
              <TableCell className="px-4 text-foreground">{m.reason}</TableCell>
              <TableCell className="px-4 text-muted-foreground">
                {m.createdBy ?? "—"}
              </TableCell>
              <TableCell
                className={`px-6 text-right font-medium tabular-nums ${
                  m.direction === "in" ? "text-green-400" : "text-destructive"
                }`}
              >
                {m.direction === "in" ? "+" : "−"}
                {formatCurrency(m.amount)}
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

// ─── Historial ────────────────────────────────────────────────────────────────

function DifferenceCell({ difference }: { difference: number | null }) {
  if (difference === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (Math.abs(difference) < 0.005) {
    return (
      <span className="font-medium tabular-nums text-green-400">
        {formatCurrency(0)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-destructive">
      <AlertTriangleIcon className="size-3" />
      {difference > 0 ? "+" : "−"}
      {formatCurrency(Math.abs(difference))}
    </span>
  );
}

function HistoryTable({ history }: { history: ClosedSessionLine[] }) {
  return (
    <motion.div
      className="glass-card card-gold-glow rounded-xl overflow-hidden"
      variants={fadeUpSmall}
      initial="hidden"
      animate="visible"
    >
      <div className="px-6 py-4 border-b border-border flex items-center gap-2">
        <HistoryIcon className="size-4 text-primary" />
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Historial de cierres
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Últimas {history.length} sesiones cerradas · asiento de auditoría
          </p>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow className="border-border/40 hover:bg-transparent border-b border-border">
            <TableHead className="px-6 text-muted-foreground font-medium">Sesión</TableHead>
            <TableHead className="px-4 text-muted-foreground font-medium">Cierre</TableHead>
            <TableHead className="px-4 text-muted-foreground font-medium text-right">Esperado</TableHead>
            <TableHead className="px-4 text-muted-foreground font-medium text-right">Contado</TableHead>
            <TableHead className="px-4 text-muted-foreground font-medium text-right">Diferencia</TableHead>
            <TableHead className="px-6 text-muted-foreground font-medium">Cerrado por</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {history.length === 0 ? (
            <TableRow className="border-0 hover:bg-transparent">
              <TableCell
                colSpan={6}
                className="px-6 py-8 text-center text-sm text-muted-foreground"
              >
                Todavía no hay cierres registrados
              </TableCell>
            </TableRow>
          ) : (
            history.map((row) => (
              <TableRow
                key={row.id}
                className="border-border/40 transition-colors hover:bg-primary/[0.04]"
              >
                <TableCell className="px-6 font-medium text-foreground">
                  #{row.id}
                </TableCell>
                <TableCell className="px-4 tabular-nums text-foreground">
                  {row.closedAt ? formatDateTime(row.closedAt) : "—"}
                </TableCell>
                <TableCell className="px-4 text-right tabular-nums text-foreground">
                  {row.expectedCash === null ? "—" : formatCurrency(row.expectedCash)}
                </TableCell>
                <TableCell className="px-4 text-right tabular-nums text-foreground">
                  {row.actualCash === null ? "—" : formatCurrency(row.actualCash)}
                </TableCell>
                <TableCell className="px-4 text-right">
                  <DifferenceCell difference={row.difference} />
                </TableCell>
                <TableCell className="px-6 text-muted-foreground">
                  {row.closedBy ?? "—"}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </motion.div>
  );
}

// ─── Vista principal ──────────────────────────────────────────────────────────

export function CajaView({ open, history }: CajaViewProps) {
  return (
    <>
      {open ? (
        <>
          <motion.div
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
            variants={staggerContainer}
            initial="hidden"
            animate="visible"
          >
            <StatCard
              title="Esperado en caja"
              value={formatCurrency(open.expectedCash)}
              description={`inicial ${formatCurrency(open.openingCash)} + efectivo ${formatCurrency(open.cashSalesTotal)} + entradas ${formatCurrency(open.movementsIn)} − salidas ${formatCurrency(open.movementsOut)}`}
              icon={WalletIcon}
            />
            <StatCard
              title="Efectivo cobrado"
              value={formatCurrency(open.cashSalesTotal)}
              description={`${open.cashSalesCount} pedidos pagos en efectivo`}
              icon={BanknoteIcon}
            />
            <StatCard
              title="Entradas"
              value={formatCurrency(open.movementsIn)}
              description="Movimientos manuales a favor"
              icon={ArrowDownIcon}
            />
            <StatCard
              title="Salidas"
              value={formatCurrency(open.movementsOut)}
              description="Retiros y gastos de caja"
              icon={ArrowUpIcon}
            />
          </motion.div>

          <motion.div
            className="glass-card card-gold-glow rounded-xl overflow-hidden"
            variants={fadeUpSmall}
            initial="hidden"
            animate="visible"
          >
            <div className="px-6 py-4 border-b border-border flex items-center gap-2">
              <WalletIcon className="size-4 text-primary" />
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  Sesión #{open.sessionId} abierta
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Abierta el {formatDateTime(open.openedAt)} · ventas del
                  período: digital {formatCurrency(open.digitalTotal)} (
                  {open.digitalCount}) · sin método (en caja){" "}
                  {formatCurrency(open.unknownTotal)} ({open.unknownCount}) ·
                  pendientes de cobro {formatCurrency(open.pendingTotal)} (
                  {open.pendingCount}) · 🛵 envíos del delivery{" "}
                  {formatCurrency(open.deliveryFees)} ({open.deliveryCount})
                </p>
              </div>
            </div>

            <MovementForm />
            <MovementsTable movements={open.movements} />
          </motion.div>
        </>
      ) : (
        <motion.div
          className="glass-card card-gold-glow rounded-xl p-8 flex flex-col items-center gap-3 text-center"
          variants={fadeUpSmall}
          initial="hidden"
          animate="visible"
        >
          <div className="size-10 rounded-lg flex items-center justify-center bg-gradient-to-br from-primary/[0.18] to-gold-ember/[0.12] border border-primary/25">
            <WalletIcon className="size-5 text-primary" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">
              No hay caja abierta
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              La caja se abre automáticamente cuando arranca la jornada desde el
              bot de Telegram.
            </p>
          </div>
        </motion.div>
      )}

      <HistoryTable history={history} />
    </>
  );
}
