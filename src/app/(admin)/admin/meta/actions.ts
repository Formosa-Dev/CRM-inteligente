"use server";

import { auth } from "@/auth";
import { requireAdmin } from "@/lib/auth/require-admin";
import { cookies } from "next/headers";
import { randomBytes } from "crypto";
import { getMetaConfig, getMetaAccessToken } from "@/lib/meta/config";
import { META_OAUTH_STATE_COOKIE } from "@/lib/meta/oauth";
import { db } from "@/db";
import { agentConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import { reportInternalError } from "@/lib/errors";
import { invalidateIntegrationSecretsCache } from "@/lib/integrations";

export type MetaConfigState = {
  success: boolean;
  message: string;
};

export type MetaConnectionStatus = {
  pixelConfigured: boolean;
  serverConfigured: boolean;
  pixelId: string | null;
  appId: string | null;
};

export type WebhookConfig = {
  webhookUrl: string;
  hasWebhookSecret: boolean;
  hasApiKey: boolean;
  hasPhoneNumber: boolean;
  phoneNumber: string | null;
};

/**
 * Genera el nonce CSRF para el flujo OAuth de Meta.
 * Lo persiste en una cookie httpOnly firmada por el servidor para que el
 * callback pueda verificar que la redirección corresponde a ESTA sesión.
 */
export async function generateMetaOAuthState(): Promise<{ state: string; authUrl: string } | null> {
  if (!(await requireAdmin())) return null;

  const state = randomBytes(24).toString("hex");
  const cookieStore = await cookies();
  cookieStore.set(META_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/meta",
    maxAge: 600, // 10 min — el flujo OAuth completo tarda mucho menos
  });

  const host =
    process.env.AUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.RENDER_EXTERNAL_URL
      ? `https://${process.env.RENDER_EXTERNAL_URL.replace(/^https?:\/\//, "")}`
      : null);
  if (!host) return null;

  const { buildMetaOAuthUrl } = await import("@/lib/meta/oauth");
  const authUrl = await buildMetaOAuthUrl(`${host}/api/meta/callback`, state);
  return { state, authUrl };
}

/**
 * Obtiene el estado actual de la conexión Meta
 */
export async function getMetaStatus(): Promise<MetaConnectionStatus> {
  const session = await auth();
  if (!session) {
    return {
      pixelConfigured: false,
      serverConfigured: false,
      pixelId: null,
      appId: null,
    };
  }

  const cfg = await getMetaConfig();
  return {
    pixelConfigured: cfg.hasPixel,
    serverConfigured: cfg.hasServerConfig,
    pixelId: cfg.pixelId ?? null,
    appId: cfg.appId ?? null,
  };
}

/**
 * Obtiene la configuración del webhook WhatsApp (YCloud)
 * para mostrar en el admin y copiar a YCloud dashboard
 */
export async function getWebhookConfig(): Promise<WebhookConfig> {
  const session = await auth();
  if (!session) {
    return {
      webhookUrl: "",
      hasWebhookSecret: false,
      hasApiKey: false,
      hasPhoneNumber: false,
      phoneNumber: null,
    };
  }

  // Secrets can come from the admin UI (DB) or env — DB wins.
  const { getIntegrationSecrets } = await import("@/lib/integrations");
  const secrets = await getIntegrationSecrets();
  const cfgRows = await db
    .select({ ycloudApiKey: agentConfig.ycloudApiKey, phoneNumber: agentConfig.phoneNumber })
    .from(agentConfig)
    .where(eq(agentConfig.id, 1))
    .limit(1);
  const secret = secrets.ycloudWebhookSecret;
  const { decryptIfEncrypted } = await import("@/lib/encryption");
  const apiKey = decryptIfEncrypted(cfgRows[0]?.ycloudApiKey) || process.env.YCLOUD_API_KEY;
  const phone = cfgRows[0]?.phoneNumber || process.env.WHATSAPP_PHONE_NUMBER;

  // Detectar la URL base desde el entorno — sin fallback hardcodeado.
  const host =
    process.env.AUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.RENDER_EXTERNAL_URL
      ? `https://${process.env.RENDER_EXTERNAL_URL.replace(/^https?:\/\//, "")}`
      : "");

  return {
    webhookUrl: `${host}/api/whatsapp/webhook`,
    hasWebhookSecret: !!(secret && secret !== "tu-webhook-secret-de-ycloud"),
    hasApiKey: !!(apiKey && apiKey !== "tu-api-key-de-ycloud"),
    hasPhoneNumber: !!(phone && phone !== "5491112345678"),
    phoneNumber: phone && phone !== "5491112345678" ? phone : null,
  };
}

/**
 * Testea la conexión con Meta Conversion API
 */
export async function testMetaConnection(): Promise<MetaConfigState> {
  if (!(await requireAdmin())) {
    return { success: false, message: "No autorizado" };
  }

  const cfg = await getMetaConfig();

  if (!cfg.hasServerConfig) {
    return {
      success: false,
      message:
        "Meta no está configurado. Agregá META_APP_ID y META_APP_SECRET en las variables de entorno de Render.",
    };
  }

  if (!cfg.hasPixel) {
    return {
      success: false,
      message:
        "Meta Pixel no está configurado. Agregá NEXT_PUBLIC_META_PIXEL_ID en las variables de entorno de Render.",
    };
  }

  try {
    // Probar la conexión haciendo un request a la Graph API de Meta
    const token = await getMetaAccessToken();
    const res = await fetch(
      `https://graph.facebook.com/v22.0/${cfg.appId}/ads?access_token=${token}&limit=1`,
      { method: "GET", signal: AbortSignal.timeout(10000) }
    );

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const ref = reportInternalError("meta.testConnection", body?.error ?? res.statusText);
      return {
        success: false,
        message: `Error de conexión con Meta (ref: ${ref})`,
      };
    }

    return {
      success: true,
      message:
        "Conexión exitosa con Meta. App ID y Pixel ID verificados correctamente.",
    };
  } catch (err) {
    // F13: internals stay in the server log under a correlation id.
    const ref = reportInternalError("meta.testConnection", err);
    return {
      success: false,
      message: `Error al conectar con Meta (ref: ${ref})`,
    };
  }
}

export async function disconnectMeta(): Promise<{ success: boolean; error?: string }> {
  if (!(await requireAdmin())) return { success: false, error: "No autorizado"  };
  try {
    await db
      .update(agentConfig)
      .set({
        metaAccessToken: null,
        metaTokenExpiresAt: null,
        metaBusinessName: null,
        metaPhoneNumberId: null,
        metaConnected: false,
        updatedAt: new Date(),
      })
      .where(eq(agentConfig.id, 1));

    // Secret write path — drop cached secrets so nothing stale is accepted.
    invalidateIntegrationSecretsCache();
    return { success: true };
  } catch (error) {
    console.error("[disconnectMeta] Error:", error);
    return { success: false, error: "Error al desconectar" };
  }
}

export async function getMetaConnectionStatus(): Promise<{
  connected: boolean;
  businessName: string | null;
  expiresAt: Date | null;
}> {
  const session = await auth();
  if (!session) return { connected: false, businessName: null, expiresAt: null };
  const rows = await db
    .select({
      metaConnected: agentConfig.metaConnected,
      metaBusinessName: agentConfig.metaBusinessName,
      metaTokenExpiresAt: agentConfig.metaTokenExpiresAt,
    })
    .from(agentConfig)
    .limit(1);

  const config = rows[0];
  return {
    connected: config?.metaConnected ?? false,
    businessName: config?.metaBusinessName ?? null,
    expiresAt: config?.metaTokenExpiresAt ?? null,
  };
}
