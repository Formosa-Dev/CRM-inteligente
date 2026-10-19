import { Redis } from "@upstash/redis";
import { messenger } from "@/lib/messaging";

const QUEUE_KEY = "queue:messages";
const DLQ_KEY = "queue:dlq";

type ProcessOutcome = "ok" | "retry" | "dlq";

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
  console.warn("[queue] UPSTASH_REDIS not configured — worker is a no-op");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDelay(retryCount: number): number {
  return Math.pow(2, retryCount) * 1000;
}

export interface QueuePayload {
  chatId: string | number;
  type: string;
  timestamp: number;
  retryCount: number;
  [key: string]: unknown;
}

async function processWhatsApp(payload: QueuePayload): Promise<ProcessOutcome> {
  const to = payload.to as string | undefined;
  const text = payload.text as string | undefined;

  if (!to || !text) {
    console.log("[queue] invalid whatsapp payload — missing to/text", {
      chatId: payload.chatId,
    });
    return "dlq";
  }

  const {
    resolveConversationAccountForPhone,
    resolveDefaultWhatsAppAccount,
  } = await import("@/lib/channels/router");
  const { decideSendAccount } = await import("@/lib/messaging/send-account");
  const decision = await decideSendAccount(to, {
    resolveBinding: resolveConversationAccountForPhone,
    resolveDefaultAccount: resolveDefaultWhatsAppAccount,
  });

  if (decision.kind === "retry") {
    console.log("[queue] account lookup transient — retrying", {
      chatId: payload.chatId,
      reason: decision.reason,
    });
    return "retry";
  }
  if (decision.kind === "drop") {
    console.log("[queue] no safe sender — DLQ", {
      chatId: payload.chatId,
      reason: decision.reason,
    });
    return "dlq";
  }

  const result = await messenger.send(
    { to, type: "text", text },
    decision.account
      ? { channel: "whatsapp", account: decision.account }
      : {}
  );
  if (!result.ok) {
    console.log("[queue] sendText failed", {
      chatId: payload.chatId,
      error: result.error,
      retryable: result.retryable,
    });
    return result.retryable ? "retry" : "dlq";
  }

  return "ok";
}

async function processTelegram(_payload: QueuePayload): Promise<ProcessOutcome> {
  console.warn("[queue] telegram processing not implemented — skipping", {
    chatId: _payload.chatId,
  });
  return "ok";
}

async function processMessage(payload: QueuePayload): Promise<ProcessOutcome> {
  switch (payload.type) {
    case "whatsapp":
      return processWhatsApp(payload);
    case "telegram":
      return processTelegram(payload);
    default:
      console.log("[queue] unknown message type", { type: payload.type });
      return "dlq";
  }
}

export interface QueueOutcomeDeps {
  process(payload: QueuePayload): Promise<ProcessOutcome>;
  requeue(payload: QueuePayload): Promise<void>;
  deadLetter(payload: QueuePayload): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/**
 * Applies the retry/DLQ policy to an already-popped payload. Exported so the
 * "unexpected throw must not lose the payload" behavior is testable without
 * Redis. An unexpected throw is treated as a retryable failure.
 */
export async function handlePoppedPayload(
  payload: QueuePayload,
  deps: QueueOutcomeDeps
): Promise<ProcessOutcome> {
  let outcome: ProcessOutcome;
  try {
    outcome = await deps.process(payload);
  } catch (error) {
    console.error("[queue] processing threw — retrying payload", error, {
      chatId: payload.chatId,
      retryCount: payload.retryCount,
    });
    outcome = "retry";
  }

  if (outcome === "ok") {
    console.log("[queue] processed successfully", { chatId: payload.chatId });
    return "ok";
  }

  if (outcome === "dlq") {
    await deps.deadLetter(payload);
    console.log("[queue] moved to DLQ (non-retryable)", {
      chatId: payload.chatId,
    });
    return "dlq";
  }

  payload.retryCount = (payload.retryCount ?? 0) + 1;
  if (payload.retryCount < 3) {
    const delay = getDelay(payload.retryCount);
    console.log("[queue] will retry in %dms (attempt %d)", delay, payload.retryCount, {
      chatId: payload.chatId,
    });
    await deps.sleep(delay);
    try {
      await deps.requeue(payload);
    } catch (requeueError) {
      console.error("[queue] re-enqueue failed — moving payload to DLQ", requeueError, {
        chatId: payload.chatId,
      });
      await deps.deadLetter(payload);
      return "dlq";
    }
    console.log("[queue] re-enqueued for retry", {
      chatId: payload.chatId,
      retryCount: payload.retryCount,
    });
    return "retry";
  }

  await deps.deadLetter(payload);
  console.log("[queue] moved to DLQ (max retries)", { chatId: payload.chatId });
  return "dlq";
}

export async function processNextMessage(): Promise<boolean> {
  if (!redis) {
    return false;
  }

  let parsed: QueuePayload | undefined;
  try {
    const raw = await redis.rpop(QUEUE_KEY);
    if (!raw) {
      return false;
    }

    try {
      parsed = JSON.parse(raw as string) as QueuePayload;
    } catch {
      console.log("[queue] failed to parse message — moving to DLQ", {
        raw: (raw as string).substring(0, 200),
      });
      await redis.lpush(DLQ_KEY, raw as string);
      return true;
    }

    const payload = parsed;

    console.log("[queue] processing", {
      type: payload.type,
      chatId: payload.chatId,
      retryCount: payload.retryCount,
    });

    await handlePoppedPayload(payload, {
      process: processMessage,
      requeue: (item) => redis!.lpush(QUEUE_KEY, JSON.stringify(item)).then(() => undefined),
      deadLetter: (item) => redis!.lpush(DLQ_KEY, JSON.stringify(item)).then(() => undefined),
      sleep,
    });
    return true;
  } catch (err) {
    console.error("[queue] processNextMessage error:", err);
    // Never drop an already-popped message because of an unexpected failure
    // outside the retry handler: put it back with its (advanced) retry count.
    if (parsed) {
      parsed.retryCount = (parsed.retryCount ?? 0) + 1;
      try {
        if (parsed.retryCount < 3) {
          await redis.lpush(QUEUE_KEY, JSON.stringify(parsed));
        } else {
          await redis.lpush(DLQ_KEY, JSON.stringify(parsed));
        }
      } catch (requeueError) {
        console.error("[queue] recovery re-enqueue failed:", requeueError, {
          chatId: parsed.chatId,
        });
      }
    }
    return false;
  }
}

export async function startWorker(intervalMs = 1000): Promise<() => void> {
  if (!redis) {
    console.warn("[queue] worker started without Redis — returning no-op cleanup");
    return () => {};
  }

  console.log("[queue] worker started (polling every %dms)", intervalMs);

  const id = setInterval(() => {
    processNextMessage().catch((err) =>
      console.error("[queue] worker interval error:", err),
    );
  }, intervalMs);

  return () => {
    clearInterval(id);
    console.log("[queue] worker stopped");
  };
}
