import { Redis } from "@upstash/redis";

const DLQ_KEY = "queue:dlq";

const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const hasRedis = !!(redisUrl && redisToken && redisUrl.startsWith("https://"));

let redis: Redis | null = null;

if (hasRedis) {
  redis = new Redis({
    url: redisUrl!,
    token: redisToken!,
  });
} else {
  console.warn("[queue] UPSTASH_REDIS not configured — DLQ is a no-op");
}

export interface DLQEntry {
  id: string;
  payload: unknown;
  failedAt: string;
}

export async function getDLQMessages(): Promise<DLQEntry[]> {
  if (!redis) {
    return [];
  }

  try {
    const raw = await redis.lrange(DLQ_KEY, 0, -1);
    if (!raw || !Array.isArray(raw) || raw.length === 0) {
      return [];
    }

    return raw.map((entry, index) => {
      let payload: unknown = entry;
      if (typeof entry === "string") {
        try {
          payload = JSON.parse(entry);
        } catch {
          payload = entry;
        }
      }

      return {
        id: `dlq-${index}`,
        payload,
        failedAt: typeof payload === "object" && payload !== null && "timestamp" in payload
          ? new Date((payload as Record<string, number>).timestamp).toISOString()
          : new Date().toISOString(),
      };
    });
  } catch (err) {
    console.error("[queue] getDLQMessages error:", err);
    return [];
  }
}

export async function clearDLQ(): Promise<boolean> {
  if (!redis) {
    return false;
  }

  try {
    await redis.del(DLQ_KEY);
    console.log("[queue] DLQ cleared");
    return true;
  } catch (err) {
    console.error("[queue] clearDLQ error:", err);
    return false;
  }
}
