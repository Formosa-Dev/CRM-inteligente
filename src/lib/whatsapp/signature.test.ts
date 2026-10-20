/**
 * F8 — YCloud signature timestamp window. The acceptance interval is
 * asymmetric: [now - 300s, now + 30s]. The previous symmetric ±300s check let
 * a captured signature stay valid far into the future.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import {
  verifyYCloudSignature,
  YCLOUD_MAX_FUTURE_SKEW_SEC,
  ycloudTimestampInWindow,
} from "./signature";

const SECRET = "whsec_signature_window_fixture";
const BODY = '{"type":"test"}';

function sign(body: string, timestamp: number, secret = SECRET): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},s=${digest}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

describe("verifyYCloudSignature — timestamp acceptance window", () => {
  it("accepts a fresh timestamp", () => {
    assert.equal(verifyYCloudSignature(BODY, sign(BODY, nowSec()), SECRET), true);
  });

  it("accepts timestamps inside the bounds: -295s and +29s", () => {
    // -295/+29 rather than the exact bounds — a mid-test clock tick can't
    // flip the assertion.
    assert.equal(
      verifyYCloudSignature(BODY, sign(BODY, nowSec() - 295), SECRET),
      true
    );
    assert.equal(
      verifyYCloudSignature(
        BODY,
        sign(BODY, nowSec() + YCLOUD_MAX_FUTURE_SKEW_SEC - 1),
        SECRET
      ),
      true
    );
  });

  it("rejects a timestamp older than 300s", () => {
    assert.equal(
      verifyYCloudSignature(BODY, sign(BODY, nowSec() - 301), SECRET),
      false
    );
  });

  it("rejects future timestamps past the 30s skew allowance", () => {
    // The old Math.abs check accepted these — a replay captured now stayed
    // valid for up to 300 future seconds.
    assert.equal(
      verifyYCloudSignature(
        BODY,
        sign(BODY, nowSec() + YCLOUD_MAX_FUTURE_SKEW_SEC + 1),
        SECRET
      ),
      false
    );
    assert.equal(
      verifyYCloudSignature(BODY, sign(BODY, nowSec() + 300), SECRET),
      false
    );
  });
});

describe("ycloudTimestampInWindow", () => {
  it("mirrors the [now-maxAge, now+skew] interval", () => {
    const now = 1_000_000;
    assert.equal(ycloudTimestampInWindow(now, 300, now), true);
    assert.equal(ycloudTimestampInWindow(now - 300, 300, now), true);
    assert.equal(ycloudTimestampInWindow(now - 301, 300, now), false);
    assert.equal(ycloudTimestampInWindow(now + 30, 300, now), true);
    assert.equal(ycloudTimestampInWindow(now + 31, 300, now), false);
  });
});
