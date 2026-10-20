/**
 * F7 — per-account webhook secret verification (node:test, FakeDb — no real
 * DB, no network).
 *
 * A single install-wide provider secret used to verify every event: its
 * holder could forge envelopes naming ANOTHER provisioned account. The fix
 * resolves each event's channel_accounts row BEFORE processing and checks
 * the signature against the secret that account actually owns
 * (`credentialsRef`-resolved `webhookSecret`), falling back to the provider
 * secret only when the account carries none (legacy placeholder /
 * unprovisioned installs).
 *
 * All phones/ids below are synthetic fixtures.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { channelAccounts } from "@/db/schema";
import { MAX_WEBHOOK_EVENTS } from "@/lib/infra/webhook-guard";
import { FakeDb, installFakeDb } from "./test-support/fake-db";

const fake = new FakeDb();
installFakeDb(fake);

// Modules-under-test required AFTER the @/db hook is installed.
const { verifyAndResolveEvents } =
  require("./ingress") as typeof import("./ingress");
const { ycloudProvider } =
  require("./providers/ycloud") as typeof import("./providers/ycloud");
const { kapsoProvider } =
  require("./providers/kapso") as typeof import("./providers/kapso");

const PROVIDER_SECRET = "provider-shared-secret";
const SECRET_A = "acct-a-webhook-secret";
const SECRET_B = "acct-b-webhook-secret";

process.env.YCLOUD_WEBHOOK_SECRET = PROVIDER_SECRET;
process.env.KAPSO_WEBHOOK_SECRET = PROVIDER_SECRET;
// env: credentialsRef — SEC7A has NO webhook secret (falls back to provider),
// SEC7B / KPA / KPB carry their own.
process.env.SEC7A_API_KEY = "acct-a-api-key";
process.env.SEC7B_API_KEY = "acct-b-api-key";
process.env.SEC7B_WEBHOOK_SECRET = SECRET_B;
process.env.KPA_API_KEY = "kpa-api-key";
process.env.KPA_WEBHOOK_SECRET = SECRET_A;
process.env.KPB_API_KEY = "kpb-api-key";
process.env.KPB_WEBHOOK_SECRET = SECRET_B;

fake.seed(channelAccounts, [
  {
    id: 1,
    channel: "whatsapp",
    provider: "ycloud",
    providerAccountId: "waba-a",
    senderAddress: "+15550001001",
    credentialsRef: "env:SEC7A_",
    status: "active",
    tenantId: "default",
  },
  {
    id: 2,
    channel: "whatsapp",
    provider: "ycloud",
    providerAccountId: "waba-b",
    senderAddress: "+15550001002",
    credentialsRef: "env:SEC7B_",
    status: "active",
    tenantId: "default",
  },
  {
    id: 3,
    channel: "whatsapp",
    provider: "kapso",
    providerAccountId: "9900110011",
    senderAddress: "+15550001003",
    credentialsRef: "env:KPA_",
    status: "active",
    tenantId: "default",
  },
  {
    id: 4,
    channel: "whatsapp",
    provider: "kapso",
    providerAccountId: "9900110022",
    senderAddress: "+15550001004",
    credentialsRef: "env:KPB_",
    status: "active",
    tenantId: "default",
  },
]);

// ── ycloud helpers ──────────────────────────────────────────────────────────

function ycloudBody(wabaId: string, id = `evt_${wabaId}`): string {
  return JSON.stringify({
    type: "whatsapp.inbound_message.received",
    id,
    whatsappInboundMessage: {
      id: `wamid_${id}`,
      wabaId,
      from: "+15550003333",
      to: "+15550004000",
      type: "text",
      text: { body: "hola" },
    },
  });
}

function ycloudSign(body: string, secret: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return { "ycloud-signature": `t=${timestamp},s=${digest}` };
}

// ── kapso helpers ───────────────────────────────────────────────────────────

function kapsoBody(phoneNumberIds: string[]): string {
  return JSON.stringify({
    type: "whatsapp.message.received",
    batch: true,
    data: phoneNumberIds.map((pnid, i) => ({
      message: {
        id: `wamid.KPBATCH${i}`,
        timestamp: "1730093200",
        type: "text",
        from: "15550003333",
        text: { body: `msg ${i}` },
        kapso: { direction: "inbound", status: "received" },
      },
      conversation: {
        id: `conv_${pnid}`,
        phone_number: "15550003333",
        phone_number_id: pnid,
      },
      phone_number_id: pnid,
    })),
  });
}

function kapsoHeaders(
  body: string,
  secret: string
): Record<string, string> {
  return {
    "x-webhook-event": "whatsapp.message.received",
    "x-webhook-signature": createHmac("sha256", secret)
      .update(body)
      .digest("hex"),
    "x-idempotency-key": "dlv_f7_test",
    "x-webhook-batch": "true",
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("F7 — per-account webhook secret verification", () => {
  it("rejects a provider-secret-signed event that names an account with its own secret", async () => {
    // THE forgery the finding describes: the install-wide secret used to
    // verify everything; an event bound to account B must require B's secret.
    const body = ycloudBody("waba-b");
    const res = await verifyAndResolveEvents(ycloudProvider, {
      headers: ycloudSign(body, PROVIDER_SECRET),
      rawBody: body,
    });
    assert.equal(res.kind, "unauthorized");
  });

  it("accepts the same envelope when signed with the named account's secret", async () => {
    const body = ycloudBody("waba-b");
    const res = await verifyAndResolveEvents(ycloudProvider, {
      headers: ycloudSign(body, SECRET_B),
      rawBody: body,
    });
    assert.equal(res.kind, "ok");
    if (res.kind !== "ok") return;
    assert.equal(res.events.length, 1);
    assert.equal(res.events[0].ctx?.account.id, "2");
    assert.equal(res.events[0].ctx?.channelAccountId, 2);
    assert.equal(res.rejected, 0);
  });

  it("keeps provider-secret verification for an account WITHOUT its own secret", async () => {
    // env:SEC7A_ resolves API key but no WEBHOOK_SECRET — the event's
    // expected signer stays the install-wide provider secret (the
    // documented single-secret blast radius until the account configures
    // its own).
    const body = ycloudBody("waba-a");
    const res = await verifyAndResolveEvents(ycloudProvider, {
      headers: ycloudSign(body, PROVIDER_SECRET),
      rawBody: body,
    });
    assert.equal(res.kind, "ok");
    if (res.kind !== "ok") return;
    assert.equal(res.events[0].ctx?.account.id, "1");
  });

  it("rejects outright when nothing verifies", async () => {
    const body = ycloudBody("waba-a");
    const res = await verifyAndResolveEvents(ycloudProvider, {
      headers: ycloudSign(body, "not-any-accounts-secret"),
      rawBody: body,
    });
    assert.equal(res.kind, "unauthorized");
  });

  it("events naming an unknown account stay on the provider secret (fail-closed skip downstream)", async () => {
    // The envelope can't be attributed to a row — no account secret exists
    // to verify against, so the shared provider secret remains the signer
    // and resolution's fail-closed skip keeps the event out of processing.
    const body = ycloudBody("waba-not-provisioned");
    const res = await verifyAndResolveEvents(ycloudProvider, {
      headers: ycloudSign(body, PROVIDER_SECRET),
      rawBody: body,
    });
    assert.equal(res.kind, "ok");
    if (res.kind !== "ok") return;
    assert.equal(res.events[0].ctx, undefined);
  });

  it("drops only the foreign-account events inside a mixed batch", async () => {
    // Kapso batch: item 1 names account A, item 2 names account B. Signed
    // with A's secret — A's event verifies, B's is dropped (F7 guard).
    const body = kapsoBody(["9900110011", "9900110022"]);
    const res = await verifyAndResolveEvents(kapsoProvider, {
      headers: kapsoHeaders(body, SECRET_A),
      rawBody: body,
    });
    assert.equal(res.kind, "ok");
    if (res.kind !== "ok") return;
    assert.equal(res.events.length, 1);
    assert.equal(res.events[0].ctx?.account.id, "3");
    assert.equal(res.rejected, 1);
  });

  it("a batch signed by the shared secret is fully rejected when accounts carry their own", async () => {
    const body = kapsoBody(["9900110011", "9900110022"]);
    const res = await verifyAndResolveEvents(kapsoProvider, {
      headers: kapsoHeaders(body, PROVIDER_SECRET),
      rawBody: body,
    });
    assert.equal(res.kind, "unauthorized");
  });

  it("caps oversized envelopes before account resolution (F8)", async () => {
    // 150 signed events in one envelope — only MAX_WEBHOOK_EVENTS may fan out
    // into per-event account resolution and processing.
    const body = kapsoBody(new Array(150).fill("9900110011"));
    const res = await verifyAndResolveEvents(kapsoProvider, {
      headers: kapsoHeaders(body, SECRET_A),
      rawBody: body,
    });
    assert.equal(res.kind, "ok");
    if (res.kind !== "ok") return;
    assert.equal(res.events.length, MAX_WEBHOOK_EVENTS);
  });

  it("signed but unparseable bodies report 'empty' (legacy JSON.parse contract)", async () => {
    // Non-JSON under a valid provider signature: the adapter yields no events,
    // and the route's legacy contract replays a JSON.parse throw (500).
    const body = "not-json{{";
    const res = await verifyAndResolveEvents(ycloudProvider, {
      headers: ycloudSign(body, PROVIDER_SECRET),
      rawBody: body,
    });
    assert.equal(res.kind, "empty");
  });
});
