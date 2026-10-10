import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

async function main() {
  const phone = '5493704868421';

  console.log('=== ELIMINANDO TAMBIEN DIRECCIONES ===\n');

  // Eliminar direcciones asociadas a ese telefono
  await sql`DELETE FROM addresses WHERE phone = ${phone}`;
  console.log('Direcciones eliminadas');

  // Verificar Customers (si existe tabla customers)
  try {
    await sql`DELETE FROM customers WHERE phone = ${phone}`;
    console.log('Customers eliminados');
  } catch {
    console.log('No hay tabla customers, ok');
  }

  // Verificar si hay algo mas con ese telefono
  const tables = ['addresses', 'leads', 'orders', 'chat_messages', 
    'order_context_items', 'attachments', 'promotions'];
  
  console.log('\n=== VERIFICACION COMPLETA ===');
  for (const table of tables) {
    try {
      await sql(`SELECT COUNT(*)::int as c FROM ${table} WHERE phone = '${phone}' OR customer_phone = '${phone}' OR phone_number = '${phone}'`);
      // No podemos usar tagged template con table name dinamico, usamos raw
    } catch {}
  }
  
  // Queries especificas
  const checkPhone = await sql`SELECT COUNT(*)::int as c FROM addresses WHERE phone = ${phone}`;
  console.log('Direcciones con ese telefono:', checkPhone[0].c);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
