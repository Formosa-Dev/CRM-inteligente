import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BufferManager } from "./manager";

// In-memory fallback path (no UPSTASH_REDIS_* in the test env) — the dedup
// contract is identical on both backends: same content within 5s → duplicate.

describe("BufferManager.isContentDuplicate — full-content dedup (A-50)", () => {
  it("does not collapse distinct messages that share a 50-char prefix", async () => {
    const user = "u-dedup-prefix";
    const prefix = "a".repeat(60); // > the old 50-char comparison window
    const first = `${prefix}-uno`;
    const second = `${prefix}-dos`;

    assert.equal(await BufferManager.isContentDuplicate("whatsapp", user, first), false);
    // The old first-50-chars hash made these identical — must NOT dedup.
    assert.equal(await BufferManager.isContentDuplicate("whatsapp", user, second), false);
    // A real resend of the second message still dedups.
    assert.equal(await BufferManager.isContentDuplicate("whatsapp", user, second), true);
  });

  it("normalizes case and surrounding whitespace before hashing", async () => {
    const user = "u-dedup-norm";
    assert.equal(await BufferManager.isContentDuplicate("whatsapp", user, "  Hola Mundo  "), false);
    assert.equal(await BufferManager.isContentDuplicate("whatsapp", user, "hola mundo"), true);
  });

  it("keeps dedup slots isolated per channel:user", async () => {
    assert.equal(await BufferManager.isContentDuplicate("whatsapp", "u-dedup-a", "mismo"), false);
    assert.equal(await BufferManager.isContentDuplicate("whatsapp", "u-dedup-b", "mismo"), false);
    assert.equal(await BufferManager.isContentDuplicate("telegram", "u-dedup-a", "mismo"), false);
    assert.equal(await BufferManager.isContentDuplicate("whatsapp", "u-dedup-a", "mismo"), true);
  });
});
