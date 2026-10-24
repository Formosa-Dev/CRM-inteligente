/**
 * resolveAIConfigFields — the pure precedence chain behind getAIConfig.
 * Row fields beat env; env falls back provider-specific → generic → OPENAI_*;
 * the catalog supplies the base URL (and its chat variant) last.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encrypt } from "@/lib/encryption";
import { providerEnv, resolveAIConfigFields } from "@/lib/ai/config";

// encrypt()/decryptIfEncrypted() read AUTH_SECRET at call time.
process.env.AUTH_SECRET ??= "test-secret-for-config-resolution";

describe("resolveAIConfigFields", () => {
  it("env-only bootstrap: no row resolves OPENAI_* and model defaults", () => {
    const cfg = resolveAIConfigFields(null, {
      OPENAI_API_KEY: "sk-env",
      OPENAI_BASE_URL: "https://openai-proxy.example.com/v1",
    });
    assert.equal(cfg.provider, "");
    assert.equal(cfg.apiKey, "sk-env");
    assert.equal(cfg.baseUrl, "https://openai-proxy.example.com/v1");
    assert.equal(cfg.model, "gpt-5.4-mini");
    assert.equal(cfg.modelFast, "gpt-5-mini");
    assert.equal(cfg.modelVision, "gpt-4o");
  });

  it("hardcoded default base URL when nothing is configured", () => {
    const cfg = resolveAIConfigFields(null, {});
    assert.equal(cfg.baseUrl, "https://api.openai.com/v1");
  });

  it("row fields win over env for every field", () => {
    const cfg = resolveAIConfigFields(
      {
        aiProvider: "deepseek",
        aiApiKey: "sk-row-plain",
        aiBaseUrl: "https://ds.example.com/v2",
        aiModel: "deepseek-chat",
      },
      {
        AGENT_AI_DEEPSEEK_API_KEY: "sk-env-p",
        OPENAI_API_KEY: "sk-env",
        AGENT_AI_DEEPSEEK_BASE_URL: "https://env-p.example.com",
        OPENAI_BASE_URL: "https://env.example.com",
      },
    );
    assert.equal(cfg.provider, "deepseek");
    assert.equal(cfg.apiKey, "sk-row-plain");
    assert.equal(cfg.baseUrl, "https://ds.example.com/v2");
    assert.equal(cfg.model, "deepseek-chat");
  });

  it("decrypts an AES-GCM stored key and tolerates legacy plaintext", () => {
    const stored = encrypt("sk-live-secret");
    const enc = resolveAIConfigFields({ aiApiKey: stored }, {});
    assert.equal(enc.apiKey, "sk-live-secret");
    const plain = resolveAIConfigFields({ aiApiKey: "sk-legacy" }, {});
    assert.equal(plain.apiKey, "sk-legacy");
  });

  it("key chain: row → AGENT_AI_<PROVIDER>_API_KEY → AGENT_AI_API_KEY → OPENAI_API_KEY", () => {
    const env: Record<string, string> = {
      AGENT_AI_DEEPSEEK_API_KEY: "sk-p",
      AGENT_AI_API_KEY: "sk-generic",
      OPENAI_API_KEY: "sk-openai",
    };
    assert.equal(
      resolveAIConfigFields({ aiProvider: "deepseek" }, env).apiKey,
      "sk-p",
    );
    delete env.AGENT_AI_DEEPSEEK_API_KEY;
    assert.equal(
      resolveAIConfigFields({ aiProvider: "deepseek" }, env).apiKey,
      "sk-generic",
    );
    delete env.AGENT_AI_API_KEY;
    assert.equal(
      resolveAIConfigFields({ aiProvider: "deepseek" }, env).apiKey,
      "sk-openai",
    );
    // Provider-specific vars are skipped when no provider is set.
    assert.equal(
      resolveAIConfigFields(null, {
        AGENT_AI_DEEPSEEK_API_KEY: "sk-p",
        OPENAI_API_KEY: "sk-openai",
      }).apiKey,
      "sk-openai",
    );
  });

  it("base URL chain: row → AGENT_AI_<P>_BASE_URL → AGENT_AI_BASE_URL → OPENAI_BASE_URL → catalog default", () => {
    const env: Record<string, string> = {
      AGENT_AI_GROQ_BASE_URL: "https://groq-env.example.com",
      AGENT_AI_BASE_URL: "https://generic.example.com",
      OPENAI_BASE_URL: "https://openai-env.example.com",
    };
    assert.equal(
      resolveAIConfigFields({ aiProvider: "groq" }, env).baseUrl,
      "https://groq-env.example.com",
    );
    delete env.AGENT_AI_GROQ_BASE_URL;
    assert.equal(
      resolveAIConfigFields({ aiProvider: "groq" }, env).baseUrl,
      "https://generic.example.com",
    );
    delete env.AGENT_AI_BASE_URL;
    // Explicit env beats the catalog default — documented chain order.
    assert.equal(
      resolveAIConfigFields({ aiProvider: "groq" }, env).baseUrl,
      "https://openai-env.example.com",
    );
    delete env.OPENAI_BASE_URL;
    assert.equal(
      resolveAIConfigFields({ aiProvider: "groq" }, env).baseUrl,
      "https://api.groq.com/openai/v1",
    );
  });

  it("google: catalog default base resolves to the OpenAI-compat chat base", () => {
    const cfg = resolveAIConfigFields(
      { aiProvider: "google", aiBaseUrl: "https://generativelanguage.googleapis.com" },
      {},
    );
    assert.equal(
      cfg.baseUrl,
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
    // A manual override URL is passed verbatim.
    const manual = resolveAIConfigFields(
      { aiProvider: "google", aiBaseUrl: "https://proxy.example.com/v1" },
      {},
    );
    assert.equal(manual.baseUrl, "https://proxy.example.com/v1");
  });

  it("AI_PROVIDER env supplies the provider when the row leaves it empty", () => {
    const cfg = resolveAIConfigFields(null, {
      AI_PROVIDER: "xai",
      AGENT_AI_XAI_API_KEY: "sk-xai",
    });
    assert.equal(cfg.provider, "xai");
    assert.equal(cfg.apiKey, "sk-xai");
    assert.equal(cfg.baseUrl, "https://api.x.ai/v1");
  });

  it("custom provider ids still resolve provider-scoped env vars", () => {
    const cfg = resolveAIConfigFields(
      { aiProvider: "my-llm.local" },
      { AGENT_AI_MY_LLM_LOCAL_API_KEY: "sk-local", AGENT_AI_MY_LLM_LOCAL_BASE_URL: "http://localhost:8000/v1" },
    );
    assert.equal(cfg.apiKey, "sk-local");
    assert.equal(cfg.baseUrl, "http://localhost:8000/v1");
  });
});

describe("providerEnv", () => {
  it("normalizes the provider segment and trims values", () => {
    assert.equal(
      providerEnv({ AGENT_AI_DEEPSEEK_API_KEY: "  k  " }, "deepseek", "API_KEY"),
      "k",
    );
    assert.equal(
      providerEnv({ AGENT_AI_MY_LLM_LOCAL_API_KEY: "x" }, "my-llm.local", "API_KEY"),
      "x",
    );
    assert.equal(providerEnv({}, "deepseek", "API_KEY"), undefined);
  });
});
