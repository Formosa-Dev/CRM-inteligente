import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clientIpFromRequest } from "./rate-limit";

function req(headers: Record<string, string>) {
  return new Request("https://example.test", { headers });
}

describe("clientIpFromRequest", () => {
  it("trusts only the right-most x-forwarded-for hop", () => {
    // The left entries are client-supplied; the last one was appended by the
    // trusted edge proxy that actually saw the peer.
    assert.equal(
      clientIpFromRequest(req({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" })),
      "2.2.2.2"
    );
    assert.equal(
      clientIpFromRequest(req({ "x-forwarded-for": "spoofed, 9.9.9.9 , " })),
      "9.9.9.9"
    );
  });

  it("falls back to x-real-ip, then a fixed unknown bucket", () => {
    assert.equal(clientIpFromRequest(req({ "x-real-ip": "7.7.7.7" })), "7.7.7.7");
    assert.equal(clientIpFromRequest(req({})), "unknown");
  });
});
