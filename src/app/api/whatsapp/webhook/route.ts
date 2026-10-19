import { NextRequest, NextResponse } from "next/server";
import { providerForChannel } from "@/lib/messaging";
import { ChannelAccountResolutionError } from "@/lib/messaging/accounts";
import { verifyAndResolveEvents } from "@/lib/messaging/ingress";
import { handleNormalizedEvent } from "@/lib/messaging/inbound-pipeline";
import { aggregateWebhookStatuses } from "@/lib/messaging/webhook-response";
import {
  checkRateLimit,
  clientIpFromRequest,
} from "@/lib/infra/rate-limit";
import { readBoundedBody } from "@/lib/infra/webhook-guard";

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
 * (signature → verifyWebhook, envelope → parseWebhook), orchestrated by
 * `verifyAndResolveEvents` (F7): the event's channel account is resolved
 * before processing, and when that account carries its own
 * `credentials.webhookSecret` the signature must verify against THAT secret
 * — a leaked install-wide provider secret can't forge cross-account events.
 * Per-event app logic lives in the shared inbound pipeline —
 * `handleNormalizedEvent` in `src/lib/messaging/inbound-pipeline.ts`.
 */
export async function POST(request: NextRequest) {
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

  const provider = providerForChannel("whatsapp");
  if (!provider) {
    console.error("[webhook:wa] No messaging provider registered for channel 'whatsapp'");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const headers = Object.fromEntries(request.headers.entries());
  let resolved;
  try {
    resolved = await verifyAndResolveEvents(provider, { headers, rawBody });
  } catch (error) {
    // Signature verified but account resolution is down — keep it retryable
    // so the provider redelivers rather than losing the message.
    if (error instanceof ChannelAccountResolutionError) {
      console.error("[webhook:wa] channel account resolution unavailable — retryable");
      return NextResponse.json(
        { error: "account-resolution-failed" },
        { status: 503 }
      );
    }
    throw error;
  }

  if (resolved.kind === "unauthorized") {
    console.error("[webhook:wa] Signature verification FAILED — check webhook secrets");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  if (resolved.kind === "empty") {
    // Preserve the pre-extraction contract: a signed but non-JSON body used
    // to throw at the inline JSON.parse (unhandled → 500); valid JSON that
    // simply isn't a YCloud envelope acks like before.
    JSON.parse(rawBody);
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const statuses: number[] = [];
  for (const { event, ctx } of resolved.events) {
    const response = await handleNormalizedEvent(event, ctx);
    statuses.push(response.status);
  }
  const aggregate = aggregateWebhookStatuses(statuses);
  return NextResponse.json(
    { ok: aggregate.ok, processed: statuses.length },
    { status: aggregate.status }
  );
}
