/* eslint-disable @typescript-eslint/no-require-imports -- script de mantenimiento CommonJS: el package no es type:module, convertirlo a ESM lo romperia */
const { neon } = require("@neondatabase/serverless");
require("dotenv").config();
const sql = neon(process.env.DATABASE_URL);
(async () => {
  const ords = await sql`SELECT count(*) as c FROM orders`;
  const convs = await sql`SELECT count(*) as c FROM conversations`;
  console.log(`Pedidos: ${ords[0]?.c} | Conversaciones: ${convs[0]?.c}`);
  await sql`DELETE FROM orders`;
  await sql`DELETE FROM chat_messages`;
  await sql`DELETE FROM attachments`;
  await sql`DELETE FROM conversations`;
  console.log("✅ Todo eliminado — base de datos limpia");
})();
