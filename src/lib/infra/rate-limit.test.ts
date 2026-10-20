import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkRateLimit, clientIpFromRequest } from "./rate-limit";

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

/**
 * F3: the shared ceiling is namespaced per bucket. Saturating one purpose's
 * bucket (e.g. unauthenticated flood of /api/leads) must never starve another
 * purpose (e.g. inbound message processing) — the old single "global" bucket
 * allowed exactly that and silently dropped inbound messages.
 *
 * The limiter is process-global state; each test uses unique bucket names so
 * cases don't consume each other's windows.
 */
let bucketSeq = 0;
const uniqueBucket = () => `t-bucket-${++bucketSeq}`;

describe("checkRateLimit — namespaced buckets", () => {
  it("a saturated bucket cannot starve a different bucket", async () => {
    const a = uniqueBucket();
    const b = uniqueBucket();
    // 100/min shared ceiling per bucket — exhaust `a` with distinct keys so
    // the per-key window (20) is not what trips.
    for (let i = 0; i < 100; i++) {
      const r = await checkRateLimit(`k${i}`, { bucket: a });
      assert.equal(r.success, true, `call ${i} in bucket ${a}`);
    }
    const blocked = await checkRateLimit("extra-key", { bucket: a });
    assert.equal(blocked.success, false);

    const free = await checkRateLimit("extra-key", { bucket: b });
    assert.equal(free.success, true);
  });

  it("per-key window still applies inside its bucket", async () => {
    const bucket = uniqueBucket();
    for (let i = 0; i < 20; i++) {
      const r = await checkRateLimit("same-key", { bucket });
      assert.equal(r.success, true);
    }
    assert.equal((await checkRateLimit("same-key", { bucket })).success, false);
  });

  it("derives the bucket from the key prefix when none is given", async () => {
    const prefix = `t-derive-${++bucketSeq}`;
    // Keys `${prefix}:<id>` derive bucket "${prefix}" — distinct keys keep the
    // per-key window green while the bucket fills.
    for (let i = 0; i < 100; i++) {
      await checkRateLimit(`${prefix}:k${i}`);
    }
    assert.equal((await checkRateLimit(`${prefix}:extra`)).success, false);
    // A different purpose/prefix has an independent bucket.
    assert.equal((await checkRateLimit(`t-derive-other-${bucketSeq}:x`)).success, true);
  });

  it("inbound-style account-scoped keys isolate buckets per account", async () => {
    // `wa-inbound:acct42:<phone>` derives bucket `wa-inbound:acct42` — a flood
    // against one account's bucket can't starve another account's inbound.
    const acctA = ++bucketSeq;
    const acctB = ++bucketSeq;
    for (let i = 0; i < 100; i++) {
      await checkRateLimit(`wa-inbound:acct${acctA}:k${i}`);
    }
    assert.equal(
      (await checkRateLimit(`wa-inbound:acct${acctA}:extra`)).success,
      false,
    );
    assert.equal(
      (await checkRateLimit(`wa-inbound:acct${acctB}:k0`)).success,
      true,
    );
  });
});
