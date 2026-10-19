import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { GET } from "./route";

/**
 * /api/media/[...path] serves files under public/uploads — inbound customer
 * conversation media only (product images live in Cloudinary). It must reject
 * unauthenticated callers; outside a request scope auth() throws, which is
 * exactly the unauthenticated path here.
 */
test("rejects unauthenticated requests with 401", async () => {
  const req = new NextRequest("https://example.test/api/media/1/voice.ogg");
  const res = await GET(req, { params: Promise.resolve({ path: ["1", "voice.ogg"] }) });
  assert.equal(res.status, 401);
});
