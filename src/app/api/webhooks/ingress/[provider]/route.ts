import { NextRequest, NextResponse } from "next/server";
import { getProvider, hasProvider } from "@/lib/messaging";
import type { ProviderId } from "@/lib/messaging";
import {
  handlePassiveChannelEvent,
  resolveIngressContext,
  resolveWebhookSecret,
} from "@/lib/messaging/ingress";
import { handleNormalizedEvent } from "@/lib/messaging/inbound-pipeline";

/**
 * POST /api/webhooks/ingress/<provider> — unified inbound entry point (S12).
 *
 * Works for any registered provider (registry today: ycloud). Flow:
 * provider by path param (404 unknown) → per-provider webhook secret
 * (resolveWebhookSecret — ycloud keeps agent_config→env, future providers
 * read <PROVIDER>_WEBHOOK_SECRET) → verifyWebhook (401 bad signature) →
 * parseWebhook → per event: resolve channel + channel_accounts row
 * (fail-closed skip + log when nothing matches) → WhatsApp/YCloud events run
 * the same shared app pipeline as /api/whatsapp/webhook; events on other
 * channels get passive persistence (conversation + message) or a structured
 * ack log when no persistence table exists for the kind.
 *
 * GET verification stays provider-specific (YCloud's ?token echo lives on
 * /api/whatsapp/webhook); there is no generic GET handshake here.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider: providerParam } = await params;
  if (!hasProvider(providerParam)) {
    console.warn(`[ingress] POST for unregistered provider '${providerParam}' — 404`);
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }
  const provider = getProvider(providerParam as ProviderId);

  const rawBody = await request.text();

  const secret = await resolveWebhookSecret(provider.id);
  if (!secret) {
    console.error(`[ingress] ${provider.id} webhook secret not configured — rejecting`);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const headers = Object.fromEntries(request.headers.entries());
  if (!provider.verifyWebhook({ headers, rawBody, secret }).ok) {
    console.error(`[ingress] ${provider.id} signature verification FAILED`);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const events = provider.parseWebhook({ headers, rawBody });
  if (events.length === 0) {
    // Same contract as /api/whatsapp/webhook: a signed but non-JSON body
    // throws here (unhandled → 500); valid JSON that isn't an envelope acks.
    JSON.parse(rawBody);
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  let response: NextResponse = NextResponse.json({ ok: true }, { status: 200 });
  for (const event of events) {
    let ctx;
    try {
      ctx = await resolveIngressContext(provider, event);
    } catch (error) {
      console.error(
        `[ingress] ${provider.id} event ${event.deliveryId} — account resolution failed, retryable`,
        error
      );
      return NextResponse.json(
        { error: "account-resolution-failed" },
        { status: 503 }
      );
    }
    if (!ctx) continue; // fail-closed — reason already logged
    response =
      provider.id === "ycloud" && ctx.channel === "whatsapp"
        ? await handleNormalizedEvent(event, ctx)
        : await handlePassiveChannelEvent(event, ctx);
  }
  return response;
}
