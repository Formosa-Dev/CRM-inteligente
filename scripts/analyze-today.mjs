import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
async function main() {
  // Todos los mensajes de WhatsApp de hoy, ordenados por conversacion
  const msgs = await sql`SELECT cm.id, cm.conversation_id, cm.role, cm.content, cm.created_at, c.customer_name, c.customer_phone
    FROM chat_messages cm 
    JOIN conversations c ON c.id = cm.conversation_id 
    WHERE c.channel = 'whatsapp' 
    AND cm.created_at > '2026-05-31'
    AND c.customer_name IS NOT NULL AND c.customer_name != ''
    ORDER BY cm.conversation_id, cm.created_at`;
  
  let currentConv = 0;
  let convCount = 0;
  let ownerMsgs = 0;
  let botMsgs = 0;
  
  for (const m of msgs) {
    if (m.conversation_id !== currentConv) {
      // Determinar si es conversacion del dueno o del bot
      // Las del dueno tienen respuestas del dueno (no rol assistant de AI)
      // Las del bot tienen respuestas del AI
      convCount++;
      console.log(`\n========== CONV #${m.conversation_id} (${m.customer_name || m.customer_phone}) ==========`);
      currentConv = m.conversation_id;
    }
    const t = new Date(m.created_at).toLocaleString('es-AR', {hour:'2-digit',minute:'2-digit'});
    const preview = m.content ? m.content.slice(0, 300) : '(empty)';
    if (m.role === 'assistant') botMsgs++;
    else if (m.role === 'user') ownerMsgs++;
    console.log(`[${t}] ${m.role.toUpperCase()}: ${preview}`);
  }
  
  console.log(`\n\n=== ESTADISTICAS ===`);
  console.log(`Conversaciones hoy: ${convCount}`);
  console.log(`Mensajes de usuarios: ${ownerMsgs}`);
  console.log(`Mensajes de AI/dueno: ${botMsgs}`);
  process.exit(0);
}
main().catch(e => console.error(e));
