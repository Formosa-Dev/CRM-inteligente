/**
 * Runtime AI provider configuration — DB first, env fallback.
 *
 * agent_config.ai_* columns let each deployment point at any
 * OpenAI-compatible provider (OpenAI, OpenRouter, DeepSeek, Groq, Together,
 * Ollama...) from the admin UI without touching env vars or redeploying.
 * Env vars still work as the bootstrap path.
 *
 * Resolution chain per field (see `resolveAIConfigFields`):
 *   provider: row.ai_provider → AI_PROVIDER
 *   apiKey:   row.ai_api_key (AES-GCM) → AGENT_AI_<PROVIDER>_API_KEY →
 *             AGENT_AI_API_KEY → OPENAI_API_KEY
 *   baseUrl:  row.ai_base_url → AGENT_AI_<PROVIDER>_BASE_URL →
 *             AGENT_AI_BASE_URL → OPENAI_BASE_URL → catalog default
 * A catalog default base URL resolves through the entry's `chatBaseUrl` when
 * the vendor's chat surface differs from its models API (e.g. Google).
 */

import { createOpenAI, openai as defaultOpenai } from "@ai-sdk/openai";
import type { OpenAIProvider } from "@ai-sdk/openai";
import { decryptIfEncrypted } from "@/lib/encryption";
import {
  AgentConfigResolutionError,
  configCacheKey,
  currentAgentConfigScope,
  resolveAgentConfigStrict,
  shouldCacheResolution,
} from "@/lib/agent-config-scope";
import { runtimeBaseUrl } from "./providers-catalog";

export interface AIConfig {
  /** Catalog provider id (or a free-form custom id); "" = unset/legacy. */
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  modelFast: string;
  modelVision: string;
}

type EnvRecord = Record<string, string | undefined>;

const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** `AGENT_AI_<PROVIDER>_<SUFFIX>` — provider segment is normalized, not hardcoded. */
export function providerEnv(
  env: EnvRecord,
  provider: string,
  suffix: string
): string | undefined {
  const normalized = provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return clean(env[`AGENT_AI_${normalized}_${suffix}`]);
}

/** Row-shaped fields read by the resolver (a subset of agent_config). */
export interface AIConfigRowFields {
  aiProvider?: string | null;
  aiApiKey?: string | null;
  aiBaseUrl?: string | null;
  aiModel?: string | null;
  aiModelFast?: string | null;
  aiModelVision?: string | null;
}

/**
 * Pure resolver: DB row fields + env record → effective AI config. No I/O, so
 * the precedence chain is unit-checkable without a database. `row` may be a
 * scoped agent_config row or null (env-only bootstrap).
 */
export function resolveAIConfigFields(
  row: AIConfigRowFields | null | undefined,
  env: EnvRecord = process.env
): AIConfig {
  const provider = clean(row?.aiProvider) ?? clean(env.AI_PROVIDER) ?? "";

  // Stored AES-256-GCM encrypted; tolerant of legacy plaintext rows. A
  // decryption failure reads as missing and falls through to env.
  const apiKey =
    clean(decryptIfEncrypted(row?.aiApiKey)) ??
    (provider ? providerEnv(env, provider, "API_KEY") : undefined) ??
    clean(env.AGENT_AI_API_KEY) ??
    clean(env.OPENAI_API_KEY) ??
    "";

  const storedBaseUrl =
    clean(row?.aiBaseUrl) ??
    (provider ? providerEnv(env, provider, "BASE_URL") : undefined) ??
    clean(env.AGENT_AI_BASE_URL) ??
    clean(env.OPENAI_BASE_URL);

  return {
    provider,
    apiKey,
    baseUrl:
      runtimeBaseUrl(storedBaseUrl, provider) ?? OPENAI_DEFAULT_BASE_URL,
    model: clean(row?.aiModel) ?? clean(env.AI_MODEL) ?? "gpt-5.4-mini",
    modelFast: clean(row?.aiModelFast) ?? clean(env.AI_MODEL_FAST) ?? "gpt-5-mini",
    modelVision:
      clean(row?.aiModelVision) ?? clean(env.AI_MODEL_VISION) ?? "gpt-4o",
  };
}

const ENV_CONFIG: AIConfig = resolveAIConfigFields(null, process.env);

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
  const cacheKey = configCacheKey(scope);
  const hit = cached.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const resolution = await resolveAgentConfigStrict(scope);
  if (resolution.kind === "db-error") {
    // A transient DB failure must not silently switch provider credentials.
    throw new AgentConfigResolutionError(resolution);
  }

  if (resolution.kind !== "resolved") {
    // No row (or an un-migrated schema) is a bootstrap state, not a scoped
    // fallback: use env without polluting a scoped cache key.
    return ENV_CONFIG;
  }

  const value = resolveAIConfigFields(resolution.row, process.env);
  // Only an exact-scope result is cached under this key. Chained global
  // fallbacks stay uncached so they can never masquerade as account config.
  if (shouldCacheResolution(scope, resolution.source)) {
    cached.set(cacheKey, { at: Date.now(), value });
  }
  return value;
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
