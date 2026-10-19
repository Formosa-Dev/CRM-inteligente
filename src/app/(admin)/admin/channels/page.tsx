import { fetchChannelAccounts } from "./actions";
import { ChannelsView } from "./channels-view";

export const metadata = {
  title: "Canales — Admin",
};

export const dynamic = "force-dynamic";

export default async function ChannelsPage() {
  const accounts = await fetchChannelAccounts();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-gold-gradient">
          Canales
        </h1>
        <p className="text-sm text-muted-foreground">
          Cuentas de mensajería por proveedor (YCloud, Zernio, Kapso). Cada
          cuenta conecta un canal a un remitente con sus credenciales.
        </p>
      </div>

      <ChannelsView initialAccounts={accounts} />
    </div>
  );
}
