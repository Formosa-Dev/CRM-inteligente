import { createHash } from "node:crypto";
import { BufferManager, type BufferedMessage, getLastProcessedContent, setLastProcessedContent } from "./manager";
import { BUFFER_CONFIG, type Channel } from "./config";

// Sleep utility
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Maximum recursive re-processing depth — prevents infinite loops when messages
// keep arriving mid-processing (e.g. a very chatty user).
const MAX_REPROCESS_DEPTH = 3;

// Maximum times a batch is handed to processCallback before it is dead-
// lettered. The retry delay comes free: each re-enqueue resets the debounce
// timer, so retries ride the normal drain cadence instead of hot-looping.
const MAX_CALLBACK_ATTEMPTS = 3;

// userId is a customer phone / telegram chat id — PII that must not reach
// logs (F4). A truncated digest keeps per-user correlation across lock,
// process, and retry lines without storing the identifier itself.
const userTag = (userId: string): string =>
  createHash("sha256").update(userId).digest("hex").slice(0, 10);

// Main processing function — called after enqueue
export async function scheduleBufferProcessing(
  channel: Channel,
  userId: string,
  processCallback: (messages: BufferedMessage[]) => Promise<void>
): Promise<void> {
  // A-50 tail race: a message enqueued between the drain's final
  // hasNewMessages check and the lock release is orphaned — its own
  // scheduleBufferProcessing call bailed on our held lock. Re-check AFTER
  // releasing and re-enter the drain while anything remains queued.
  for (;;) {
    // Try to acquire lock — if someone else is processing, bail
    const locked = await BufferManager.acquireLock(channel, userId);
    if (!locked) {
      console.log(`[buffer:lock] Lock already held for ${channel}:${userTag(userId)}, skipping`);
      return; // another processor is handling this user
    }

    console.log(`[buffer:lock] Acquired lock for ${channel}:${userTag(userId)}`);

    try {
      await processBufferLoop(channel, userId, processCallback, 0);
    } finally {
      await BufferManager.releaseLock(channel, userId);
      console.log(`[buffer:lock] Released lock for ${channel}:${userTag(userId)}`);
    }

    if (!(await BufferManager.hasNewMessages(channel, userId))) return;
    console.log(
      `[buffer:tail] Messages arrived during lock release for ${channel}:${userTag(userId)} — re-entering drain`
    );
  }
}

async function processBufferLoop(
  channel: Channel,
  userId: string,
  processCallback: (messages: BufferedMessage[]) => Promise<void>,
  depth: number
): Promise<void> {
  if (depth >= MAX_REPROCESS_DEPTH) {
    console.warn(
      `[buffer:interrupt] Max reprocess depth (${MAX_REPROCESS_DEPTH}) reached for ${channel}:${userTag(userId)}, stopping recursion`
    );
    return;
  }

  const config = BUFFER_CONFIG[channel];

  // Wait for the debounce timer to expire (sliding window)
  let attempts = 0;
  const maxAttempts = Math.ceil(config.debounceMs / 1000) + 5; // safety limit

  while (attempts < maxAttempts) {
    const expired = await BufferManager.isTimerExpired(channel, userId);
    if (expired) break;

    await sleep(1000); // check every second
    attempts++;
  }

  console.log(`[buffer:process] Timer expired or max attempts reached for ${channel}:${userTag(userId)} after ${attempts}s`);

  // Fetch all buffered messages
  const messages = await BufferManager.fetchAndClear(channel, userId);

  if (messages.length === 0) return;

    console.log(
      `[buffer:process] Start — ${messages.length} msgs for ${channel}:${userTag(userId)} (depth=${depth})`
    );

    try {
      console.log(`[buffer:process] About to call processCallback for ${channel}:${userTag(userId)}`);
      await processCallback(messages);
      console.log(`[buffer:process] Done for ${channel}:${userTag(userId)} (depth=${depth})`);
    } catch (err) {
      console.error(
        `[buffer:process] Callback error for ${channel}:${userTag(userId)} (depth=${depth}):`,
        err instanceof Error ? err.message : err,
        err instanceof Error ? err.stack : ''
      );
      // A-11 — the batch was destructively fetched before the callback ran,
      // so a failed callback must never mean silent data loss. Re-enqueue
      // it with a bumped attempt counter (bounded); once retries are
      // exhausted the batch is dead-lettered durably instead of dropped.
      // Returning here skips the content-dedup block below — it would
      // fetch-and-clear the re-enqueued copy and mistake it for a new
      // duplicate batch.
      const attempts = Math.max(0, ...messages.map((m) => m.attempt ?? 0)) + 1;
      if (attempts < MAX_CALLBACK_ATTEMPTS) {
        for (const m of messages) {
          await BufferManager.enqueue(channel, userId, { ...m, attempt: attempts });
        }
        console.warn(
          `[buffer:retry] Re-enqueued ${messages.length} msg(s) for ${channel}:${userTag(userId)} (attempt ${attempts + 1}/${MAX_CALLBACK_ATTEMPTS})`
        );
      } else {
        await BufferManager.enqueueDeadLetter(channel, userId, {
          failedAt: Date.now(),
          attempts,
          messages,
        });
        console.error(
          `[buffer:dead-letter] ${messages.length} msg(s) for ${channel}:${userTag(userId)} exhausted ${MAX_CALLBACK_ATTEMPTS} callback attempts — moved to dead letter`
        );
      }
      // The outer loop's post-release hasNewMessages re-check picks the
      // re-enqueued batch up on the next drain.
      return;
    }

  // GRACEFUL INTERRUPTION: check if new messages arrived during processing
  const hasNew = await BufferManager.hasNewMessages(channel, userId);
  if (hasNew) {
    // Compute content hash of what was just processed to compare later
    const processedHash = messages.map((m) => m.content).join("|").slice(0, 200);

    // Fetch new messages and check if they're content-duplicates
    const newMsgs = await BufferManager.fetchAndClear(channel, userId);
    const newHash = newMsgs.map((m) => m.content).join("|").slice(0, 200);

    if (newHash === processedHash || newHash === getLastProcessedContent(channel, userId)) {
      console.log(
        `[buffer:interrupt] Content-duplicate detected for ${channel}:${userTag(userId)}, skipping re-process (depth=${depth})`
      );
      setLastProcessedContent(channel, userId, newHash);
      return; // Don't re-process — content is identical to what was just handled
    }

    // Put messages back and re-process (different content)
    for (const msg of newMsgs) {
      await BufferManager.enqueue(channel, userId, msg);
    }

    setLastProcessedContent(channel, userId, newHash);
    console.log(
      `[buffer:interrupt] New (different) messages during processing for ${channel}:${userTag(userId)}, re-processing (depth=${depth + 1})`
    );
    await processBufferLoop(channel, userId, processCallback, depth + 1);
  }
}
