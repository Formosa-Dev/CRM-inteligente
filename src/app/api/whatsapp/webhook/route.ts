import { NextRequest, NextResponse } from "next/server";
import { providerForChannel } from "@/lib/messaging";
import { resolveWebhookSecret } from "@/lib/messaging/ingress";
import { handleNormalizedEvent } from "@/lib/messaging/inbound-pipeline";
import { aggregateWebhookStatuses } from "@/lib/messaging/webhook-response";
import {
  checkRateLimit,
  clientIpFromRequest,
} from "@/lib/infra/rate-limit";
import {
  MAX_WEBHOOK_EVENTS,
  readBoundedBody,
} from "@/lib/infra/webhook-guard";

/**
 * GET — Webhook verification (YCloud sends a challenge token)
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }
  return new NextResponse(token, { status: 200 });
}

/**
 * POST — Incoming WhatsApp messages from YCloud
 *
 * Envelope verification + parsing are delegated to the provider adapter
 * (signature → verifyWebhook, envelope → parseWebhook). Per-event app logic
 * lives in the shared inbound pipeline — `handleNormalizedEvent` in
 * `src/lib/messaging/inbound-pipeline.ts` (extracted here verbatim in S12;
 * the unified ingress route at /api/webhooks/ingress/<provider> runs the
 * same function with a resolved channel-account context).
 */export async function POST(request: NextRequest) {
  // Bound unauthenticated work BEFORE buffering the body: a per-IP rate
  // limit inside a per-provider bucket, then a declared-size reject so a
  // huge Content-Length never becomes a string in memory (F8).
  const rate = await checkRateLimit(
    `webhook:ycloud:${clientIpFromRequest(request)}`,
    { bucket: "webhook:ycloud", limit: 120, bucketLimit: 600 }
  );
  if (!rate.success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const bounded = await readBoundedBody(request, 128 * 1024);
  if (!bounded.ok) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  const rawBody = bounded.rawBody;

  // 1. Verify webhook signature (header: ycloud-signature)
  const secret = await resolveWebhookSecret("ycloud");

  if (!secret) {
    console.error("[webhook:wa] YCLOUD_WEBHOOK_SECRET not set — rejecting");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const provider = providerForChannel("whatsapp");
  if (!provider) {
    console.error("[webhook:wa] No messaging provider registered for channel 'whatsapp'");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const headers = Object.fromEntries(request.headers.entries());
  if (!provider.verifyWebhook({ headers, rawBody, secret }).ok) {
    console.error("[webhook:wa] Signature verification FAILED — check YCLOUD_WEBHOOK_SECRET matches YCloud dashboard");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const parsed = provider.parseWebhook({ headers, rawBody });
  if (parsed.length === 0) {
    // Preserve the pre-extraction contract: a signed but non-JSON body used
    // to throw at the inline JSON.parse (unhandled → 500). The adapter
    // returns [] for those bodies, so replay the throw here; valid JSON
    // that simply isn't a YCloud envelope acks like before.
    JSON.parse(rawBody);
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  // Cap per-envelope event work (F8) — excess events are dropped with a
  // warning; re-delivering the same envelope can't save them, so we still ack.
  const events = parsed.slice(0, MAX_WEBHOOK_EVENTS);
  if (events.length < parsed.length) {
    console.warn(
      `[webhook:wa] envelope carried ${parsed.length} events — capped at ${MAX_WEBHOOK_EVENTS}`
    );
  }

  const statuses: number[] = [];
  for (const event of events) {
    const response = await handleNormalizedEvent(event);
    statuses.push(response.status);
  }
  const aggregate = aggregateWebhookStatuses(statuses);
  return NextResponse.json(
    { ok: aggregate.ok, processed: statuses.length },
    { status: aggregate.status }
  );
}
