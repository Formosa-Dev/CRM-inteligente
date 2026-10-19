import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
});

describe("callback failure handling (A-11)", () => {
  it("re-enqueues a failed batch and retries instead of losing user input", async () => {
    const user = "u-retry";
    const timer = mock.method(BufferManager, "isTimerExpired", async () => true);
    const batches: string[][] = [];
    let calls = 0;

    try {
      await BufferManager.enqueue("whatsapp", user, msg("hi"));
      await scheduleBufferProcessing("whatsapp", user, async (msgs) => {
        calls += 1;
        batches.push(msgs.map((m) => m.content));
        if (calls === 1) throw new Error("send blew up");
      });
    } finally {
      timer.mock.restore();
    }

    // The failed batch came back around the drain — same content retried,
    // nothing lost, nothing dead-lettered.
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[0], ["hi"]);
    assert.deepEqual(batches[1], ["hi"]);
    assert.deepEqual(await BufferManager.getDeadLetters("whatsapp", user), []);
  });

  it("dead-letters the batch after exhausting retries instead of dropping it", async () => {
    const user = "u-deadletter";
    const timer = mock.method(BufferManager, "isTimerExpired", async () => true);
    let calls = 0;

    try {
      await BufferManager.enqueue("whatsapp", user, msg("poison"));
      await scheduleBufferProcessing("whatsapp", user, async () => {
        calls += 1;
        throw new Error("always fails");
      });
    } finally {
      timer.mock.restore();
    }

    assert.equal(calls, 3); // 1 initial attempt + 2 bounded retries
    const dead = await BufferManager.getDeadLetters("whatsapp", user);
    assert.equal(dead.length, 1);
    assert.deepEqual(dead[0].messages.map((m) => m.content), ["poison"]);
    assert.equal(dead[0].attempts, 3);
    // Nothing left looping in the live buffer either.
    assert.equal(await BufferManager.hasNewMessages("whatsapp", user), false);
  });
});

describe("send-first persistence ordering (A-11)", () => {
  it("the reply path persists via onBubbleSent — no pre-send assistant row", () => {
    const pipeline = readFileSync("src/lib/messaging/inbound-pipeline.ts", "utf8");
    const cbStart = pipeline.indexOf("scheduleBufferProcessing(");
    const cb = pipeline.slice(cbStart, pipeline.indexOf("}).catch(", cbStart));

    // No whole-reply assistant insert survives ahead of the sends…
    assert.equal(
      cb.includes('insertMessage(conversationId, "assistant", reply'),
      false
    );
    assert.equal(
      cb.includes('insertMessage(conversationId, "assistant", responseText'),
      false
    );
    // …both bubble sends persist through the per-bubble callback…
    const onBubble = cb.match(/onBubbleSent: persistSentBubble/g) ?? [];
    assert.equal(onBubble.length, 2);
    // …and that callback stores each fragment with its own providerMessageId.
    const fn = cb.slice(cb.indexOf("persistSentBubble = async"));
    assert.match(fn, /insertMessage\(\s*conversationId,\s*"assistant",\s*bubble\.text/);
    assert.match(fn, /bubble\.providerMessageId \|\| undefined/);
  });
});

describe("scheduleBufferProcessing — lock contention", () => {
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
