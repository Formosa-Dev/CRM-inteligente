/**
 * In-memory inbound message buffer for the channel inbound pipeline.
 *
 * Short-debounce batching: bursts of customer messages land in a per-
 * (channel, user) queue and are handed to the agent ONCE, as a batch, after
 * the conversation goes quiet — instead of one agent run per message.
 *
 * This is a process-local store (no Redis): the same trade-off AH Sports
 * made, and here it is backed by the durable `agent_inbound_jobs` queue —
 * a crash between enqueue and flush loses only the in-memory copy, and the
 * PG job rebuilds the turn from the already-persisted chat_messages rows.
 * The older `src/lib/buffer/*` (Redis/Upstash) stays for the telegram path;
 * channel inbound bypasses it entirely.
 *
 * Hard caps carried over: bounded batches (callback retries dead-letter
 * instead of looping), a per-key lock so overlapping flushes can't double-
 * dispatch, a sliding debounce, and level-2 content dedup that catches exact
 * resends within a 5s window even when the platform message id changed.
 */

import { createHash } from "node:crypto";

import type { ChannelKind } from "./types";

export interface BufferChannelConfig {
  debounceMs: number;
  lockTtlMs: number;
  maxBufferSize: number;
}

const DEFAULT_CONFIG: BufferChannelConfig = {
  debounceMs: 3_000,
  lockTtlMs: 300_000,
  maxBufferSize: 20,
};

export const BUFFER_CONFIG: Record<string, BufferChannelConfig> = {
  whatsapp: { ...DEFAULT_CONFIG }, // 3s sliding window
  telegram: { ...DEFAULT_CONFIG, debounceMs: 8_000 }, // 8s grace period
};

function configFor(channel: ChannelKind): BufferChannelConfig {
  return BUFFER_CONFIG[channel] ?? DEFAULT_CONFIG;
}

export interface BufferedMessage {
  content: string;
  messageId: string;
  timestamp: number;
  /** Optional structured payload kept alongside the text (e.g. media attrs). */
  contentAttributes?: unknown[];
  /**
   * Callback retry counter, incremented each time the batch is re-enqueued
   * after a processing failure.
   */
  attempt?: number;
}

/** A batch that exhausted its callback retries. Never dropped silently. */
export interface DeadLetterEntry {
  failedAt: number;
  attempts: number;
  messages: BufferedMessage[];
}

// ─── In-memory store ────────────────────────────────────────────────────────

interface InMemoryEntry {
  messages: BufferedMessage[];
  /** Timestamp of the last enqueue — the sliding debounce anchor. */
  timer: number;
  lock: boolean;
  /** When the lock was taken — bounds a hung flush (lockTtlMs). */
  lockAcquiredAt: number;
}

const inMemoryStore = new Map<string, InMemoryEntry>();
const inMemoryDeadLetters = new Map<string, DeadLetterEntry[]>();
const inMemoryDedup = new Map<string, { hash: string; ts: number }>();
const lastProcessedContent = new Map<string, string>();

const CLEANUP_INTERVAL = 5 * 60 * 1000;
const ENTRY_TTL = 10 * 60 * 1000;

const sweeper = setInterval(() => {
  const cutoff = Date.now() - ENTRY_TTL;
  for (const [key, entry] of inMemoryStore.entries()) {
    if (entry.timer < cutoff && !entry.lock) inMemoryStore.delete(key);
  }
  const dedupCutoff = Date.now() - 10_000;
  for (const [key, entry] of inMemoryDedup.entries()) {
    if (entry.ts < dedupCutoff) inMemoryDedup.delete(key);
  }
  if (lastProcessedContent.size > 1000) {
    // Emergency cleanup if the map grows unbounded.
    lastProcessedContent.clear();
  }
}, CLEANUP_INTERVAL);
// In Node runtimes the sweeper must not keep the process alive.
sweeper.unref?.();

function memKey(channel: ChannelKind, userId: string): string {
  return `${channel}:${userId}`;
}

/** Full normalized content fingerprint for the level-2 dedup. */
function contentHash(content: string): string {
  return createHash("sha256").update(content.toLowerCase().trim()).digest("hex");
}

function getOrCreateEntry(channel: ChannelKind, userId: string): InMemoryEntry {
  const key = memKey(channel, userId);
  if (!inMemoryStore.has(key)) {
    inMemoryStore.set(key, { messages: [], timer: 0, lock: false, lockAcquiredAt: 0 });
  }
  return inMemoryStore.get(key)!;
}

// ─── BufferManager ──────────────────────────────────────────────────────────

export const BufferManager = {
  /**
   * Append a message and slide the debounce window. Batches beyond
   * maxBufferSize keep the newest messages (the queue drops the oldest, so a
   * flood can't grow the pending batch without bound).
   */
  async enqueue(
    channel: ChannelKind,
    userId: string,
    message: BufferedMessage
  ): Promise<void> {
    const entry = getOrCreateEntry(channel, userId);
    entry.messages.push(message);
    const max = configFor(channel).maxBufferSize;
    if (entry.messages.length > max) {
      entry.messages.splice(0, entry.messages.length - max);
    }
    entry.timer = Date.now();
  },

  async acquireLock(channel: ChannelKind, userId: string): Promise<boolean> {
    const entry = getOrCreateEntry(channel, userId);
    const now = Date.now();
    const lockTtlMs = configFor(channel).lockTtlMs;
    if (entry.lock) {
      if (now - entry.lockAcquiredAt < lockTtlMs) return false;
      // A flush that never released (thrown outside its finally, leaked
      // await) would otherwise wedge this key forever — bound it.
      console.warn(
        `[buffer:lock] stale lock for ${channel}:${userTag(userId)} ` +
          `exceeded ${lockTtlMs}ms — reacquiring`
      );
    }
    entry.lock = true;
    entry.lockAcquiredAt = now;
    return true;
  },

  async releaseLock(channel: ChannelKind, userId: string): Promise<void> {
    const entry = inMemoryStore.get(memKey(channel, userId));
    if (entry) entry.lock = false;
  },

  async isTimerExpired(channel: ChannelKind, userId: string): Promise<boolean> {
    const entry = inMemoryStore.get(memKey(channel, userId));
    if (!entry) return true; // No entry = timer expired (e.g. process restart)
    return Date.now() - entry.timer >= configFor(channel).debounceMs;
  },

  async fetchAndClear(
    channel: ChannelKind,
    userId: string
  ): Promise<BufferedMessage[]> {
    const entry = inMemoryStore.get(memKey(channel, userId));
    if (!entry) return [];
    const messages = [...entry.messages];
    entry.messages = [];
    entry.timer = 0;
    return messages;
  },

  async hasNewMessages(channel: ChannelKind, userId: string): Promise<boolean> {
    const entry = inMemoryStore.get(memKey(channel, userId));
    return entry ? entry.messages.length > 0 : false;
  },

  /**
   * Durable failure signal: a batch that exhausted its callback retries is
   * pushed to a dead-letter list instead of being dropped. Inspectable via
   * getDeadLetters for ops/replay. Dead letters are rare — the list is
   * bounded implicitly by the small failure volume.
   */
  async enqueueDeadLetter(
    channel: ChannelKind,
    userId: string,
    entry: DeadLetterEntry
  ): Promise<void> {
    const key = memKey(channel, userId);
    const list = inMemoryDeadLetters.get(key) ?? [];
    list.push(entry);
    inMemoryDeadLetters.set(key, list);
  },

  async getDeadLetters(
    channel: ChannelKind,
    userId: string
  ): Promise<DeadLetterEntry[]> {
    return inMemoryDeadLetters.get(memKey(channel, userId)) ?? [];
  },

  /**
   * Level-2 content dedup: true when the same normalized content was seen in
   * the last 5 seconds. Compare-and-set is atomic here — the runtime is
   * single-threaded between the check and the write.
   */
  async isContentDuplicate(
    channel: ChannelKind,
    userId: string,
    content: string
  ): Promise<boolean> {
    const hash = contentHash(content);
    const dedupKey = `dedup:${channel}:${userId}`;
    const now = Date.now();
    const existing = inMemoryDedup.get(dedupKey);
    if (existing && existing.hash === hash && now - existing.ts < 5000) {
      return true;
    }
    inMemoryDedup.set(dedupKey, { hash, ts: now });
    return false;
  },
};

export function getLastProcessedContent(
  channel: ChannelKind,
  userId: string
): string | undefined {
  return lastProcessedContent.get(memKey(channel, userId));
}

export function setLastProcessedContent(
  channel: ChannelKind,
  userId: string,
  hash: string
): void {
  lastProcessedContent.set(memKey(channel, userId), hash);
}

// ─── Processor ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Maximum recursive re-processing depth — prevents infinite loops when
// messages keep arriving mid-processing (e.g. a very chatty user).
const MAX_REPROCESS_DEPTH = 3;

// Maximum times a batch is handed to processCallback before it is dead-
// lettered. The retry delay comes free: each re-enqueue resets the debounce
// timer, so retries ride the normal drain cadence instead of hot-looping.
const MAX_CALLBACK_ATTEMPTS = 3;

// userId is a customer phone / chat id — PII that must not reach logs. A
// truncated digest keeps per-user correlation across lock, process, and
// retry lines without storing the identifier itself.
const userTag = (userId: string): string =>
  createHash("sha256").update(userId).digest("hex").slice(0, 10);

/**
 * Main processing entry — called after enqueue. The outer loop re-checks
 * after releasing the lock: a message enqueued between the drain's final
 * hasNewMessages check and the lock release would otherwise be orphaned (its
 * own scheduleBufferProcessing call bailed on the held lock).
 */
export async function scheduleBufferProcessing(
  channel: ChannelKind,
  userId: string,
  processCallback: (messages: BufferedMessage[]) => Promise<void>
): Promise<void> {
  for (;;) {
    const locked = await BufferManager.acquireLock(channel, userId);
    if (!locked) {
      return; // another processor is handling this user
    }

    try {
      await processBufferLoop(channel, userId, processCallback, 0);
    } finally {
      await BufferManager.releaseLock(channel, userId);
    }

    if (!(await BufferManager.hasNewMessages(channel, userId))) return;
  }
}

async function processBufferLoop(
  channel: ChannelKind,
  userId: string,
  processCallback: (messages: BufferedMessage[]) => Promise<void>,
  depth: number
): Promise<void> {
  if (depth >= MAX_REPROCESS_DEPTH) {
    console.warn(
      `[buffer:interrupt] Max reprocess depth (${MAX_REPROCESS_DEPTH}) reached ` +
        `for ${channel}:${userTag(userId)}, stopping recursion`
    );
    return;
  }

  const config = configFor(channel);

  // Wait for the debounce timer to expire (sliding window).
  let attempts = 0;
  const maxAttempts = Math.ceil(config.debounceMs / 1000) + 5; // safety limit
  while (attempts < maxAttempts) {
    if (await BufferManager.isTimerExpired(channel, userId)) break;
    await sleep(1000);
    attempts++;
  }

  const messages = await BufferManager.fetchAndClear(channel, userId);
  if (messages.length === 0) return;

  try {
    await processCallback(messages);
  } catch (err) {
    console.error(
      `[buffer:process] Callback error for ${channel}:${userTag(userId)} ` +
        `(depth=${depth}):`,
      err instanceof Error ? err.message : err
    );
    // The batch was destructively fetched before the callback ran, so a
    // failed callback must never mean silent data loss. Re-enqueue it with
    // a bumped attempt counter (bounded); once retries are exhausted the
    // batch is dead-lettered instead of dropped. Returning here skips the
    // content-dedup block below — it would fetch-and-clear the re-enqueued
    // copy and mistake it for a new duplicate batch.
    const attempt = Math.max(0, ...messages.map((m) => m.attempt ?? 0)) + 1;
    if (attempt < MAX_CALLBACK_ATTEMPTS) {
      for (const m of messages) {
        await BufferManager.enqueue(channel, userId, { ...m, attempt });
      }
    } else {
      await BufferManager.enqueueDeadLetter(channel, userId, {
        failedAt: Date.now(),
        attempts: attempt,
        messages,
      });
      console.error(
        `[buffer:dead-letter] ${messages.length} msg(s) for ` +
          `${channel}:${userTag(userId)} exhausted ${MAX_CALLBACK_ATTEMPTS} ` +
          `callback attempts — moved to dead letter`
      );
    }
    // The outer loop's post-release hasNewMessages re-check picks the
    // re-enqueued batch up on the next drain.
    return;
  }

  // Graceful interruption: check if new messages arrived during processing.
  if (await BufferManager.hasNewMessages(channel, userId)) {
    const processedHash = messages.map((m) => m.content).join("|").slice(0, 200);
    const newMsgs = await BufferManager.fetchAndClear(channel, userId);
    const newHash = newMsgs.map((m) => m.content).join("|").slice(0, 200);

    if (
      newHash === processedHash ||
      newHash === getLastProcessedContent(channel, userId)
    ) {
      setLastProcessedContent(channel, userId, newHash);
      return; // Identical content — don't re-process.
    }

    // Put messages back and re-process (different content).
    for (const msg of newMsgs) {
      await BufferManager.enqueue(channel, userId, msg);
    }
    setLastProcessedContent(channel, userId, newHash);
    await processBufferLoop(channel, userId, processCallback, depth + 1);
  }
}
