"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { fadeUpSmall, staggerContainer } from "@/lib/animation-variants";
import {
  saveAgentConfig,
  testAgentConnection,
  copyAgentConfig,
  type AgentConfigState,
  type PhoneIdEntry,
} from "./actions";
import type { AgentConfigScopeOption } from "@/lib/agent-config-scope";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectOption } from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Eye,
  EyeOff,
  Plus,
  X,
  ExternalLink,
  Play,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertCircle,
  MessageCircle,
  Layers,
  Copy,
} from "lucide-react";
import { clsx } from "clsx";

export type { PhoneIdEntry } from "./actions";

export type BusinessHour = {
  day: string;
  open: boolean;
  openTime: string;
  closeTime: string;
};

export type AgentConfigFormData = {
  systemPrompt: string;
  phoneNumber: string;
  enabled: boolean;
  businessHours: BusinessHour[];
  // ─── Nuevos campos ────────────────────────────────────────────────────────
  // Secret never reaches the client — only whether one is configured.
  ycloudApiKeySet: boolean;
  whatsappBotNumber: string;
  allowedPhoneIds: PhoneIdEntry[];
  sellerPhoneIds: PhoneIdEntry[];
  autoReply24h: boolean;
  autoReply24hMessage: string;
  webOrderRedirectEnabled: boolean;
  webOrderRedirectMessage: string;
  trainBotContext: string;
  // ─── WhatsApp Agent Editor ──────────────────────────────────────────────
  whatsappSystemPrompt: string;
  whatsappInstrucciones: string;
  whatsappZonasDelivery: { zona: string; disponible: boolean; tiempo: string; costo: number }[];
  // ─── System Status ──────────────────────────────────────────────────────
  isCooking: boolean;
  hamburguesasSinStock: boolean;
  stockPanDocenas: number;
  aliasB2c: string;
  aliasB2b: string;
  tiempoEspera: string;
  // ─── Menu Images ─────────────────────────────────────────────────────────
  menuImageUrlHamburguesas: string;
  menuImageUrlPan: string;
  // ─── Delivery ──────────────────────────────────────────────────────────
  deliveryPhoneNumber: string;
  deliveryEnabled: boolean;
  deliveryStartHour: string;
  // ─── Production ────────────────────────────────────────────────────────
  productionHours: string;
  // ─── Business identity ─────────────────────────────────────────────────
  businessName: string;
  businessTagline: string;
  businessAddress: string;
  businessPhoneDisplay: string;
  instagramHandle: string;
  businessWebsite: string;
  businessDescription: string;
  // ─── AI provider — the key itself is never sent back to the browser ────
  aiApiKeySet: boolean;
  aiBaseUrl: string;
  aiModel: string;
  aiModelFast: string;
  aiModelVision: string;
  // ─── Integrations — secrets arrive only as …Set flags, never raw ───────
  ycloudWebhookSecretSet: boolean;
  cloudinaryCloudName: string;
  cloudinaryApiKey: string;
  cloudinaryApiSecretSet: boolean;
  metaAppId: string;
  metaAppSecretSet: boolean;
  metaWebhookVerifyTokenSet: boolean;
  telegramNotifyChatId: string;
  cronSecretSet: boolean;
  escalationEmail: string;
};

const initialState: AgentConfigState = {
  success: false,
  message: "",
};

const DEFAULT_DAYS: BusinessHour[] = [
  { day: "Lunes", open: true, openTime: "09:00", closeTime: "22:00" },
  { day: "Martes", open: true, openTime: "09:00", closeTime: "22:00" },
  { day: "Miércoles", open: true, openTime: "09:00", closeTime: "22:00" },
  { day: "Jueves", open: true, openTime: "09:00", closeTime: "22:00" },
  { day: "Viernes", open: true, openTime: "09:00", closeTime: "22:00" },
  { day: "Sábado", open: true, openTime: "09:00", closeTime: "22:00" },
  { day: "Domingo", open: false, openTime: "09:00", closeTime: "22:00" },
];

export default function AgentConfigForm({
  config,
  scopeKey,
  scopeOptions,
  scopeExists,
}: {
  config: AgentConfigFormData;
  scopeKey: string;
  scopeOptions: AgentConfigScopeOption[];
  scopeExists: boolean;
}) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState(
    saveAgentConfig,
    initialState
  );

  const [copyFrom, setCopyFrom] = useState("");
  const [copying, setCopying] = useState(false);

  const [testState, setTestState] = useState<{
    loading: boolean;
    result: null | { success: boolean; message: string };
  }>({ loading: false, result: null });

  // ─── State ──────────────────────────────────────────────────────────────────

  const [enabled, setEnabled] = useState(config.enabled);
  const [showApiKey, setShowApiKey] = useState(false);
  const [allowedPhoneIds, setAllowedPhoneIds] = useState<PhoneIdEntry[]>(
    config.allowedPhoneIds
  );
  const [sellerPhoneIds, setSellerPhoneIds] = useState<PhoneIdEntry[]>(
    config.sellerPhoneIds
  );
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [autoReply24h, setAutoReply24h] = useState(config.autoReply24h);
  const [webOrderRedirectEnabled, setWebOrderRedirectEnabled] = useState(
    config.webOrderRedirectEnabled
  );
  const [showPreview, setShowPreview] = useState(false);
  const [trainBotContext, setTrainBotContext] = useState(config.trainBotContext);
  const [systemPrompt, setSystemPrompt] = useState(config.systemPrompt);
  const [whatsappSystemPrompt, setWhatsappSystemPrompt] = useState(config.whatsappSystemPrompt || "");
  const [whatsappInstrucciones, setWhatsappInstrucciones] = useState(config.whatsappInstrucciones || "");
  const [zonasDelivery, setZonasDelivery] = useState(config.whatsappZonasDelivery || [
    { zona: "centro", disponible: true, tiempo: "20-30 min", costo: 0 },
    { zona: "norte", disponible: true, tiempo: "25-35 min", costo: 0 },
    { zona: "sur", disponible: true, tiempo: "30-40 min", costo: 0 },
  ]);

  const [isCooking, setIsCooking] = useState(config.isCooking ?? true);
  const [hamburguesasSinStock, setHamburguesasSinStock] = useState(config.hamburguesasSinStock ?? false);
  const [stockPanDocenas, setStockPanDocenas] = useState(config.stockPanDocenas ?? 0);
  const [aliasB2c, setAliasB2c] = useState(config.aliasB2c ?? "");
  const [aliasB2b, setAliasB2b] = useState(config.aliasB2b ?? "");
  const [menuImageHamburguesas, setMenuImageHamburguesas] = useState(config.menuImageUrlHamburguesas ?? "");
  const [menuImagePan, setMenuImagePan] = useState(config.menuImageUrlPan ?? "");
  const [uploadingMenuHamb, setUploadingMenuHamb] = useState(false);
  const [uploadingMenuPan, setUploadingMenuPan] = useState(false);
  const [deliveryEnabled, setDeliveryEnabled] = useState(config.deliveryEnabled ?? true);
  const [deliveryStartHour, setDeliveryStartHour] = useState(config.deliveryStartHour ?? "14:00");
  const [productionHours, setProductionHours] = useState(config.productionHours ?? "");

  // ─── Toast notifications ────────────────────────────────────────────────────

  useEffect(() => {
    if (!state.message) return;
    if (state.success) {
      toast.success(state.message);
    } else {
      toast.error(state.message);
    }
  }, [state]);

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  const addPhoneId = () => {
    const name = newName.trim();
    const phone = newPhone.trim();
    if (!name || !phone) {
      toast.error("Completá nombre y teléfono");
      return;
    }
    if (allowedPhoneIds.some((e) => e.phone === phone)) {
      toast.error("Ese teléfono ya está agregado");
      return;
    }
    setAllowedPhoneIds((prev) => [...prev, { name, phone }]);
    setNewName("");
    setNewPhone("");
  };

  const removePhoneId = (phone: string) => {
    setAllowedPhoneIds((prev) => prev.filter((e) => e.phone !== phone));
  };

  // ─── Image upload helper ─────────────────────────────────────────────────────
  async function handleMenuImageUpload(
    file: File,
    setUrl: (url: string) => void,
    setUploading: (v: boolean) => void
  ) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/media/upload", { method: "POST", body: fd });
      if (!res.ok) throw new Error((await res.json()).error || "Error");
      const data = await res.json();
      setUrl(data.url);
      toast.success("Imagen subida");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error al subir");
    } finally {
      setUploading(false);
    }
  }

  const handleTestConfig = async () => {
    setTestState({ loading: true, result: null });
    try {
      const result = await testAgentConnection(scopeKey);
      setTestState({ loading: false, result });
      if (result.success) {
        toast.success("✅ Todas las verificaciones pasaron");
      } else {
        toast.error("Revisá la configuración — hay campos pendientes");
      }
    } catch {
      setTestState({ loading: false, result: { success: false, message: "Error al ejecutar test" } });
      toast.error("Error al ejecutar test");
    }
  };

  const businessHours =
    config.businessHours.length > 0 ? config.businessHours : DEFAULT_DAYS;

  const combinedSystemPrompt = systemPrompt
    ? systemPrompt +
      (trainBotContext
        ? `\n\n--- Contexto adicional ---\n${trainBotContext}`
        : "")
    : "(sin prompt del sistema)";

  const handleCopyScope = async () => {
    if (!copyFrom) return;
    setCopying(true);
    try {
      const result = await copyAgentConfig(copyFrom, scopeKey);
      if (result.success) {
        toast.success(result.message);
        setCopyFrom("");
        router.refresh();
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error("Error al copiar la configuración");
    } finally {
      setCopying(false);
    }
  };

  return (
    <form action={formAction} className="flex flex-col gap-6">
      {/* Scope being edited — saveAgentConfig creates the row only on save. */}
      <input type="hidden" name="agentConfigScope" value={scopeKey} />
      <motion.div
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
        className="flex flex-col gap-6"
      >
        {/* ═════════════════════════════════════════════════════════════════════
           0. Ámbito de la configuración (global / canal / cuenta)
           ═════════════════════════════════════════════════════════════════════ */}
        <motion.div variants={fadeUpSmall}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Layers size={18} />
                Ámbito de la configuración
              </CardTitle>
              <CardDescription>
                La config global aplica a todo. Un ámbito de canal o cuenta la
                reemplaza completa cuando el agente atiende ese ámbito.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div>
                <Label htmlFor="agentScopeSelect">Ámbito a editar</Label>
                <Select
                  id="agentScopeSelect"
                  value={scopeKey}
                  onChange={(e) =>
                    router.push(
                      `/admin/agent?scope=${encodeURIComponent(e.target.value)}`
                    )
                  }
                >
                  {scopeOptions.map((o) => (
                    <SelectOption key={o.key} value={o.key}>
                      {o.label}
                      {o.exists ? "" : " · sin configurar"}
                    </SelectOption>
                  ))}
                </Select>
                {!scopeExists && scopeKey !== "global" && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Este ámbito todavía no tiene fila propia — se crea al guardar.
                    Mientras tanto se usa la config global.
                  </p>
                )}
              </div>

              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Label htmlFor="copyFromScope">Copiar desde…</Label>
                  <Select
                    id="copyFromScope"
                    value={copyFrom}
                    onChange={(e) => setCopyFrom(e.target.value)}
                  >
                    <SelectOption value="">Elegí un ámbito…</SelectOption>
                    {scopeOptions
                      .filter((o) => o.key !== scopeKey && o.exists)
                      .map((o) => (
                        <SelectOption key={o.key} value={o.key}>
                          {o.label}
                        </SelectOption>
                      ))}
                  </Select>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2"
                  onClick={handleCopyScope}
                  disabled={!copyFrom || copying}
                >
                  <Copy size={16} />
                  {copying ? "Copiando..." : "Copiar"}
                </Button>
              </div>
              {/* Secrets copy verbatim (already-encrypted install data). */}
              <p className="text-xs text-muted-foreground">
                La copia incluye credenciales guardadas — son datos de esta
                instalación y se copian ya cifradas.
              </p>
            </CardContent>
          </Card>
        </motion.div>

        {/* ═════════════════════════════════════════════════════════════════════
           1. Estado del agente
           ═════════════════════════════════════════════════════════════════════ */}
        <motion.div variants={fadeUpSmall}>
          <Card
            className={
              enabled
                ? "border-primary/40 transition-colors"
                : "transition-colors"
            }
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Estado del agente
                {enabled && (
                  <span className="inline-flex h-2 w-2 rounded-full bg-primary shadow-[0_0_6px_var(--primary)]" />
                )}
              </CardTitle>
              <CardDescription>
                Activá o desactivá el agente de WhatsApp
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <input type="hidden" name="enabled" value={String(enabled)} />
                <Switch
                  id="enabled"
                  checked={enabled}
                  onCheckedChange={setEnabled}
                />
                <Label htmlFor="enabled" className="cursor-pointer">
                  {enabled ? (
                    <span className="font-medium text-primary">
                      Agente activo
                    </span>
                  ) : (
                    "Agente desactivado"
                  )}
                </Label>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* ═════════════════════════════════════════════════════════════════════
           2. Configuración general
           ═════════════════════════════════════════════════════════════════════ */}
        <motion.div variants={fadeUpSmall}>
          <Card>
            <CardHeader>
              <CardTitle>Configuración general</CardTitle>
              <CardDescription>
                Número de teléfono y prompt del sistema
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="phoneNumber">Número de teléfono</Label>
                <Input
                  id="phoneNumber"
                  name="phoneNumber"
                  placeholder="+5491100000000"
                  defaultValue={config.phoneNumber}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="systemPrompt">Prompt del sistema</Label>
                <Textarea
                  id="systemPrompt"
                  name="systemPrompt"
                  rows={8}
                  placeholder="Sos el asistente virtual de este negocio..."
                  defaultValue={config.systemPrompt}
                  className="resize-none"
                  onChange={(e) => setSystemPrompt(e.target.value)}
                />
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* ═════════════════════════════════════════════════════════════════════
           3. YCloud Credentials
           ═════════════════════════════════════════════════════════════════════ */}
        <motion.div variants={fadeUpSmall}>
          <Card>
            <CardHeader>
              <CardTitle>Credenciales YCloud</CardTitle>
              <CardDescription>
                API Key de YCloud y número del bot de WhatsApp
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ycloudApiKey">
                  YCloud Business API Key
                </Label>
                <div className="relative">
                  <Input
                    id="ycloudApiKey"
                    name="ycloudApiKey"
                    type={showApiKey ? "text" : "password"}
                    placeholder={
                      config.ycloudApiKeySet
                        ? "•••••••• (configurada — dejá vacío para conservar)"
                        : "sk_..."
                    }
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={
                      showApiKey ? "Ocultar API key" : "Mostrar API key"
                    }
                  >
                    {showApiKey ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {config.ycloudApiKeySet
                    ? "Hay una key guardada. Vacío = conservar, \"CLEAR\" = borrar."
                    : "Pegá tu API key de YCloud. También puede venir de YCLOUD_API_KEY en el servidor."}
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="whatsappBotNumber">
                  Número del bot (WhatsApp ID)
                </Label>
                <Input
                  id="whatsappBotNumber"
                  name="whatsappBotNumber"
                  placeholder="+5491100000000"
                  defaultValue={config.whatsappBotNumber}
                />
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* ═════════════════════════════════════════════════════════════════════
           3b. Identidad del negocio — lo que ven los clientes
           ═════════════════════════════════════════════════════════════════════ */}
        <motion.div variants={fadeUpSmall}>
          <Card>
            <CardHeader>
              <CardTitle>Negocio</CardTitle>
              <CardDescription>
                Nombre, dirección y redes — se usa en la tienda, los mensajes y
                los prompts del agente.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="businessName">Nombre del negocio</Label>
                <Input
                  id="businessName"
                  name="businessName"
                  placeholder="Mi Negocio"
                  defaultValue={config.businessName}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="businessTagline">Ubicación / tagline</Label>
                <Input
                  id="businessTagline"
                  name="businessTagline"
                  placeholder="Ej: Formosa Capital y alrededores"
                  defaultValue={config.businessTagline}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="businessAddress">Dirección de retiro</Label>
                <Input
                  id="businessAddress"
                  name="businessAddress"
                  placeholder="Ej: Calle 123, Centro"
                  defaultValue={config.businessAddress}
                />
                <p className="text-xs text-muted-foreground">
                  El agente la usa cuando un cliente pide retirar.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="businessPhoneDisplay">Teléfono (visible)</Label>
                  <Input
                    id="businessPhoneDisplay"
                    name="businessPhoneDisplay"
                    placeholder="Ej: 3705-115020"
                    defaultValue={config.businessPhoneDisplay}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="instagramHandle">Instagram (sin @)</Label>
                  <Input
                    id="instagramHandle"
                    name="instagramHandle"
                    placeholder="mi.negocio"
                    defaultValue={config.instagramHandle}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="businessWebsite">Sitio web (opcional)</Label>
                <Input
                  id="businessWebsite"
                  name="businessWebsite"
                  placeholder="https://..."
                  defaultValue={config.businessWebsite}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="businessDescription">Descripción breve (opcional)</Label>
                <Textarea
                  id="businessDescription"
                  name="businessDescription"
                  rows={2}
                  placeholder="Ej: Rotisería artesanal — hamburguesas, pan mayorista y tragos."
                  defaultValue={config.businessDescription}
                />
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* ═════════════════════════════════════════════════════════════════════
           3c. Proveedor de IA — cualquier endpoint compatible con OpenAI
           ═════════════════════════════════════════════════════════════════════ */}
        <motion.div variants={fadeUpSmall}>
          <Card>
            <CardHeader>
              <CardTitle>Proveedor de IA</CardTitle>
              <CardDescription>
                API key y modelos del agente. Funciona con OpenAI, OpenRouter,
                DeepSeek, Groq, Together u otro endpoint compatible. Si lo dejás
                vacío se usan las variables de entorno del servidor.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="aiApiKey">API Key del proveedor</Label>
                <Input
                  id="aiApiKey"
                  name="aiApiKey"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    config.aiApiKeySet
                      ? "•••••••• (guardada — dejar vacío para conservar, 'CLEAR' para borrar)"
                      : "sk-... — queda vacío si usás OPENAI_API_KEY del servidor"
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Nunca se muestra la clave guardada. Escribí una nueva para
                  reemplazarla o <code>CLEAR</code> para borrarla.
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="aiBaseUrl">Base URL (opcional)</Label>
                <Input
                  id="aiBaseUrl"
                  name="aiBaseUrl"
                  placeholder="https://api.openai.com/v1"
                  defaultValue={config.aiBaseUrl}
                />
                <p className="text-xs text-muted-foreground">
                  OpenRouter: https://openrouter.ai/api/v1 · DeepSeek:
                  https://api.deepseek.com · Groq: https://api.groq.com/openai/v1
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="aiModel">Modelo principal</Label>
                  <Input
                    id="aiModel"
                    name="aiModel"
                    placeholder="deepseek-flash"
                    defaultValue={config.aiModel}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="aiModelFast">Modelo rápido</Label>
                  <Input
                    id="aiModelFast"
                    name="aiModelFast"
                    placeholder="gpt-5-mini"
                    defaultValue={config.aiModelFast}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="aiModelVision">Modelo de visión</Label>
                  <Input
                    id="aiModelVision"
                    name="aiModelVision"
                    placeholder="gpt-4o"
                    defaultValue={config.aiModelVision}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* ═════════════════════════════════════════════════════════════════════
           3d. Integraciones — secrets write-only (vacío = conservar, CLEAR = borrar)
           ═════════════════════════════════════════════════════════════════════ */}
        <motion.div variants={fadeUpSmall}>
          <Card>
            <CardHeader>
              <CardTitle>Integraciones</CardTitle>
              <CardDescription>
                Credenciales de servicios externos. Los campos de secreto nunca
                muestran el valor guardado: dejá vacío para conservarlo,
                escribí uno nuevo para reemplazarlo o <code>CLEAR</code> para
                borrarlo. Si no se cargan acá, se usan las variables de entorno.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              {/* YCloud */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ycloudWebhookSecret">YCloud — Webhook Secret</Label>
                <Input
                  id="ycloudWebhookSecret"
                  name="ycloudWebhookSecret"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    config.ycloudWebhookSecretSet
                      ? "•••••••• (guardado)"
                      : "Secret de firma del webhook de YCloud"
                  }
                />
              </div>

              {/* Cloudinary */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cloudinaryCloudName">Cloudinary — Cloud name</Label>
                  <Input
                    id="cloudinaryCloudName"
                    name="cloudinaryCloudName"
                    defaultValue={config.cloudinaryCloudName}
                    placeholder="mi-cloud"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cloudinaryApiKey">Cloudinary — API key</Label>
                  <Input
                    id="cloudinaryApiKey"
                    name="cloudinaryApiKey"
                    defaultValue={config.cloudinaryApiKey}
                    placeholder="123456789"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cloudinaryApiSecret">Cloudinary — API secret</Label>
                  <Input
                    id="cloudinaryApiSecret"
                    name="cloudinaryApiSecret"
                    type="password"
                    autoComplete="off"
                    placeholder={
                      config.cloudinaryApiSecretSet ? "•••••••• (guardado)" : "Secret"
                    }
                  />
                </div>
              </div>

              {/* Meta */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="metaAppId">Meta — App ID</Label>
                  <Input
                    id="metaAppId"
                    name="metaAppId"
                    defaultValue={config.metaAppId}
                    placeholder="1234567890"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="metaAppSecret">Meta — App secret</Label>
                  <Input
                    id="metaAppSecret"
                    name="metaAppSecret"
                    type="password"
                    autoComplete="off"
                    placeholder={
                      config.metaAppSecretSet ? "•••••••• (guardado)" : "App secret"
                    }
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="metaWebhookVerifyToken">Meta — Webhook verify token</Label>
                  <Input
                    id="metaWebhookVerifyToken"
                    name="metaWebhookVerifyToken"
                    type="password"
                    autoComplete="off"
                    placeholder={
                      config.metaWebhookVerifyTokenSet
                        ? "•••••••• (guardado)"
                        : "Token aleatorio que inventás"
                    }
                  />
                </div>
              </div>

              {/* Ops */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="telegramNotifyChatId">Telegram — Chat ID de avisos</Label>
                  <Input
                    id="telegramNotifyChatId"
                    name="telegramNotifyChatId"
                    defaultValue={config.telegramNotifyChatId}
                    placeholder="1991128737"
                  />
                  <p className="text-xs text-muted-foreground">
                    Recibe avisos de pedidos mayoristas y derivaciones.
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cronSecret">Cron — Secret</Label>
                  <Input
                    id="cronSecret"
                    name="cronSecret"
                    type="password"
                    autoComplete="off"
                    placeholder={
                      config.cronSecretSet ? "•••••••• (guardado)" : "Token para /api/cron/*"
                    }
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="escalationEmail">Email de derivaciones</Label>
                  <Input
                    id="escalationEmail"
                    name="escalationEmail"
                    type="email"
                    defaultValue={config.escalationEmail}
                    placeholder="dueño@tunegocio.com"
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* ═════════════════════════════════════════════════════════════════════
           4. Allowed Phone IDs
           ═════════════════════════════════════════════════════════════════════ */}
        <motion.div variants={fadeUpSmall}>
          <Card>
            <CardHeader>
              <CardTitle>IDs de teléfono permitidos</CardTitle>
              <CardDescription>
                Personas autorizadas para interactuar con el bot (CEO, empleados).
                Si no agregás ninguno, el bot responde a todos.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {/* Hidden input — serializa el array como JSON */}
              <input
                type="hidden"
                name="allowedPhoneIds"
                value={JSON.stringify(allowedPhoneIds)}
              />

              {/* Add row */}
              <div className="flex items-end gap-2">
                <div className="flex-1 flex flex-col gap-1.5">
                  <Label htmlFor="newName" className="text-xs">
                    Nombre
                  </Label>
                  <Input
                    id="newName"
                    placeholder="Ej: Juan Pérez"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === "Enter" &&
                      (e.preventDefault(), addPhoneId())
                    }
                  />
                </div>
                <div className="flex-1 flex flex-col gap-1.5">
                  <Label htmlFor="newPhone" className="text-xs">
                    Teléfono
                  </Label>
                  <Input
                    id="newPhone"
                    placeholder="+5491100000000"
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === "Enter" &&
                      (e.preventDefault(), addPhoneId())
                    }
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={addPhoneId}
                  className="shrink-0"
                  aria-label="Agregar ID permitido"
                >
                  <Plus size={18} />
                </Button>
              </div>

              {/* Lista */}
              {allowedPhoneIds.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No hay IDs permitidos. Todos los números pueden hablar con el
                  bot.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {allowedPhoneIds.map((entry) => (
                    <div
                      key={entry.phone}
                      className="flex items-center justify-between rounded-md border border-primary/20 bg-muted/20 px-3 py-2"
                    >
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">
                          {entry.name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {entry.phone}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => removePhoneId(entry.phone)}
                        className="text-muted-foreground hover:text-red-400 transition-colors"
                        aria-label={`Eliminar ${entry.name}`}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* ═════════════════════════════════════════════════════════════════════
            4b. Vendedores (usan el sistema del bot de Telegram por WhatsApp)
            ═════════════════════════════════════════════════════════════════════ */}
        <motion.div variants={fadeUpSmall}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span>🛒</span>
                Vendedores
              </CardTitle>
              <CardDescription>
                Vendedores que pueden cargar pedidos hablando con la IA por WhatsApp. Usan el mismo sistema que el bot de Telegram — pueden crear pedidos, buscar clientes, y gestionar todo.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {/* Hidden input — serializa el array como JSON */}
              <input
                type="hidden"
                name="sellerPhoneIds"
                value={JSON.stringify(sellerPhoneIds)}
              />

              {/* Add row */}
              <div className="flex items-end gap-2">
                <div className="flex-1 flex flex-col gap-1.5">
                  <Label htmlFor="sellerNewName" className="text-xs">
                    Nombre del vendedor
                  </Label>
                  <Input
                    id="sellerNewName"
                    placeholder="Ej: Carla Pérez"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === "Enter" &&
                      (e.preventDefault(), addPhoneId())
                    }
                  />
                </div>
                <div className="flex-1 flex flex-col gap-1.5">
                  <Label htmlFor="sellerNewPhone" className="text-xs">
                    Teléfono
                  </Label>
                  <Input
                    id="sellerNewPhone"
                    placeholder="5493700000000"
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                    onKeyDown={(e) =>
                      e.key === "Enter" &&
                      (e.preventDefault(), addPhoneId())
                    }
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    const name = newName.trim();
                    const phone = newPhone.trim();
                    if (!name || !phone) {
                      toast.error("Completá nombre y teléfono");
                      return;
                    }
                    if (sellerPhoneIds.some((e) => e.phone === phone)) {
                      toast.error("Ese teléfono ya está agregado");
                      return;
                    }
                    setSellerPhoneIds((prev) => [...prev, { name, phone }]);
                    setNewName("");
                    setNewPhone("");
                  }}
                  className="shrink-0"
                  aria-label="Agregar vendedor"
                >
                  <Plus size={18} />
                </Button>
              </div>

              {/* Lista */}
              {sellerPhoneIds.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No hay vendedores registrados. Agregá sus números para que puedan cargar pedidos por WhatsApp.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {sellerPhoneIds.map((entry) => (
                    <div
                      key={entry.phone}
                      className="flex items-center justify-between rounded-md border border-primary/20 bg-muted/20 px-3 py-2"
                    >
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">
                          {entry.name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {entry.phone}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSellerPhoneIds((prev) =>
                          prev.filter((e) => e.phone !== entry.phone)
                        )}
                        className="text-muted-foreground hover:text-red-400 transition-colors"
                        aria-label={`Eliminar ${entry.name}`}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* ═════════════════════════════════════════════════════════════════════
            5. Horarios de atención
            ═════════════════════════════════════════════════════════════════════ */}
        <motion.div variants={fadeUpSmall}>
          <Card>
            <CardHeader>
              <CardTitle>Horarios de atención</CardTitle>
              <CardDescription>
                Configurá los días y horarios en que el agente responde
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-3">
                {/* Header */}
                <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-1 text-xs font-medium text-muted-foreground">
                  <span>Día</span>
                  <span className="w-16 text-center">Abierto</span>
                  <span className="w-24 text-center">Apertura</span>
                  <span className="w-24 text-center">Cierre</span>
                </div>

                {businessHours.map((bh) => (
                  <BusinessHourRow key={bh.day} businessHour={bh} />
                ))}
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* ═════════════════════════════════════════════════════════════════════
           6. Ventana 24hs
           ═════════════════════════════════════════════════════════════════════ */}
        <motion.div variants={fadeUpSmall}>
          <Card>
            <CardHeader>
              <CardTitle>Ventana de 24hs</CardTitle>
              <CardDescription>
                Auto-responder cuando un cliente escribe fuera de la ventana de
                24hs de WhatsApp
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <input
                  type="hidden"
                  name="autoReply24h"
                  value={String(autoReply24h)}
                />
                <Switch
                  id="autoReply24h"
                  checked={autoReply24h}
                  onCheckedChange={setAutoReply24h}
                />
                <Label htmlFor="autoReply24h" className="cursor-pointer">
                  {autoReply24h
                    ? "Auto-respuesta activada"
                    : "Auto-respuesta desactivada"}
                </Label>
              </div>

              {autoReply24h && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="autoReply24hMessage">
                    Mensaje automático
                  </Label>
                  <Textarea
                    id="autoReply24hMessage"
                    name="autoReply24hMessage"
                    rows={3}
                    placeholder="¡Hola! Gracias por contactarte. Actualmente no estamos en horario de atención, pero tu mensaje será respondido a la brevedad."
                    defaultValue={config.autoReply24hMessage}
                    className="resize-none"
                  />
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* ═════════════════════════════════════════════════════════════════════
           6b. Pedidos por la web
           ═════════════════════════════════════════════════════════════════════ */}
        <motion.div variants={fadeUpSmall}>
          <Card>
            <CardHeader>
              <CardTitle>Pedidos por la web</CardTitle>
              <CardDescription>
                En el primer mensaje de un cliente nuevo, enviá una respuesta que
                lo dirija a la carta digital para que el pedido quede registrado
                en el sistema.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <input
                  type="hidden"
                  name="webOrderRedirectEnabled"
                  value={String(webOrderRedirectEnabled)}
                />
                <Switch
                  id="webOrderRedirectEnabled"
                  checked={webOrderRedirectEnabled}
                  onCheckedChange={setWebOrderRedirectEnabled}
                />
                <Label htmlFor="webOrderRedirectEnabled" className="cursor-pointer">
                  {webOrderRedirectEnabled
                    ? "Derivación al sistema activada"
                    : "Derivación al sistema desactivada"}
                </Label>
              </div>

              {webOrderRedirectEnabled && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="webOrderRedirectMessage">
                    Mensaje automático (opcional)
                  </Label>
                  <Textarea
                    id="webOrderRedirectMessage"
                    name="webOrderRedirectMessage"
                    rows={4}
                    placeholder="¡Hola! Para que tu pedido quede registrado correctamente, hacelo desde nuestra carta digital."
                    defaultValue={config.webOrderRedirectMessage}
                    className="resize-none"
                  />
                  <p className="text-xs text-muted-foreground">
                    Si lo dejás vacío, se usa un mensaje estándar con el enlace a la carta digital.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* ═════════════════════════════════════════════════════════════════════
           7. Train Bot
           ═════════════════════════════════════════════════════════════════════ */}
        <motion.div variants={fadeUpSmall}>
          <Card>
            <CardHeader>
              <CardTitle>Entrenar Bot</CardTitle>
              <CardDescription>
                Agregá contexto adicional (productos nuevos, promociones, etc.)
                para que el bot lo tenga en cuenta en sus respuestas
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="trainBotContext">
                  Contexto adicional
                </Label>
                <Textarea
                  id="trainBotContext"
                  name="trainBotContext"
                  rows={4}
                  placeholder="Ej: Esta semana tenemos promo 2x1 en hamburguesas clásicas..."
                  defaultValue={config.trainBotContext}
                  className="resize-none"
                  onChange={(e) => setTrainBotContext(e.target.value)}
                />
              </div>

              {/* Preview del system prompt */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowPreview((v) => !v)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showPreview ? (
                    <ChevronUp size={14} />
                  ) : (
                    <ChevronDown size={14} />
                  )}
                  {showPreview ? "Ocultar" : "Mostrar"} vista previa del
                  prompt del sistema
                </button>

                {showPreview && (
                  <pre className="mt-2 max-h-60 overflow-auto rounded-md border border-border bg-muted/60 p-3 text-xs text-muted-foreground whitespace-pre-wrap font-mono">
                    {combinedSystemPrompt}
                  </pre>
                )}
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* ═════════════════════════════════════════════════════════════════════
            8. WhatsApp Agent — Editor de Prompt
            ═════════════════════════════════════════════════════════════════════ */}
        <motion.div variants={fadeUpSmall}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageCircle size={18} className="text-[#25D366]" />
                Editor de Prompt — WhatsApp Agent
              </CardTitle>
              <CardDescription>
                Personalizá el comportamiento del agente. El prompt V2 base siempre está activo;
                estos valores se agregan como instrucciones adicionales.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              {/* System Prompt override */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="whatsappSystemPrompt">System Prompt personalizado</Label>
                <Textarea
                  id="whatsappSystemPrompt"
                  name="whatsappSystemPrompt"
                  rows={4}
                  placeholder="Ej: Usá un tono más formal con clientes B2B..."
                  value={whatsappSystemPrompt}
                  onChange={(e) => setWhatsappSystemPrompt(e.target.value)}
                  className="resize-none"
                />
                <p className="text-[10px] text-muted-foreground">
                  Si se completa, reemplaza al prompt V2 por completo. Dejalo vacío para usar el prompt base.
                </p>
              </div>

              {/* Instrucciones adicionales */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="whatsappInstrucciones">Instrucciones adicionales</Label>
                <Textarea
                  id="whatsappInstrucciones"
                  name="whatsappInstrucciones"
                  rows={3}
                  placeholder="Ej: Preguntá siempre si quieren papas antes de cerrar el pedido..."
                  value={whatsappInstrucciones}
                  onChange={(e) => setWhatsappInstrucciones(e.target.value)}
                  className="resize-none"
                />
              </div>

              {/* Zonas de delivery */}
              <div className="flex flex-col gap-3">
                <Label>Zonas de delivery</Label>
                <input
                  type="hidden"
                  name="whatsappZonasDelivery"
                  value={JSON.stringify(zonasDelivery)}
                />
                <div className="flex flex-col gap-2">
                  {zonasDelivery.map((z, i) => (
                    <div key={i} className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2">
                      <div className="flex-1 grid grid-cols-4 gap-2 text-sm">
                        <Input
                          value={z.zona}
                          onChange={(e) => {
                            const next = [...zonasDelivery];
                            next[i] = { ...next[i], zona: e.target.value };
                            setZonasDelivery(next);
                          }}
                          className="h-8 text-xs"
                          placeholder="Zona"
                        />
                        <Input
                          value={z.tiempo}
                          onChange={(e) => {
                            const next = [...zonasDelivery];
                            next[i] = { ...next[i], tiempo: e.target.value };
                            setZonasDelivery(next);
                          }}
                          className="h-8 text-xs"
                          placeholder="Tiempo"
                        />
                        <Input
                          type="number"
                          value={z.costo}
                          onChange={(e) => {
                            const next = [...zonasDelivery];
                            next[i] = { ...next[i], costo: Number(e.target.value) };
                            setZonasDelivery(next);
                          }}
                          className="h-8 text-xs"
                          placeholder="Costo"
                        />
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={z.disponible}
                            onCheckedChange={(v) => {
                              const next = [...zonasDelivery];
                              next[i] = { ...next[i], disponible: v };
                              setZonasDelivery(next);
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => setZonasDelivery((prev) => prev.filter((_, idx) => idx !== i))}
                            className="text-muted-foreground hover:text-red-400 transition-colors"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setZonasDelivery((prev) => [...prev, { zona: "", disponible: true, tiempo: "30 min", costo: 0 }])}
                  className="gap-1 self-start"
                >
                  <Plus size={14} />
                  Agregar zona
                </Button>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* ═════════════════════════════════════════════════════════════════════
            9. System Status — Cocina + Stock + Alias
            ═════════════════════════════════════════════════════════════════════ */}
        <motion.div variants={fadeUpSmall}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span>👨‍🍳</span>
                Estado del Local
              </CardTitle>
              <CardDescription>
                Control de cocina, stock de pan y alias de pago — influye en las respuestas del agente
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              {/* isCooking */}
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <Label htmlFor="isCooking">Cocina operativa</Label>
                  <p className="text-xs text-muted-foreground">
                    Si está desactivado, el agente responde &quot;Hoy no :/&quot; y no toma pedidos
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <input type="hidden" name="isCooking" value={String(isCooking)} />
                  <Switch
                    id="isCooking"
                    checked={isCooking}
                    onCheckedChange={setIsCooking}
                  />
                  <span className={clsx("text-sm font-medium", isCooking ? "text-green-400" : "text-red-400")}>
                    {isCooking ? "Cocinando" : "Cerrado"}
                  </span>
                </div>
              </div>

              {/* hamburguesasSinStock */}
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <Label htmlFor="hamburguesasSinStock">🍔 Hamburguesas sin stock</Label>
                  <p className="text-xs text-muted-foreground">
                    Si está activado, el agente NO vende hamburguesas (B2C) pero sigue vendiendo pan mayorista (B2B) normalmente
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <input type="hidden" name="hamburguesasSinStock" value={String(hamburguesasSinStock)} />
                  <Switch
                    id="hamburguesasSinStock"
                    checked={hamburguesasSinStock}
                    onCheckedChange={setHamburguesasSinStock}
                  />
                  <span className={clsx("text-sm font-medium", hamburguesasSinStock ? "text-red-400" : "text-green-400")}>
                    {hamburguesasSinStock ? "Sin stock" : "Con stock"}
                  </span>
                </div>
              </div>

              {/* stockPanDocenas */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="stockPanDocenas">Stock pan al por mayor (en docenas)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="stockPanDocenas"
                    name="stockPanDocenas"
                    type="number"
                    min={0}
                    value={stockPanDocenas}
                    onChange={(e) => setStockPanDocenas(Number(e.target.value))}
                    className="w-24"
                  />
                  <span className="text-sm text-muted-foreground">docenas disponibles</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Si el cliente pide más de esto, el agente dice &quot;Tengo X doc nomás amigo&quot;
                </p>
              </div>

              {/* Alias B2C */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="aliasB2c">Alias de pago — B2C (hamburguesas / rotisería)</Label>
                <Input
                  id="aliasB2c"
                  name="aliasB2c"
                  placeholder="Ej: LEAN..LEMON"
                  value={aliasB2c}
                  onChange={(e) => setAliasB2c(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  El agente inyecta este alias cuando un cliente de hamburguesas pide datos para transferir
                </p>
              </div>

              {/* Alias B2B */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="aliasB2b">Alias de pago — B2B (pan mayorista / negocios)</Label>
                <Input
                  id="aliasB2b"
                  name="aliasB2b"
                  placeholder="Ej: PANES.AL.POR.MAYOR"
                  value={aliasB2b}
                  onChange={(e) => setAliasB2b(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  El agente inyecta este alias cuando un cliente mayorista pide datos para transferir
                </p>
              </div>

              {/* Tiempo de espera */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tiempoEspera">Tiempo de espera estimado</Label>
                <Input
                  id="tiempoEspera"
                  name="tiempoEspera"
                  placeholder="30-40 min"
                  defaultValue={config.tiempoEspera ?? ""}
                />
                <p className="text-xs text-muted-foreground">
                  El agente usa este tiempo al confirmar pedidos. Ej: &quot;En 30-40 min lo tenes amigo&quot;
                </p>
              </div>

              {/* Horario de producción */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="productionHours">Horario de producción</Label>
                <Textarea
                  id="productionHours"
                  name="productionHours"
                  rows={3}
                  placeholder="Ej: El pan y productos mayoristas están disponibles a partir de las 14hs. A la mañana la producción está en marcha pero los productos todavía no están listos para retirar."
                  value={productionHours}
                  onChange={(e) => setProductionHours(e.target.value)}
                  className="resize-none"
                />
                <p className="text-xs text-muted-foreground">
                  El agente usa este texto + la hora actual para saber cuándo los productos están disponibles. Ej: Cliente pregunta &quot;¿A qué hora tienen pan?&quot; → el agente responde según esto.
                </p>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* ═════════════════════════════════════════════════════════════════════
            10. Imágenes de Menú
            ═════════════════════════════════════════════════════════════════════ */}
        <motion.div variants={fadeUpSmall}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <span>📸</span>
                Imágenes de Menú
              </CardTitle>
              <CardDescription>
                Subí las imágenes del menú que el agente envía cuando los clientes preguntan
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              {/* Menu Hamburguesas */}
              <div className="flex items-start gap-4">
                <div className="w-24 h-24 rounded-xl overflow-hidden bg-muted/40 border border-border flex items-center justify-center shrink-0">
                  {menuImageHamburguesas ? (
                    // eslint-disable-next-line @next/next/no-img-element -- preview de imagen subida (blob/data URL); next/image no optimiza fuentes locales arbitrarias
                    <img src={menuImageHamburguesas} alt="Menu hamburguesas" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-3xl text-foreground/20">🍔</span>
                  )}
                </div>
                <div className="flex flex-col gap-2 flex-1">
                  <Label>Menú Hamburguesas</Label>
                  <input type="hidden" name="menuImageUrlHamburguesas" value={menuImageHamburguesas} />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={uploadingMenuHamb}
                    onClick={() => document.getElementById("menu-upload-hamb")?.click()}
                  >
                    {uploadingMenuHamb ? "Subiendo..." : "Subir imagen"}
                  </Button>
                  <input
                    id="menu-upload-hamb"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleMenuImageUpload(f, setMenuImageHamburguesas, setUploadingMenuHamb);
                    }}
                  />
                  {menuImageHamburguesas && (
                    <button
                      type="button"
                      onClick={() => setMenuImageHamburguesas("")}
                      className="text-xs text-red-400 hover:text-red-300 self-start"
                    >
                      Quitar imagen
                    </button>
                  )}
                </div>
              </div>

              {/* Menu Pan */}
              <div className="flex items-start gap-4">
                <div className="w-24 h-24 rounded-xl overflow-hidden bg-muted/40 border border-border flex items-center justify-center shrink-0">
                  {menuImagePan ? (
                    // eslint-disable-next-line @next/next/no-img-element -- preview de imagen subida (blob/data URL); next/image no optimiza fuentes locales arbitrarias
                    <img src={menuImagePan} alt="Menu pan" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-3xl text-foreground/20">🍞</span>
                  )}
                </div>
                <div className="flex flex-col gap-2 flex-1">
                  <Label>Menú Pan (B2B)</Label>
                  <input type="hidden" name="menuImageUrlPan" value={menuImagePan} />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={uploadingMenuPan}
                    onClick={() => document.getElementById("menu-upload-pan")?.click()}
                  >
                    {uploadingMenuPan ? "Subiendo..." : "Subir imagen"}
                  </Button>
                  <input
                    id="menu-upload-pan"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleMenuImageUpload(f, setMenuImagePan, setUploadingMenuPan);
                    }}
                  />
                  {menuImagePan && (
                    <button
                      type="button"
                      onClick={() => setMenuImagePan("")}
                      className="text-xs text-red-400 hover:text-red-300 self-start"
                    >
                      Quitar imagen
                    </button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* ═════════════════════════════════════════════════════════════════════
            10b. Delivery
            ═════════════════════════════════════════════════════════════════════ */}
        <motion.div variants={fadeUpSmall}>
          <Card>
            <CardHeader>
              <CardTitle>Delivery</CardTitle>
              <CardDescription>
                Configuración del servicio de delivery. Cuando está activo y en horario, el agente
                ofrece delivery propio con costo. Cuando está inactivo o fuera de horario, el agente
                gestiona con Uber.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Switch delivery activo */}
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <Label htmlFor="deliveryEnabled">Delivery activo</Label>
                  <p className="text-xs text-muted-foreground">
                    Si está desactivado, el agente deriva todos los pedidos a Uber
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <input type="hidden" name="deliveryEnabled" value={String(deliveryEnabled)} />
                  <Switch
                    id="deliveryEnabled"
                    checked={deliveryEnabled}
                    onCheckedChange={setDeliveryEnabled}
                  />
                  <span className={clsx("text-sm font-medium", deliveryEnabled ? "text-green-400" : "text-red-400")}>
                    {deliveryEnabled ? "Activo" : "Inactivo"}
                  </span>
                </div>
              </div>

              {/* Horario de inicio del delivery */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="deliveryStartHour">Horario de inicio del delivery</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="deliveryStartHour"
                    name="deliveryStartHour"
                    value={deliveryStartHour}
                    onChange={(e) => setDeliveryStartHour(e.target.value)}
                    placeholder="14:00"
                    className="w-24 font-mono"
                  />
                  <span className="text-sm text-muted-foreground">
                    hs — desde esta hora hasta el cierre hay delivery
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Antes de esta hora, el agente dice: &quot;En este turno gestionamos los pedidos mediante Uber&quot;
                </p>
              </div>

              {/* Número del delivery */}
              <div className="flex flex-col gap-2">
                <Label htmlFor="deliveryPhoneNumber">
                  Número de WhatsApp del delivery
                </Label>
                <Input
                  id="deliveryPhoneNumber"
                  name="deliveryPhoneNumber"
                  defaultValue={config.deliveryPhoneNumber ?? ""}
                  placeholder="549XXXXXXXXXX"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Sin +, sin espacios. Ej: 549XXXXXXXXXX
                </p>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* ═════════════════════════════════════════════════════════════════════
            11. Quick Actions
            ═════════════════════════════════════════════════════════════════════ */}
        <motion.div variants={fadeUpSmall}>
          <Card>
            <CardHeader>
              <CardTitle>Acciones rápidas</CardTitle>
              <CardDescription>
                Herramientas útiles para probar y acceder al bot
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-3">
                <a
                  href={
                    config.whatsappBotNumber
                      ? `https://wa.me/${config.whatsappBotNumber.replace(/[^0-9]/g, "")}`
                      : "#"
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className={clsx(
                    "btn-gold inline-flex items-center gap-2 px-4 py-2 text-sm rounded-full transition-opacity hover:opacity-90",
                    !config.whatsappBotNumber &&
                      "pointer-events-none opacity-50"
                  )}
                >
                  <ExternalLink size={16} />
                  Hablar con el Bot
                </a>

                <Button
                  type="button"
                  variant="outline"
                  className="gap-2"
                  onClick={handleTestConfig}
                  disabled={testState.loading}
                >
                  <Play size={16} />
                  {testState.loading ? "Verificando..." : "Test configuración"}
                </Button>
              </div>

              {/* Resultado del test */}
              {testState.result && (
                <div
                  className={clsx(
                    "mt-4 flex items-start gap-2 rounded-md border p-3 text-sm",
                    testState.result.success
                      ? "border-green-500/30 bg-green-500/5 text-green-400"
                      : "border-yellow-500/30 bg-yellow-500/5 text-yellow-400"
                  )}
                >
                  {testState.result.success ? (
                    <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
                  ) : (
                    <AlertCircle size={16} className="mt-0.5 shrink-0" />
                  )}
                  <span className="whitespace-pre-line">
                    {testState.result.message}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </motion.div>

      {/* ═════════════════════════════════════════════════════════════════════════
         Submit — sticky bottom bar, always visible
         ═════════════════════════════════════════════════════════════════════════ */}
      <div className="sticky bottom-0 z-30 -mx-4 mt-4 border-t border-border bg-background/95 backdrop-blur-sm px-4 py-3 flex justify-end">
        <Button
          type="submit"
          disabled={isPending}
          className="btn-gold min-w-[160px] transition-opacity hover:opacity-90"
        >
          {isPending ? "Guardando..." : "Guardar configuración"}
        </Button>
      </div>
    </form>
  );
}

// ─── Business Hour Row ────────────────────────────────────────────────────────

function BusinessHourRow({
  businessHour,
}: {
  businessHour: BusinessHour;
}) {
  const { day, open, openTime, closeTime } = businessHour;
  const [isOpen, setIsOpen] = useState(open);

  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 rounded-md border px-3 py-2 transition-colors hover:bg-muted/20">
      <span className="text-sm font-medium">{day}</span>

      <div className="flex w-16 justify-center">
        <input
          type="hidden"
          name={`businessHours.${day}.open`}
          value={String(isOpen)}
        />
        <Switch
          id={`businessHours.${day}.open`}
          checked={isOpen}
          onCheckedChange={setIsOpen}
          aria-label={`${day} abierto`}
        />
      </div>

      <Input
        id={`businessHours.${day}.openTime`}
        name={`businessHours.${day}.openTime`}
        type="time"
        defaultValue={openTime}
        className="w-24"
        aria-label={`${day} hora de apertura`}
      />

      <Input
        id={`businessHours.${day}.closeTime`}
        name={`businessHours.${day}.closeTime`}
        type="time"
        defaultValue={closeTime}
        className="w-24"
        aria-label={`${day} hora de cierre`}
      />
    </div>
  );
}
