import AgentConfigForm, { type AgentConfigFormData, type BusinessHour } from "./agent-config-form";
import {
  findAgentConfigForScope,
  listAgentConfigScopes,
  parseScopeKey,
  scopeKeyOf,
} from "@/lib/agent-config-scope";

export const metadata = {
  title: "Agente — Admin",
};

const DEFAULT_BUSINESS_HOURS: BusinessHour[] = [
  { day: "Lunes", open: true, openTime: "09:00", closeTime: "22:00" },
  { day: "Martes", open: true, openTime: "09:00", closeTime: "22:00" },
  { day: "Miércoles", open: true, openTime: "09:00", closeTime: "22:00" },
  { day: "Jueves", open: true, openTime: "09:00", closeTime: "22:00" },
  { day: "Viernes", open: true, openTime: "09:00", closeTime: "22:00" },
  { day: "Sábado", open: true, openTime: "09:00", closeTime: "22:00" },
  { day: "Domingo", open: false, openTime: "09:00", closeTime: "22:00" },
];

const DEFAULT_CONFIG: AgentConfigFormData = {
  systemPrompt: "",
  phoneNumber: "",
  enabled: false,
  businessHours: DEFAULT_BUSINESS_HOURS,
  ycloudApiKeySet: false,
  whatsappBotNumber: "",
  allowedPhoneIds: [],
  sellerPhoneIds: [],
  autoReply24h: false,
  autoReply24hMessage: "",
  webOrderRedirectEnabled: false,
  webOrderRedirectMessage: "",
  trainBotContext: "",
  whatsappSystemPrompt: "",
  whatsappInstrucciones: "",
  whatsappZonasDelivery: [],
  isCooking: true,
  hamburguesasSinStock: false,
  stockPanDocenas: 0,
  aliasB2c: "",
  aliasB2b: "",
  tiempoEspera: "",
  menuImageUrlHamburguesas: "",
  menuImageUrlPan: "",
  deliveryPhoneNumber: "",
  deliveryEnabled: true,
  deliveryStartHour: "14:00",
  productionHours: "",
  businessName: "",
  businessTagline: "",
  businessAddress: "",
  businessPhoneDisplay: "",
  instagramHandle: "",
  businessWebsite: "",
  businessDescription: "",
  aiApiKeySet: false,
  aiBaseUrl: "",
  aiModel: "",
  aiModelFast: "",
  aiModelVision: "",
  ycloudWebhookSecretSet: false,
  cloudinaryCloudName: "",
  cloudinaryApiKey: "",
  cloudinaryApiSecretSet: false,
  metaAppId: "",
  metaAppSecretSet: false,
  metaWebhookVerifyTokenSet: false,
  telegramNotifyChatId: "",
  cronSecretSet: false,
  escalationEmail: "",
};

function rowToFormData(row: Record<string, unknown> | undefined): AgentConfigFormData {
  return row
    ? {
        systemPrompt: (row.systemPrompt as string) ?? "",
        phoneNumber: (row.phoneNumber as string) ?? "",
        enabled: (row.enabled as boolean) ?? false,
        businessHours:
          Array.isArray(row.businessHours) && (row.businessHours as unknown[]).length > 0
            ? (row.businessHours as BusinessHour[])
            : DEFAULT_BUSINESS_HOURS,
        // Secret never reaches the client — only whether one exists.
        ycloudApiKeySet: Boolean(row.ycloudApiKey),
        whatsappBotNumber: (row.whatsappBotNumber as string) ?? "",
        allowedPhoneIds: Array.isArray(row.allowedPhoneIds)
          ? (row.allowedPhoneIds as { name: string; phone: string }[])
          : [],
        sellerPhoneIds: Array.isArray(row.sellerPhoneIds)
          ? (row.sellerPhoneIds as { name: string; phone: string }[])
          : [],
        autoReply24h: (row.autoReply24h as boolean) ?? false,
        autoReply24hMessage: (row.autoReply24hMessage as string) ?? "",
        webOrderRedirectEnabled: (row.webOrderRedirectEnabled as boolean) ?? false,
        webOrderRedirectMessage: (row.webOrderRedirectMessage as string) ?? "",
        trainBotContext: (row.trainBotContext as string) ?? "",
        whatsappSystemPrompt: (row.whatsappSystemPrompt as string) ?? "",
        whatsappInstrucciones: (row.whatsappInstrucciones as string) ?? "",
        whatsappZonasDelivery: Array.isArray(row.whatsappZonasDelivery)
          ? (row.whatsappZonasDelivery as { zona: string; disponible: boolean; tiempo: string; costo: number }[])
          : [],
        isCooking: (row.isCooking as boolean) ?? true,
        hamburguesasSinStock: (row.hamburguesasSinStock as boolean) ?? false,
        stockPanDocenas: (row.stockPanDocenas as number) ?? 0,
        aliasB2c: (row.aliasB2c as string) ?? "",
        aliasB2b: (row.aliasB2b as string) ?? "",
        tiempoEspera: (row.tiempoEspera as string) ?? "",
        menuImageUrlHamburguesas: (row.menuImageUrlHamburguesas as string) ?? "",
        menuImageUrlPan: (row.menuImageUrlPan as string) ?? "",
        deliveryPhoneNumber: (row.deliveryPhoneNumber as string) ?? "",
        deliveryEnabled: (row.deliveryEnabled as boolean) ?? true,
        deliveryStartHour: (row.deliveryStartHour as string) ?? "14:00",
        productionHours: (row.productionHours as string) ?? "",
        businessName: (row.businessName as string) ?? "",
        businessTagline: (row.businessTagline as string) ?? "",
        businessAddress: (row.businessAddress as string) ?? "",
        businessPhoneDisplay: (row.businessPhoneDisplay as string) ?? "",
        instagramHandle: (row.instagramHandle as string) ?? "",
        businessWebsite: (row.businessWebsite as string) ?? "",
        businessDescription: (row.businessDescription as string) ?? "",
        // Secret fields never reach the client — only whether one exists.
        aiApiKeySet: Boolean(row.aiApiKey),
        aiBaseUrl: (row.aiBaseUrl as string) ?? "",
        aiModel: (row.aiModel as string) ?? "",
        aiModelFast: (row.aiModelFast as string) ?? "",
        aiModelVision: (row.aiModelVision as string) ?? "",
        // Integration secrets — only the "is it configured?" flag leaves the server.
        ycloudWebhookSecretSet: Boolean(row.ycloudWebhookSecret),
        cloudinaryCloudName: (row.cloudinaryCloudName as string) ?? "",
        cloudinaryApiKey: (row.cloudinaryApiKey as string) ?? "",
        cloudinaryApiSecretSet: Boolean(row.cloudinaryApiSecret),
        metaAppId: (row.metaAppId as string) ?? "",
        metaAppSecretSet: Boolean(row.metaAppSecret),
        metaWebhookVerifyTokenSet: Boolean(row.metaWebhookVerifyToken),
        telegramNotifyChatId: (row.telegramNotifyChatId as string) ?? "",
        cronSecretSet: Boolean(row.cronSecret),
        escalationEmail: (row.escalationEmail as string) ?? "",
      }
    : DEFAULT_CONFIG;
}

interface AgentPageProps {
  searchParams: Promise<{ scope?: string }>;
}

export default async function AgentPage({ searchParams }: AgentPageProps) {
  const params = await searchParams;
  // Unknown/missing scope keys resolve to the global row — pre-S13 behavior.
  const scope = parseScopeKey(params.scope) ?? {};
  const scopeKey = scopeKeyOf(scope);

  // Exact-scope load only: editing "channel:X" must show that row or blank
  // defaults, never the resolved (global-fallback) row — otherwise saving
  // would write global values into the scoped row.
  const [row, scopeOptions] = await Promise.all([
    findAgentConfigForScope(scope),
    listAgentConfigScopes(),
  ]);

  const config = rowToFormData(row as Record<string, unknown> | undefined);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-gold-gradient">
          Agente de WhatsApp
        </h1>
        <p className="text-sm text-muted-foreground">
          Configurá el comportamiento del agente de IA — credenciales, prompt, IDs permitidos y más
        </p>
      </div>
      {/* key remounts the form on scope switch AND after a copy (updatedAt
          bumps), so uncontrolled inputs always reflect the loaded row. */}
      <AgentConfigForm
        key={`${scopeKey}:${row?.updatedAt ? new Date(row.updatedAt).getTime() : "empty"}`}
        config={config}
        scopeKey={scopeKey}
        scopeOptions={scopeOptions}
        scopeExists={Boolean(row)}
      />
    </div>
  );
}
