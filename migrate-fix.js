/* eslint-disable @typescript-eslint/no-require-imports -- script de migracion CommonJS: el package no es type:module, convertirlo a ESM lo romperia */
const { neon } = require("@neondatabase/serverless");

const sql = neon(process.env.DATABASE_URL);

async function migrate() {
  console.log("Adding columns...");
  
  try {
    await sql`ALTER TABLE agent_config ADD COLUMN IF NOT EXISTS whatsapp_bot_number varchar(50)`;
    console.log("✓ whatsapp_bot_number");
  } catch(e) { console.log(" whatsapp_bot_number:", e.message.includes('already') ? 'exists' : e.message) }
  
  try {
    await sql`ALTER TABLE agent_config ADD COLUMN IF NOT EXISTS allowed_phone_ids jsonb DEFAULT '[]'::jsonb`;
    console.log("✓ allowed_phone_ids");
  } catch(e) { console.log(" allowed_phone_ids:", e.message.includes('already') ? 'exists' : e.message) }
  
  try {
    await sql`ALTER TABLE agent_config ADD COLUMN IF NOT EXISTS auto_reply_24h boolean DEFAULT false`;
    console.log("✓ auto_reply_24h");
  } catch(e) { console.log(" auto_reply_24h:", e.message.includes('already') ? 'exists' : e.message) }
  
  try {
    await sql`ALTER TABLE agent_config ADD COLUMN IF NOT EXISTS auto_reply_24h_message text`;
    console.log("✓ auto_reply_24h_message");
  } catch(e) { console.log(" auto_reply_24h_message:", e.message.includes('already') ? 'exists' : e.message) }
  
  try {
    await sql`ALTER TABLE agent_config ADD COLUMN IF NOT EXISTS train_bot_context text`;
    console.log("✓ train_bot_context");
  } catch(e) { console.log(" train_bot_context:", e.message.includes('already') ? 'exists' : e.message) }
  
  console.log("Done!");
  process.exit(0);
}

migrate().catch(e => { console.error(e); process.exit(1); });