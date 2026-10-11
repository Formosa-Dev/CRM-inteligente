import { redis } from "./redis";
import { BUFFER_CONFIG, type Channel } from "./config";

function bufferKey(channel: Channel, userId: string) {
  return `buffer:${channel}:${userId}`;
}

function timerKey(channel: Channel, userId: string) {
  return `timer:${channel}:${userId}`;
}

function lockKey(channel: Channel, userId: string) {
  return `lock:${channel}:${userId}`;
}

export interface BufferedMessage {
  content: string;
  messageId: string;
  timestamp: number;
  contentAttributes?: unknown[];
}

// ─── In-Memory Fallback (cuando Redis no está disponible) ───────────────────
interface InMemoryEntry {
  messages: BufferedMessage[];
  timer: number; // timestamp del último enqueue
  lock: boolean;
}

const inMemoryStore = new Map<string, InMemoryEntry>();

// Cleanup cada 5 min: borra entradas con más de 10 min de inactividad
const CLEANUP_INTERVAL = 5 * 60 * 1000;
const ENTRY_TTL = 10 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - ENTRY_TTL;
  for (const [key, entry] of inMemoryStore.entries()) {
    if (entry.timer < cutoff) {
      inMemoryStore.delete(key);
    }
  }
}, CLEANUP_INTERVAL);

function memKey(channel: Channel, userId: string): string {
  return `${channel}:${userId}`;
}

function getOrCreateEntry(channel: Channel, userId: string): InMemoryEntry {
  const key = memKey(channel, userId);
  if (!inMemoryStore.has(key)) {
    inMemoryStore.set(key, { messages: [], timer: 0, lock: false });
  }
  return inMemoryStore.get(key)!;
}

// ─── BufferManager ──────────────────────────────────────────────────────────

export const BufferManager = {
  async enqueue(channel: Channel, userId: string, message: BufferedMessage): Promise<void> {
    const config = BUFFER_CONFIG[channel];

    if (redis) {
      const bKey = bufferKey(channel, userId);
      const tKey = timerKey(channel, userId);
      await redis.rpush(bKey, JSON.stringify(message));
      const debounceSeconds = Math.ceil(config.debounceMs / 1000);
      await redis.set(tKey, Date.now().toString(), { ex: debounceSeconds });
      await redis.expire(bKey, 600);
    } else {
      const entry = getOrCreateEntry(channel, userId);
      entry.messages.push(message);
      entry.timer = Date.now();
    }
  },

  async acquireLock(channel: Channel, userId: string): Promise<boolean> {
    if (redis) {
      const config = BUFFER_CONFIG[channel];
      const lKey = lockKey(channel, userId);
      const lockTtlSeconds = Math.ceil(config.lockTtlMs / 1000);
      const result = await redis.set(lKey, Date.now().toString(), {
        nx: true,
        ex: lockTtlSeconds,
      });
      return result === "OK";
    }

    const entry = getOrCreateEntry(channel, userId);
    if (entry.lock) return false;
    entry.lock = true;
    return true;
  },

  async releaseLock(channel: Channel, userId: string): Promise<void> {
    if (redis) {
      await redis.del(lockKey(channel, userId));
    } else {
      const key = memKey(channel, userId);
      const entry = inMemoryStore.get(key);
      if (entry) entry.lock = false;
    }
  },

  async isTimerExpired(channel: Channel, userId: string): Promise<boolean> {
    if (redis) {
      const tKey = timerKey(channel, userId);
      const exists = await redis.exists(tKey);
      return exists === 0;
    }

    const key = memKey(channel, userId);
    const entry = inMemoryStore.get(key);
    if (!entry) return true; // No entry = timer expirado (ej: reinicio del servidor)

    const config = BUFFER_CONFIG[channel];
    const elapsed = Date.now() - entry.timer;
    return elapsed >= config.debounceMs;
  },

  async fetchAndClear(channel: Channel, userId: string): Promise<BufferedMessage[]> {
    if (redis) {
      const bKey = bufferKey(channel, userId);
      const raw = await redis.lrange(bKey, 0, -1);
      await redis.del(bKey);
      return raw.map((item) => {
        if (typeof item === "string") return JSON.parse(item) as BufferedMessage;
        return item as BufferedMessage;
      });
    }

    const key = memKey(channel, userId);
    const entry = inMemoryStore.get(key);
    if (!entry) return [];

    const messages = [...entry.messages];
    entry.messages = [];
    entry.timer = 0;
    return messages;
  },

  async hasNewMessages(channel: Channel, userId: string): Promise<boolean> {
    if (redis) {
      const bKey = bufferKey(channel, userId);
      const len = await redis.llen(bKey);
      return len > 0;
    }

    const key = memKey(channel, userId);
    const entry = inMemoryStore.get(key);
    return entry ? entry.messages.length > 0 : false;
  },

  // Level-2 content dedup: returns true if the same content was seen in the last 5 seconds
  async isContentDuplicate(channel: Channel, userId: string, content: string): Promise<boolean> {
    if (redis) {
      const hashKey = `dedup:${channel}:${userId}`;
      const hash = content.toLowerCase().trim().slice(0, 50);
      const existing = await redis.get(hashKey);
      if (existing === hash) return true;
      await redis.set(hashKey, hash, { ex: 5 });
      return false;
    }

    // In-memory dedup: Map separado con TTL de 5s
    const hash = content.toLowerCase().trim().slice(0, 50);
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

// Mapa separado para dedup in-memory (no contamina el buffer)
const inMemoryDedup = new Map<string, { hash: string; ts: number }>();

// Tracks the last processed content hash per user (to avoid re-processing duplicates)
const lastProcessedContent = new Map<string, string>();

export function getLastProcessedContent(channel: Channel, userId: string): string | undefined {
  const key = `${channel}:${userId}`;
  return lastProcessedContent.get(key);
}

export function setLastProcessedContent(channel: Channel, userId: string, hash: string): void {
  const key = `${channel}:${userId}`;
  lastProcessedContent.set(key, hash);
}

// Cleanup dedup y lastProcessedContent cada 30s
setInterval(() => {
  const cutoff = Date.now() - 10_000;
  for (const [key, entry] of inMemoryDedup.entries()) {
    if (entry.ts < cutoff) inMemoryDedup.delete(key);
  }
  if (lastProcessedContent.size > 1000) {
    // Emergency cleanup if map grows unbounded
    lastProcessedContent.clear();
  }
}, 30_000);
