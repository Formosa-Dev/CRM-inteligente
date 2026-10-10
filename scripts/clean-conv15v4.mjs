import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

async function main() {
  // Primero mostrar para confirmar
  const antes = await sql`SELECT COUNT(*)::int as c FROM chat_messages WHERE conversation_id = 15`;
  console.log('Antes:', antes[0].c, 'mensajes');

  // Borrar mensajes del 31/5 desde las 03:10 en adelante
  await sql`DELETE FROM chat_messages 
    WHERE conversation_id = 15 
    AND created_at >= '2026-05-31T03:10:00-03:00'`;

  console.log('DELETE ejecutado');

  const despues = await sql`SELECT COUNT(*)::int as c FROM chat_messages WHERE conversation_id = 15`;
  console.log('Despues:', despues[0].c, 'mensajes');
  console.log('Diferencia:', antes[0].c - despues[0].c, 'eliminados');
}
main().catch(e => console.error(e));
