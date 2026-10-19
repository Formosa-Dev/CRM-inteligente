import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { UpdateLeadSchema } from "./helpers";

describe("POST /api/leads/update schema", () => {
  it("rejects non-numeric ids that used to hit Postgres as syntax errors", () => {
    assert.equal(UpdateLeadSchema.safeParse({ id: "abc" }).success, false);
    assert.equal(UpdateLeadSchema.safeParse({ id: "1; DROP TABLE leads;--" }).success, false);
    assert.equal(UpdateLeadSchema.safeParse({ id: 1.5 }).success, false);
    assert.equal(UpdateLeadSchema.safeParse({ id: -3 }).success, false);
  });

  it("coerces numeric ids to int", () => {
    const parsed = UpdateLeadSchema.safeParse({ id: "42" });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.id, 42);
  });

  it("bounds type to the known segments", () => {
    assert.equal(UpdateLeadSchema.safeParse({ type: "vip" }).success, false);
    assert.equal(UpdateLeadSchema.safeParse({ type: "b2b" }).success, true);
    assert.equal(UpdateLeadSchema.safeParse({ type: "b2c" }).success, true);
  });

  it("bounds tags to a string list", () => {
    assert.equal(UpdateLeadSchema.safeParse({ tags: "hot" }).success, false);
    assert.equal(UpdateLeadSchema.safeParse({ tags: [1, 2] }).success, false);
    assert.equal(UpdateLeadSchema.safeParse({ tags: ["a", "b"] }).success, true);
    assert.equal(
      UpdateLeadSchema.safeParse({ tags: Array.from({ length: 51 }, (_, i) => `t${i}`) }).success,
      false
    );
  });

  it("validates email format while allowing empty (clear) and absent", () => {
    assert.equal(UpdateLeadSchema.safeParse({ email: "nope" }).success, false);
    assert.equal(UpdateLeadSchema.safeParse({ email: "a@b.co" }).success, true);
    assert.equal(UpdateLeadSchema.safeParse({ email: "" }).success, true);
    assert.equal(UpdateLeadSchema.safeParse({}).success, true);
  });

  it("strips unknown keys instead of mass-assigning them", () => {
    const parsed = UpdateLeadSchema.safeParse({ id: 1, role: "admin", status: "lost" });
    assert.equal(parsed.success, true);
    assert.equal("role" in (parsed.data ?? {}), false);
    assert.equal("status" in (parsed.data ?? {}), false);
  });
});
