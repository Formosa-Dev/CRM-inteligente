/**
 * Inbound scoping keys for buffer, content-dedup, and rate-limit buckets.
 *
 * A bound channel account namespaces the customer key so the same phone
 * messaging two provisioned numbers inside the debounce/rate-limit window
 * never shares a turn, a dedup slot, or a bucket — the first event's binding
 * can no longer answer another account's inbound. A NULL/legacy context keeps
 * the exact legacy `${userId}` key shape byte-for-byte.
 */
export function accountScopedInboundKey(
  channelAccountId: number | null | undefined,
  userId: string
): string {
  return channelAccountId != null ? `acct${channelAccountId}:${userId}` : userId;
}
