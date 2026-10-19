import { createHash } from "crypto";
import type { NormalizedInboundEvent, ProviderId } from "@/lib/messaging";

/**
 * Meta → NormalizedInboundEvent. The envelope's routing key is
 * metadata.phone_number_id; the wamid becomes both deliveryId and
 * platformMessageId (durable dedup). The pipeline reads the provider message
 * off `raw.whatsappInboundMessage` — Meta's message object already uses the
 * same field names (type / text.body / location / media objects), so it is
 * passed through unchanged. `raw.type` carries the inbound envelope marker:
 * without it `isProtocolArtifact` would drop the event before persistence.
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
