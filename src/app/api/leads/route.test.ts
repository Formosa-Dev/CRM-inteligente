import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseDateParam } from "./route";

describe("GET /api/leads date params", () => {
  it("returns null for absent params", () => {
    assert.equal(parseDateParam(null), null);
    assert.equal(parseDateParam(""), null);
  });

  it("ignores invalid dates instead of throwing inside Drizzle", () => {
    assert.equal(parseDateParam("not-a-date"), null);
    assert.equal(parseDateParam("2024-13-45"), null);
    assert.equal(parseDateParam("'; DROP TABLE leads;--"), null);
  });

  it("parses valid ISO dates", () => {
    const parsed = parseDateParam("2024-05-01T00:00:00.000Z");
    assert.ok(parsed instanceof Date);
    assert.equal(parsed.toISOString(), "2024-05-01T00:00:00.000Z");
  });
});
