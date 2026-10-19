/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * B5 / §2.4 social-identity tests over a mocked DB.
 *
 * Phone-less channels (instagram/facebook/reddit) must create/link leads via
 * `lead_identities(channel, externalId)` — the roadmap's Zernio gate:
 *   1. inbound IG message.received with NO phone → conversation + phone-less
 *      lead + lead_identities row;
 *   2. repeat inbound → same conversation, no duplicate lead/identity;
 *   3. social sender WITH a known phone → identity attaches to that lead;
 *   4. pre-existing identity → conversation links to the owning lead.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeDb, installFakeDb } from "./test-support/fake-db";

const fake = new FakeDb();
const restoreDb = installFakeDb(fake);

const {
  findOrCreateConversation,
} = require("@/lib/channels/router") as typeof import("@/lib/channels/router");
const { ensureLeadIdentity } =
  require("@/lib/messaging/lead-identity") as typeof import("@/lib/messaging/lead-identity");
const { leadIdentities, leads, conversations } = require("@/db/schema") as typeof import("@/db/schema");

process.on("exit", () => restoreDb());

const IG_SENDER = "17841405823604595"; // instagram-scoped user id (digits, not a phone)
const ACCOUNT_ID = 42;

function seedZernioIgAccount() {
  fake.seed(
    require("@/db/schema").channelAccounts,
    [
      {
        id: ACCOUNT_ID,
        tenantId: "default",
        provider: "zernio",
        channel: "instagram",
        providerAccountId: "ig-business-acct-1",
        senderAddress: "@formosadev",
        displayName: "Formosa.dev IG",
        credentialsRef: "env:ZERNIO_IG",
        status: "active",
      },
    ]
  );
}

describe("social lead identities (phone-less channels)", () => {
  it("inbound IG message creates conversation + phone-less lead + identity row", async () => {
    seedZernioIgAccount();
    const convo = await findOrCreateConversation(
      "instagram",
      IG_SENDER,
      "martina.ig",
      undefined,
      ACCOUNT_ID
    );
    assert.ok(convo.isNew, "first inbound must create the conversation");

    const leadRows = fake.rows("leads");
    assert.equal(leadRows.length, 1, "exactly one lead created");
    assert.equal(leadRows[0].phone, null, "social lead has no phone");
    assert.equal(leadRows[0].channel, "instagram");
    assert.equal(leadRows[0].externalUserId, IG_SENDER);
    assert.equal(leadRows[0].channelAccountId, ACCOUNT_ID);
    assert.equal(leadRows[0].conversationId, convo.id);

    const ids = fake.rows("lead_identities");
    assert.equal(ids.length, 1, "exactly one identity row");
    assert.equal(ids[0].leadId, leadRows[0].id);
    assert.equal(ids[0].channel, "instagram");
    // Canonical key — the same value stored on the conversation.
    const convoRow = fake.rows("conversations")[0];
    assert.equal(ids[0].externalId, convoRow.externalUserIdNormalized);
  });

  it("repeat inbound on the same identity dedups — no new lead/identity", async () => {
    const convo = await findOrCreateConversation(
      "instagram",
      IG_SENDER,
      "martina.ig",
      undefined,
      ACCOUNT_ID
    );
    assert.equal(convo.isNew, false, "second inbound resolves existing conversation");
    assert.equal(fake.rows("leads").length, 1);
    assert.equal(fake.rows("lead_identities").length, 1);
  });

  it("social sender carrying a known phone attaches the identity to that lead", async () => {
    // Existing WhatsApp-era lead keyed by phone.
    fake.seed(leads, [
      {
        id: 7,
        name: "Caro",
        phone: "5493704000000",
        channel: "whatsapp",
        conversationId: null,
        status: "new",
      },
    ]);

    const convo = await findOrCreateConversation(
      "facebook",
      "fb-psid-991",
      "Caro R.",
      "+54 9 3704 00-0000", // raw as the provider sends it
      ACCOUNT_ID
    );

    const leadRows = fake.rows("leads");
    assert.equal(leadRows.length, 1, "no extra lead created");
    assert.equal(leadRows[0].conversationId, convo.id, "existing lead linked");

    const ids = fake.rows("lead_identities");
    const fbIdentity = ids.find((r) => r.channel === "facebook");
    assert.ok(fbIdentity, "facebook identity row created");
    assert.equal(fbIdentity!.leadId, 7, "identity attaches to the phone-matched lead");
    assert.equal(fbIdentity!.externalId, "fb-psid-991");
  });

  it("pre-existing identity links its lead to the conversation", async () => {
    // Simulate a second account-scope hitting an identity that already
    // exists: seed identity + lead, create the conversation via a different
    // external id path.
    fake.seed(conversations, []);
    fake.seed(leadIdentities, [
      {
        id: 99,
        leadId: 7,
        channel: "facebook",
        externalId: "fb-psid-222",
      },
    ]);
    fake.seed(leads, [
      // re-seed: FakeDb.replace semantics
      { id: 7, name: "Caro", phone: "5493704000000", channel: "whatsapp", conversationId: null, status: "new" },
    ]);

    const convo = await findOrCreateConversation(
      "facebook",
      "fb-psid-222",
      undefined,
      undefined,
      ACCOUNT_ID
    );

    const lead = fake.rows("leads").find((r) => r.id === 7);
    assert.equal(lead!.conversationId, convo.id, "conversation linked to owning lead");
    // The identity row must still point at lead 7 — one row, one owner.
    const idRows = fake.rows("lead_identities").filter((r) => r.channel === "facebook" && r.externalId === "fb-psid-222");
    assert.equal(idRows.length, 1);
    assert.equal(idRows[0].leadId, 7);
  });
});

describe("lead identity race (concurrent first-contact inbounds)", () => {
  const input = (conversationId: number) => ({
    channel: "instagram" as const,
    externalUserId: "ig-race-1",
    externalUserIdNormalized: "ig-race-1",
    customerName: "Race User",
    customerPhone: null,
    channelAccountId: ACCOUNT_ID,
    conversationId,
  });

  it("the losing lead shell is deleted — one lead owns the identity", async () => {
    fake.seed(leads, []);
    fake.seed(leadIdentities, []);

    // FakeDb runs side effects synchronously inside then(), so Promise.all
    // interleaves deterministically: both see no identity, both create a
    // lead, the second insert hits 23505 and its shell must be dropped.
    await Promise.all([
      ensureLeadIdentity(input(9001)),
      ensureLeadIdentity(input(9002)),
    ]);

    const leadRows = fake.rows("leads");
    assert.equal(leadRows.length, 1, "only the winning lead survives");
    const ids = fake.rows("lead_identities");
    assert.equal(ids.length, 1, "one identity row");
    assert.equal(ids[0].leadId, leadRows[0].id, "identity owned by the surviving lead");
  });

  it("a phone-matched pre-existing lead is never deleted on race", async () => {
    fake.seed(leads, [
      { id: 30, name: "Pre", phone: "5493704111111", channel: "whatsapp", conversationId: null, status: "new" },
    ]);
    fake.seed(leadIdentities, []);

    const withPhone = (conversationId: number) => ({
      ...input(conversationId),
      externalUserId: "ig-race-2",
      externalUserIdNormalized: "ig-race-2",
      customerPhone: "+54 9 3704 11-1111",
    });
    await Promise.all([
      ensureLeadIdentity(withPhone(9003)),
      ensureLeadIdentity(withPhone(9004)),
    ]);

    const leadRows = fake.rows("leads");
    assert.equal(leadRows.length, 1, "pre-existing lead untouched");
    assert.equal(leadRows[0].id, 30);
    const ids = fake.rows("lead_identities").filter((r) => r.externalId === "ig-race-2");
    assert.equal(ids.length, 1);
    assert.equal(ids[0].leadId, 30);
  });
});
