import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import {
  ChannelAccountResolutionError,
  providerForChannel,
  resolveChannelAccount,
  resolveChannelAccountStrict,
} from "@/lib/messaging";
import {
  handleNormalizedEvent,
  type InboundContext,
} from "@/lib/messaging/inbound-pipeline";
import { aggregateWebhookStatuses } from "@/lib/messaging/webhook-response";
import {
  checkRateLimit,
  clientIpFromRequest,
} from "@/lib/infra/rate-limit";
import {
  MAX_WEBHOOK_EVENTS,
  readBoundedBody,
} from "@/lib/infra/webhook-guard";
import {
  metaEchoToInboundEvent,
  metaMessageText,
  metaMessageToInboundEvent,
  metaStatusToInboundEvent,
  type MetaMessageShape,
  type MetaStatusShape,
} from "./helpers";

// Structural shapes for the Meta envelope fields this route reads.
type MetaMessage = MetaMessageShape;
type MetaValue = {
  messages?: MetaMessage[];
  smb_message_echoes?: MetaMessage[];
  statuses?: MetaStatusShape[];
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: { profile?: { name?: string } }[];
};

type PendingMeta =
  | { kind: "message" | "echo"; msg: MetaMessage; value: MetaValue }
  | { kind: "status"; status: MetaStatusShape; value: MetaValue };

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
  // Bound unauthenticated work BEFORE buffering the body (F8): per-IP rate
  // limit inside a per-provider bucket, then a declared/actual size reject.
  const rate = await checkRateLimit(
    `webhook:meta:${clientIpFromRequest(req)}`,
    { bucket: "webhook:meta", limit: 120, bucketLimit: 600 }
  );
  if (!rate.success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const bounded = await readBoundedBody(req);
  if (!bounded.ok) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  const rawBody = bounded.rawBody;

  if (!(await verifyMetaSignature(rawBody, req.headers.get("x-hub-signature-256")))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const statuses: number[] = [];
  try {
    const body = JSON.parse(rawBody);

    // Collect work first so a single envelope can't exceed the event cap
    // through unbounded entry/change/message nesting (F8). Three payload
    // kinds ride the same "messages" change: inbound `messages`,
    // `smb_message_echoes` (human sends from the WhatsApp Business app in
    // coexistence mode), and `statuses` (delivery receipts for our sends).
    const pending: PendingMeta[] = [];
    const entries = body?.entry || [];
    outer: for (const entry of entries) {
      const changes = entry?.changes || [];
      for (const change of changes) {
        if (pending.length >= MAX_WEBHOOK_EVENTS) break outer;
        if (change.field !== "messages") continue;

        const value = change.value;

        for (const msg of value?.messages || []) {
          if (pending.length >= MAX_WEBHOOK_EVENTS) break outer;
          // id+from required for dedup/identity; text is optional (media
          // messages may carry only a caption or no text at all).
          if (!msg?.id || !msg?.from) continue;
          pending.push({ kind: "message", msg, value });
        }
        for (const msg of value?.smb_message_echoes || []) {
          if (pending.length >= MAX_WEBHOOK_EVENTS) break outer;
          // Echo: from = business/operator, to = customer. Both required —
          // `to` is the conversation routing key.
          if (!msg?.id || !msg?.from || !msg?.to) continue;
          pending.push({ kind: "echo", msg, value });
        }
        for (const status of value?.statuses || []) {
          if (pending.length >= MAX_WEBHOOK_EVENTS) break outer;
          if (!status?.id) continue;
          pending.push({ kind: "status", status, value });
        }
      }
    }

    for (const item of pending) {
      const value = item.value;

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
          "[meta/webhook] missing Meta routing key/provider — skipping message"
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
          "[meta/webhook] no matching channel account — skipping message"
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
            "[meta/webhook] no resolvable channel account — skipping message"
          );
          continue;
        }
        ctx = { channel: "whatsapp", account };
      }

      const providerAccountId = String(
        value?.metadata?.phone_number_id ?? candidates[0]
      );
      const senderName = value?.contacts?.[0]?.profile?.name;
      const event =
        item.kind === "echo"
          ? metaEchoToInboundEvent(item.msg, {
              providerAccountId,
              senderName,
              provider: metaProvider.id,
            })
          : item.kind === "status"
            ? metaStatusToInboundEvent(item.status, {
                providerAccountId,
                provider: metaProvider.id,
              })
            : metaMessageToInboundEvent(item.msg, {
                providerAccountId,
                senderName,
                text: metaMessageText(item.msg),
                provider: metaProvider.id,
              });
      const response = await handleNormalizedEvent(event, ctx);
      statuses.push(response.status);
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
