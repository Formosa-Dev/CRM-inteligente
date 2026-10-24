"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CheckIcon,
  CopyIcon,
  LinkIcon,
  PlugIcon,
  PowerIcon,
  PowerOffIcon,
  WebhookIcon,
} from "lucide-react";

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
  registerZernioWebhookAction,
  setChannelAccountStatus,
  startZernioConnect,
  type ChannelAccountRow,
} from "./actions";
import { useIsAdmin } from "@/components/admin/role-context";
import type { ProviderId } from "@/lib/messaging/types";

export interface WebhookEndpoint {
  provider: ProviderId;
  url: string;
  note?: string;
}

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
  { value: "linkedin", label: "LinkedIn" },
  { value: "tiktok", label: "TikTok" },
  { value: "youtube", label: "YouTube" },
  { value: "threads", label: "Threads" },
  { value: "pinterest", label: "Pinterest" },
  { value: "discord", label: "Discord" },
  { value: "slack", label: "Slack" },
];

const PROVIDER_HINTS: Record<string, string> = {
  ycloud: "Número E.164 del remitente (ej. 5493704…)",
  zernio: "accountId de Zernio (24 hex) — visible en el dashboard",
  kapso: "phone_number_id de Meta asignado por Kapso",
};

/** Zernio embedded-connect buttons (OAuth / WhatsApp Embedded Signup). */
const ZERNIO_CONNECT: {
  platform: string;
  label: string;
  onboarding?: "api" | "business_app";
}[] = [
  {
    platform: "whatsapp",
    label: "WhatsApp — coexistencia (tu app actual)",
    onboarding: "business_app",
  },
  {
    platform: "whatsapp",
    label: "WhatsApp — número nuevo / Cloud API",
    onboarding: "api",
  },
  { platform: "instagram", label: "Instagram" },
  { platform: "facebook", label: "Facebook" },
  { platform: "linkedin", label: "LinkedIn" },
  { platform: "tiktok", label: "TikTok" },
  { platform: "youtube", label: "YouTube" },
  { platform: "threads", label: "Threads" },
  { platform: "pinterest", label: "Pinterest" },
  { platform: "discord", label: "Discord" },
  { platform: "slack", label: "Slack" },
];

const FLASH_ERRORS: Record<string, string> = {
  "oauth-state": "Estado OAuth inválido — reintentá la conexión",
  "connect-params": "Zernio no devolvió plataforma/cuenta válidas",
  "persist-failed": "No se pudo guardar la cuenta — revisá el log del servidor",
};

const PROVIDER_LABELS: Record<string, string> = {
  ycloud: "YCloud",
  zernio: "Zernio",
  kapso: "Kapso",
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          timer.current = setTimeout(() => setCopied(false), 2000);
        } catch {
          toast.error("No se pudo copiar — seleccioná la URL a mano");
        }
      }}
    >
      {copied ? (
        <CheckIcon className="size-3.5 text-emerald-400" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
      {copied ? "Copiado" : "Copiar"}
    </Button>
  );
}

export function ChannelsView({
  initialAccounts,
  webhooks,
  baseUrlMissing,
  flashConnected,
  flashError,
}: {
  initialAccounts: ChannelAccountRow[];
  webhooks: WebhookEndpoint[];
  baseUrlMissing: boolean;
  flashConnected?: string;
  flashError?: string;
}) {
  const router = useRouter();
  const isAdmin = useIsAdmin();
  // Local state only holds optimistic status overrides — rows derive from
  // server props, so a router.refresh() after create can't leave the table
  // stale (a useState(initialAccounts) copy did exactly that).
  const [statusOverrides, setStatusOverrides] = useState<
    Record<number, string>
  >({});
  const accounts = initialAccounts.map((row) =>
    statusOverrides[row.id] ? { ...row, status: statusOverrides[row.id] } : row
  );
  const [pending, startTransition] = useTransition();

  const [provider, setProvider] = useState("zernio");
  const [channel, setChannel] = useState("instagram");
  const [providerAccountId, setProviderAccountId] = useState("");
  const [senderAddress, setSenderAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [credentialsRef, setCredentialsRef] = useState("");

  // Flash from the zernio connect callback (?connected=zernio:ig | ?error=…)
  useEffect(() => {
    if (flashConnected) {
      toast.success(`Cuenta conectada (${flashConnected})`);
    } else if (flashError) {
      toast.error(FLASH_ERRORS[flashError] ?? "Error al conectar la cuenta");
    }
    if (flashConnected || flashError) router.replace("/admin/channels");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connectZernio(
    platform: string,
    onboarding?: "api" | "business_app"
  ) {
    startTransition(async () => {
      const res = await startZernioConnect({ platform, onboarding });
      if (!res.ok || !res.authUrl) {
        toast.error(res.error ?? "No se pudo iniciar la conexión");
        return;
      }
      window.location.href = res.authUrl;
    });
  }

  function registerZernioHook() {
    startTransition(async () => {
      const res = await registerZernioWebhookAction();
      if (!res.ok) {
        toast.error(res.error ?? "No se pudo registrar el webhook");
        return;
      }
      toast.success("Webhook registrado en Zernio");
    });
  }

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
      setStatusOverrides((overrides) => ({ ...overrides, [row.id]: next }));
      toast.success(next === "active" ? "Cuenta activada" : "Cuenta desconectada");
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Create form */}
      {isAdmin && (
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
              {"env:PREFIX resuelve PREFIX+API_KEY (con _ final: env:ZERNIO_ → ZERNIO_API_KEY). 'agent_config' o vacío usa las credenciales del scope (cuenta → canal → global) de /admin/agent — hoy solo YCloud; el resto queda fail-closed."}
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
      )}

      {/* Zernio embedded connect */}
      {isAdmin && (
      <div className="glass-card rounded-xl p-5">
        <div className="mb-4 flex items-center gap-2">
          <LinkIcon className="size-4 text-primary" />
          <h2 className="text-sm font-semibold">Conexión rápida con Zernio</h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Requiere <code className="font-mono text-xs">ZERNIO_API_KEY</code> en el
          entorno. Te redirige a Zernio para autorizar la cuenta; al volver se
          crea la fila automáticamente (credenciales vía{" "}
          <code className="font-mono text-xs">env:ZERNIO_</code>). WhatsApp
          ofrece dos modos: <strong>coexistencia</strong> (tu número sigue
          funcionando en la app WhatsApp Business del celu — Meta muestra un
          QR para escanear) o <strong>Cloud API</strong> (número nuevo o ya
          migrado, sin app). Facebook incluye la selección de página dentro
          del flujo.
        </p>
        <div className="flex flex-wrap gap-2">
          {ZERNIO_CONNECT.map((c) => (
            <Button
              key={`${c.platform}:${c.onboarding ?? "default"}`}
              variant="outline"
              disabled={pending}
              onClick={() => connectZernio(c.platform, c.onboarding)}
            >
              <PlugIcon className="size-3.5" />
              {c.label}
            </Button>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-amber-400/80">
          Ojo: el agente responde automáticamente en WhatsApp (cualquier
          proveedor) y Telegram. Los demás canales — Instagram, Facebook,
          Reddit, LinkedIn, TikTok, YouTube, Threads, Pinterest, Discord y
          Slack — guardan los mensajes en la bandeja de entrada, sin
          auto-reply del agente.
        </p>
      </div>
      )}

      {/* Webhook endpoints per provider */}
      <div className="glass-card rounded-xl p-5">
        <div className="mb-4 flex items-center gap-2">
          <WebhookIcon className="size-4 text-primary" />
          <h2 className="text-sm font-semibold">Webhooks entrantes</h2>
        </div>
        {baseUrlMissing ? (
          <p className="text-sm text-muted-foreground">
            Configurá <code className="font-mono text-xs">AUTH_URL</code> o{" "}
            <code className="font-mono text-xs">NEXT_PUBLIC_APP_URL</code> para
            ver las URLs de webhook de este deploy.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {webhooks.map((w) => (
              <div
                key={w.provider}
                className="flex flex-col gap-1 rounded-lg border border-border/60 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {PROVIDER_LABELS[w.provider] ?? w.provider}
                  </div>
                  <div className="truncate font-mono text-xs">{w.url}</div>
                  {w.note && (
                    <div className="text-[11px] text-muted-foreground">
                      {w.note}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <CopyButton text={w.url} />
                  {isAdmin && w.provider === "zernio" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={registerZernioHook}
                    >
                      Registrar en Zernio
                    </Button>
                  )}
                </div>
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">
              En Zernio el secret es <code className="font-mono">ZERNIO_WEBHOOK_SECRET</code>;
              en Kapso, el de su dashboard; en YCloud, el token de verificación
              habitual.
            </p>
          </div>
        )}
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
                    {isAdmin && (
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
                    )}
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
