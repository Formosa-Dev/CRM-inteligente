/**
 * Temporal context + order-lifecycle guard (WhatsApp sales agent).
 *
 * Root cause this module addresses: the customer history window mixed messages
 * from several days into a single LLM context with no visible day boundary, so
 * a short reply such as "nooo" (today) could be answered from an order placed on
 * an older day ("¿Te preparo lo de siempre?").
 *
 * Everything here is pure and DB-free so the invariants are unit-testable:
 *  - Argentina local calendar day keys and `[DD/MM HH:mm]` stamps.
 *  - Day segmentation of the conversation history shown to the model.
 *  - Turn-intent classification (explicit order vs non-ordering reply).
 *  - The material order-creation plan (block / keep active / auto-close / create).
 *  - The 4-hour active-order lifecycle window.
 */

import { dedupeHistoryWithBuffered } from "./buffered-history";

export const ARGENTINA_TIME_ZONE = "America/Argentina/Buenos_Aires";

/** An order is still "active" while younger than this; at/over it is stale. */
export const ACTIVE_ORDER_LIFECYCLE_HOURS = 4;

/** Order statuses that count as an open/active order. */
export const ACTIVE_ORDER_STATUSES = ["pending", "preparing", "ready"] as const;
export type ActiveOrderStatus = (typeof ACTIVE_ORDER_STATUSES)[number];

export interface ActiveOrderSnapshot {
  id: number;
  status: string;
  createdAt: Date | string;
}

// ─── Argentina calendar helpers ─────────────────────────────────────────────

const DAY_KEY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: ARGENTINA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const STAMP_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: ARGENTINA_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Argentina local calendar day key, `YYYY-MM-DD`. */
export function argentinaDayKey(value: Date | string | number): string {
  const parts = DAY_KEY_FORMATTER.formatToParts(toDate(value));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Argentina local timestamp label, `[DD/MM HH:mm]`. */
export function formatArgentinaStamp(value: Date | string | number): string {
  const parts = STAMP_FORMATTER.formatToParts(toDate(value));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `[${get("day")}/${get("month")} ${get("hour")}:${get("minute")}]`;
}

/** Short `DD/MM` label for headings. */
export function formatArgentinaDayLabel(value: Date | string | number): string {
  return formatArgentinaStamp(value).replace(/^\[/, "").replace(/ .*$/, "");
}

export function isSameArgentinaDay(a: Date | string | number, b: Date | string | number): boolean {
  return argentinaDayKey(a) === argentinaDayKey(b);
}

export function isTodayArgentina(value: Date | string | number, now: Date = new Date()): boolean {
  return isSameArgentinaDay(value, now);
}

export function ageInHours(createdAt: Date | string | number, now: Date = new Date()): number {
  return (toDate(now).getTime() - toDate(createdAt).getTime()) / 3_600_000;
}

export function isWithinActiveWindow(
  createdAt: Date | string | number,
  now: Date = new Date(),
  hours: number = ACTIVE_ORDER_LIFECYCLE_HOURS,
): boolean {
  return ageInHours(createdAt, now) < hours;
}

// ─── Day segmentation of the model context ──────────────────────────────────

export interface TemporalHistoryEntry {
  role: string;
  content: string;
  createdAt: Date | string;
  platformMessageId?: string | null;
}

export interface SegmentedMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface SegmentationResult {
  messages: SegmentedMessage[];
  todayDayKey: string;
  todayCount: number;
  olderCount: number;
  olderDayKeys: string[];
}

function mapRole(role: string): SegmentedMessage["role"] {
  if (role === "system") return "system";
  if (role === "user") return "user";
  // assistant + human both are outbound turns for the model.
  return "assistant";
}

/**
 * Turns persisted turns into model messages with an explicit day boundary.
 * Older-day turns are visually segmented and prefixed with `[DD/MM HH:mm]`;
 * today's turns stay unlabelled because they are the primary, authoritative
 * context. A system boundary line separates the two so the model can never
 * mistake an older-day item for the current order.
 */
export function segmentHistoryByDay(
  entries: TemporalHistoryEntry[],
  now: Date = new Date(),
): SegmentationResult {
  const todayDayKey = argentinaDayKey(now);
  const olderDayKeys = new Set<string>();

  const labelled = entries.map((entry) => {
    const createdAt = toDate(entry.createdAt);
    const dayKey = argentinaDayKey(createdAt);
    if (dayKey === todayDayKey) {
      return { role: mapRole(entry.role), content: entry.content, isToday: true };
    }
    olderDayKeys.add(dayKey);
    return {
      role: mapRole(entry.role),
      content: `${formatArgentinaStamp(createdAt)} ${entry.content}`,
      isToday: false,
    };
  });

  const messages: SegmentedMessage[] = [];
  const hasOlder = labelled.some((entry) => !entry.isToday);
  let boundaryInserted = false;

  for (const entry of labelled) {
    if (hasOlder && entry.isToday && !boundaryInserted) {
      messages.push({
        role: "system",
        content:
          `[CONTEXTO TEMPORAL — ${ARGENTINA_TIME_ZONE}] ` +
          `HOY es ${formatArgentinaDayLabel(now)}. Los mensajes anteriores etiquetados [DD/MM HH:mm] ` +
          `son de días previos: contexto histórico SECUNDARIO. Solo los mensajes de HOY representan el ` +
          `pedido actual. Nunca reconstruyas ni ofrezcas un pedido combinando mensajes de días distintos.`,
      });
      boundaryInserted = true;
    }
    messages.push({ role: entry.role, content: entry.content });
  }

  return {
    messages,
    todayDayKey,
    todayCount: labelled.filter((entry) => entry.isToday).length,
    olderCount: labelled.filter((entry) => !entry.isToday).length,
    olderDayKeys: [...olderDayKeys].sort(),
  };
}

export interface BufferedTurnLike {
  content: string;
  messageId?: string;
}

/**
 * Builds the exact model context from persisted history plus the buffered turn:
 * dedupes the just-persisted inbound turns, stamps older-day turns with
 * `[DD/MM HH:mm]`, inserts an explicit day boundary, and maps roles for the
 * model (system stays system, human → assistant).
 */
export function buildTemporalAgentMessages(
  history: TemporalHistoryEntry[],
  buffered: BufferedTurnLike[],
  now: Date = new Date(),
): SegmentationResult {
  const allowed = new Set(["user", "assistant", "human", "system"]);
  const filtered = history.filter((entry) => allowed.has(entry.role));
  const deduped = dedupeHistoryWithBuffered(filtered, buffered);

  const entries: TemporalHistoryEntry[] = deduped.map((entry) => ({
    role: entry.role,
    content: entry.content,
    createdAt: entry.createdAt ?? now,
    platformMessageId: entry.platformMessageId,
  }));

  if (buffered.length > 0) {
    entries.push({
      role: "user",
      content: buffered.map((message) => message.content).join("\n"),
      createdAt: now,
    });
  }

  return segmentHistoryByDay(entries, now);
}

// ─── Turn intent classification ─────────────────────────────────────────────

export type TurnIntent = "explicit_order" | "non_ordering" | "ambiguous";

function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

const ORDER_VERB_PATTERN =
  /\b(quiero|queria|quiere|queremos|dame|mandame|mandame|agregame|agrega|sumale|suma|poneme|pone|llevo|necesito|pedir|pedido|pedi|ordenar|comprar|compra|compro|preparame|prepara|haceme|anotame|anota|reservame|reservar)\b/;

const PRODUCT_HINT_PATTERN =
  /\b(hamburguesa|hamburguesas|burger|bookbinder|genesis|deli|deli deli|crispy|classic|clasica|toro|torro|smash|papas|pan|docena|docenas|prepizza|fernet|trago|tragos|bebida|bebidas|combo|promo|promocion|empanada|empanadas|medialuna|lomito)\b/;

const NON_ORDERING_PATTERNS: RegExp[] = [
  /^(hola+|holaa+|buenas+|buen dia|buenas tardes|buenas noches|que tal|que onda)\b/,
  /^(ok(?:is|ay|ey|a)?|dale+|sisi+|sii+|si|listo|perfecto|genial|joya|barbaro|excelente|de una|bueno|obvio|claro|seguro|gracias|muchas gracias|mil gracias|chau|nos vemos)\b/,
  /^(no+|nop|nope)\b/,
  /^no,?\s*gracias\b/,
  /\blo de siempre\b/,
  /\bla de siempre\b/,
  /\bcomo siempre\b/,
  /\bla (?:misma|de antes)\b/,
];

const EMOJI_ONLY_PATTERN = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\s|\uFE0F)+$/u;

/**
 * Marker embedded in the keep-active question. The tool result that asks
 * "same order or a new one?" carries it, so a later turn can detect that the
 * clarification already happened and a "new order" answer may proceed —
 * otherwise keep_active would be a dead end the customer could never exit.
 */
export const KEEP_ACTIVE_ORDER_MARKER = "mismo pedido o querés uno nuevo";

const SEPARATE_ORDER_PATTERN =
  /\b(otro pedido|otra orden|pedido nuevo|nuevo pedido|orden nueva|nueva orden|pedido aparte|pedido separado|pedido distinto|un pedido mas|hacer otro pedido)\b/;

/** The customer explicitly asks for a NEW/separate order (not the active one). */
export function wantsSeparateOrder(text: string): boolean {
  const norm = normalizeForMatch(text);
  if (!norm) return false;
  return SEPARATE_ORDER_PATTERN.test(norm);
}

export function hasExplicitOrderText(text: string): boolean {
  const norm = normalizeForMatch(text);
  if (!norm) return false;
  return ORDER_VERB_PATTERN.test(norm) || PRODUCT_HINT_PATTERN.test(norm);
}

export function isNonOrderingText(text: string): boolean {
  const norm = normalizeForMatch(text);
  if (!norm) return false;
  if (NON_ORDERING_PATTERNS.some((pattern) => pattern.test(norm))) return true;
  return norm.replace(/\s/g, "").length < 3 && EMOJI_ONLY_PATTERN.test(text.trim());
}

/** A rejection must never create or suggest an order, even with an open cart. */
export function isNegativeResponseText(text: string): boolean {
  const norm = normalizeForMatch(text);
  if (!norm) return false;
  return /^(no+|nop|nope)\b/.test(norm) || /^no,?\s*gracias\b/.test(norm);
}

export function classifyTurnIntent(text: string): TurnIntent {
  const norm = normalizeForMatch(text);
  if (!norm) return "ambiguous";
  if (hasExplicitOrderText(norm)) return "explicit_order";
  if (isNonOrderingText(norm)) return "non_ordering";
  return "ambiguous";
}

export function textMentionsName(text: string, name: string): boolean {
  const normText = normalizeForMatch(text);
  const normName = normalizeForMatch(name);
  if (!normName) return false;
  return normText.includes(normName);
}

// ─── Order lifecycle (pure decision) ────────────────────────────────────────

export type OrderLifecycleAction =
  | { action: "none" }
  | { action: "keep_active"; orderId: number; ageHours: number }
  | { action: "auto_close"; orderId: number; ageHours: number };

export function evaluateOrderLifecycle(input: {
  activeOrder: ActiveOrderSnapshot | null;
  now?: Date;
  hours?: number;
}): OrderLifecycleAction {
  if (!input.activeOrder) return { action: "none" };
  const now = input.now ?? new Date();
  const hours = input.hours ?? ACTIVE_ORDER_LIFECYCLE_HOURS;
  const ageHours = ageInHours(input.activeOrder.createdAt, now);
  if (ageHours >= hours) {
    return { action: "auto_close", orderId: input.activeOrder.id, ageHours };
  }
  return { action: "keep_active", orderId: input.activeOrder.id, ageHours };
}

// ─── Material order-creation plan ───────────────────────────────────────────

export interface OrderCartItem {
  name: string;
  quantity: number;
}

export interface OrderCreationFacts {
  referencedWebOrderId?: number;
  turnText: string;
  replyToNotification: boolean;
  /** Active (non-expired, same-day) cart items recorded server-side. */
  sameDayCartItems: OrderCartItem[];
  /** Items the model claims for THIS turn (never trusted on their own). */
  explicitItems?: OrderCartItem[];
  activeOrder: ActiveOrderSnapshot | null;
  /**
   * True when recent turns show the same/new clarification already happened
   * (assistant asked the keep-active question, or the customer already said
   * "otro pedido"). Lets an explicit new order proceed past keep_active.
   */
  newOrderIntentPending?: boolean;
  now?: Date;
  lifecycleHours?: number;
}

export type OrderCreationBlockReason =
  | "web_order_exists"
  | "negative_response"
  | "notification_reply"
  | "non_ordering"
  | "no_current_day_items"
  | "unsupported_items";

export type OrderCreationPlan =
  | { kind: "blocked"; reason: OrderCreationBlockReason; message: string }
  | { kind: "keep_active"; orderId: number; message: string }
  | { kind: "auto_close_then_create"; closeOrderId: number }
  | { kind: "create" };

const NO_CREATE_PREFIX = "NO se creó ningún pedido.";

/**
 * Decides whether a new order may be created, revalidating the temporal and
 * lifecycle invariants server-side (cannot be bypassed by the prompt/LLM):
 *  1. A verified web order is never duplicated.
 *  2. A rejection ("nooo") never creates or suggests an order.
 *  3. A reply to a closure/status notification never creates an order.
 *  4. A pure non-ordering reply (greeting/ack/emoji) with no same-day cart
 *     never creates an order.
 *  5. Orders are only created from explicit items of TODAY — either a
 *     server-recorded same-day cart or explicit items that the current turn
 *     actually mentions. Never reconstructed across days.
 *  6. An open order under 4h keeps active (avoid duplication; ask same/new);
 *     at/over 4h it is auto-closed before any new order is created.
 */
export function planOrderCreation(facts: OrderCreationFacts): OrderCreationPlan {
  const now = facts.now ?? new Date();

  if (facts.referencedWebOrderId) {
    return {
      kind: "blocked",
      reason: "web_order_exists",
      message: `El pedido web #${facts.referencedWebOrderId} ya está registrado. Continuá sobre ese mismo pedido; no lo dupliques.`,
    };
  }

  if (isNegativeResponseText(facts.turnText)) {
    return {
      kind: "blocked",
      reason: "negative_response",
      message: `${NO_CREATE_PREFIX} El cliente respondió negativamente. No ofrezcas ni crees un pedido.`,
    };
  }

  if (facts.replyToNotification) {
    return {
      kind: "blocked",
      reason: "notification_reply",
      message: `${NO_CREATE_PREFIX} El cliente responde a una notificación de estado de un pedido. No crees ni sugieras un pedido nuevo.`,
    };
  }

  const hasSameDayCart = facts.sameDayCartItems.length > 0;

  if (!hasSameDayCart && classifyTurnIntent(facts.turnText) === "non_ordering") {
    return {
      kind: "blocked",
      reason: "non_ordering",
      message: `${NO_CREATE_PREFIX} El mensaje de HOY es un saludo/reacción/confirmación, no un pedido. No sugieras "lo de siempre" ni pedidos de días anteriores.`,
    };
  }

  const hasExplicitItems = (facts.explicitItems?.length ?? 0) > 0;
  if (!hasSameDayCart && !hasExplicitItems) {
    return {
      kind: "blocked",
      reason: "no_current_day_items",
      message: `${NO_CREATE_PREFIX} No hay productos explícitos del día de HOY. No reconstruyas un pedido con mensajes de días anteriores.`,
    };
  }

  if (!hasSameDayCart && facts.explicitItems) {
    const mentioned = facts.explicitItems.some((item) => textMentionsName(facts.turnText, item.name));
    if (!mentioned && !hasExplicitOrderText(facts.turnText)) {
      return {
        kind: "blocked",
        reason: "unsupported_items",
        message: `${NO_CREATE_PREFIX} El cliente no confirmó esos productos en el mensaje actual. No los registres sin confirmación.`,
      };
    }
  }

  const lifecycle = evaluateOrderLifecycle({
    activeOrder: facts.activeOrder,
    now,
    hours: facts.lifecycleHours,
  });

  if (lifecycle.action === "keep_active") {
    // The same/new clarification already happened (or the customer explicitly
    // asked for a separate order): items above are already grounded in today,
    // so honoring "iniciar otro" is the required path — not a duplicate.
    const separateOrderRequested =
      facts.newOrderIntentPending === true || wantsSeparateOrder(facts.turnText);
    if (!separateOrderRequested) {
      return {
        kind: "keep_active",
        orderId: lifecycle.orderId,
        message:
          `Ya tenés un pedido activo (#${lifecycle.orderId}) de hace menos de ` +
          `${facts.lifecycleHours ?? ACTIVE_ORDER_LIFECYCLE_HOURS} horas. ` +
          `No creé otro. ¿Es el ${KEEP_ACTIVE_ORDER_MARKER}?`,
      };
    }
  }

  if (lifecycle.action === "auto_close") {
    return { kind: "auto_close_then_create", closeOrderId: lifecycle.orderId };
  }

  return { kind: "create" };
}
