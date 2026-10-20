import { randomUUID } from "crypto";

/**
 * F13: internal failures (DB/SQL detail, provider responses, file paths) must
 * never reach the client. Log the full error server-side under a short
 * correlation id and return that id so the generic client-facing message can
 * be traced back to the log line ("ref: ab12cd34").
 */
export function reportInternalError(tag: string, error: unknown): string {
  const ref = randomUUID().slice(0, 8);
  console.error(`[${tag}] ref=${ref}:`, error);
  return ref;
}
