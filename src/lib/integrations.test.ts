/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * F15: getIntegrationSecrets() caches decrypted values for 30s — admin write
 * paths must invalidate that cache so a rotated webhook/app/cron secret takes
 * effect immediately instead of staying accepted until the TTL expires.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { agentConfig } from "@/db/schema";
import { FakeDb, installFakeDb } from "@/lib/messaging/test-support/fake-db";

const fake = new FakeDb();
installFakeDb(fake);

const { getIntegrationSecrets, invalidateIntegrationSecretsCache } =
  require("./integrations") as typeof import("./integrations");

describe("F15 — integration secrets cache", () => {
  it("serves the 30s cache until invalidateIntegrationSecretsCache() is called", async () => {
    fake.seed(agentConfig, [{ id: 1, cronSecret: "plain-secret-v1" }]);

    const first = await getIntegrationSecrets();
    assert.equal(first.cronSecret, "plain-secret-v1");

    // The row rotates out from under the cache.
    fake.rows("agent_config")[0].cronSecret = "rotated-v2";
    const stillCached = await getIntegrationSecrets();
    assert.equal(stillCached.cronSecret, "plain-secret-v1");

    invalidateIntegrationSecretsCache();
    const fresh = await getIntegrationSecrets();
    assert.equal(fresh.cronSecret, "rotated-v2");
  });

  it("is exported and called from every owned secret-write path", () => {
    assert.equal(typeof invalidateIntegrationSecretsCache, "function");

    const agentActions = readFileSync(
      "src/app/(admin)/admin/agent/actions.ts",
      "utf8"
    );
    const calls = agentActions.match(/invalidateIntegrationSecretsCache\(\)/g);
    // saveAgentConfig + copyAgentConfig both write agent_config secrets.
    assert.ok(calls && calls.length >= 2);

    const metaActions = readFileSync(
      "src/app/(admin)/admin/meta/actions.ts",
      "utf8"
    );
    assert.match(metaActions, /invalidateIntegrationSecretsCache\(\)/);
  });
});
