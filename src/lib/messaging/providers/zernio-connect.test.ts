import assert from "node:assert/strict";
import test, { describe, mock } from "node:test";

import {
  ZERNIO_CONNECT_PLATFORMS,
  ZERNIO_CONNECT_STATE_COOKIE,
  connectStateCookieName,
  getZernioConnectUrl,
  isZernioConnectPlatform,
  registerZernioWebhook,
  resolveZernioProfileId,
} from "./zernio-connect";

// Synthetic values only — no real keys/ids.

describe("zernio-connect platform set", () => {
  test("offers OAuth-capable channels only (telegram/sms stay manual)", () => {
    assert.deepEqual([...ZERNIO_CONNECT_PLATFORMS], [
      "whatsapp",
      "instagram",
      "facebook",
      "reddit",
    ]);
    assert.ok(isZernioConnectPlatform("instagram"));
    assert.ok(!isZernioConnectPlatform("telegram"));
    assert.ok(!isZernioConnectPlatform("sms"));
  });
});

describe("connectStateCookieName", () => {
  test("keys the state cookie per platform so parallel connects don't collide", () => {
    assert.equal(
      connectStateCookieName("whatsapp"),
      `${ZERNIO_CONNECT_STATE_COOKIE}_whatsapp`
    );
    assert.notEqual(
      connectStateCookieName("whatsapp"),
      connectStateCookieName("instagram")
    );
    for (const p of ZERNIO_CONNECT_PLATFORMS) {
      assert.match(connectStateCookieName(p), /^zernio_connect_state_[a-z]+$/);
    }
  });
});

describe("resolveZernioProfileId", () => {
  test("ZERNIO_PROFILE_ID env wins without calling the API", async () => {
    const prev = process.env.ZERNIO_PROFILE_ID;
    process.env.ZERNIO_PROFILE_ID = "prof_env_1";
    let fetched = false;
    mock.method(globalThis, "fetch", async () => {
      fetched = true;
      return new Response("{}");
    });
    try {
      const res = await resolveZernioProfileId("key");
      assert.deepEqual(res, { ok: true, profileId: "prof_env_1" });
      assert.equal(fetched, false);
    } finally {
      mock.restoreAll();
      if (prev === undefined) delete process.env.ZERNIO_PROFILE_ID;
      else process.env.ZERNIO_PROFILE_ID = prev;
    }
  });

  test("falls back to the default-first profile from GET /v1/profiles", async () => {
    const prev = process.env.ZERNIO_PROFILE_ID;
    delete process.env.ZERNIO_PROFILE_ID;
    const calls: { url: string; init?: RequestInit }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ profiles: [{ id: "prof_default" }, { id: "prof_2" }] })
      );
    });
    try {
      const res = await resolveZernioProfileId("key-1");
      assert.deepEqual(res, { ok: true, profileId: "prof_default" });
    } finally {
      mock.restoreAll();
      if (prev !== undefined) process.env.ZERNIO_PROFILE_ID = prev;
    }
    assert.equal(calls[0].url, "https://zernio.com/api/v1/profiles");
    assert.equal(
      (calls[0].init?.headers as Record<string, string>).Authorization,
      "Bearer key-1"
    );
  });

  test("empty profile list is a clear error", async () => {
    const prev = process.env.ZERNIO_PROFILE_ID;
    delete process.env.ZERNIO_PROFILE_ID;
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ profiles: [] }))
    );
    try {
      const res = await resolveZernioProfileId("key");
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.error, /no profiles/);
    } finally {
      mock.restoreAll();
      if (prev !== undefined) process.env.ZERNIO_PROFILE_ID = prev;
    }
  });
});

describe("getZernioConnectUrl", () => {
  test("builds the OAuth start request and surfaces authUrl", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ authUrl: "https://instagram.com/oauth/xyz" })
      );
    });
    try {
      const res = await getZernioConnectUrl({
        platform: "instagram",
        profileId: "prof_1",
        redirectUrl: "https://crm.test/api/channels/zernio/callback",
        apiKey: "key-1",
      });
      assert.deepEqual(res, {
        ok: true,
        authUrl: "https://instagram.com/oauth/xyz",
      });
    } finally {
      mock.restoreAll();
    }
    const url = new URL(calls[0].url);
    assert.equal(url.origin + url.pathname, "https://zernio.com/api/v1/connect/instagram");
    assert.equal(url.searchParams.get("profileId"), "prof_1");
    assert.equal(
      url.searchParams.get("redirect_url"),
      "https://crm.test/api/channels/zernio/callback"
    );
    assert.equal(url.searchParams.get("onboarding"), null);
  });

  test("whatsapp adds onboarding=api (Embedded Signup)", async () => {
    const calls: { url: string }[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
      calls.push({ url });
      return new Response(JSON.stringify({ authUrl: "https://wa.test/es" }));
    });
    try {
      await getZernioConnectUrl({
        platform: "whatsapp",
        profileId: "p",
        redirectUrl: "https://crm.test/cb",
        apiKey: "k",
      });
    } finally {
      mock.restoreAll();
    }
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, "/api/v1/connect/whatsapp");
    assert.equal(url.searchParams.get("onboarding"), "api");
  });

  test("missing authUrl is a failure, upstream errors pass through", async () => {
    mock.method(globalThis, "fetch", async () => new Response("{}"));
    try {
      const res = await getZernioConnectUrl({
        platform: "reddit",
        profileId: "p",
        redirectUrl: "https://crm.test/cb",
        apiKey: "k",
      });
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.error, /no authUrl/);
    } finally {
      mock.restoreAll();
    }

    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ error: "bad key", code: "invalid_credentials" }), {
        status: 401,
      })
    );
    try {
      const res = await getZernioConnectUrl({
        platform: "reddit",
        profileId: "p",
        redirectUrl: "https://crm.test/cb",
        apiKey: "k",
      });
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.error, /401.*invalid_credentials/);
    } finally {
      mock.restoreAll();
    }
  });
});

describe("registerZernioWebhook", () => {
  test("posts the caller-chosen secret with the full event set", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "wh_1" }), { status: 200 });
    });
    try {
      const res = await registerZernioWebhook({
        url: "https://crm.test/api/webhooks/ingress/zernio",
        secret: "whsec_1",
        apiKey: "key-1",
      });
      assert.deepEqual(res, { ok: true });
    } finally {
      mock.restoreAll();
    }
    assert.equal(calls[0].url, "https://zernio.com/api/v1/webhooks/settings");
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.url, "https://crm.test/api/webhooks/ingress/zernio");
    assert.equal(body.secret, "whsec_1");
    assert.ok(body.events.includes("message.received"));
    assert.ok(body.events.includes("comment.received"));
    assert.ok(body.events.includes("account.connected"));
    assert.equal(
      (calls[0].init?.headers as Record<string, string>).Authorization,
      "Bearer key-1"
    );
  });

  test("non-OK upstream response surfaces code + error", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({ error: "limit reached", code: "webhook_limit" }),
        { status: 400 }
      )
    );
    try {
      const res = await registerZernioWebhook({
        url: "https://crm.test/hook",
        secret: "s",
        apiKey: "k",
      });
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.error, /400.*webhook_limit/);
    } finally {
      mock.restoreAll();
    }
  });
});
