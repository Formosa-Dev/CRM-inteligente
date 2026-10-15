// ─── Internal Reconcile Scheduler ────────────────────────────────────────────
// Corre DENTRO del proceso Next (arranca desde instrumentation.ts register()).
// Se activa solo con INTERNAL_CRON=1 — pensado para instancias Render siempre
// encendidas (plan pago). En el free tier la instancia duerme: el scheduler
// solo corre mientras está despierta, lo cual ya cubre buena parte del horario
// de venta (tráfico web + webhooks la mantienen viva). Alternativa sin pagar:
// un ping externo (cron-job.org / GitHub Actions) al endpoint — ambos pueden
// coexistir: el lock de reconcile_runs evita corridas dobles.

import { runReconcile } from "./runner";
import { getArgentinaHour } from "@/lib/argentina-time";
import { rolloverCashDay } from "@/lib/cash/session";
import { notifyAdmins } from "@/lib/telegram/notifier";

const TICK_MS = 60 * 1000;                 // chequeo cada minuto
const SCAN_INTERVAL_MS = 30 * 60 * 1000;   // scan cada 30 min
const SWEEP_HOURS = new Set([3, 14]);      // barrido: cierre de noche + mediodía
const CASH_ROLLOVER_HOUR = 2;              // cierre de turno: 02:00 ART

let started = false;
let lastScanAt = 0;
let lastSweepKey = "";
let lastCashKey = "";

export function startReconcileScheduler(): void {
  if (started) return;
  started = true;
  console.log("[reconcile] internal scheduler started (scan 30min, sweep @3h/14h ART)");

  setInterval(() => {
    void tick().catch((err) => console.error("[reconcile] tick error:", err));
  }, TICK_MS).unref();
}

async function tick(): Promise<void> {
  const now = Date.now();
  const hour = getArgentinaHour();

  if (now - lastScanAt >= SCAN_INTERVAL_MS) {
    lastScanAt = now;
    await runReconcile({ mode: "scan" });
  }

  const sweepKey = `${new Date().toISOString().slice(0, 10)}-${hour}`;
  if (SWEEP_HOURS.has(hour) && lastSweepKey !== sweepKey) {
    lastSweepKey = sweepKey;
    await runReconcile({ mode: "sweep" });
  }

  // Cierre obligatorio de caja a las 02:00 ART. Si la instancia está dormida
  // igual se resuelve: ensureOpenSession hace el rollover perezoso en la
  // primera actividad posterior — esto solo lo hace en hora y notifica.
  const cashKey = new Date().toISOString().slice(0, 10);
  if (hour === CASH_ROLLOVER_HOUR && lastCashKey !== cashKey) {
    lastCashKey = cashKey;
    const res = await rolloverCashDay();
    if (res.rolledOver) {
      await notifyAdmins(
        `💰 Caja #${res.closedId} cerrada automáticamente (fin de turno 02:00). ` +
        `Se abrió la sesión nueva. Verificá el efectivo contra el esperado cuando puedas.`,
      );
    }
  }
}
