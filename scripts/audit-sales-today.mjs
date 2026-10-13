// ─── Auditoría read-only de ventas/conversaciones de HOY (hora Argentina) ────
// Uso: node scripts/audit-sales-today.mjs [--json]
//
// Garantías:
//   - SOLO lecturas (SELECT). Nunca escribe, envía ni migra nada.
//   - Redacta PII antes de imprimir: nombres de clientes, teléfonos, emails y
//     direcciones/números largos. Los textos quedan legibles para analizar tono
//     sin exponer datos personales.
//   - No imprime DATABASE_URL ni credenciales.
//
// Clasificación de resultados (autoritativa = fila en `orders`, jamás intención):
//   - web       : pedido con tag "Carta digital" o nota "Pedido web".
//   - operador  : conversación WhatsApp con override humano activo o rol "human"
//                 en la ventana del pedido.
//   - bot       : resto de pedidos con conversación WhatsApp hoy y sin operador.
//   - sin-venta : conversación sin pedido asociado (unknown/abandonada).

import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

const PHONE_RE = /\+?\d[\d\s().-]{5,}\d/g;
const LONGNUM_RE = /\b\d{5,}\b/g;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

function buildRedactor(names) {
  const sorted = [...names]
    .filter((n) => typeof n === "string" && n.trim().length >= 3)
    .sort((a, b) => b.length - a.length);
  return (input) => {
    if (input == null) return "";
    let out = String(input);
    for (const n of sorted) {
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(esc, "gi"), "[CLIENTE]");
    }
    out = out
      .replace(/\b(adri(?:an|i)?)\b/gi, "[ADMIN]")
      .replace(EMAIL_RE, "[EMAIL]")
      .replace(PHONE_RE, "[TEL]")
      .replace(LONGNUM_RE, "[NUM]");
    return out.replace(/\s+/g, " ").trim();
  };
}

const cut = (s, n = 220) => (s.length > n ? s.slice(0, n) + "…" : s);
const fmt = (d) =>
  new Date(d).toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

async function main() {
  const [{ today }] = await sql`
    SELECT to_char(now() AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD') AS today`;

  // Ventana de HOY (00:00 AR → 00:00 AR del día siguiente), en timestamptz.
  const [bounds] = await sql`
    SELECT
      (${today}::timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires') AS start_today,
      ((${today}::timestamp + interval '1 day') AT TIME ZONE 'America/Argentina/Buenos_Aires') AS start_tomorrow,
      ((${today}::timestamp - interval '1 day' + interval '13 hours') AT TIME ZONE 'America/Argentina/Buenos_Aires') AS start_yesterday_pm`;
  const startToday = bounds.start_today;
  const startTomorrow = bounds.start_tomorrow;
  const startYesterdayPm = bounds.start_yesterday_pm;

  const names = await sql`
    SELECT DISTINCT value FROM (
      SELECT customer_name AS value FROM conversations WHERE customer_name IS NOT NULL
      UNION ALL
      SELECT name FROM leads WHERE name IS NOT NULL
    ) t WHERE length(value) >= 3`;
  const redact = buildRedactor(names.map((r) => r.value));

  // ── 1. Pedidos creados HOY ────────────────────────────────────────────────
  const orders = await sql`
    SELECT id, created_at, status, payment_status, order_type, phone_number,
           lead_id, tags, notes, delivered_at
    FROM orders
    WHERE created_at >= ${startToday} AND created_at < ${startTomorrow}
    ORDER BY created_at`;

  // ── 2. Conversaciones WhatsApp con actividad HOY ──────────────────────────
  const convs = await sql`
    SELECT c.id, c.customer_name, c.customer_phone, c.human_override_until,
           count(*) FILTER (WHERE cm.role = 'user')      AS user_msgs,
           count(*) FILTER (WHERE cm.role = 'assistant') AS bot_msgs,
           count(*) FILTER (WHERE cm.role = 'human')     AS human_msgs,
           count(*)                                      AS total_msgs,
           min(cm.created_at) AS first_at,
           max(cm.created_at) AS last_at
    FROM chat_messages cm
    JOIN conversations c ON c.id = cm.conversation_id
    WHERE c.channel = 'whatsapp'
      AND cm.created_at >= ${startToday} AND cm.created_at < ${startTomorrow}
    GROUP BY c.id, c.customer_name, c.customer_phone, c.human_override_until
    ORDER BY max(cm.created_at)`;

  const convIds = convs.map((c) => c.id);
  let messages = [];
  if (convIds.length) {
    messages = await sql`
      SELECT conversation_id, role, content, created_at
      FROM chat_messages
      WHERE conversation_id = ANY(${convIds})
        AND created_at >= ${startToday} AND created_at < ${startTomorrow}
      ORDER BY conversation_id, created_at`;
  }
  const byConv = new Map();
  for (const m of messages) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id).push(m);
  }

  // ── 3. Telegram (ayer tarde/noche + hoy) ──────────────────────────────────
  const telegram = await sql`
    SELECT c.id, cm.role, cm.content, cm.created_at
    FROM chat_messages cm
    JOIN conversations c ON c.id = cm.conversation_id
    WHERE c.channel = 'telegram'
      AND cm.created_at >= ${startYesterdayPm}
    ORDER BY cm.created_at`;

  // ── Clasificación por teléfono ────────────────────────────────────────────
  const norm = (p) => String(p || "").replace(/\D/g, "");
  const convByPhone = new Map();
  for (const c of convs) convByPhone.set(norm(c.customer_phone), c);

  const isWeb = (o) =>
    (Array.isArray(o.tags) && o.tags.includes("Carta digital")) ||
    /pedido web/i.test(o.notes || "");
  const hadOperator = (c) =>
    c && (c.human_msgs > 0 || (c.human_override_until && new Date(c.human_override_until) > new Date(bounds.start_today)));

  const classified = orders.map((o) => {
    const conv = convByPhone.get(norm(o.phone_number));
    let kind = "bot";
    if (isWeb(o)) kind = "web";
    else if (hadOperator(conv)) kind = "operador";
    else if (!conv) kind = "sin-conv";
    return { o, conv, kind };
  });

  // ── Salida ────────────────────────────────────────────────────────────────
  const L = [];
  L.push(`VENTANA (AR): ${today} 00:00 → 24:00  (UTC now ${new Date().toISOString()})`);
  L.push(`Conversaciones WhatsApp con actividad hoy: ${convs.length}`);
  L.push(`Mensajes en esas conversaciones: ${messages.length}`);
  const counts = { user: 0, assistant: 0, human: 0, system: 0 };
  for (const m of messages) counts[m.role] = (counts[m.role] || 0) + 1;
  L.push(`  rol user=${counts.user} assistant=${counts.assistant} human=${counts.human} system=${counts.system}`);
  L.push(`Pedidos creados hoy: ${orders.length}`);
  const byKind = {};
  for (const c of classified) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
  L.push(`Clasificación: ${JSON.stringify(byKind)}`);
  L.push("");

  L.push("═══ PEDIDOS DE HOY ═══");
  for (const { o, conv, kind } of classified) {
    const items = Array.isArray(o.items)
      ? o.items.map((i) => `${i.quantity || 1}x ${i.name || "?"}`).join(", ")
      : "?";
    L.push(
      `#${o.id} [${kind}] ${fmt(o.created_at)} ${o.order_type || "?"}/${o.status}/${o.payment_status}` +
        ` — ${redact(items)}${o.address ? ` (dir: ${redact(o.address)})` : ""}` +
        `${conv ? ` conv#${conv.id}` : ""}`
    );
  }
  L.push("");

  L.push("═══ CONVERSACIONES WHATSAPP DE HOY ═══");
  for (const c of convs) {
    const order = classified.find((x) => x.conv?.id === c.id);
    L.push(
      `\n--- conv#${c.id} ${fmt(c.first_at)}→${fmt(c.last_at)} | user=${c.user_msgs} bot=${c.bot_msgs} human=${c.human_msgs}` +
        `${order ? ` | PEDIDO #${order.o.id} [${order.kind}]` : " | SIN PEDIDO"}`
    );
    for (const m of byConv.get(c.id) || []) {
      L.push(`  [${fmt(m.created_at)}] ${m.role.toUpperCase()}: ${redact(cut(m.content, 200))}`);
    }
  }
  L.push("");

  L.push("═══ TELEGRAM (ayer tarde/noche + hoy) ═══");
  const tgConvs = new Map();
  for (const m of telegram) {
    if (!tgConvs.has(m.id)) tgConvs.set(m.id, []);
    tgConvs.get(m.id).push(m);
  }
  L.push(`Conversaciones Telegram: ${tgConvs.size}, mensajes: ${telegram.length}`);
  for (const [id, msgs] of tgConvs) {
    L.push(`\n--- tg conv#${id} (${msgs.length} msgs) ---`);
    for (const m of msgs) {
      L.push(`  [${fmt(m.created_at)}] ${m.role.toUpperCase()}: ${redact(cut(m.content, 260))}`);
    }
  }

  const report = L.join("\n");
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ today, convs: convs.length, orders: orders.length, byKind, telegram: telegram.length }));
  } else {
    console.log(report);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[audit] fallo:", e.message);
    process.exit(1);
  });
