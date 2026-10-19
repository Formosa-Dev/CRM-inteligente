/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * A-56: saveAgentConfig must not log raw customer phone lists, and admin
 * actions must return generic client-facing errors — DB internals stay in
 * the server log, redacted to the console only.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, mock } from "node:test";

import { FakeDb, installFakeDb } from "@/lib/messaging/test-support/fake-db";

const fake = new FakeDb();
installFakeDb(fake);

const Module = require("node:module") as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const prevLoad = Module._load;

let session: unknown = { user: { id: "1", role: "admin" } };
const scopeState = {
  findError: null as Error | null,
  resolveError: null as Error | null,
  existing: null as unknown,
};

Module._load = function (request, parent, isMain): unknown {
  if (request === "@/auth") {
    return { auth: async () => session };
  }
  if (request === "next/cache") {
    return { revalidatePath: () => undefined };
  }
  if (request === "@/lib/encryption") {
    return { encrypt: (value: string) => `enc:${value}` };
  }
  if (request === "@/lib/ai/config") {
    return { invalidateAIConfigCache: () => undefined };
  }
  if (request === "@/lib/agent-config-scope") {
    return {
      findAgentConfigForScope: async () => {
        if (scopeState.findError) throw scopeState.findError;
        return scopeState.existing;
      },
      invalidateAgentConfigScopeCache: () => undefined,
      parseScopeKey: (key: string) => (key ? { key } : null),
      resolveAgentConfig: async () => {
        if (scopeState.resolveError) throw scopeState.resolveError;
        return {
          ycloudApiKey: "key",
          whatsappBotNumber: "+15550000001",
          systemPrompt: "prompt",
          enabled: true,
        };
      },
      scopeColumnsForInsert: async () => ({}),
      scopeKeyOf: (scope: { key?: string }) => scope?.key ?? "global",
    };
  }
  return prevLoad.call(this, request, parent, isMain);
};

const { saveAgentConfig, copyAgentConfig, testAgentConnection } =
  require("./actions") as typeof import("./actions");

const logs: string[] = [];
const errors: string[] = [];
mock.method(console, "log", (...args: unknown[]) => {
  logs.push(args.map(String).join(" "));
});
mock.method(console, "error", (...args: unknown[]) => {
  errors.push(args.map(String).join(" "));
});

const SELLER_PHONE = "+5493704111222";
const ALLOWED_PHONE = "+5493704333444";
const INTERNALS = "password authentication failed for neon_admin@db.internal:5432";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("A-56 — agent actions PII and error leakage", () => {
  it("never logs the raw phone lists while saving config", async () => {
    session = { user: { id: "1", role: "admin" } };
    scopeState.existing = { id: 1 };
    const result = await saveAgentConfig(
      { success: false, message: "" },
      form({
        phoneNumber: "+15550100",
        enabled: "true",
        sellerPhoneIds: JSON.stringify([{ name: "Vendedor", phone: SELLER_PHONE }]),
        allowedPhoneIds: JSON.stringify([{ name: "Permitido", phone: ALLOWED_PHONE }]),
      })
    );
    assert.equal(result.success, true);
    const logged = logs.join("\n");
    assert.ok(!logged.includes("3704111222"), "seller phone leaked to logs");
    assert.ok(!logged.includes("3704333444"), "allowed phone leaked to logs");
    assert.ok(!logged.includes("sellerPhoneIds"), "phone list key leaked to logs");
    assert.ok(!logged.includes("allowedPhoneIds"), "phone list key leaked to logs");
  });

  it("saveAgentConfig returns a generic error while internals stay server-side", async () => {
    session = { user: { id: "1", role: "admin" } };
    scopeState.findError = new Error(INTERNALS);
    const errorsBefore = errors.length;

    const result = await saveAgentConfig(
      { success: false, message: "" },
      form({ phoneNumber: "+15550100", enabled: "true" })
    );

    assert.equal(result.success, false);
    assert.equal(result.message, "Error al guardar la configuración");
    assert.ok(!result.message.includes("db.internal"));
    assert.ok(
      errors.slice(errorsBefore).some((line) => line.includes("db.internal")),
      "the real error must remain observable in the server log"
    );
    scopeState.findError = null;
  });

  it("copyAgentConfig returns a generic error on store failure", async () => {
    session = { user: { id: "1", role: "admin" } };
    scopeState.findError = new Error(INTERNALS);
    const errorsBefore = errors.length;

    const result = await copyAgentConfig("account:1", "global");

    assert.equal(result.success, false);
    assert.equal(result.message, "Error al copiar la configuración");
    assert.ok(!result.message.includes("db.internal"));
    assert.ok(errors.slice(errorsBefore).some((line) => line.includes("db.internal")));
    scopeState.findError = null;
  });

  it("testAgentConnection returns a generic error on config read failure", async () => {
    session = { user: { id: "1", role: "admin" } };
    scopeState.resolveError = new Error(INTERNALS);
    const errorsBefore = errors.length;

    const result = await testAgentConnection();

    assert.equal(result.success, false);
    assert.equal(result.message, "Error al leer la configuración");
    assert.ok(!result.message.includes("db.internal"));
    assert.ok(errors.slice(errorsBefore).some((line) => line.includes("db.internal")));
    scopeState.resolveError = null;
  });

  it("the module carries no raw phone-list logging or client-facing e.message", () => {
    const src = readFileSync(
      "src/app/(admin)/admin/agent/actions.ts",
      "utf8"
    );
    assert.doesNotMatch(src, /console\.log\(/);
    assert.doesNotMatch(src, /e\.message/);
  });
});
