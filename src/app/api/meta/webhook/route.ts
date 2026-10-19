import { NextRequest, NextResponse } from "next/server";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import {
  ChannelAccountResolutionError,
  providerForChannel,
  resolveChannelAccount,
  resolveChannelAccountStrict,
  type NormalizedInboundEvent,
  type ProviderId,
} from "@/lib/messaging";
import {
  handleNormalizedEvent,
  type InboundContext,
} from "@/lib/messaging/inbound-pipeline";
import { aggregateWebhookStatuses } from "@/lib/messaging/webhook-response";

// Meta signs webhook payloads with X-Hub-Signature-256: sha256=<hmac>
// computed over the raw body using the app secret.
async function verifyMetaSignature(rawBody: string, header: string | null): Promise<boolean> {
  const { getIntegrationSecrets } = await import("@/lib/integrations");
  const secret = (await getIntegrationSecrets()).metaAppSecret;
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Meta → NormalizedInboundEvent. The envelope's routing key is
 * metadata.phone_number_id; the wamid becomes both deliveryId and
 * platformMessageId (durable dedup). The pipeline reads the provider message
 * off `raw.whatsappInboundMessage` — Meta's message object already uses the
 * same field names (type / text.body / location / media objects), so it is
 * passed through unchanged. Only text-bearing messages reach this point —
 * the route keeps its existing `!from || !text` skip.
 */
export function metaMessageToInboundEvent(
  msg: { id?: string; from?: string; timestamp?: string },
  input: {
    providerAccountId: string;
    senderName?: string;
    text: string;
    provider: ProviderId;
  }
): NormalizedInboundEvent {
  const epochSeconds = Number(msg.timestamp);
  return {
    provider: input.provider,
    deliveryId: msg.id
      ? `meta:${msg.id}`
      : `meta:synth:${createHash("sha256")
          .update(`${msg.from ?? ""}|${msg.timestamp ?? ""}|${input.text}`)
          .digest("hex")
          .slice(0, 24)}`,
    kind: "message.received",
    direction: "inbound",
    providerAccountId: input.providerAccountId,
    platformMessageId: msg.id,
    sender: { phone: msg.from, name: input.senderName },
    type: "text",
    text: input.text,
    timestamp: Number.isFinite(epochSeconds)
      ? new Date(epochSeconds * 1000).toISOString()
      : new Date().toISOString(),
    raw: { type: "whatsapp.inbound_message.received", whatsappInboundMessage: msg },
  };
}

// GET: Webhook verification
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get("hub.mode");
  const token = req.nextUrl.searchParams.get("hub.verify_token");
  const challenge = req.nextUrl.searchParams.get("hub.challenge");
  const { getIntegrationSecrets } = await import("@/lib/integrations");
  const expected = (await getIntegrationSecrets()).metaWebhookVerifyToken;

  // Fail closed when the verify token is unset or empty — an empty env would
  // otherwise match an empty query param and confirm subscriptions for anyone.
  if (mode === "subscribe" && expected && token === expected) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

// POST: Incoming messages from Meta — verified envelope → account resolution
// → shared inbound pipeline (same entry the canonical WhatsApp webhook runs),
// which persists the message and drives the agent.
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  if (!(await verifyMetaSignature(rawBody, req.headers.get("x-hub-signature-256")))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const statuses: number[] = [];
  try {
    const body = JSON.parse(rawBody);

    // Meta sends entries with changes
    const entries = body?.entry || [];
    for (const entry of entries) {
      const changes = entry?.changes || [];
      for (const change of changes) {
        if (change.field !== "messages") continue;

        const value = change.value;
        const messages = value?.messages || [];

        for (const msg of messages) {
          const from = msg.from; // phone number
          const text = msg.text?.body || msg.caption || "";

          if (!from || !text) continue;

          // Account-aware attribution from the Meta routing keys. A
          // provisioned channel with no match is skipped (no null-account
          // row); only a genuinely unprovisioned install keeps legacy nulls.
          const candidates = [
            value?.metadata?.phone_number_id,
            value?.metadata?.display_phone_number,
          ].filter(
            (candidate: unknown): candidate is string =>
              typeof candidate === "string" && candidate.length > 0
          );
          // Fail closed when Meta does not identify the receiving business:
          // never attribute an event to the sole active account by default.
          const metaProvider = providerForChannel("whatsapp");
          if (!metaProvider || candidates.length === 0) {
            console.warn(
              "[meta/webhook] missing Meta routing key/provider — skipping message",
              from
            );
            continue;
          }
          // Only an account provisioned for the configured Meta/WhatsApp
          // provider may receive this event; a provider mismatch is a skip.
          const resolution = await resolveChannelAccountStrict(
            "whatsapp",
            candidates,
            metaProvider.id
          );
          if (resolution.kind === "db-error") {
            throw new ChannelAccountResolutionError(resolution);
          }
          if (resolution.kind === "not-found" || resolution.kind === "mismatch") {
            console.warn(
              "[meta/webhook] no matching channel account — skipping message",
              from
            );
            continue;
          }

          // resolved → bound row; unprovisioned/schema-not-ready → legacy
          // placeholder (the same fallback the unified ingress applies).
          let ctx: InboundContext;
          if (resolution.kind === "resolved") {
            ctx = {
              channel: "whatsapp",
              account: resolution.account,
              channelAccountId: resolution.rowId,
            };
          } else {
            const account = await resolveChannelAccount(
              "whatsapp",
              undefined,
              metaProvider.id
            );
            if (!account) {
              console.warn(
                "[meta/webhook] no resolvable channel account — skipping message",
                from
              );
              continue;
            }
            ctx = { channel: "whatsapp", account };
          }

          const event = metaMessageToInboundEvent(msg, {
            providerAccountId: String(
              value?.metadata?.phone_number_id ?? candidates[0]
            ),
            senderName: value?.contacts?.[0]?.profile?.name,
            text,
            provider: metaProvider.id,
          });
          const response = await handleNormalizedEvent(event, ctx);
          statuses.push(response.status);
        }
      }
    }
  } catch (error) {
    console.error("[meta/webhook] Error:", error);
    const { classifyError } = await import("@/lib/messaging/errors");
    return NextResponse.json(
      { error: "meta-webhook-failed" },
      { status: classifyError(error) === "retryable-db" ? 503 : 500 }
    );
  }

  const aggregate = aggregateWebhookStatuses(statuses);
  return NextResponse.json(
    { ok: aggregate.ok, processed: statuses.length },
    { status: aggregate.status }
  );
}
