/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * A-03: OAuth sign-in (e.g. Facebook) must be gated by the provisioned-users
 * allowlist — an arbitrary OAuth account can no longer mint a session.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { FakeDb, installFakeDb } from "@/lib/messaging/test-support/fake-db";
import { users } from "@/db/schema";

const fake = new FakeDb();
installFakeDb(fake);

const { findProvisionedUser } =
  require("./oauth-allowlist") as typeof import("./oauth-allowlist");

describe("A-03 — OAuth allowlist", () => {
  it("admits an email provisioned in users and carries its id and role", async () => {
    fake.seed(users, [
      {
        id: 7,
        email: "duenia@negocio.com",
        hashedPassword: "hash",
        name: "Dueña",
        role: "admin",
      },
      {
        id: 8,
        email: "lectora@negocio.com",
        hashedPassword: "hash",
        name: "Lectora",
        role: "viewer",
      },
    ]);

    const admin = await findProvisionedUser("duenia@negocio.com");
    assert.equal(admin?.id, 7);
    assert.equal(admin?.role, "admin");

    const viewer = await findProvisionedUser("lectora@negocio.com");
    assert.equal(viewer?.id, 8);
    assert.equal(viewer?.role, "viewer");
  });

  it("denies emails that were never provisioned", async () => {
    assert.equal(await findProvisionedUser("intruso@externo.com"), null);
    assert.equal(await findProvisionedUser(""), null);
  });

  it("the NextAuth config wires the gate fail-closed for OAuth providers", () => {
    const src = readFileSync("src/auth/index.ts", "utf8");
    assert.match(src, /async signIn\(/);
    // Credentials keeps its own authorize() path; OAuth goes through the list.
    assert.match(src, /provider === "credentials"\)\s+return true/);
    assert.match(src, /findProvisionedUser/);
    // Denial paths: missing email, unprovisioned email, and lookup failure.
    assert.match(src, /if \(!email\) return false/);
    assert.match(src, /if \(!provisioned\) return false/);
    assert.match(src, /catch \(err\)[\s\S]*?return false/);
  });
});
