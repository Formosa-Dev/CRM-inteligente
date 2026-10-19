/**
 * Multi-event webhook aggregation.
 *
 * A signed envelope may carry several events. The HTTP status must reflect the
 * WORST outcome: one retryable failure makes the whole delivery retryable so
 * the provider redelivers (durable dedup makes replays safe). A single later
 * success must never hide an earlier failure.
 */

export interface AggregatedWebhookResponse {
  status: number;
  ok: boolean;
  retryable: boolean;
}

export function aggregateWebhookStatuses(
  statuses: readonly number[]
): AggregatedWebhookResponse {
  if (statuses.length === 0) {
    return { status: 200, ok: true, retryable: false };
  }
  if (statuses.includes(503)) {
    return { status: 503, ok: false, retryable: true };
  }
  const serverError = statuses.find((status) => status >= 500);
  if (serverError !== undefined) {
    return { status: serverError, ok: false, retryable: false };
  }
  const clientError = statuses.find((status) => status >= 400);
  if (clientError !== undefined) {
    return { status: clientError, ok: false, retryable: false };
  }
  return { status: 200, ok: true, retryable: false };
}
