"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { agentConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/require-admin";
import { encrypt } from "@/lib/encryption";
import { invalidateAIConfigCache } from "@/lib/ai/config";
import {
  findAgentConfigForScope,
  invalidateAgentConfigScopeCache,
  parseScopeKey,
  resolveAgentConfig,
  scopeColumnsForInsert,
  scopeKeyOf,
} from "@/lib/agent-config-scope";

// ─── Types ──────────────────────────────────────────────────────────────────────

export type PhoneIdEntry = {
  name: string;
  phone: string;
};

export type AgentConfigState = {
  success: boolean;
  message: string;
};

// ─── Schemas ────────────────────────────────────────────────────────────────────

const businessHourSchema = z.object({
  day: z.string(),
  open: z.boolean(),
  openTime: z.string().regex(/^\d{2}:\d{2}$/, "Formato HH:MM requerido"),
  closeTime: z.string().regex(/^\d{2}:\d{2}$/, "Formato HH:MM requerido"),
});

const phoneIdSchema = z.object({
  name: z.string().min(1, "El nombre es obligatorio"),
  phone: z.string().min(1, "El teléfono es obligatorio"),
});

const zonaDeliverySchema = z.object({
  zona: z.string(),
  disponible: z.boolean(),
  tiempo: z.string(),
  costo: z.number(),
});

const agentConfigSchema = z.object({
  systemPrompt: z.string().optional().default(""),
  phoneNumber: z.string().min(1, "El número de teléfono es obligatorio"),
  enabled: z.boolean(),
  businessHours: z.array(businessHourSchema),
  ycloudApiKey: z.string().optional(),
  whatsappBotNumber: z.string().optional(),
  allowedPhoneIds: z.array(phoneIdSchema),
  sellerPhoneIds: z.array(phoneIdSchema),
  autoReply24h: z.boolean(),
  autoReply24hMessage: z.string().optional(),
  webOrderRedirectEnabled: z.boolean(),
  webOrderRedirectMessage: z.string().max(1000).optional(),
  trainBotContext: z.string().optional(),
  whatsappSystemPrompt: z.string().optional(),
  whatsappInstrucciones: z.string().optional(),
  whatsappPromociones: z.string().optional(),
  whatsappZonasDelivery: z.array(zonaDeliverySchema).optional().default([]),
  isCooking: z.boolean(),
  hamburguesasSinStock: z.boolean(),
  stockPanDocenas: z.number().int().min(0).optional().default(0),
  aliasB2c: z.string().optional(),
  aliasB2b: z.string().optional(),
  tiempoEspera: z.string().optional(),
  menuImageUrlHamburguesas: z.string().optional(),
  menuImageUrlPan: z.string().optional(),
  deliveryPhoneNumber: z.string().optional(),
  deliveryEnabled: z.boolean().optional().default(true),
  deliveryStartHour: z.string().optional(),
  productionHours: z.string().optional(),
  // ─── Business identity ───────────────────────────────────────────────────
  businessName: z.string().max(160).optional(),
  businessTagline: z.string().max(255).optional(),
  businessAddress: z.string().max(255).optional(),
  businessPhoneDisplay: z.string().max(50).optional(),
  instagramHandle: z.string().max(100).optional(),
  businessWebsite: z.string().max(500).optional(),
  businessDescription: z.string().max(2000).optional(),
  // ─── AI provider — aiApiKey empty means "keep existing" ──────────────────
  aiApiKey: z.string().max(500).optional(),
  aiBaseUrl: z.string().max(500).optional(),
  aiModel: z.string().max(120).optional(),
  aiModelFast: z.string().max(120).optional(),
  aiModelVision: z.string().max(120).optional(),
  // ─── Integration secrets — empty means "keep existing", "CLEAR" wipes ──
  ycloudWebhookSecret: z.string().max(500).optional(),
  cloudinaryCloudName: z.string().max(120).optional(),
  cloudinaryApiKey: z.string().max(120).optional(),
  cloudinaryApiSecret: z.string().max(500).optional(),
  metaAppId: z.string().max(80).optional(),
  metaAppSecret: z.string().max(500).optional(),
  metaWebhookVerifyToken: z.string().max(200).optional(),
  telegramNotifyChatId: z.string().max(50).optional(),
  cronSecret: z.string().max(200).optional(),
  escalationEmail: z.string().email("Email inválido").max(200).optional().or(z.literal("")),
});

// ─── Actions ────────────────────────────────────────────────────────────────────

export async function saveAgentConfig(
  _prevState: AgentConfigState,
  formData: FormData
): Promise<AgentConfigState> {
  if (!(await requireAdmin())) {
    return { success: false, message: "No autorizado" };
  }

  // ─── Business hours ────────────────────────────────────────────────────────
  const rawBusinessHours: unknown[] = [];
  const days = [
    "Lunes",
    "Martes",
    "Miércoles",
    "Jueves",
    "Viernes",
    "Sábado",
    "Domingo",
  ];

  for (const day of days) {
    rawBusinessHours.push({
      day,
      open: formData.get(`businessHours.${day}.open`) === "true",
      openTime: formData.get(`businessHours.${day}.openTime`) ?? "09:00",
      closeTime: formData.get(`businessHours.${day}.closeTime`) ?? "22:00",
    });
  }

  // ─── Allowed phone IDs (JSON string from hidden input) ─────────────────────
  let allowedPhoneIds: PhoneIdEntry[] = [];
  try {
    const raw = formData.get("allowedPhoneIds");
    if (raw && typeof raw === "string") {
      allowedPhoneIds = JSON.parse(raw);
    }
  } catch {
    allowedPhoneIds = [];
  }

  // ─── Seller phone IDs (vendedores con acceso al sistema interno) ───────
  let sellerPhoneIds: PhoneIdEntry[] = [];
  try {
    const raw = formData.get("sellerPhoneIds");
    if (raw && typeof raw === "string") {
      sellerPhoneIds = JSON.parse(raw);
    }
  } catch {
    sellerPhoneIds = [];
  }

  // ─── WhatsApp zonas delivery (JSON string from hidden input) ─────────────
  let whatsappZonasDelivery: unknown[] = [];
  try {
    const rawZonas = formData.get("whatsappZonasDelivery");
    if (rawZonas && typeof rawZonas === "string") {
      whatsappZonasDelivery = JSON.parse(rawZonas);
    }
  } catch {
    whatsappZonasDelivery = [];
  }

  // Debug: log de los campos clave
  console.log("[agent-config] sellerPhoneIds raw:", formData.get("sellerPhoneIds"));
  console.log("[agent-config] allowedPhoneIds raw:", formData.get("allowedPhoneIds"));

  const raw = {
    systemPrompt: formData.get("systemPrompt") || "",
    phoneNumber: formData.get("phoneNumber"),
    enabled: formData.get("enabled") === "true",
    businessHours: rawBusinessHours,
    ycloudApiKey: formData.get("ycloudApiKey") || undefined,
    whatsappBotNumber: formData.get("whatsappBotNumber") || undefined,
    allowedPhoneIds,
    sellerPhoneIds,
    autoReply24h: formData.get("autoReply24h") === "true",
    autoReply24hMessage: formData.get("autoReply24hMessage") || undefined,
    webOrderRedirectEnabled: formData.get("webOrderRedirectEnabled") === "true",
    webOrderRedirectMessage: formData.get("webOrderRedirectMessage") || undefined,
    trainBotContext: formData.get("trainBotContext") || undefined,
    whatsappSystemPrompt: formData.get("whatsappSystemPrompt") || undefined,
    whatsappInstrucciones: formData.get("whatsappInstrucciones") || undefined,
    whatsappPromociones: formData.get("whatsappPromociones") || undefined,
    whatsappZonasDelivery,
    isCooking: formData.get("isCooking") === "true",
    hamburguesasSinStock: formData.get("hamburguesasSinStock") === "true",
    stockPanDocenas: Number(formData.get("stockPanDocenas")) || 0,
    aliasB2c: formData.get("aliasB2c") || undefined,
    aliasB2b: formData.get("aliasB2b") || undefined,
    tiempoEspera: formData.get("tiempoEspera") || undefined,
    menuImageUrlHamburguesas: formData.get("menuImageUrlHamburguesas") || undefined,
    menuImageUrlPan: formData.get("menuImageUrlPan") || undefined,
    deliveryPhoneNumber: formData.get("deliveryPhoneNumber") || undefined,
    deliveryEnabled: formData.get("deliveryEnabled") === "true",
    deliveryStartHour: formData.get("deliveryStartHour") || undefined,
    productionHours: formData.get("productionHours") || undefined,
    businessName: formData.get("businessName") || undefined,
    businessTagline: formData.get("businessTagline") || undefined,
    businessAddress: formData.get("businessAddress") || undefined,
    businessPhoneDisplay: formData.get("businessPhoneDisplay") || undefined,
    instagramHandle: (formData.get("instagramHandle") as string | null)?.replace(/^@/, "") || undefined,
    businessWebsite: formData.get("businessWebsite") || undefined,
    businessDescription: formData.get("businessDescription") || undefined,
    aiApiKey: formData.get("aiApiKey") || undefined,
    aiBaseUrl: formData.get("aiBaseUrl") || undefined,
    aiModel: formData.get("aiModel") || undefined,
    aiModelFast: formData.get("aiModelFast") || undefined,
    aiModelVision: formData.get("aiModelVision") || undefined,
    ycloudWebhookSecret: formData.get("ycloudWebhookSecret") || undefined,
    cloudinaryCloudName: formData.get("cloudinaryCloudName") || undefined,
    cloudinaryApiKey: formData.get("cloudinaryApiKey") || undefined,
    cloudinaryApiSecret: formData.get("cloudinaryApiSecret") || undefined,
    metaAppId: formData.get("metaAppId") || undefined,
    metaAppSecret: formData.get("metaAppSecret") || undefined,
    metaWebhookVerifyToken: formData.get("metaWebhookVerifyToken") || undefined,
    telegramNotifyChatId: formData.get("telegramNotifyChatId") || undefined,
    cronSecret: formData.get("cronSecret") || undefined,
    escalationEmail: formData.get("escalationEmail") || undefined,
  };

  const parsed = agentConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const field = firstIssue?.path?.join(".") || "desconocido";
    const msg = firstIssue?.message || "Datos inválidos";
    console.error("[agent-config] Validation error:", JSON.stringify(parsed.error.issues));
    return { success: false, message: `Error en "${field}": ${msg}` };
  }

  // S13: the form posts the scope being edited; an unknown/missing key saves
  // to the global row (pre-S13 behavior).
  const scope =
    parseScopeKey(String(formData.get("agentConfigScope") ?? "global")) ?? {};

  try {
    // Exact-scope row only — never a broader scope's row, so an empty secret
    // field keeps THIS scope's stored value, not the global one.
    const existing = await findAgentConfigForScope(scope);

    const values = {
      systemPrompt: parsed.data.systemPrompt,
      phoneNumber: parsed.data.phoneNumber,
      enabled: parsed.data.enabled,
      businessHours: parsed.data.businessHours,
      // Secret write pattern: empty = keep stored key, "CLEAR" = wipe it.
      // New values are stored AES-256-GCM encrypted at rest.
      ycloudApiKey:
        parsed.data.ycloudApiKey === "CLEAR"
          ? null
          : parsed.data.ycloudApiKey
            ? encrypt(parsed.data.ycloudApiKey)
            : existing?.ycloudApiKey || null,
      whatsappBotNumber: parsed.data.whatsappBotNumber ?? null,
      allowedPhoneIds: parsed.data.allowedPhoneIds,
      sellerPhoneIds: parsed.data.sellerPhoneIds,
      autoReply24h: parsed.data.autoReply24h,
      autoReply24hMessage: parsed.data.autoReply24hMessage ?? null,
      webOrderRedirectEnabled: parsed.data.webOrderRedirectEnabled,
      webOrderRedirectMessage: parsed.data.webOrderRedirectMessage ?? null,
      trainBotContext: parsed.data.trainBotContext ?? null,
      whatsappSystemPrompt: parsed.data.whatsappSystemPrompt ?? null,
      whatsappInstructions: parsed.data.whatsappInstrucciones ?? null,
      whatsappPromociones: parsed.data.whatsappPromociones ?? null,
      whatsappZonasDelivery: parsed.data.whatsappZonasDelivery ?? null,
      isCooking: parsed.data.isCooking,
      hamburguesasSinStock: parsed.data.hamburguesasSinStock,
      stockPanDocenas: parsed.data.stockPanDocenas ?? 0,
      aliasB2c: parsed.data.aliasB2c ?? null,
      aliasB2b: parsed.data.aliasB2b ?? null,
      tiempoEspera: parsed.data.tiempoEspera ?? null,
      menuImageUrlHamburguesas: parsed.data.menuImageUrlHamburguesas ?? null,
      menuImageUrlPan: parsed.data.menuImageUrlPan ?? null,
      deliveryPhoneNumber: parsed.data.deliveryPhoneNumber ?? null,
      deliveryEnabled: parsed.data.deliveryEnabled ?? true,
      deliveryStartHour: parsed.data.deliveryStartHour ?? null,
      productionHours: parsed.data.productionHours ?? null,
      businessName: parsed.data.businessName ?? null,
      businessTagline: parsed.data.businessTagline ?? null,
      businessAddress: parsed.data.businessAddress ?? null,
      businessPhoneDisplay: parsed.data.businessPhoneDisplay ?? null,
      instagramHandle: parsed.data.instagramHandle ?? null,
      businessWebsite: parsed.data.businessWebsite ?? null,
      businessDescription: parsed.data.businessDescription ?? null,
      // Secret write pattern: an empty field keeps the stored key. To clear it
      // deliberately the admin sends the literal string "CLEAR".
      aiApiKey:
        parsed.data.aiApiKey === "CLEAR"
          ? null
          : parsed.data.aiApiKey
            ? encrypt(parsed.data.aiApiKey)
            : existing?.aiApiKey || null,
      aiBaseUrl: parsed.data.aiBaseUrl ?? null,
      aiModel: parsed.data.aiModel ?? null,
      aiModelFast: parsed.data.aiModelFast ?? null,
      aiModelVision: parsed.data.aiModelVision ?? null,
      // Integration secrets — encrypted at rest, write-only in the UI.
      ycloudWebhookSecret:
        parsed.data.ycloudWebhookSecret === "CLEAR"
          ? null
          : parsed.data.ycloudWebhookSecret
            ? encrypt(parsed.data.ycloudWebhookSecret)
            : existing?.ycloudWebhookSecret || null,
      cloudinaryCloudName: parsed.data.cloudinaryCloudName ?? null,
      cloudinaryApiKey: parsed.data.cloudinaryApiKey ?? null,
      cloudinaryApiSecret:
        parsed.data.cloudinaryApiSecret === "CLEAR"
          ? null
          : parsed.data.cloudinaryApiSecret
            ? encrypt(parsed.data.cloudinaryApiSecret)
            : existing?.cloudinaryApiSecret || null,
      metaAppId: parsed.data.metaAppId ?? null,
      metaAppSecret:
        parsed.data.metaAppSecret === "CLEAR"
          ? null
          : parsed.data.metaAppSecret
            ? encrypt(parsed.data.metaAppSecret)
            : existing?.metaAppSecret || null,
      metaWebhookVerifyToken:
        parsed.data.metaWebhookVerifyToken === "CLEAR"
          ? null
          : parsed.data.metaWebhookVerifyToken
            ? encrypt(parsed.data.metaWebhookVerifyToken)
            : existing?.metaWebhookVerifyToken || null,
      telegramNotifyChatId: parsed.data.telegramNotifyChatId ?? null,
      cronSecret:
        parsed.data.cronSecret === "CLEAR"
          ? null
          : parsed.data.cronSecret
            ? encrypt(parsed.data.cronSecret)
            : existing?.cronSecret || null,
      escalationEmail: parsed.data.escalationEmail ?? null,
      updatedAt: new Date(),
    };

    if (existing) {
      await db
        .update(agentConfig)
        .set(values)
        .where(eq(agentConfig.id, existing.id));
    } else {
      // Create-on-save: selecting a scope never inserts; the first save does.
      // The partial uniques guard races — a concurrent insert surfaces as an
      // error to the form rather than a silent overwrite.
      const scopeCols = await scopeColumnsForInsert(scope);
      await db.insert(agentConfig).values({
        ...(scopeKeyOf(scope) === "global" ? { id: 1 } : {}),
        ...values,
        ...scopeCols,
      });
    }

    invalidateAIConfigCache();
    invalidateAgentConfigScopeCache();
    revalidatePath("/admin/agent");
    return { success: true, message: "Configuración guardada" };
  } catch (e) {
    console.error("[agent-config] Error saving:", e);
    return { success: false, message: `Error al guardar: ${e instanceof Error ? e.message : "desconocido"}` };
  }
}

/**
 * Clones one scope's configuration into the current scope (create-on-save for
 * the target). Secret fields are copied VERBATIM: they are AES-256-GCM
 * ciphertext owned by this install, so the clone decrypts identically under
 * the same ENCRYPTION_KEY. Documented decision (S13): secrets are copyable
 * within the same install.
 */
export async function copyAgentConfig(
  fromScopeKey: string,
  toScopeKey: string
): Promise<AgentConfigState> {
  if (!(await requireAdmin())) {
    return { success: false, message: "No autorizado" };
  }
  const from = parseScopeKey(fromScopeKey);
  const to = parseScopeKey(toScopeKey);
  if (!from || !to) {
    return { success: false, message: "Ámbito inválido" };
  }
  if (scopeKeyOf(from) === scopeKeyOf(to)) {
    return { success: false, message: "El origen y el destino son el mismo ámbito" };
  }

  try {
    const source = await findAgentConfigForScope(from);
    if (!source) {
      return {
        success: false,
        message: "El ámbito origen no tiene configuración propia para copiar",
      };
    }

    const { id: _id, channel: _ch, channelAccountId: _acc, updatedAt: _u, ...data } = source;

    const target = await findAgentConfigForScope(to);
    if (target) {
      await db
        .update(agentConfig)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(agentConfig.id, target.id));
    } else {
      const scopeCols = await scopeColumnsForInsert(to);
      await db.insert(agentConfig).values({
        ...(scopeKeyOf(to) === "global" ? { id: 1 } : {}),
        ...data,
        ...scopeCols,
      });
    }

    invalidateAIConfigCache();
    invalidateAgentConfigScopeCache();
    revalidatePath("/admin/agent");
    return { success: true, message: "Configuración copiada al ámbito actual" };
  } catch (e) {
    console.error("[agent-config] Error copying scope:", e);
    return {
      success: false,
      message: `Error al copiar: ${e instanceof Error ? e.message : "desconocido"}`,
    };
  }
}

export async function testAgentConnection(scopeKey?: string): Promise<{
  success: boolean;
  message: string;
}> {
  if (!(await requireAdmin())) {
    return { success: false, message: "No autorizado" };
  }

  try {
    // Effective row for the scope being viewed (account → channel → global).
    const scope = parseScopeKey(scopeKey ?? "global") ?? {};
    const cfg = await resolveAgentConfig(scope);
    if (!cfg) {
      return {
        success: false,
        message: "No hay configuración guardada. Guardá la configuración primero.",
      };
    }

    // Access columns dynamically to avoid TS errors with schema type mismatch
    const ycloudApiKey = (cfg as Record<string, unknown>).ycloudApiKey as string | null;
    const whatsappBotNumber = (cfg as Record<string, unknown>).whatsappBotNumber as string | null;
    const systemPrompt = (cfg as Record<string, unknown>).systemPrompt as string | null;
    const enabled = (cfg as Record<string, unknown>).enabled as boolean;

    const checks: string[] = [];
    if (ycloudApiKey) checks.push("✅ YCloud API Key configurada");
    else checks.push("❌ YCloud API Key no configurada");

    if (whatsappBotNumber) checks.push("✅ Número del bot configurado");
    else checks.push("❌ Número del bot no configurado");

    if (systemPrompt) checks.push("✅ Prompt del sistema configurado");
    else checks.push("❌ Prompt del sistema no configurado");

    checks.push(enabled ? "✅ Agente activo" : "⚠️ Agente desactivado");

    const allOk = checks.every((c) => c.startsWith("✅"));
    return {
      success: allOk,
      message: checks.join(" · "),
    };
  } catch (e) {
    return {
      success: false,
      message: `Error al leer configuración: ${e instanceof Error ? e.message : "desconocido"}`,
    };
  }
}
