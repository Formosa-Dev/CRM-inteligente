import { db } from "@/db";
import { conversations } from "@/db/schema";
import { eq } from "drizzle-orm";
import { updateConversationMetadataCAS } from "./conversation-metadata";

// ─── Types ──────────────────────────────────────────────────────────────────

export type MessageType = "order" | "greeting" | "menu" | "info" | "complaint" | "non_commercial" | "other";

export type ConversationMetadata = {
  repromptCount: number;
  lastUserMessageType: MessageType;
  lastSuggestedProducts: string[];
  lastTools: string[];
  // Opaque fields written by other subsystems (e.g. the order-lifecycle
  // same/new confirmation marker) are preserved verbatim on every rewrite.
  keepActiveConfirmation?: { activeOrderId: number; askedAt: string };
  [extra: string]: unknown;
};

// ─── Analyze message type ───────────────────────────────────────────────────

export function classifyMessageType(text: string): MessageType {
  const lower = text.toLowerCase();

  // Keywords de pedido
  const orderKeywords = [
    "quiero", "dame", "pedir", "llevo", "compra", "necesito",
    "hamburguesa", "hamburguesa", "bookbinder", "genesis", "crispy",
    "deli", "classic", "torro", "smash", "pan", "docena",
    "agreg", "otro", "ponele", "mandale",
  ];
  if (orderKeywords.some((k) => lower.includes(k))) return "order";

  // Keywords de menú
  const menuKeywords = ["menú", "menu", "carta", "productos", "tienen", "venden", "qué hay", "que hay", "lista"];
  if (menuKeywords.some((k) => lower.includes(k))) return "menu";

  // Keywords de información (ANTES que saludo — para detectar intención comercial incluso si hay saludo)
  const infoKeywords = ["precio", "precios", "cuesta", "vale", "horario", "ubica", "dirección", "donde", "dónde", "abierto", "cierran"];
  if (infoKeywords.some((k) => lower.includes(k))) return "info";

  // Keywords de queja
  const complaintKeywords = ["queja", "reclamo", "mal", "pésimo", "error", "falta", "problema", "demor", "tard"];
  if (complaintKeywords.some((k) => lower.includes(k))) return "complaint";

  // Keywords de saludo (se evalúa DESPUÉS de infoKeywords para que "Hola, pasame los precios" sea "info", no "greeting")
  const greetingKeywords = ["hola", "buenas", "buen día", "buenas tardes", "buenas noches", "qué tal", "que tal", "como estas", "cómo estás", "buen dia"];
  if (greetingKeywords.some((k) => lower.includes(k))) return "greeting";

  // Detección de mensaje NO comercial (amigo, joda, charla casual, agradecimientos, afirmaciones)
  const nonCommercialKeywords = [
    "cumpa", "vro", "q pendejo", "todo bien?", "todo bien",
    "que onda", "que ondaa", "ke onda", "ké onda",
    "amigo", "como andas", "cómo andas", "todo tranqui",
    "en la lucha", "de una de una", "fortín", "yunka",
    // Agradecimientos y afirmaciones comunes
    "gracias", "graciass", "muchas gracias", "mil gracias",
    "ok", "okay", "okei",
    "obvio", "claro", "seguro",
    "naa", "nah",
  ];
  if (nonCommercialKeywords.some((k) => lower.includes(k))) return "non_commercial";

  // Mensaje de SOLO emojis (sin texto)
  const emojiOnlyRegex = /^[\p{Emoji}\s]+$/u;
  if (lower.replace(/\s/g, "").length < 3 && emojiOnlyRegex.test(text.trim())) return "non_commercial";

  return "other";
}

// ─── Analyze conversation state ─────────────────────────────────────────────

export async function analyzeConversationState(
  conversationId: number,
  lastUserMessage: string,
  lastToolCalls: string[]
): Promise<{
  isLooping: boolean;
  repromptCount: number;
  directive: string;
  metadata: ConversationMetadata;
}> {
  // Cargar metadata actual
  const [conv] = await db
    .select({ metadata: conversations.conversationMetadata })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const currentMeta: ConversationMetadata = (conv?.metadata as ConversationMetadata) || {
    repromptCount: 0,
    lastUserMessageType: "other",
    lastSuggestedProducts: [],
    lastTools: [],
  };

  const messageType = classifyMessageType(lastUserMessage);

  // Detectar si es un re-prompt: el usuario dijo algo similar al último mensaje
  // o si el agente preguntó lo mismo más de una vez
  const isReprompt = messageType === currentMeta.lastUserMessageType;

  // Actualizar metadata preservando campos desconocidos de otros subsistemas
  // (p. ej. el marcador de confirmación mismo/nuevo del ciclo de pedidos).
  const newMeta: ConversationMetadata = {
    ...currentMeta,
    repromptCount: isReprompt ? currentMeta.repromptCount + 1 : 0,
    lastUserMessageType: messageType,
    lastSuggestedProducts: currentMeta.lastSuggestedProducts,
    lastTools: lastToolCalls,
  };

  // Persistir metadata en DB — A-48: optimistic CAS. The merge re-applies on
  // top of the freshest row on conflict, so a concurrent lifecycle/tool write
  // is never silently lost (unconditional RMW used to drop fields).
  try {
    await updateConversationMetadataCAS(conversationId, (current) => {
      const cur = current as Partial<ConversationMetadata>;
      const reprompt = messageType === cur.lastUserMessageType;
      return {
        ...cur,
        repromptCount: reprompt
          ? (typeof cur.repromptCount === "number" ? cur.repromptCount : 0) + 1
          : 0,
        lastUserMessageType: messageType,
        lastSuggestedProducts: Array.isArray(cur.lastSuggestedProducts) ? cur.lastSuggestedProducts : [],
        lastTools: lastToolCalls,
      };
    });
  } catch {
    // non-fatal
  }

  // Construir directiva anti-loop
  const isLooping = newMeta.repromptCount >= 2;
  let directive: string;

  if (isLooping) {
    directive = `⚠️ DETECTÉ QUE ESTAMOS EN UN CICLO. Ya preguntaste/viste esto antes.
ACCIÓN REQUERIDA:
1. NO preguntes lo mismo de nuevo.
2. Si el cliente quiere hacer un pedido → ejecutá la acción (addOrderItem, luego createOrder).
3. Si el cliente está pidiendo información que ya diste → dala de nuevo sin vueltas.
4. Si no sabés qué hacer → "¿Qué más necesitás amigo?" y escuchá.
5. BAJO NINGÚN CONCEPTO sigas preguntando lo mismo.`;
  } else if (newMeta.repromptCount === 1) {
    directive = `⚠️ CUIDADO: El cliente está repitiendo el tipo de mensaje anterior ("${messageType}").
Probablemente no entendió tu respuesta anterior o quiere avanzar.
Intentá ser más directo: si es un pedido → ejecutalo. Si es una pregunta → respondela sin preguntar de nuevo.`;
  } else {
    directive = "";
  }

  return { isLooping, repromptCount: newMeta.repromptCount, directive, metadata: newMeta };
}

// ─── Build anti-loop directive from raw metadata ────────────────────────────

export function buildAntiLoopDirective(metadata: ConversationMetadata): string {
  if (metadata.repromptCount >= 2) {
    return `⚠️ DETECTÉ QUE ESTAMOS EN UN CICLO. Ya preguntaste/viste esto antes.
ACCIÓN REQUERIDA:
1. NO preguntes lo mismo de nuevo.
2. Si el cliente quiere hacer un pedido → ejecutá la acción.
3. Si no sabés qué hacer → "¿Qué más necesitás amigo?".
4. BAJO NINGÚN CONCEPTO sigas preguntando lo mismo.`;
  }
  return "";
}
