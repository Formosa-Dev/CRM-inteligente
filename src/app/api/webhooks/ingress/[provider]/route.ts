import { NextRequest, NextResponse } from "next/server";
import { getProvider, hasProvider } from "@/lib/messaging";
import type { ProviderId } from "@/lib/messaging";
import { ChannelAccountResolutionError } from "@/lib/messaging/accounts";
import {
  handlePassiveChannelEvent,
  verifyAndResolveEvents,
} from "@/lib/messaging/ingress";
import { handleNormalizedEvent } from "@/lib/messaging/inbound-pipeline";
import { aggregateWebhookStatuses } from "@/lib/messaging/webhook-response";
import {
  checkRateLimit,
  clientIpFromRequest,
} from "@/lib/infra/rate-limit";
import { readBoundedBody } from "@/lib/infra/webhook-guard";

/**
 * POST /api/webhooks/ingress/<provider> — unified inbound entry point (S12).
 *
 * Works for any registered provider (registry today: ycloud, kapso). Flow:
 * provider by path param (404 unknown) → per-IP rate limit + bounded body
 * (F8) → `verifyAndResolveEvents` (F7): parseWebhook (capped) + per-event
 * channel_accounts resolution BEFORE processing, signature verified against
 * the named account's own `credentials.webhookSecret` when it carries one
 * (else the provider-level secret) — 401 when nothing verifies → per event:
 * WhatsApp-channel events from ANY provider run the same shared app
 * pipeline as /api/whatsapp/webhook; events on other channels get passive persistence
 * (conversation + message) or a structured ack log when no persistence
 * table exists for the kind. Events whose account can't be resolved are
 * fail-closed skips (logged inside resolution).
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

  const headers = Object.fromEntries(request.headers.entries());
  let resolved;
  try {
    resolved = await verifyAndResolveEvents(provider, { headers, rawBody });
  } catch (error) {
    // Verified signature but account resolution is down — retryable so the
    // provider redelivers; an ack here would silently drop the message.
    if (error instanceof ChannelAccountResolutionError) {
      console.error(
        `[ingress] ${provider.id} — account resolution unavailable, retryable`
      );
      return NextResponse.json(
        { error: "account-resolution-failed" },
        { status: 503 }
      );
    }
    throw error;
  }

  if (resolved.kind === "unauthorized") {
    console.error(`[ingress] ${provider.id} signature verification FAILED`);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  if (resolved.kind === "empty") {
    // Same contract as /api/whatsapp/webhook: a signed but non-JSON body
    // throws here (unhandled → 500); valid JSON that isn't an envelope acks.
    JSON.parse(rawBody);
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const statuses: number[] = [];
  for (const { event, ctx } of resolved.events) {
    if (!ctx) continue; // fail-closed — reason already logged in resolution
    const response =
      ctx.channel === "whatsapp"
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
