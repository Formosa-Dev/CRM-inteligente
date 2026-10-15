import "dotenv/config";
import bcrypt from "bcryptjs";
import { db } from "./index";
import { users, agentConfig, products } from "./schema";
import { LINEA_CARNE } from "@/lib/constants";

// ─── Tipos helpers ──────────────────────────────────────────────────────────────
type Category = "hamburguesa" | "acompanamiento" | "pan_mayorista" | "tragos_vip" | "bebidas" | "alcohol" | "empanadas" | "pizzas";

const TRAGOS_VIP = [
  { name: "Frutilla", price: 6500, sort: 0 },
  { name: "Durazno", price: 6500, sort: 1 },
  { name: "Ananá", price: 6500, sort: 2 },
  { name: "Frutos Rojos", price: 6500, sort: 3 },
  { name: "Mixtos (Durazno y Frutilla)", price: 6500, sort: 4 },
];

/**
 * Seed mínimo seguro:
 *   ADMIN_EMAIL + ADMIN_PASSWORD   → crea el primer usuario admin (obligatorio)
 *   SEED_DEMO=1                    → además carga productos de ejemplo
 *
 * Nunca escribe credenciales ni API keys — todo lo sensible se carga después
 * desde /admin/agent.
 */
async function main() {
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD;
  const seedDemo = process.env.SEED_DEMO === "1";

  if (!adminEmail || !adminPassword) {
    console.error(
      "Faltan ADMIN_EMAIL y/o ADMIN_PASSWORD.\n" +
        "El seed nunca crea credenciales por defecto — pasá las tuyas:\n" +
        '  ADMIN_EMAIL=you@example.com ADMIN_PASSWORD="clave-segura" npm run db:seed'
    );
    process.exit(1);
  }

  if (adminPassword.length < 8) {
    console.error("ADMIN_PASSWORD debe tener al menos 8 caracteres.");
    process.exit(1);
  }

  console.log("Seeding database...");

  // ── Admin user ──────────────────────────────────────────────────────────────
  const hashedPassword = await bcrypt.hash(adminPassword, 12);

  await db
    .insert(users)
    .values({
      email: adminEmail,
      hashedPassword,
      name: "Admin",
      role: "admin",
    })
    .onConflictDoNothing({ target: users.email });

  console.log(`✓ Admin user ready (${adminEmail})`);

  // ── Agent config (id=1 row so the admin UI has something to update) ─────────
  await db
    .insert(agentConfig)
    .values({
      id: 1,
      systemPrompt:
        "Sos el asistente virtual del negocio. Ayudás a los clientes con información sobre los productos y pedidos.",
      enabled: false,
      businessHours: {
        monday: { open: "10:00", close: "22:00" },
        tuesday: { open: "10:00", close: "22:00" },
        wednesday: { open: "10:00", close: "22:00" },
        thursday: { open: "10:00", close: "22:00" },
        friday: { open: "10:00", close: "23:00" },
        saturday: { open: "11:00", close: "23:00" },
        sunday: { open: "11:00", close: "22:00" },
      },
    })
    .onConflictDoNothing();

  console.log("✓ Agent config ready (id=1)");

  if (!seedDemo) {
    console.log("Seed complete. (Pasá SEED_DEMO=1 para cargar productos de ejemplo)");
    process.exit(0);
  }

  // ── Demo catalog (opt-in, replaceable from /admin/products) ─────────────────
  const burgerRows = LINEA_CARNE.map((p, index) => ({
    name: p.name,
    description: p.ingredients,
    price: p.price !== null ? String(p.price) : null,
    category: "hamburguesa" as Category,

    available: true,
    comingSoon: p.comingSoon ?? false,
    sortOrder: index,
  }));

  await db.insert(products).values(burgerRows).onConflictDoNothing();
  console.log(`✓ ${burgerRows.length} demo products seeded (LINEA_CARNE)`);

  await db
    .insert(products)
    .values({
      name: "Coca-Cola",
      description: "Gaseosa Coca-Cola 500ml",
      price: "1500",
      category: "bebidas" as Category,

      available: true,
      sortOrder: 0,
    })
    .onConflictDoNothing();
  console.log("✓ Coca-Cola seeded");

  for (const t of TRAGOS_VIP) {
    await db
      .insert(products)
      .values({
        name: `Tragos V.I.P ${t.name}`,
        description: `Trago V.I.P de 1 Litro - ${t.name}. Con muchas gomitas y salsas de caramelo.`,
        price: String(t.price),
        category: "tragos_vip" as Category,

        available: true,
        sortOrder: t.sort,
        variants: [
          { name: "Sin Crema", priceDelta: 0, default: true },
          { name: "Con Crema", priceDelta: 500 },
        ],
      })
      .onConflictDoNothing();
  }
  console.log(`✓ ${TRAGOS_VIP.length} Tragos V.I.P seeded`);

  console.log("Seeding complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
