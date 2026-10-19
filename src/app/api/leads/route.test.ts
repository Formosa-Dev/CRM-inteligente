import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";

import { POST } from "./route";
import { isUniqueViolation, parseDateParam } from "./helpers";

function postRequest(body: string): NextRequest {
  return new NextRequest("https://example.test/api/leads", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/leads hardening", () => {
  it("rejects a phone that normalizes to an empty string", async () => {
    const res = await POST(postRequest(JSON.stringify({ phone: "abc" })));
    assert.equal(res.status, 400);
  });

  it("rejects phones shorter than 7 digits after normalization", async () => {
    const res = await POST(postRequest(JSON.stringify({ phone: "+54 123" })));
    assert.equal(res.status, 400);
  });

  it("rejects a missing phone", async () => {
    const res = await POST(postRequest(JSON.stringify({ name: "x" })));
    assert.equal(res.status, 400);
  });

  it("rejects a non-JSON body with 400 instead of a 500", async () => {
    const res = await POST(postRequest("not json {{{"));
    assert.equal(res.status, 400);
  });

  it("rejects oversized bodies even without a content-length fast path", async () => {
    const res = await POST(
      postRequest(JSON.stringify({ phone: "5491111111111", notes: "x".repeat(9000) }))
    );
    assert.equal(res.status, 413);
  });

  it("flags unique violations by code and by message", () => {
    assert.equal(isUniqueViolation({ code: "23505" }), true);
    assert.equal(
      isUniqueViolation(new Error('duplicate key value violates unique constraint "leads_phone_key"')),
      true
    );
    assert.equal(isUniqueViolation(new Error("connection refused")), false);
    assert.equal(isUniqueViolation(null), false);
  });
});

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
