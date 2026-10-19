/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * F12: cron endpoints take the secret in an Authorization: Bearer header —
 * never in the URL — and are rate-limited per client IP. A query-string key
 * is honored only behind the CRON_ALLOW_QUERY_KEY=1 escape hatch.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FakeDb, installFakeDb } from "@/lib/messaging/test-support/fake-db";

const fake = new FakeDb();
installFakeDb(fake);

const SECRET = "test-cron-secret-0123456789";

const { authorizeCronRequest, cronSecretMatches } =
  require("./cron-auth") as typeof import("./cron-auth");

function req(headers: Record<string, string>, url = "https://app.test/api/cron/followup") {
  return new Request(url, { method: "POST", headers });
}

let savedFlag: string | undefined;
let savedSecret: string | undefined;

beforeEach(() => {
  savedFlag = process.env.CRON_ALLOW_QUERY_KEY;
  savedSecret = process.env.CRON_SECRET;
  delete process.env.CRON_ALLOW_QUERY_KEY;
  process.env.CRON_SECRET = SECRET;
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env.CRON_ALLOW_QUERY_KEY;
  else process.env.CRON_ALLOW_QUERY_KEY = savedFlag;
  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;
});

describe("cronSecretMatches", () => {
  it("compares constant-time and fails closed on empty/missing values", () => {
    assert.equal(cronSecretMatches(SECRET, SECRET), true);
    assert.equal(cronSecretMatches("wrong", SECRET), false);
    assert.equal(cronSecretMatches(SECRET, ""), false);
    assert.equal(cronSecretMatches("", SECRET), false);
    assert.equal(cronSecretMatches(null, SECRET), false);
    assert.equal(cronSecretMatches(SECRET, undefined), false);
  });
});

describe("F12 — authorizeCronRequest", () => {
  it("accepts a valid Bearer token", async () => {
    const denied = await authorizeCronRequest(
      req({ authorization: `Bearer ${SECRET}` })
    );
    assert.equal(denied, null);
  });

  it("the Bearer scheme is case-insensitive", async () => {
    const denied = await authorizeCronRequest(
      req({ authorization: `bearer ${SECRET}` })
    );
    assert.equal(denied, null);
  });

  it("rejects a wrong or missing bearer token with 401", async () => {
    for (const headers of [
      { authorization: "Bearer nope" },
      { authorization: "Basic " + SECRET },
      {},
    ] as Record<string, string>[]) {
      const denied = await authorizeCronRequest(req(headers));
      assert.equal(denied?.status, 401);
    }
  });

  it("rejects a query-string key by default — even when it is valid", async () => {
    const denied = await authorizeCronRequest(
      req({}, `https://app.test/api/cron/followup?key=${SECRET}`)
    );
    assert.equal(denied?.status, 401);
  });

  it("accepts the legacy query key only behind CRON_ALLOW_QUERY_KEY=1", async () => {
    process.env.CRON_ALLOW_QUERY_KEY = "1";
    const denied = await authorizeCronRequest(
      req({}, `https://app.test/api/cron/followup?key=${SECRET}`)
    );
    assert.equal(denied, null);
  });

  it("rejects a bad query key even with the flag on", async () => {
    process.env.CRON_ALLOW_QUERY_KEY = "1";
    const denied = await authorizeCronRequest(
      req({}, "https://app.test/api/cron/followup?key=wrong")
    );
    assert.equal(denied?.status, 401);
  });
});
