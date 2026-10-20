import { db } from "@/db";
import { agentConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import { decryptIfEncrypted } from "@/lib/encryption";

/**
 * Integration credentials — DB (agent_config id=1) first, env fallback.
 * Lets every deployment manage YCloud/Cloudinary/Meta/Telegram/cron secrets
 * from /admin/agent without touching env vars or redeploying.
 * Server-only — never import this from client components.
 */
export interface IntegrationSecrets {
  ycloudWebhookSecret: string;
  cloudinaryCloudName: string;
  cloudinaryApiKey: string;
  cloudinaryApiSecret: string;
  metaAppId: string;
  metaAppSecret: string;
  metaWebhookVerifyToken: string;
  telegramNotifyChatId: string;
  cronSecret: string;
  escalationEmail: string;
}

let cached: { at: number; value: IntegrationSecrets } | null = null;
const CACHE_TTL_MS = 30_000;

const fromEnv = (): IntegrationSecrets => ({
  ycloudWebhookSecret: process.env.YCLOUD_WEBHOOK_SECRET ?? "",
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME ?? "",
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY ?? "",
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET ?? "",
  metaAppId: process.env.META_APP_ID ?? "",
  metaAppSecret: process.env.META_APP_SECRET ?? "",
  metaWebhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ?? "",
  telegramNotifyChatId: process.env.TELEGRAM_LICHAS_CHAT_ID ?? "",
  cronSecret: process.env.CRON_SECRET ?? "",
  escalationEmail: process.env.ESCALATION_EMAIL ?? "",
});

export async function getIntegrationSecrets(): Promise<IntegrationSecrets> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  try {
    const [cfg] = await db
      .select({
        ycloudWebhookSecret: agentConfig.ycloudWebhookSecret,
        cloudinaryCloudName: agentConfig.cloudinaryCloudName,
        cloudinaryApiKey: agentConfig.cloudinaryApiKey,
        cloudinaryApiSecret: agentConfig.cloudinaryApiSecret,
        metaAppId: agentConfig.metaAppId,
        metaAppSecret: agentConfig.metaAppSecret,
        metaWebhookVerifyToken: agentConfig.metaWebhookVerifyToken,
        telegramNotifyChatId: agentConfig.telegramNotifyChatId,
        cronSecret: agentConfig.cronSecret,
        escalationEmail: agentConfig.escalationEmail,
      })
      .from(agentConfig)
      .where(eq(agentConfig.id, 1))
      .limit(1);

    const env = fromEnv();
    // Secrets are stored AES-256-GCM encrypted; decryptIfEncrypted is tolerant
    // to legacy plaintext rows (they re-encrypt on the next admin save).
    const pick = (dbVal: string | null | undefined, envVal: string) =>
      decryptIfEncrypted(dbVal?.trim() || "") || envVal;

    const value: IntegrationSecrets = cfg
      ? {
          ycloudWebhookSecret: pick(cfg.ycloudWebhookSecret, env.ycloudWebhookSecret),
          cloudinaryCloudName: pick(cfg.cloudinaryCloudName, env.cloudinaryCloudName),
          cloudinaryApiKey: pick(cfg.cloudinaryApiKey, env.cloudinaryApiKey),
          cloudinaryApiSecret: pick(cfg.cloudinaryApiSecret, env.cloudinaryApiSecret),
          metaAppId: pick(cfg.metaAppId, env.metaAppId),
          metaAppSecret: pick(cfg.metaAppSecret, env.metaAppSecret),
          metaWebhookVerifyToken: pick(cfg.metaWebhookVerifyToken, env.metaWebhookVerifyToken),
          telegramNotifyChatId: pick(cfg.telegramNotifyChatId, env.telegramNotifyChatId),
          cronSecret: pick(cfg.cronSecret, env.cronSecret),
          escalationEmail: pick(cfg.escalationEmail, env.escalationEmail),
        }
      : env;
    cached = { at: Date.now(), value };
    return value;
  } catch {
    // Columns may not exist on older deployments — env is the fallback.
    return fromEnv();
  }
}

/**
 * F15: rotated secrets (ycloudWebhookSecret, metaAppSecret, cronSecret, ...)
 * must take effect immediately — every admin write path that can change them
 * calls this after saving so the 30s TTL cannot keep a revoked value valid.
 */
export function invalidateIntegrationSecretsCache(): void {
  cached = null;
}

/**
 * YCloud API key — stored encrypted in agent_config (admin UI), env fallback.
 * Centralizes what used to be `process.env.YCLOUD_API_KEY || cfg?.ycloudApiKey`
 * scattered across ~10 call sites.
 */
export async function getYCloudApiKey(): Promise<string> {
  try {
    const [cfg] = await db
      .select({ ycloudApiKey: agentConfig.ycloudApiKey })
      .from(agentConfig)
      .where(eq(agentConfig.id, 1))
      .limit(1);
    return decryptIfEncrypted(cfg?.ycloudApiKey?.trim() || "") || process.env.YCLOUD_API_KEY || "";
  } catch {
    return process.env.YCLOUD_API_KEY || "";
  }
}
