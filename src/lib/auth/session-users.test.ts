/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * F9: JWT role claims must not outlive the row that minted them. The jwt
 * callback re-reads `users.role` through this cached lookup; a missing row
 * kills the session, a changed role propagates within the TTL.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { FakeDb, installFakeDb } from "@/lib/messaging/test-support/fake-db";
import { users } from "@/db/schema";

const fake = new FakeDb();
installFakeDb(fake);

const { createRoleLookup } =
  require("./session-users") as typeof import("./session-users");

describe("F9 — role revalidation lookup", () => {
  it("returns the stored role and null for a deleted/unknown user", async () => {
    fake.seed(users, [
      { id: 7, email: "a@x.com", hashedPassword: "h", name: "A", role: "admin" },
    ]);
    const lookup = createRoleLookup();

    assert.deepEqual(await lookup.lookup(7), { status: "ok", role: "admin" });
    assert.deepEqual(await lookup.lookup(999), { status: "ok", role: null });
  });

  it("treats malformed token ids as a missing row", async () => {
    const lookup = createRoleLookup();
    assert.deepEqual(await lookup.lookup("not-a-number"), {
      status: "ok",
      role: null,
    });
    assert.deepEqual(await lookup.lookup("7.9"), { status: "ok", role: null });
  });

  it("serves the cached role inside the TTL and re-reads after expiry", async () => {
    fake.seed(users, [
      { id: 1, email: "b@x.com", hashedPassword: "h", name: "B", role: "admin" },
    ]);
    let now = 1_000;
    const lookup = createRoleLookup({ ttlMs: 60_000, now: () => now });

    assert.deepEqual(await lookup.lookup(1), { status: "ok", role: "admin" });

    // Demote in the DB — within the TTL the cached role still stands.
    fake.update("users", { role: "viewer" }, undefined);
    assert.deepEqual(await lookup.lookup(1), { status: "ok", role: "admin" });

    // Past the TTL the demotion is picked up.
    now += 60_001;
    assert.deepEqual(await lookup.lookup(1), { status: "ok", role: "viewer" });
  });

  it("invalidate() forces an immediate re-read", async () => {
    fake.seed(users, [
      { id: 2, email: "c@x.com", hashedPassword: "h", name: "C", role: "admin" },
    ]);
    const lookup = createRoleLookup();
    assert.deepEqual(await lookup.lookup(2), { status: "ok", role: "admin" });

    fake.deleteRows("users", undefined);
    // Still cached…
    assert.deepEqual(await lookup.lookup(2), { status: "ok", role: "admin" });
    // …until invalidated — a deleted user resolves to no role.
    lookup.invalidate(2);
    assert.deepEqual(await lookup.lookup(2), { status: "ok", role: null });
  });

  it("bounds the cache so it cannot grow without limit", async () => {
    fake.seed(users, [
      { id: 1, email: "a@x.com", hashedPassword: "h", name: "A", role: "admin" },
      { id: 2, email: "b@x.com", hashedPassword: "h", name: "B", role: "viewer" },
      { id: 3, email: "c@x.com", hashedPassword: "h", name: "C", role: "viewer" },
    ]);
    const lookup = createRoleLookup({ maxEntries: 2 });
    await lookup.lookup(1);
    await lookup.lookup(2);
    await lookup.lookup(3); // exceeds the bound — oldest entry evicted
    // id 1 was evicted: a fresh lookup returns a fresh (identical) result, so
    // prove eviction by changing the row before and after.
    fake.update("users", { role: "viewer" }, undefined);
    const again = await lookup.lookup(1);
    assert.deepEqual(again, { status: "ok", role: "viewer" });
  });
});

describe("F9 — NextAuth config wiring", () => {
  const src = readFileSync("src/auth/index.ts", "utf8");

  it("points the sign-in page at the real /login route (D10)", () => {
    assert.match(src, /signIn:\s*"\/login"/);
    assert.doesNotMatch(src, /admin\/login/);
  });

  it("bounds sessions to 24h", () => {
    assert.match(src, /maxAge:\s*24\s*\*\s*60\s*\*\s*60/);
  });

  it("revalidates the user row inside the jwt callback", () => {
    assert.match(src, /lookupUserRole/);
    // A missing user row must destroy the token (jwt callback → null).
    assert.match(src, /check\.role === null\) return null/);
    // Tokens without an id are malformed — killed, not trusted.
    assert.match(src, /token\.id === (undefined|null)[\s\S]*?return null/);
  });
});
