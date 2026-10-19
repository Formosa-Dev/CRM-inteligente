import { NextResponse } from "next/server";
import { db } from "@/db";
import { reconcileRuns } from "@/db/schema";
import { and, gt, isNull } from "drizzle-orm";
import { runReconcile, type ReconcileMode } from "@/lib/reconcile/runner";
import { authorizeCronRequest } from "@/lib/auth/cron-auth";

/**
 * Reconciler: detecta ventas cerradas en chats de WhatsApp que no quedaron
 * cargadas como pedidos y las carga sola. Reporta por Telegram.
 *
 *   POST /api/cron/reconcile             → scan (≥4 msgs nuevos, 36h)
 *   POST /api/cron/reconcile?mode=sweep  → barrido (≥1 msg, 72h)
 *   &limit=N   → máx conversaciones por corrida (default 8)
 *
 * Auth: `Authorization: Bearer <cronSecret>` (F12 — el secret nunca viaja en
 * la URL; `?key=` solo se acepta con CRON_ALLOW_QUERY_KEY=1). GET se mantiene
 * para schedulers sin body; ambos métodos exigen el header.
 * Sugerido: cron-job.org cada 30 min para scan; sweep 1-2 veces al día.
 * Solo el deep pass usa LLM — el scan es SQL barato y sale temprano si no hay trabajo.
 */
async function handle(request: Request) {
  const denied = await authorizeCronRequest(request);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
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

// POST is the preferred trigger (state changes); GET stays for schedulers
// that cannot send a body — both require the Bearer header.
export const GET = handle;
export const POST = handle;
