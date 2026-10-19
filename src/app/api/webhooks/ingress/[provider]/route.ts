import { NextRequest, NextResponse } from "next/server";
import { getProvider, hasProvider } from "@/lib/messaging";
import type { ProviderId } from "@/lib/messaging";
import {
  handlePassiveChannelEvent,
  resolveIngressContext,
  resolveWebhookSecret,
} from "@/lib/messaging/ingress";
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
 * POST /api/webhooks/ingress/<provider> — unified inbound entry point (S12).
 *
 * Works for any registered provider (registry today: ycloud, kapso). Flow:
 * provider by path param (404 unknown) → per-IP rate limit + bounded body
 * (F8) → per-provider webhook secret (resolveWebhookSecret — ycloud keeps
 * agent_config→env, future providers read <PROVIDER>_WEBHOOK_SECRET) →
 * verifyWebhook (401 bad signature) → parseWebhook (capped) → per event:
 * resolve channel + channel_accounts row (fail-closed skip + log when
 * nothing matches) → WhatsApp/YCloud events run the same shared app
 * pipeline as /api/whatsapp/webhook; events on other channels get passive
 * persistence (conversation + message) or a structured ack log when no
 * persistence table exists for the kind.
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

  // Bound unauthenticated work BEFORE buffering the body (F8): per-IP rate
  // limit inside a per-provider bucket, then a declared/actual size reject.
  const rate = await checkRateLimit(
    `webhook:${provider.id}:${clientIpFromRequest(request)}`,
    { bucket: `webhook:${provider.id}`, limit: 120, bucketLimit: 600 }
  );
  if (!rate.success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const bounded = await readBoundedBody(request);
  if (!bounded.ok) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  const rawBody = bounded.rawBody;

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

  const parsed = provider.parseWebhook({ headers, rawBody });
  if (parsed.length === 0) {
    // Same contract as /api/whatsapp/webhook: a signed but non-JSON body
    // throws here (unhandled → 500); valid JSON that isn't an envelope acks.
    JSON.parse(rawBody);
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  // Cap per-envelope event work (F8) — excess events are dropped with a
  // warning; re-delivering the same envelope can't save them, so we still ack.
  const events = parsed.slice(0, MAX_WEBHOOK_EVENTS);
  if (events.length < parsed.length) {
    console.warn(
      `[ingress] ${provider.id} envelope carried ${parsed.length} events — capped at ${MAX_WEBHOOK_EVENTS}`
    );
  }

  const statuses: number[] = [];
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
    const response =
      provider.id === "ycloud" && ctx.channel === "whatsapp"
        ? await handleNormalizedEvent(event, ctx)
        : await handlePassiveChannelEvent(event, ctx);
    statuses.push(response.status);
  }
  const aggregate = aggregateWebhookStatuses(statuses);
  return NextResponse.json(
    { ok: aggregate.ok, processed: statuses.length },
    { status: aggregate.status }
  );
}
