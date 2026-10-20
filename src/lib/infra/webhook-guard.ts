/**
 * Webhook ingress guards (F8). Every webhook route buffers its raw body for
 * signature verification, so an unauthenticated request could previously push
 * arbitrary memory/CPU work through `request.text()` and event loops. These
 * helpers bound that work BEFORE any signature check:
 *
 * - `readBoundedBody` rejects oversized envelopes by declared size
 *   (Content-Length) before reading, and by actual size after reading.
 * - `MAX_WEBHOOK_EVENTS` caps how many events one signed envelope may carry.
 */

/** Hard default cap on a webhook envelope. Routes may pass a lower bound. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/**
 * Max events processed per signed envelope. Providers batch legitimately
 * (Kapso status flushes, Meta entry batches) but nothing legitimate nears
 * this; events past the cap are dropped with a warning — retrying the same
 * envelope can't save them, so the route still acks.
 */
export const MAX_WEBHOOK_EVENTS = 100;

export type BoundedBody =
  | { ok: true; rawBody: string }
  | { ok: false; reason: "declared-too-large" | "body-too-large" };

export async function readBoundedBody(
  request: { headers: Headers; text(): Promise<string> },
  maxBytes = MAX_WEBHOOK_BODY_BYTES,
): Promise<BoundedBody> {
  // Declared size first — a giant Content-Length never becomes a buffered
  // string. Absent or malformed headers (chunked delivery) fall through to
  // the post-read check, which also catches a lying small header.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: "declared-too-large" };
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > maxBytes) {
    return { ok: false, reason: "body-too-large" };
  }
  return { ok: true, rawBody };
}
