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

const TICK_MS = 60 * 1000;                 // chequeo cada minuto
const SCAN_INTERVAL_MS = 30 * 60 * 1000;   // scan cada 30 min
const SWEEP_HOURS = new Set([3, 14]);      // barrido: cierre de noche + mediodía

let started = false;
let lastScanAt = 0;
let lastSweepKey = "";

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
}
