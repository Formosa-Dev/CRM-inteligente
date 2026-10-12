import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) { console.error("NO DATABASE_URL"); process.exit(1); }
const sql = neon(url);

const maskPhone = (v) => {
  if (v == null) return "(null)";
  const s = String(v);
  const digits = s.replace(/\D/g, "");
  return digits.length <= 4 ? "****" : "***" + digits.slice(-4) + ` [digits=${digits.length}]`;
};
const clip = (v, n = 220) => (v == null ? "(null)" : String(v).length > n ? String(v).slice(0, n) + "…" : String(v));
// Customer names are PII: keep only the first initial so the script can still
// correlate records without exposing full identities in logs.
const maskName = (v) => {
  if (v == null) return "(null)";
  const s = String(v).trim();
  return s.length === 0 ? "(empty)" : `${s[0].toUpperCase()}***`;
};

async function main() {
  const host = new URL(url).host.replace(/^[^.]+/, "***");
  const [ver] = await sql`select version() as v`;
  console.log("DB host (masked):", host);
  console.log("PG:", clip(ver.v, 60));

  console.log("\n=== orders columns ===");
  const cols = await sql`
    select column_name, data_type, is_nullable
    from information_schema.columns
    where table_name = 'orders' order by ordinal_position`;
  for (const c of cols) console.log(` ${c.column_name} ${c.data_type} null=${c.is_nullable}`);

  console.log("\n=== agent_config columns (presence) ===");
  const acols = await sql`
    select column_name from information_schema.columns
    where table_name = 'agent_config' order by ordinal_position`;
  console.log(" ", acols.map((c) => c.column_name).join(", "));

  console.log("\n=== agent_config id=1 (masked) ===");
  const [cfg] = await sql`
    select id, phone_number, whatsapp_bot_number, business_phone_display,
           business_website, business_name, meta_connected, meta_phone_number_id,
           web_order_redirect_enabled, delivery_phone_number, telegram_chat_id
    from agent_config where id = 1`;
  if (!cfg) console.log("  NO ROW id=1");
  else {
    console.log("  id=1");
    console.log("  phone_number (agent target):", maskPhone(cfg.phone_number));
    console.log("  whatsapp_bot_number:", maskPhone(cfg.whatsapp_bot_number));
    console.log("  delivery_phone_number:", maskPhone(cfg.delivery_phone_number));
    console.log("  business_phone_display:", maskPhone(cfg.business_phone_display));
    console.log("  meta_connected:", cfg.meta_connected, "| meta_phone_number_id present:", !!cfg.meta_phone_number_id);
    console.log("  business_website:", clip(cfg.business_website, 120));
    console.log("  business_name:", clip(cfg.business_name, 80));
    console.log("  web_order_redirect_enabled:", cfg.web_order_redirect_enabled);
  }

  console.log("\n=== agent_config row count ===");
  const [cnt] = await sql`select count(*)::int as n from agent_config`;
  console.log("  rows:", cnt.n);

  console.log("\n=== web orders (notes like '%Pedido web%') last 25 ===");
  const web = await sql`
    select id, phone_number, customer_name, status, order_type, created_at,
           left(notes, 320) as notes, jsonb_array_length(items) as item_count
    from orders
    where notes like '%Pedido web%' or notes like '%Referencia WEB:%'
    order by id desc limit 25`;
  console.log("  count(returned):", web.length);
  for (const o of web) {
    console.log(`  #${o.id} phone=${maskPhone(o.phone_number)} status=${o.status} type=${o.order_type} items=${o.item_count} at=${o.created_at?.toISOString?.() || o.created_at}`);
    console.log(`     notes: ${clip(o.notes, 320)}`);
  }

  console.log("\n=== total web orders ===");
  const [wc] = await sql`select count(*)::int as n from orders where notes like '%Pedido web%' or notes like '%Referencia WEB:%'`;
  console.log("  total:", wc.n);

  console.log("\n=== duplicate WEB references (same reference in >1 order) ===");
  const dups = await sql`
    select substring(notes from 'Referencia WEB:([0-9a-fA-F-]{36})') as ref,
           count(*)::int as n, array_agg(id order by id) as ids
    from orders
    where notes ~ 'Referencia WEB:[0-9a-fA-F-]{36}'
    group by 1 having count(*) > 1
    order by n desc limit 20`;
  console.log("  groups with duplicates:", dups.length);
  for (const d of dups) console.log(`   ref=${clip(d.ref, 40)} n=${d.n} ids=${d.ids.join(",")}`);

  console.log("\n=== orders with WEB ref but NO fingerprint (legacy format) ===");
  const [legacy] = await sql`
    select count(*)::int as n from orders
    where notes like '%Referencia WEB:%' and notes not like '%web-payload:%'`;
  console.log("  legacy (ref w/o fingerprint):", legacy.n);
  const [hasFp] = await sql`
    select count(*)::int as n from orders
    where notes like '%web-payload:%'`;
  console.log("  with fingerprint:", hasFp.n);

  console.log("\n=== recent web-checkout orders for the reported customer suffix 8421 ===");
  const cust = await sql`
    select id, phone_number, customer_name, status, created_at, left(notes,360) as notes
    from orders
    where phone_number like '%8421'
    order by id desc limit 10`;
  console.log("  matches:", cust.length);
  for (const o of cust) {
    console.log(`  #${o.id} phone=${maskPhone(o.phone_number)} name=${maskName(o.customer_name)} status=${o.status} at=${o.created_at?.toISOString?.() || o.created_at}`);
    console.log(`     notes: ${clip(o.notes, 360)}`);
  }

  console.log("\n=== orders table total ===");
  const [oc] = await sql`select count(*)::int as n from orders`;
  console.log("  total orders:", oc.n);
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
