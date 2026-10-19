import { fetchChannelAccounts } from "./actions";
import { ChannelsView } from "./channels-view";
import { publicBaseUrl, webhookEndpoints } from "./webhook-endpoints";

export const metadata = {
  title: "Canales — Admin",
};

export const dynamic = "force-dynamic";

export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const { connected, error } = await searchParams;
  const accounts = await fetchChannelAccounts();
  const baseUrl = publicBaseUrl();

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

      <ChannelsView
        initialAccounts={accounts}
        webhooks={baseUrl ? webhookEndpoints(baseUrl) : []}
        baseUrlMissing={!baseUrl}
        flashConnected={connected}
        flashError={error}
      />
    </div>
  );
}
