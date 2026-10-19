"use client";

import { useState } from "react";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { fadeUpSmall, staggerContainer } from "@/lib/animation-variants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  CopyIcon,
  CheckCircle2Icon,
  XCircleIcon,
  RefreshCwIcon,
  GlobeIcon,
  BotIcon,
  Settings2Icon,
  UsersIcon,
  WebhookIcon,
  Trash2Icon,
} from "lucide-react";
import type {
  TelegramStatus,
  WebhookInfo,
} from "./actions";

type Props = {
  initialStatus: TelegramStatus;
};

export function TelegramConfigClient({ initialStatus }: Props) {
  const [status] = useState(initialStatus);
  const [webhookInfo, setWebhookInfo] = useState<WebhookInfo | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [confirmDeleteWebhook, setConfirmDeleteWebhook] = useState(false);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copiado`);
  };

  const handleSetWebhook = async () => {
    setLoading("webhook-set");
    try {
      const { setTelegramWebhookAction } = await import("./actions");
      const result = await setTelegramWebhookAction();
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error("Error al configurar webhook");
    } finally {
      setLoading(null);
    }
  };

  const handleDeleteWebhook = async () => {
    setLoading("webhook-delete");
    try {
      const { deleteTelegramWebhookAction } = await import("./actions");
      const result = await deleteTelegramWebhookAction();
      if (result.success) {
        toast.success(result.message);
        setWebhookInfo(null);
        setConfirmDeleteWebhook(false);
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error("Error al eliminar webhook");
    } finally {
      setLoading(null);
    }
  };

  const handleCheckWebhook = async () => {
    setLoading("webhook-check");
    try {
      const { getTelegramWebhookInfoAction } = await import("./actions");
      const result = await getTelegramWebhookInfoAction();
      if ("url" in result) {
        setWebhookInfo(result as WebhookInfo);
        toast.success("Información del webhook obtenida");
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error("Error al verificar webhook");
    } finally {
      setLoading(null);
    }
  };

  const handleTestBot = async () => {
    setLoading("test-bot");
    try {
      const { getTelegramWebhookInfoAction } = await import("./actions");
      const infoResult = await getTelegramWebhookInfoAction();
      if ("url" in infoResult) {
        setWebhookInfo(infoResult);
        if (infoResult.url) {
          toast.success(
            `Bot conectado. Webhook activo, ${infoResult.pendingUpdateCount} updates pendientes.`
          );
        } else {
          toast.error(
            "El bot no tiene webhook configurado. Usá 'Configurar Webhook'."
          );
        }
      } else {
        toast.error(infoResult.message);
      }
    } catch {
      toast.error("Error al probar conexión");
    } finally {
      setLoading(null);
    }
  };

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-6"
    >
      {/* ── Estado del Bot ── */}
      <motion.div variants={fadeUpSmall}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BotIcon className="h-5 w-5 text-primary" />
              Estado del Bot
            </CardTitle>
            <CardDescription>
              Estado actual de la conexión con Telegram
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-4">
              <div className="flex items-center gap-2 rounded-md border px-3 py-2">
                {status.configured ? (
                  <CheckCircle2Icon className="h-5 w-5 text-green-500" />
                ) : (
                  <XCircleIcon className="h-5 w-5 text-red-500" />
                )}
                <span className="text-sm">
                  {status.configured ? "Configurado" : "No configurado"}
                </span>
              </div>

              {status.botUsername && (
                <div className="flex items-center gap-2 rounded-md border px-3 py-2">
                  <BotIcon className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">
                    {status.botUsername}
                  </span>
                </div>
              )}

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTestBot}
                disabled={loading === "test-bot" || !status.configured}
                className="gap-2"
              >
                <RefreshCwIcon
                  className={`h-4 w-4 ${loading === "test-bot" ? "animate-spin" : ""}`}
                />
                Probar conexión
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* ── Configuración ── */}
      <motion.div variants={fadeUpSmall}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings2Icon className="h-5 w-5 text-primary" />
              Configuración
            </CardTitle>
            <CardDescription>
              Variables de entorno para Telegram. Configuralas en Render.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* Bot Token */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">
                TELEGRAM_BOT_TOKEN
              </label>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={status.botToken || "— No configurado —"}
                  className="font-mono text-sm"
                />
                {status.botToken && (
                  <Badge
                    variant="outline"
                    className="shrink-0 text-green-600 border-green-600"
                  >
                    ✓ configurado
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Token del bot de Telegram. Se obtiene de{" "}
                <code className="text-primary">@BotFather</code>.
              </p>
            </div>

            <Separator />

            {/* Access Token (webhook security) */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">
                TELEGRAM_WEBHOOK_TOKEN
              </label>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={status.webhookToken}
                  className="font-mono text-sm"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    copyToClipboard(status.webhookToken, "Webhook token")
                  }
                  aria-label="Copiar webhook token"
                >
                  <CopyIcon className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Token de seguridad incluido en la URL del webhook. No compartir.
              </p>
            </div>

            <Separator />

            {/* Allowed Chat IDs */}
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-sm font-medium">
                <UsersIcon className="h-4 w-4" />
                TELEGRAM_ALLOWED_CHAT_IDS
              </label>
              <Input
                readOnly
                value={
                  status.allowedChatIds.length > 0
                    ? status.allowedChatIds.join(", ")
                    : "— No configurado —"
                }
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                IDs de chats/grupos autorizados (separados por coma). Dejá vacío
                para permitir todos (no recomendado).
              </p>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* ── Webhook ── */}
      <motion.div variants={fadeUpSmall}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <WebhookIcon className="h-5 w-5 text-primary" />
              Webhook
            </CardTitle>
            <CardDescription>
              URL que Telegram usará para enviar los mensajes
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* Webhook URL */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">URL del Webhook</label>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={status.webhookUrl}
                  className="font-mono text-sm"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    copyToClipboard(status.webhookUrl, "Webhook URL")
                  }
                  aria-label="Copiar webhook URL"
                >
                  <CopyIcon className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Acciones */}
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="default"
                className="btn-gold gap-2"
                onClick={handleSetWebhook}
                disabled={
                  loading === "webhook-set" || !status.configured
                }
              >
                <GlobeIcon className="h-4 w-4" />
                {loading === "webhook-set"
                  ? "Configurando..."
                  : "Configurar Webhook"}
              </Button>

              <Button
                type="button"
                variant="outline"
                onClick={handleCheckWebhook}
                disabled={loading === "webhook-check" || !status.configured}
                className="gap-2"
              >
                <RefreshCwIcon
                  className={`h-4 w-4 ${loading === "webhook-check" ? "animate-spin" : ""}`}
                />
                Verificar estado
              </Button>

              {confirmDeleteWebhook ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Corta los mensajes entrantes hasta reconfigurar
                  </span>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={handleDeleteWebhook}
                    disabled={loading === "webhook-delete"}
                    className="gap-2"
                  >
                    <Trash2Icon className="h-4 w-4" />
                    {loading === "webhook-delete"
                      ? "Eliminando..."
                      : "Confirmar eliminación"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmDeleteWebhook(false)}
                  >
                    Volver
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => setConfirmDeleteWebhook(true)}
                  disabled={
                    loading === "webhook-delete" || !status.configured
                  }
                  className="gap-2"
                >
                  <Trash2Icon className="h-4 w-4" />
                  Eliminar Webhook
                </Button>
              )}
            </div>

            {/* Webhook info */}
            {webhookInfo && (
              <div className="rounded-md border bg-muted/40 p-3">
                <p className="text-sm font-medium mb-2">
                  Información del webhook
                </p>
                <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span className="w-32 shrink-0">URL activa:</span>
                    <span className="font-mono text-xs truncate">
                      {webhookInfo.url || "— ninguna —"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-32 shrink-0">Updates pendientes:</span>
                    <Badge variant="secondary" className="text-xs">
                      {webhookInfo.pendingUpdateCount}
                    </Badge>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  );
}
