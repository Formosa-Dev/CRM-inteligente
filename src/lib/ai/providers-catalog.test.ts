/**
 * fetchProviderModels checks — auth styles, response shapes (OpenAI data[] /
 * Google models[]) and the never-throw contract, all through a mocked fetch.
 * runtimeBaseUrl pins the catalog-default → chatBaseUrl mapping the runtime
 * relies on for providers whose chat surface differs from the models API.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fetchProviderModels,
  providerBaseUrl,
  runtimeBaseUrl,
} from "@/lib/ai/providers-catalog";

type FetchArgs = { url: string; init?: { headers?: Record<string, string> } };

function fakeFetch(
  calls: FetchArgs[],
  response: { status?: number; body?: unknown; throws?: boolean },
): typeof fetch {
  return (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as FetchArgs["init"] });
    if (response.throws) throw new Error("boom");
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response.body,
    } as Response;
  }) as typeof fetch;
}

describe("fetchProviderModels", () => {
  it("openai shape: bearer auth, parses data[].id, sorted unique", async () => {
    const calls: FetchArgs[] = [];
    const res = await fetchProviderModels(
      "openai",
      "https://api.openai.com/v1",
      "sk-test",
      fakeFetch(calls, { body: { data: [{ id: "b" }, { id: "a" }, { id: "a" }] } }),
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.models, ["a", "b"]);
    assert.equal(calls[0].url, "https://api.openai.com/v1/models");
    assert.equal(calls[0].init?.headers?.authorization, "Bearer sk-test");
  });

  it("google shape: ?key= auth, parses models[].name, filters non-generative", async () => {
    const calls: FetchArgs[] = [];
    const res = await fetchProviderModels(
      "google",
      undefined,
      "g-key",
      fakeFetch(calls, {
        body: {
          models: [
            { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
            { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
          ],
        },
      }),
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.models, ["gemini-2.5-pro"]);
    assert.equal(
      calls[0].url,
      "https://generativelanguage.googleapis.com/v1beta/models?key=g-key",
    );
  });

  it("anthropic uses x-api-key + anthropic-version headers", async () => {
    const calls: FetchArgs[] = [];
    await fetchProviderModels(
      "anthropic",
      undefined,
      "ak",
      fakeFetch(calls, { body: { data: [{ id: "claude-x" }] } }),
    );
    assert.equal(calls[0].init?.headers?.["x-api-key"], "ak");
    assert.equal(calls[0].init?.headers?.["anthropic-version"], "2023-06-01");
    assert.equal(calls[0].url, "https://api.anthropic.com/v1/models");
  });

  it("strips a trailing /chat/completions from the base", async () => {
    const calls: FetchArgs[] = [];
    await fetchProviderModels(
      "deepseek",
      "https://api.deepseek.com/chat/completions",
      "k",
      fakeFetch(calls, { body: { data: [] } }),
    );
    assert.equal(calls[0].url, "https://api.deepseek.com/models");
  });

  it("non-2xx and network errors return ok:false, never throw", async () => {
    const calls: FetchArgs[] = [];
    const denied = await fetchProviderModels(
      "openai",
      undefined,
      "bad",
      fakeFetch(calls, { status: 401, body: { error: { message: "nope" } } }),
    );
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.match(denied.error, /401/);

    const down = await fetchProviderModels("openai", undefined, "k", fakeFetch(calls, { throws: true }));
    assert.equal(down.ok, false);
  });

  it("unknown provider id falls back to a generic bearer /models probe", async () => {
    const calls: FetchArgs[] = [];
    const res = await fetchProviderModels(
      "ollama",
      "http://localhost:11434/v1",
      undefined,
      fakeFetch(calls, { body: { data: [{ id: "llama3" }] } }),
    );
    assert.equal(res.ok, true);
    assert.equal(calls[0].url, "http://localhost:11434/v1/models");
    assert.equal(calls[0].init?.headers?.authorization, undefined);
  });
});

describe("providerBaseUrl", () => {
  it("normalizes slashes and chat-completions suffixes", () => {
    assert.equal(providerBaseUrl("https://x.com/v1/"), "https://x.com/v1");
    assert.equal(providerBaseUrl("https://x.com/v1/chat/completions"), "https://x.com/v1");
    assert.equal(providerBaseUrl("  "), undefined);
    assert.equal(providerBaseUrl(null), undefined);
  });
});

describe("runtimeBaseUrl", () => {
  it("maps an untouched catalog default to the chat base URL (google)", () => {
    assert.equal(
      runtimeBaseUrl("https://generativelanguage.googleapis.com", "google"),
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
    // Trailing slashes and case still count as the catalog default.
    assert.equal(
      runtimeBaseUrl("https://generativelanguage.googleapis.com/", "google"),
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
  });

  it("uses the chat base when the provider has no stored URL", () => {
    assert.equal(
      runtimeBaseUrl(undefined, "google"),
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
    assert.equal(runtimeBaseUrl(null, "deepseek"), "https://api.deepseek.com");
  });

  it("passes manual URLs and non-catalog providers through verbatim", () => {
    assert.equal(
      runtimeBaseUrl("https://proxy.example.com/v1", "google"),
      "https://proxy.example.com/v1",
    );
    assert.equal(
      runtimeBaseUrl("http://localhost:11434/v1", "ollama"),
      "http://localhost:11434/v1",
    );
    assert.equal(runtimeBaseUrl(undefined, "ollama"), undefined);
    assert.equal(runtimeBaseUrl(undefined, undefined), undefined);
  });
});
