import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  handlePoppedPayload,
  type QueueOutcomeDeps,
  type QueuePayload,
} from "./worker";

function deps(over: Partial<QueueOutcomeDeps> = {}): QueueOutcomeDeps {
  return {
    process: async () => "ok",
    requeue: async () => undefined,
    deadLetter: async () => undefined,
    sleep: async () => undefined,
    ...over,
  };
}

function payload(retryCount = 0): QueuePayload {
  return { chatId: "chat-1", type: "whatsapp", timestamp: 1, retryCount };
}

describe("queue popper never loses an unexpected throw", () => {
  it("re-enqueues with an incremented retryCount", async () => {
    const requeued: QueuePayload[] = [];
    const result = await handlePoppedPayload(
      payload(),
      deps({
        process: async () => {
          throw new Error("boom");
        },
        requeue: async (item) => {
          requeued.push({ ...item });
        },
      })
    );
    assert.equal(result, "retry");
    assert.equal(requeued.length, 1);
    assert.equal(requeued[0].retryCount, 1);
  });

  it("moves to the DLQ after the retry budget is spent", async () => {
    const dead: QueuePayload[] = [];
    const result = await handlePoppedPayload(
      payload(2),
      deps({
        process: async () => {
          throw new Error("boom");
        },
        deadLetter: async (item) => {
          dead.push({ ...item });
        },
      })
    );
    assert.equal(result, "dlq");
    assert.equal(dead.length, 1);
    assert.equal(dead[0].retryCount, 3);
  });

  it("falls back to the DLQ when re-enqueue fails", async () => {
    const dead: QueuePayload[] = [];
    const result = await handlePoppedPayload(
      payload(),
      deps({
        process: async () => "retry",
        requeue: async () => {
          throw new Error("redis down");
        },
        deadLetter: async (item) => {
          dead.push({ ...item });
        },
      })
    );
    assert.equal(result, "dlq");
    assert.equal(dead.length, 1);
  });
});
