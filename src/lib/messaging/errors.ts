/**
 * Shared error classification for the messaging layer.
 *
 * Fail-closed rule: a scoped lookup may use its legacy compatibility path ONLY
 * when the schema itself is demonstrably missing (un-migrated install). Any
 * other database failure is surfaced as retryable and never converted into a
 * placeholder/global sender.
 */

export type ErrorClass =
  | "schema-not-ready"
  | "retryable-db"
  | "permanent"
  | "unknown";

const SCHEMA_CODES = new Set(["42P01", "42703", "3F000"]);
const RETRYABLE_CODES = new Set([
  "08000",
  "08003",
  "08006",
  "08001",
  "08004",
  "40001",
  "40P01",
  "53300",
  "53400",
  "57P01",
  "57P02",
  "57P03",
  "58000",
  "58030",
]);
const RETRYABLE_NAMES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const RETRYABLE_MESSAGES = [
  /fetch failed/i,
  /network/i,
  /timeout/i,
  /timed out/i,
  /connection (?:closed|reset|refused|terminated)/i,
  /database.*unreachable/i,
  /too many connections/i,
];

type ErrorLike = {
  code?: unknown;
  name?: unknown;
  message?: unknown;
  cause?: unknown;
  retryable?: unknown;
};

function readError(error: unknown): ErrorLike {
  return error !== null && typeof error === "object"
    ? (error as ErrorLike)
    : {};
}

export function errorCode(error: unknown): string | undefined {
  const direct = readError(error).code;
  if (typeof direct === "string") return direct;
  const cause = readError(readError(error).cause);
  return typeof cause.code === "string" ? cause.code : undefined;
}

function errorMessage(error: unknown): string {
  const message = readError(error).message;
  return typeof message === "string" ? message : "";
}

/** Positive evidence that a scoped column/table has not been migrated yet. */
export function isSchemaNotReady(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && SCHEMA_CODES.has(code);
}

/** Transient database/network failure — callers must retry, never degrade. */
export function isRetryableDbError(error: unknown): boolean {
  const code = errorCode(error);
  if (code && (RETRYABLE_CODES.has(code) || RETRYABLE_NAMES.has(code))) {
    return true;
  }
  const name = readError(error).name;
  if (typeof name === "string" && RETRYABLE_NAMES.has(name)) return true;
  const message = `${errorMessage(error)} ${errorMessage(readError(error).cause)}`;
  return RETRYABLE_MESSAGES.some((pattern) => pattern.test(message));
}

export function classifyError(error: unknown): ErrorClass {
  if (isSchemaNotReady(error)) return "schema-not-ready";
  if (isRetryableDbError(error)) return "retryable-db";
  // Custom resolution/send errors carry an explicit retryable flag even when
  // they have no SQLSTATE/code (e.g. ChannelAccountResolutionError).
  if (readError(error).retryable === true) return "retryable-db";
  if (error instanceof TypeError) return "permanent";
  return "unknown";
}

/** True when a webhook/provider should redeliver instead of being acked. */
export function shouldRetryError(error: unknown): boolean {
  const kind = classifyError(error);
  return kind === "retryable-db";
}
