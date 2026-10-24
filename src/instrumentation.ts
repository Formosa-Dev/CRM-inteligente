// Next.js instrumentation — register() corre UNA vez al iniciar el server.
// INTERNAL_CRON=1 habilita el scheduler interno del reconciler (para
// instancias Render siempre encendidas). Sin la flag, no hace nada.

const INBOUND_DRAIN_INTERVAL_MS = 120_000;

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  if (process.env.INTERNAL_CRON === "1") {
    const { startReconcileScheduler } = await import("@/lib/reconcile/scheduler");
    startReconcileScheduler();
  }

  // S3 — durable inbound queue: startup drain + slow periodic sweep cover
  // orphan recovery when webhooks go quiet (the PRIMARY trigger lives at the
  // top of handleNormalizedEvent). Importing the pipeline registers the
  // WhatsApp sales dispatcher before any drain can dispatch; schema-not-
  // ready installs degrade quietly inside the queue layer.
  const { drainPendingInboundTurns } = await import(
    "@/lib/messaging/inbound-pipeline"
  );
  const sweep = () => {
    drainPendingInboundTurns().catch((error) => {
      console.error("[instrumentation] inbound queue drain failed:", error);
    });
  };
  void sweep();
  const timer = setInterval(sweep, INBOUND_DRAIN_INTERVAL_MS);
  timer.unref();
}
