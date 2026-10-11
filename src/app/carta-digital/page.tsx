import { db } from "@/db";
import { products, promotions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { Suspense } from "react";
import { MenuDigitalClient } from "./menu-digital-client";

export const metadata = {
  title: "Carta Digital",
  description: "Explorá nuestro menú, armá tu pedido y pedilo por WhatsApp",
};

// Forzar que siempre cargue datos frescos de la DB, sin caché
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function CartaDigitalPage() {
  const items = await db
    .select()
    .from(products)
    .where(eq(products.available, true))
    .orderBy(products.sortOrder);

  const activePromos = await db
    .select()
    .from(promotions)
    .where(eq(promotions.active, true));

  return (
    <Suspense>
      <MenuDigitalClient
        products={items}
        promos={activePromos}
      />
    </Suspense>
  );
}
