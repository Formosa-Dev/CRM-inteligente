import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { BufferManager, type BufferedMessage } from "./manager";
import { scheduleBufferProcessing } from "./processor";

// In-memory BufferManager (no UPSTASH_REDIS_* in test env). Deterministic
// timing: isTimerExpired is mocked to expire instantly so tests never sleep.

function msg(content: string, messageId = `m-${content}`): BufferedMessage {
  return { content, messageId, timestamp: Date.now() };
}

describe("scheduleBufferProcessing — tail race re-check (A-50)", () => {
  it("re-enters the drain for a message enqueued between the last check and lock release", async () => {
    const user = "u-tail-race";
    const processed: BufferedMessage[][] = [];

    const realHasNew = BufferManager.hasNewMessages.bind(BufferManager);
    const realEnqueue = BufferManager.enqueue.bind(BufferManager);

    let hasNewCalls = 0;
    const hasNew = mock.method(
      BufferManager,
      "hasNewMessages",
      async (channel: "whatsapp" | "telegram", userId: string) => {
        hasNewCalls += 1;
        if (hasNewCalls === 1) {
          // Producer lands a message just as the in-loop check runs: its own
          // scheduleBufferProcessing call bails on the held lock, so without
          // the post-release re-check this message would sit orphaned until
          // the next inbound.
          await realEnqueue(channel, userId, msg("late"));
          return false; // the in-loop caller still sees the pre-enqueue state
        }
        return realHasNew(channel, userId);
      }
    );
    const timer = mock.method(BufferManager, "isTimerExpired", async () => true);

    try {
      await realEnqueue("whatsapp", user, msg("first"));
      await scheduleBufferProcessing("whatsapp", user, async (msgs) => {
        processed.push(msgs);
      });
    } finally {
      hasNew.mock.restore();
      timer.mock.restore();
    }

    assert.equal(processed.length, 2);
    assert.deepEqual(processed[0].map((m) => m.content), ["first"]);
    assert.deepEqual(processed[1].map((m) => m.content), ["late"]);
    // Buffer fully drained — nothing orphaned.
    assert.equal(await realHasNew("whatsapp", user), false);
  });

  it("leaves the buffer alone when the lock is already held", async () => {
    const user = "u-lock-held";
    const realAcquire = BufferManager.acquireLock.bind(BufferManager);
    const realEnqueue = BufferManager.enqueue.bind(BufferManager);

    assert.equal(await realAcquire("whatsapp", user), true);
    let calls = 0;
    try {
      await realEnqueue("whatsapp", user, msg("queued"));
      await scheduleBufferProcessing("whatsapp", user, async () => {
        calls += 1;
      });
    } finally {
      await BufferManager.releaseLock("whatsapp", user);
    }
    assert.equal(calls, 0);
    // Cleanup: drain manually so no state leaks into other tests.
    await BufferManager.fetchAndClear("whatsapp", user);
  });
});
