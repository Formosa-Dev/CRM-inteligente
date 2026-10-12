import { getClosedSessions, getOpenSessionView } from "./queries";
import { CajaView } from "./caja-view";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Caja — Admin",
};

export default async function CajaPage() {
  const [open, history] = await Promise.all([
    getOpenSessionView(),
    getClosedSessions(20),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-gold-gradient">
          Caja
        </h1>
        <p className="text-sm text-muted-foreground">
          Sesión abierta e historial de cierres · el cierre se hace desde el bot
          de Telegram
        </p>
      </div>

      <CajaView open={open} history={history} />
    </div>
  );
}
