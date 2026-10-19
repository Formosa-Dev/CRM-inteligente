import { NextRequest, NextResponse } from "next/server";
import { providerForChannel } from "@/lib/messaging";
import { resolveWebhookSecret } from "@/lib/messaging/ingress";
import { handleNormalizedEvent } from "@/lib/messaging/inbound-pipeline";

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
  const rawBody = await request.text();

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

  const events = provider.parseWebhook({ headers, rawBody });
  if (events.length === 0) {
    // Preserve the pre-extraction contract: a signed but non-JSON body used
    // to throw at the inline JSON.parse (unhandled → 500). The adapter
    // returns [] for those bodies, so replay the throw here; valid JSON
    // that simply isn't a YCloud envelope acks like before.
    JSON.parse(rawBody);
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  let response: NextResponse = NextResponse.json({ ok: true }, { status: 200 });
  for (const event of events) {
    response = await handleNormalizedEvent(event);
  }
  return response;
}
