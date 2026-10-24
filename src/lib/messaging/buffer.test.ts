import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BufferManager,
  getLastProcessedContent,
  setLastProcessedContent,
  type BufferedMessage,
} from "./buffer";

// The channel inbound buffer is a process-local store (the durable shadow is
// agent_inbound_jobs). These tests pin the semantics the pipeline relies on:
// bounded batches, per-key locks, sliding debounce, content dedup, and
// dead-letter capture — all keyed by (channel, userId).

function msg(content: string, messageId = content): BufferedMessage {
  return { content, messageId, timestamp: Date.now() };
}

describe("messaging buffer — per-key state", () => {
  it("keeps buffered state isolated per channel+user key", async () => {
    await BufferManager.enqueue("whatsapp", "s34:a", msg("m1"));
    assert.equal(await BufferManager.hasNewMessages("whatsapp", "s34:a"), true);
    assert.equal(await BufferManager.hasNewMessages("whatsapp", "s34:b"), false);
    assert.equal(await BufferManager.hasNewMessages("telegram", "s34:a"), false);
  });

  it("fetchAndClear drains the batch and resets the debounce anchor", async () => {
    await BufferManager.enqueue("whatsapp", "s34:drain", msg("one"));
    await BufferManager.enqueue("whatsapp", "s34:drain", msg("two"));
    const batch = await BufferManager.fetchAndClear("whatsapp", "s34:drain");
    assert.equal(batch.length, 2);
    assert.deepEqual(batch.map((m) => m.content), ["one", "two"]);
    assert.equal(await BufferManager.hasNewMessages("whatsapp", "s34:drain"), false);
    assert.equal((await BufferManager.fetchAndClear("whatsapp", "s34:drain")).length, 0);
  });

  it("bounds the batch to maxBufferSize, keeping the newest messages", async () => {
    for (let i = 0; i < 30; i++) {
      await BufferManager.enqueue("whatsapp", "s34:cap", msg(`m${i}`));
    }
    const batch = await BufferManager.fetchAndClear("whatsapp", "s34:cap");
    assert.equal(batch.length, 20);
    assert.equal(batch[0]?.content, "m10");
    assert.equal(batch.at(-1)?.content, "m29");
  });

  it("keeps contentAttributes alongside the buffered message", async () => {
    await BufferManager.enqueue("whatsapp", "s34:attrs", {
      content: "[Imagen recibida]",
      messageId: "wamid.attrs",
      timestamp: Date.now(),
      contentAttributes: [{ type: "image", url: "/api/media/1/x.jpg" }],
    });
    const [buffered] = await BufferManager.fetchAndClear("whatsapp", "s34:attrs");
    assert.deepEqual(buffered?.contentAttributes, [{ type: "image", url: "/api/media/1/x.jpg" }]);
  });
});

describe("messaging buffer — lock", () => {
  it("admits one holder per key and frees on release", async () => {
    assert.equal(await BufferManager.acquireLock("whatsapp", "s34:lock"), true);
    assert.equal(await BufferManager.acquireLock("whatsapp", "s34:lock"), false);
    assert.equal(await BufferManager.acquireLock("whatsapp", "s34:lock2"), true);
    await BufferManager.releaseLock("whatsapp", "s34:lock");
    assert.equal(await BufferManager.acquireLock("whatsapp", "s34:lock"), true);
  });
});

describe("messaging buffer — level-2 content dedup", () => {
  it("flags an identical resend inside the 5s window, scoped per key", async () => {
    assert.equal(await BufferManager.isContentDuplicate("whatsapp", "s34:dd", "hola"), false);
    assert.equal(await BufferManager.isContentDuplicate("whatsapp", "s34:dd", "hola"), true);
    assert.equal(await BufferManager.isContentDuplicate("whatsapp", "s34:dd2", "hola"), false);
    // Normalized content: case/whitespace differences still collide.
    assert.equal(await BufferManager.isContentDuplicate("whatsapp", "s34:dd3", "HOLA"), false);
    assert.equal(await BufferManager.isContentDuplicate("whatsapp", "s34:dd3", "  hola  "), true);
  });
});

describe("messaging buffer — dead letters + processed content", () => {
  it("captures exhausted batches for ops replay", async () => {
    const before = await BufferManager.getDeadLetters("whatsapp", "s34:dlq");
    assert.equal(before.length, 0);
    await BufferManager.enqueueDeadLetter("whatsapp", "s34:dlq", {
      failedAt: Date.now(),
      attempts: 3,
      messages: [msg("lost-1"), msg("lost-2")],
    });
    const dead = await BufferManager.getDeadLetters("whatsapp", "s34:dlq");
    assert.equal(dead.length, 1);
    assert.equal(dead[0]?.messages.length, 2);
    assert.equal(dead[0]?.attempts, 3);
  });

  it("tracks last-processed content per key for the interrupt dedup", () => {
    assert.equal(getLastProcessedContent("whatsapp", "s34:lp"), undefined);
    setLastProcessedContent("whatsapp", "s34:lp", "hash-1");
    assert.equal(getLastProcessedContent("whatsapp", "s34:lp"), "hash-1");
    assert.equal(getLastProcessedContent("whatsapp", "s34:lp2"), undefined);
  });
});
