import pino from "pino";

// Correlation ID generator
export function createCorrelationId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Keys that never belong in logs (F4): customer phones/names, message
 * bodies and media captions, transcripts, addresses, chat ids. Matched
 * keys have their values replaced with "[redacted]" at any depth of the
 * logged object.
 */
const REDACTED_KEYS = new Set([
  "phone",
  "customerPhone",
  "phoneNumber",
  "customerName",
  "address",
  "text",
  "content",
  "caption",
  "transcription",
  "chatId",
]);

const MAX_SCRUB_DEPTH = 8;

function scrubPii(value: unknown, depth: number): unknown {
  if (depth > MAX_SCRUB_DEPTH || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubPii(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key) ? "[redacted]" : scrubPii(item, depth + 1);
  }
  return out;
}

// pino logger - output as JSON for production, pretty for dev
export const logger = pino({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  formatters: {
    log: (log) => {
      const scrubbed = scrubPii(log, 0) as Record<string, unknown>;
      return {
        ...scrubbed,
        // log.time puede ser epoch timestamp number
        timestamp: typeof log.time === "number" ? new Date(log.time).toISOString() : undefined,
      };
    },
  },
});

export function createLogger(correlationId: string) {
  return logger.child({ correlationId });
}

// Helpers for structured logging — opaque identifiers only, never
// chat ids, phones, or message bodies (F4).
export function logRequestReceived(logger: pino.Logger, data: {
  messageId: string;
  hasText?: boolean;
}) {
  logger.info({ event: "request_received", ...data }, "Telegram update received");
}
