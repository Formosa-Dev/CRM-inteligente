/**
 * Runtime AI provider configuration — DB first, env fallback.
 *
 * agent_config.ai_* columns let each deployment point at any
 * OpenAI-compatible provider (OpenAI, OpenRouter, DeepSeek, Groq, Together,
 * Ollama...) from the admin UI without touching env vars or redeploying.
 * Env vars still work as the bootstrap path.
 */

import { createOpenAI, openai as defaultOpenai } from "@ai-sdk/openai";
import type { OpenAIProvider } from "@ai-sdk/openai";
import { db } from "@/db";
import { agentConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import { decryptIfEncrypted } from "@/lib/encryption";
import {
  currentAgentConfigScope,
  resolveAgentConfigId,
  scopeKeyOf,
} from "@/lib/agent-config-scope";
import { AI_BASE_URL, AI_MODEL, AI_MODEL_FAST, AI_MODEL_VISION } from "./models";

export interface AIConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  modelFast: string;
  modelVision: string;
}

const ENV_CONFIG: AIConfig = {
  apiKey: process.env.OPENAI_API_KEY ?? "",
  baseUrl: AI_BASE_URL,
  model: AI_MODEL,
  modelFast: AI_MODEL_FAST,
  modelVision: AI_MODEL_VISION,
};

// Short-lived per-scope cache — saves a DB hit per inbound message while
// still picking up admin edits within ~30s. Keyed by agent_config scope so a
// channel/account-scoped run doesn't bleed into another scope's provider.
const cached = new Map<string, { at: number; value: AIConfig }>();
const CACHE_TTL_MS = 30_000;

/** Applies an admin provider change to the next inbound agent request. */
export function invalidateAIConfigCache(): void {
  cached.clear();
}

export async function getAIConfig(): Promise<AIConfig> {
  const scope = currentAgentConfigScope();
  const cacheKey = scopeKeyOf(scope);
  const hit = cached.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  try {
    const [cfg] = await db
      .select({
        aiApiKey: agentConfig.aiApiKey,
        aiBaseUrl: agentConfig.aiBaseUrl,
        aiModel: agentConfig.aiModel,
        aiModelFast: agentConfig.aiModelFast,
        aiModelVision: agentConfig.aiModelVision,
      })
      .from(agentConfig)
      .where(eq(agentConfig.id, await resolveAgentConfigId(scope)))
      .limit(1);
    const value: AIConfig = {
      // Stored AES-256-GCM encrypted; tolerant of legacy plaintext rows.
      apiKey: decryptIfEncrypted(cfg?.aiApiKey?.trim() || "") || ENV_CONFIG.apiKey,
      baseUrl: (cfg?.aiBaseUrl?.trim() || ENV_CONFIG.baseUrl).replace(/\/+$/, ""),
      model: cfg?.aiModel?.trim() || ENV_CONFIG.model,
      modelFast: cfg?.aiModelFast?.trim() || ENV_CONFIG.modelFast,
      modelVision: cfg?.aiModelVision?.trim() || ENV_CONFIG.modelVision,
    };
    cached.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch {
    // Columns may not exist on older deployments — env is the fallback.
    return ENV_CONFIG;
  }
}

/**
 * DeepSeek models default to "thinking" mode, which rejects
 * tool_choice:"required" with HTTP 400 and requires reasoning_content to be
 * passed back on tool-carrying turns (the AI SDK does not resend it → 400).
 * Disable thinking at the transport layer so the OpenAI-compatible path works.
 */
const deepseekNonThinkingFetch: typeof fetch = (input, init) => {
  if (init?.body && typeof init.body === "string") {
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      const url = String(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.includes("/responses")) {
        body.reasoning = { effort: "none" };
      } else {
        body.thinking = { type: "disabled" };
      }
      init = { ...init, body: JSON.stringify(body) };
    } catch {
      // non-JSON body — pass through untouched
    }
  }
  return fetch(input, init);
};

/** True when the configured base URL points at a DeepSeek API host. */
export function isDeepSeekBaseUrl(baseUrl: string): boolean {
  return baseUrl.includes("deepseek.com");
}

/** True when the configured base URL points at OpenAI's own API host. */
export function isOpenAIBaseUrl(baseUrl: string): boolean {
  return baseUrl.includes("api.openai.com");
}

/**
 * Returns an OpenAI-compatible provider bound to the resolved credentials.
 * Falls back to the default env-driven provider when the DB has no key.
 */
export async function getAIProvider(): Promise<OpenAIProvider> {
  const cfg = await getAIConfig();
  if (!cfg.apiKey) return defaultOpenai; // lets the SDK surface its own missing-key error
  return createOpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
    fetch: isDeepSeekBaseUrl(cfg.baseUrl) ? deepseekNonThinkingFetch : undefined,
  });
}

/** Main conversational model (WhatsApp sales agent). */
export async function getMainModel() {
  const [provider, cfg] = await Promise.all([getAIProvider(), getAIConfig()]);
  return provider(cfg.model);
}

/** Main model via Chat Completions API (WhatsApp agent uses openai.chat()). */
export async function getMainChatModel() {
  const [provider, cfg] = await Promise.all([getAIProvider(), getAIConfig()]);
  return provider.chat(cfg.model);
}

/** Fast/cheap model for internal agent + Telegram. */
export async function getFastModel() {
  const [provider, cfg] = await Promise.all([getAIProvider(), getAIConfig()]);
  return provider.chat(cfg.modelFast);
}
