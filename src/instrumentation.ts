// Next.js instrumentation — register() corre UNA vez al iniciar el server.
// INTERNAL_CRON=1 habilita el scheduler interno del reconciler (para
// instancias Render siempre encendidas). Sin la flag, no hace nada.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.INTERNAL_CRON === "1") {
    const { startReconcileScheduler } = await import("@/lib/reconcile/scheduler");
    startReconcileScheduler();
  }
}
