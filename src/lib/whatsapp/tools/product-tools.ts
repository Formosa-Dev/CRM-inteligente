import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { products, promotions } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { PRODUCT_IMAGE_BY_NAME } from "@/lib/constants";

function formatProductPrice(price: string | null) {
  return price === null ? "Precio a consultar" : `$${price}`;
}

// getProductDetails - Ver detalles de un producto
export const getProductDetailsTool = tool({
  description: "Obtiene los detalles completos de un producto específico: nombre, descripción, precio, línea, categoría",
  inputSchema: z.object({
    name: z.string().describe("Nombre del producto a buscar"),
  }),
  execute: async ({ name }) => {
    const items = await db
      .select({
        id: products.id,
        name: products.name,
        description: products.description,
        price: products.price,
        category: products.category,
        line: products.line,
        available: products.available,
        stock: products.stock,
        imageUrl: products.imageUrl,
      })
      .from(products)
      .orderBy(products.sortOrder);

    const normalizedName = name.toLowerCase();
    const found = items.find(
      (p) => p.name?.toLowerCase().includes(normalizedName)
    );

    if (!found) {
      return "No encontré ese producto. ¿Querés que te muestre el menú completo?";
    }

    if (!found.available) {
      return `${found.name} no está disponible actualmente. ¿Querés ver qué otras opciones tenemos?`;
    }

    if (found.stock !== null && found.stock === 0) {
      return `${found.name} está agotado por ahora. ¿Querés ver qué otras opciones tenemos?`;
    }

    const categoryLabel: Record<string, string> = {
      hamburguesa: "Hamburguesa",
      acompañamiento: "Acompañamiento",
      pan_mayorista: "Pan al Por Mayor",
    };

    const lineLabel: Record<string, string> = {
      pollo: "Pollo",
      carne: "Carne",
      clasica: "Clásica",
      pan: "Pan",
    };

    return `🍔 ${found.name}
${found.description || "Sin descripción"}
💰 ${formatProductPrice(found.price)}
📦 Categoría: ${categoryLabel[found.category ?? ""] ?? found.category}
🐔 Línea: ${lineLabel[found.line ?? ""] ?? found.line}`;
  },
});

// getProductPrice - Ver precio de un producto
export const getProductPriceTool = tool({
  description: "Obtiene el precio de un producto. Cuando el cliente pregunte: 'a cómo está la bookbinder?', 'cuánto vale la deli?', 'qué precio tiene la toro?', 'cuánto cuesta la genesis?'",
  inputSchema: z.object({
    name: z.string().describe("Nombre del producto"),
  }),
  execute: async ({ name }) => {
    const items = await db
      .select({ name: products.name, price: products.price, available: products.available, stock: products.stock })
      .from(products)
      .where(eq(products.available, true));

    const normalizedName = name.toLowerCase();
    const found = items.find((p) => p.name?.toLowerCase().includes(normalizedName));

    if (!found) {
      return "No encontré ese producto en el menú.";
    }

    if (found.stock !== null && found.stock === 0) {
      return `${found.name} está agotado por ahora. ¿Querés ver otras opciones?`;
    }

    return `💰 ${found.name}: ${formatProductPrice(found.price)}`;
  },
});

// createSendProductImageTool - Enviar foto de un producto por WhatsApp
export function createSendProductImageTool(_conversationId: number, _customerPhone: string) {
  return tool({
    description: "Envía la foto de un PRODUCTO al cliente por WhatsApp. Podés buscar por ID o por nombre (productName, ej: 'bookbinder', 'deli deli'). OBLIGATORIO: cuando el cliente pide ver un producto o pregunta cómo se ve, ejecutá esta tool. NO digas 'tengo foto' sin enviarla.",
    inputSchema: z.object({
      productId: z.number().optional().describe("ID del producto (alternativa al nombre)"),
      productName: z.string().optional().describe("Nombre del producto para buscar (alternativa al ID). Ej: 'genesis', 'bookbinder', 'deli deli'"),
    }),
    execute: async ({ productId, productName }) => {
      let product;
      
      if (productId) {
        [product] = await db
          .select({
            id: products.id,
            name: products.name,
            price: products.price,
            imageUrl: products.imageUrl,
          })
          .from(products)
          .where(eq(products.id, productId))
          .limit(1);
      } else if (productName) {
        const all = await db
          .select({
            id: products.id,
            name: products.name,
            price: products.price,
            imageUrl: products.imageUrl,
          })
          .from(products)
          .orderBy(products.sortOrder);
        
        const q = productName.toLowerCase();
        product = all.find(p => p.name?.toLowerCase().includes(q));
      }

      if (!product) {
        return "No encontré ese producto.";
      }

      const baseUrl =
        process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, "") ||
        "https://muzapp.onrender.com";

      let fullImageUrl: string;
      if (product.imageUrl) {
        fullImageUrl = product.imageUrl.startsWith("/")
          ? `${baseUrl}${product.imageUrl}`
          : product.imageUrl;
      } else {
        // Buscar en assets estáticos por nombre
        const staticPath = PRODUCT_IMAGE_BY_NAME[product.name.toLowerCase()];
        if (!staticPath) {
          return "Este producto no tiene foto.";
        }
        fullImageUrl = `${baseUrl}${staticPath}`;
      }

      const caption = `${product.name} - $${product.price}`;
      return JSON.stringify({
        _media: true,
        type: "image",
        url: fullImageUrl,
        caption,
        dbContent: `📸 ${product.name}`,
        description: `${product.name} — $${product.price}`,
      });
    },
  });
}

// searchProducts - Buscar productos por nombre (matching parcial)
export const searchProductsTool = tool({
  description: "Busca productos por nombre. Usá esta tool cuando el cliente pida un producto por nombre parcial, ej: 'pancitos chips', 'pan de lomito', 'prepizza'. Busca coincidencias parciales en el nombre y devuelve hasta 5 resultados.",
  inputSchema: z.object({
    query: z.string().describe("Término de búsqueda (puede ser parcial)"),
  }),
  execute: async ({ query }) => {
    const items = await db
      .select({
        name: products.name,
        description: products.description,
        price: products.price,
        available: products.available,
        stock: products.stock,
      })
      .from(products)
      .where(eq(products.available, true));

    const normalizedQuery = query.toLowerCase().trim();
    const queryWords = normalizedQuery.split(/\s+/).filter(Boolean);

    const filtered = items.filter((p) => {
      const name = p.name?.toLowerCase() || "";
      const desc = p.description?.toLowerCase() || "";

      // Match exacto del query completo
      if (name.includes(normalizedQuery) || desc.includes(normalizedQuery)) return true;

      // Match por palabras individuales (al menos 1 palabra coincide)
      if (queryWords.length > 1) {
        return queryWords.some(
          (word) => name.includes(word) || desc.includes(word)
        );
      }

      return false;
    });

    if (filtered.length === 0) {
      return `No encontré productos que coincidan con "${query}". ¿Querés ver el menú completo?`;
    }

    const results = filtered.slice(0, 5);

    return results
      .map((p) => `• ${p.name} - ${formatProductPrice(p.price)}${p.description ? ` — ${p.description}` : ""}${p.stock !== null ? ` (stock: ${p.stock})` : ""}`)
      .join("\n");
  },
});

// getActivePromos - Consultar promociones activas (OBLIGATORIO)
export const getActivePromosTool = tool({
  description: `OBLIGATORIO — ejecutá esta tool cuando el cliente se refiera a promos, ofertas, combos, descuentos, especiales, paquetes, o "lo que tenga". También cuando mencionen precios que parezcan de una oferta, o digan cosas como:
  • "qué ofertas tienen?"
  • "hay algún descuento?"
  • "cuál es la más barata?"
  • "qué combos manejan?"
  • "tienen algo especial?"
  • "la de 10 mil", "la promo de 10", "la de 14"
  • "la que subiste a IG", "la que está en la foto"
  • "me conviene algo?"
  • "qué me recomendás de lo que está en oferta?"
  NO respondas sin ejecutar esta tool. Incluso si ya preguntó antes, ejecutala de nuevo.`,
  inputSchema: z.object({}),
  execute: async () => {
    const activePromos = await db
      .select({
        id: promotions.id,
        name: promotions.name,
        description: promotions.description,
        customPrice: promotions.customPrice,
        imageUrl: promotions.imageUrl,
        items: promotions.items,
      })
      .from(promotions)
      .where(eq(promotions.active, true))
      .orderBy(desc(promotions.createdAt));

    if (activePromos.length === 0) {
      return "No hay promociones activas en este momento.";
    }

    const promos = activePromos.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: p.customPrice ? Number(p.customPrice) : null,
      imageUrl: p.imageUrl,
      hasImage: p.imageUrl !== null,
      items: (p.items || []) as { productName: string; quantity: number }[],
    }));

    return JSON.stringify({ _promos: true, promos, hint: "Call sendPromoImage to show promos to the user - the client cannot see this JSON data." });
  },
});
