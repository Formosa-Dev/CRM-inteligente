import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";

import { GET as businessGET } from "./business/route";
import { GET as whatsappPhoneGET } from "./whatsapp-phone/route";

/**
 * The public GET endpoints sit behind the shared rate limiter
 * (20 req/min per key, in-memory when Upstash isn't configured). Without a
 * forwarded hop every test request lands in the same "unknown" bucket, so the
 * 21st call must 429.
 */
const LIMIT = 20;

function req(path: string): NextRequest {
  return new NextRequest(`https://example.test${path}`);
}

describe("public GET rate limits", () => {
  it("429s /api/business past the per-key limit", async () => {
    let status = 0;
    for (let i = 0; i < LIMIT; i++) {
      status = (await businessGET(req("/api/business"))).status;
    }
    assert.equal(status, 200);
    assert.equal((await businessGET(req("/api/business"))).status, 429);
  });

  it("429s /api/whatsapp-phone past the per-key limit", async () => {
    for (let i = 0; i < LIMIT; i++) {
      await whatsappPhoneGET(req("/api/whatsapp-phone"));
    }
    assert.equal((await whatsappPhoneGET(req("/api/whatsapp-phone"))).status, 429);
  });
});
