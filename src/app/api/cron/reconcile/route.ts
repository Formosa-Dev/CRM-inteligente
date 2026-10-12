import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { db } from "@/db";
import { reconcileRuns } from "@/db/schema";
import { and, gt, isNull } from "drizzle-orm";
import { runReconcile, type ReconcileMode } from "@/lib/reconcile/runner";

/**
 * Reconciler: detecta ventas cerradas en chats de WhatsApp que no quedaron
 * cargadas como pedidos y las carga sola. Reporta por Telegram.
 *
 *   GET /api/cron/reconcile?key=CRON_SECRET              → scan (≥4 msgs nuevos, 36h)
 *   GET /api/cron/reconcile?key=CRON_SECRET&mode=sweep   → barrido (≥1 msg, 72h)
 *   &limit=N   → máx conversaciones por corrida (default 8)
 *
 * Sugerido: cron-job.org cada 30 min para scan; sweep 1-2 veces al día.
 * Solo el deep pass usa LLM — el scan es SQL barato y sale temprano si no hay trabajo.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key");

  const { getIntegrationSecrets } = await import("@/lib/integrations");
  const secret = (await getIntegrationSecrets()).cronSecret;
  const a = Buffer.from(key ?? "");
  const b = Buffer.from(secret ?? "");
  if (!secret || a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const mode: ReconcileMode = searchParams.get("mode") === "sweep" ? "sweep" : "scan";
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 8, 1), 20);

  try {
    // Guard anti-solapamiento: si hay una corrida sin terminar iniciada en los
    // últimos 20 min, esta invocación se saltea. Fail-safe: si dos corren a la
    // vez ambas se ven y se retiran — preferimos skip antes que doble carga.
    const staleCutoff = new Date(Date.now() - 20 * 60 * 1000);
    const running = await db
      .select({ id: reconcileRuns.id })
      .from(reconcileRuns)
      .where(and(isNull(reconcileRuns.finishedAt), gt(reconcileRuns.startedAt, staleCutoff)))
      .limit(1);
    if (running.length) {
      return NextResponse.json({ message: "Ya hay una corrida en curso", skipped: true });
    }

    const result = await runReconcile({ mode, maxConversations: limit });

    return NextResponse.json({
      mode,
      scanned: result.scanned,
      ordersCreated: result.ordersCreated,
      candidatesCreated: result.candidatesCreated,
      report: result.reportText,
    });
  } catch (e) {
    console.error("[reconcile] Error:", e);
    return NextResponse.json({ error: "Error interno" }, { status: 500 });
  }
}
