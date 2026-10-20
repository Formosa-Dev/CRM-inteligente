/**
 * F8 — webhook ingress guards: oversized bodies must be rejected BEFORE the
 * route buffers them, both by declared Content-Length and by actual size.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_WEBHOOK_BODY_BYTES,
  MAX_WEBHOOK_EVENTS,
  readBoundedBody,
} from "./webhook-guard";

function fakeRequest(
  body: string,
  headers: Record<string, string> = {}
): { headers: Headers; text: () => Promise<string> } {
  return {
    headers: new Headers(headers),
    text: async () => body,
  };
}

describe("readBoundedBody", () => {
  it("rejects on declared Content-Length without reading the body", async () => {
    let read = false;
    const req = {
      headers: new Headers({ "content-length": String(MAX_WEBHOOK_BODY_BYTES + 1) }),
      text: async () => {
        read = true;
        return "x";
      },
    };
    const res = await readBoundedBody(req);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "declared-too-large");
    assert.equal(read, false, "body must never be buffered");
  });

  it("rejects bodies that exceed the cap despite a small/absent Content-Length", async () => {
    const body = "x".repeat(1025);
    const res = await readBoundedBody(fakeRequest(body), 1024);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, "body-too-large");
  });

  it("a lying small Content-Length still fails on the actual body", async () => {
    const body = "x".repeat(2048);
    const res = await readBoundedBody(
      fakeRequest(body, { "content-length": "10" }),
      1024
    );
    assert.equal(res.ok, false);
  });

  it("accepts bodies within the cap and returns the raw text", async () => {
    const body = JSON.stringify({ type: "ok", data: [1, 2, 3] });
    const res = await readBoundedBody(
      fakeRequest(body, { "content-length": String(body.length) })
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.rawBody, body);
  });

  it("a custom lower cap applies", async () => {
    const res = await readBoundedBody(fakeRequest("x".repeat(100)), 64);
    assert.equal(res.ok, false);
  });
});

describe("MAX_WEBHOOK_EVENTS", () => {
  it("is a sane envelope cap", () => {
    assert.equal(MAX_WEBHOOK_EVENTS, 100);
  });
});
