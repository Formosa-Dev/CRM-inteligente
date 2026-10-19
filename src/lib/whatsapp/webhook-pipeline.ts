/**
 * Webhook pipeline helpers (SDD memoria-persistente-sesion-whatsapp, PR 2).
 *
 * Pure, side-effect-free eligibility and persistence decisions for the
 * WhatsApp webhook. Protocol artifacts (empty Business echoes and
 * delivery/status events) must never cause conversation lookup, session or
 * event mutation, routing, or replies. Only eligible customer input reaches
 * durable session persistence, and every persistence/CAS failure resolves to
 * fail-closed (no buffering, no GPT/Jev/tools, no automatic replies).
 */

export const ECHO_EVENT_TYPES = [
  "whatsapp.message.echo",
  "whatsapp.smb.message.echoes",
] as const;

const ECHO_MESSAGE_KEYS = [
  "whatsappMessage",
  "whatsappSmbMessageEcho",
  "whatsappSmbMessageEchoes",
  "smbMessage",
  "message",
  "whatsappMessageEcho",
] as const;

const INBOUND_EVENT_TYPE = "whatsapp.inbound_message.received";

const STATUS_MESSAGE_TYPES = new Set([
  "status",
  "delivery",
  "delivery_status",
  "message_status",
  "seen",
  "read",
  "played",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractEchoMessage(event: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const key of ECHO_MESSAGE_KEYS) {
    const candidate = event[key];
    if (isRecord(candidate)) return candidate;
  }
  for (const [key, value] of Object.entries(event)) {
    if (["type", "id", "createTime", "sendTime", "apiVersion"].includes(key)) continue;
    if (isRecord(value) && (value.to !== undefined || value.from !== undefined)) return value;
  }
  return undefined;
}

function echoMessageHasContent(msg: Record<string, unknown>): boolean {
  const msgType = typeof msg.type === "string" ? msg.type : "text";
  if (msgType === "text" && isRecord(msg.text)) {
    return typeof msg.text.body === "string" && msg.text.body.trim().length > 0;
  }
  if (["image", "audio", "document", "video"].includes(msgType)) {
    const media = msg[msgType];
    if (isRecord(media)) {
      if (typeof media.id === "string" && media.id.length > 0) return true;
      if (typeof media.caption === "string" && media.caption.trim().length > 0) return true;
    }
    return false;
  }
  if (msgType === "location" && isRecord(msg.location)) {
    const loc = msg.location;
    return (
      (typeof loc.address === "string" && loc.address.trim().length > 0) ||
      (typeof loc.name === "string" && loc.name.trim().length > 0) ||
      (typeof loc.latitude === "number" && typeof loc.longitude === "number")
    );
  }
  return false;
}

/**
 * Returns true when the webhook payload is a protocol artifact that must be
 * acknowledged with 200 and cause no lookup, mutation, routing, or reply:
 * empty Business echoes and delivery/status events.
 */
export function isProtocolArtifact(payload: unknown): boolean {
  if (!isRecord(payload)) return true;
  const type = typeof payload.type === "string" ? payload.type : undefined;

  if (type !== undefined && (ECHO_EVENT_TYPES as readonly string[]).includes(type)) {
    const msg = extractEchoMessage(payload);
    if (!msg) return true;
    return !echoMessageHasContent(msg);
  }

  if (type !== INBOUND_EVENT_TYPE) return true;

  const message = payload.whatsappInboundMessage;
  if (!isRecord(message)) return true;
  const msgType = typeof message.type === "string" ? message.type : undefined;
  if (!msgType || STATUS_MESSAGE_TYPES.has(msgType)) return true;
  if (typeof message.id !== "string" || message.id.length === 0) return true;
  if (typeof message.from !== "string" || message.from.length === 0) return true;
  return false;
}

export type DedupOutcome = "new" | "duplicate" | "failed";
export type CasOutcome = "saved" | "duplicate" | "conflict";

export type SessionPersistenceInput = {
  eligible: boolean;
  aiEnabled: boolean;
  dedup: DedupOutcome;
  cas: CasOutcome;
};

export type SessionPersistenceDecision = {
  persistSession: boolean;
  allowBuffer: boolean;
  allowAgent: boolean;
  allowReply: boolean;
  failClosed: boolean;
};

/**
 * Resolves what the webhook may do after the eligibility and durability
 * gates. Eligible transitions persist even with AI disabled; buffering, GPT,
 * Jev/tools, and automatic replies run only when AI is enabled on a fresh
 * save. Duplicates are idempotent no-ops (already persisted once); dedup or
 * CAS failures fail closed with no routing and no output.
 */
export function resolveSessionPersistence(input: SessionPersistenceInput): SessionPersistenceDecision {
  const closed: SessionPersistenceDecision = {
    persistSession: false,
    allowBuffer: false,
    allowAgent: false,
    allowReply: false,
    failClosed: true,
  };
  const suppressed: SessionPersistenceDecision = {
    persistSession: false,
    allowBuffer: false,
    allowAgent: false,
    allowReply: false,
    failClosed: false,
  };

  if (!input.eligible) return suppressed;
  if (input.dedup === "failed" || input.cas === "conflict") return closed;
  if (input.dedup === "duplicate" || input.cas === "duplicate") return suppressed;

  return {
    persistSession: true,
    allowBuffer: input.aiEnabled,
    allowAgent: input.aiEnabled,
    allowReply: input.aiEnabled,
    failClosed: false,
  };
}
