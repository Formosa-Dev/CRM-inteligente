"use client";

import { useActionState, useState, useCallback } from "react";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { fadeUpSmall, staggerContainer } from "@/lib/animation-variants";
import { testMetaConnection, type MetaConnectionStatus, type WebhookConfig } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function StatusDot({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex h-2.5 w-2.5 rounded-full ${
        active ? "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)]" : "bg-red-500/60"
      }`}
    />
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("No se pudo copiar — seleccioná el texto a mano");
    }
  }, [value]);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex gap-2">
        <Input
          readOnly
          value={value}
          className="font-mono text-xs bg-muted/40 border-border select-all"
        />
        <Button
          type="button"
          onClick={copy}
          variant="outline"
          size="sm"
          className="shrink-0 border-border text-xs"
        >
          {copied ? "¡Copiado!" : "Copiar"}
        </Button>
      </div>
    </div>
  );
}

export function MetaConfigClient({
  initialStatus,
  webhookConfig,
}: {
  initialStatus: MetaConnectionStatus;
  webhookConfig: WebhookConfig;
}) {
  const [testState, formAction, isPending] = useActionState(
    testMetaConnection,
    null
  );

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-6"
    >
      {/* Estado de conexión */}
      <motion.div variants={fadeUpSmall}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Estado de conexión
            </CardTitle>
            <CardDescription>
              Componentes de Meta Ads y su estado actual
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Pixel status */}
              <div className="rounded-lg border p-4 flex items-start gap-3 transition-colors hover:bg-muted/20">
                <StatusDot active={initialStatus.pixelConfigured} />
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Meta Pixel</span>
                  <span className="text-xs text-muted-foreground">
                    {initialStatus.pixelConfigured
                      ? `ID: ${initialStatus.pixelId}`
                      : "No configurado — falta NEXT_PUBLIC_META_PIXEL_ID"}
                  </span>
                  <span className="text-[11px] text-muted-foreground/60">
                    Tracking client-side de visitas y conversiones (fbq)
                  </span>
                </div>
              </div>

              {/* Server config status */}
              <div className="rounded-lg border p-4 flex items-start gap-3 transition-colors hover:bg-muted/20">
                <StatusDot active={initialStatus.serverConfigured} />
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">
                    Conversion API (server-side)
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {initialStatus.serverConfigured
                      ? `App ID: ${initialStatus.appId}`
                      : "No configurado — falta META_APP_ID / META_APP_SECRET"}
                  </span>
                  <span className="text-[11px] text-muted-foreground/60">
                    Reporta conversiones desde el servidor a Meta
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Probar conexión */}
      <motion.div variants={fadeUpSmall}>
        <Card>
          <CardHeader>
            <CardTitle>Probar conexión</CardTitle>
            <CardDescription>
              Verificá que las credenciales de Meta funcionen correctamente
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <form action={formAction}>
              <Button
                type="submit"
                disabled={isPending}
                variant="outline"
                className="border-primary/40 text-primary hover:bg-primary/10 hover:text-gold-bright"
              >
                {isPending
                  ? "Probando conexión..."
                  : "Probar conexión con Meta"}
              </Button>
            </form>

            {testState && (
              <div
                className={`rounded-lg px-4 py-3 text-sm ${
                  testState.success
                    ? "bg-green-500/10 text-green-400 border border-green-500/20"
                    : "bg-red-500/10 text-red-400 border border-red-500/20"
                }`}
              >
                {testState.message}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Webhook WhatsApp */}
      <motion.div variants={fadeUpSmall}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Webhook WhatsApp (YCloud)
            </CardTitle>
            <CardDescription>
              Datos para configurar en el dashboard de YCloud — copialos y pegalos
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <CopyField
              label="URL del Webhook"
              value={webhookConfig.webhookUrl}
            />

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="rounded-lg border p-3 flex items-start gap-2 transition-colors hover:bg-muted/20">
                <StatusDot active={webhookConfig.hasWebhookSecret} />
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium">YCLOUD_WEBHOOK_SECRET</span>
                  <span className="text-[11px] text-muted-foreground">
                    {webhookConfig.hasWebhookSecret ? "Configurado" : "Falta en Render"}
                  </span>
                </div>
              </div>

              <div className="rounded-lg border p-3 flex items-start gap-2 transition-colors hover:bg-muted/20">
                <StatusDot active={webhookConfig.hasApiKey} />
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium">YCLOUD_API_KEY</span>
                  <span className="text-[11px] text-muted-foreground">
                    {webhookConfig.hasApiKey ? "Configurado" : "Falta en Render"}
                  </span>
                </div>
              </div>

              <div className="rounded-lg border p-3 flex items-start gap-2 transition-colors hover:bg-muted/20">
                <StatusDot active={webhookConfig.hasPhoneNumber} />
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium">WHATSAPP_PHONE_NUMBER</span>
                  <span className="text-[11px] text-muted-foreground">
                    {webhookConfig.phoneNumber ?? "Falta en Render"}
                  </span>
                </div>
              </div>
            </div>

            <div className="rounded-lg bg-amber-500/5 border border-amber-500/20 px-4 py-3 text-xs text-amber-300/80">
              <strong>Pasos en YCloud:</strong> Andá a WhatsApp → Webhook, pega la URL de arriba, ingresá el mismo
              secret que pusiste en <code className="text-[10px] bg-muted px-1 rounded">YCLOUD_WEBHOOK_SECRET</code>,
              y guardá. Después activá los eventos de inbound_message.
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Instrucciones */}
      <motion.div variants={fadeUpSmall}>
        <Card>
          <CardHeader>
            <CardTitle>Configuración en Render</CardTitle>
            <CardDescription>
              Estas variables de entorno deben estar configuradas en el dashboard
              de Render
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 text-sm">
              <div className="flex items-center gap-2">
                <code className="rounded bg-muted/60 px-2 py-0.5 text-xs font-mono">
                  NEXT_PUBLIC_META_PIXEL_ID
                </code>
                <span className="text-muted-foreground">
                  ID del Pixel de Meta (lo ves en Events Manager)
                </span>
              </div>
              <div className="flex items-center gap-2">
                <code className="rounded bg-muted/60 px-2 py-0.5 text-xs font-mono">
                  META_APP_ID
                </code>
                <span className="text-muted-foreground">
                  ID de la App de Facebook Developers
                </span>
              </div>
              <div className="flex items-center gap-2">
                <code className="rounded bg-muted/60 px-2 py-0.5 text-xs font-mono">
                  META_APP_SECRET
                </code>
                <span className="text-muted-foreground">
                  Secret de la App de Facebook Developers
                </span>
              </div>
            </div>

            <div className="rounded-lg bg-amber-500/5 border border-amber-500/20 px-4 py-3 text-xs text-amber-300/80">
              <strong>Importante:</strong> Los cambios en variables de entorno
              requieren un nuevo deploy en Render para que tomen efecto.
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  );
}
