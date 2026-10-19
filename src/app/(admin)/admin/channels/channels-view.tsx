"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PlugIcon, PowerIcon, PowerOffIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectOption } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createChannelAccount,
  setChannelAccountStatus,
  type ChannelAccountRow,
} from "./actions";

const PROVIDERS = [
  { value: "ycloud", label: "YCloud" },
  { value: "zernio", label: "Zernio" },
  { value: "kapso", label: "Kapso" },
];

const CHANNELS = [
  { value: "whatsapp", label: "WhatsApp" },
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook" },
  { value: "telegram", label: "Telegram" },
  { value: "sms", label: "SMS" },
  { value: "reddit", label: "Reddit" },
];

const PROVIDER_HINTS: Record<string, string> = {
  ycloud: "Número E.164 del remitente (ej. 5493704…)",
  zernio: "accountId de Zernio (24 hex) — visible en el dashboard",
  kapso: "phone_number_id de Meta asignado por Kapso",
};

export function ChannelsView({
  initialAccounts,
}: {
  initialAccounts: ChannelAccountRow[];
}) {
  const router = useRouter();
  const [accounts, setAccounts] = useState(initialAccounts);
  const [pending, startTransition] = useTransition();

  const [provider, setProvider] = useState("zernio");
  const [channel, setChannel] = useState("instagram");
  const [providerAccountId, setProviderAccountId] = useState("");
  const [senderAddress, setSenderAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [credentialsRef, setCredentialsRef] = useState("");

  function submit() {
    startTransition(async () => {
      const res = await createChannelAccount({
        provider,
        channel,
        providerAccountId,
        senderAddress,
        displayName: displayName || undefined,
        credentialsRef: credentialsRef || undefined,
      });
      if (!res.ok) {
        toast.error(res.error ?? "No se pudo crear la cuenta");
        return;
      }
      toast.success("Cuenta conectada");
      setProviderAccountId("");
      setSenderAddress("");
      setDisplayName("");
      setCredentialsRef("");
      router.refresh();
    });
  }

  function toggleStatus(row: ChannelAccountRow) {
    const next = row.status === "active" ? "disconnected" : "active";
    startTransition(async () => {
      const res = await setChannelAccountStatus(row.id, next);
      if (!res.ok) {
        toast.error(res.error ?? "No se pudo actualizar");
        return;
      }
      setAccounts((rows) =>
        rows.map((r) => (r.id === row.id ? { ...r, status: next } : r))
      );
      toast.success(next === "active" ? "Cuenta activada" : "Cuenta desconectada");
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Create form */}
      <div className="glass-card rounded-xl p-5">
        <div className="mb-4 flex items-center gap-2">
          <PlugIcon className="size-4 text-primary" />
          <h2 className="text-sm font-semibold">Conectar cuenta</h2>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="provider">Proveedor</Label>
            <Select
              id="provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              {PROVIDERS.map((p) => (
                <SelectOption key={p.value} value={p.value}>
                  {p.label}
                </SelectOption>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="channel">Canal</Label>
            <Select
              id="channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            >
              {CHANNELS.map((c) => (
                <SelectOption key={c.value} value={c.value}>
                  {c.label}
                </SelectOption>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="providerAccountId">ID de cuenta del proveedor</Label>
            <Input
              id="providerAccountId"
              value={providerAccountId}
              onChange={(e) => setProviderAccountId(e.target.value)}
              placeholder={PROVIDER_HINTS[provider]}
            />
            <p className="text-[11px] text-muted-foreground">
              {PROVIDER_HINTS[provider]}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="senderAddress">Dirección del remitente</Label>
            <Input
              id="senderAddress"
              value={senderAddress}
              onChange={(e) => setSenderAddress(e.target.value)}
              placeholder="+5493704… o @usuario"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="displayName">Nombre visible (opcional)</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="WhatsApp principal"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="credentialsRef">Referencia de credenciales</Label>
            <Input
              id="credentialsRef"
              value={credentialsRef}
              onChange={(e) => setCredentialsRef(e.target.value)}
              placeholder="env:ZERNIO_"
            />
            <p className="text-[11px] text-muted-foreground">
              {"env:PREFIX resuelve PREFIX+API_KEY (con _ final: env:ZERNIO_ → ZERNIO_API_KEY). Vacío = sin credenciales (fail-closed)."}
            </p>
          </div>
        </div>

        <Button
          className="btn-gold mt-4 gap-2"
          disabled={pending || !providerAccountId.trim() || !senderAddress.trim()}
          onClick={submit}
        >
          <PlugIcon className="size-4" />
          Conectar
        </Button>
      </div>

      {/* Accounts table */}
      <div className="glass-card rounded-xl p-5">
        <h2 className="mb-4 text-sm font-semibold">
          Cuentas conectadas ({accounts.length})
        </h2>
        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No hay cuentas conectadas. Conectá la primera arriba.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Proveedor</TableHead>
                <TableHead>Canal</TableHead>
                <TableHead>Cuenta</TableHead>
                <TableHead>Remitente</TableHead>
                <TableHead>Credenciales</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Acción</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium capitalize">
                    {row.provider}
                  </TableCell>
                  <TableCell className="capitalize">{row.channel}</TableCell>
                  <TableCell>
                    <div className="font-mono text-xs">{row.providerAccountId}</div>
                    {row.displayName && (
                      <div className="text-xs text-muted-foreground">
                        {row.displayName}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {row.senderAddress}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.credentialsRef ?? "—"}
                  </TableCell>
                  <TableCell>
                    <span
                      className={
                        row.status === "active"
                          ? "text-xs font-medium text-emerald-400"
                          : "text-xs font-medium text-muted-foreground"
                      }
                    >
                      {row.status === "active" ? "Activa" : "Desconectada"}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => toggleStatus(row)}
                    >
                      {row.status === "active" ? (
                        <>
                          <PowerOffIcon className="size-3.5" /> Desconectar
                        </>
                      ) : (
                        <>
                          <PowerIcon className="size-3.5" /> Activar
                        </>
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
