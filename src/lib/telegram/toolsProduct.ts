import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { products } from "@/db/schema";
import { eq, asc } from "drizzle-orm";

// ─── manageProduct: Herramientas de gestión de productos ──────────────────────

// getAllProducts - Ver todos los productos
export const getAllProducts = tool({
  description:
    "Lista todos los productos disponibles. Preguntas: 'qué productos tienen', 'menú completo'",
  inputSchema: z.object({}).optional(),
  execute: async () => {
    const rows = await db
      .select({
        id: products.id,
        name: products.name,
        description: products.description,
        price: products.price,
        category: products.category,

        available: products.available,
      })
      .from(products)
      .where(eq(products.available, true))
      .orderBy(asc(products.sortOrder));

    const byCategory: Record<string, { name: string; price: string }[]> = {};

    for (const row of rows) {
      const cat = row.category ?? "otro";
      if (!byCategory[cat]) {
        byCategory[cat] = [];
      }
      byCategory[cat].push({
        name: row.name,
        price: `$${row.price}`,
      });
    }

    return {
      count: rows.length,
      products: rows.map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        category: p.category,
      })),
      byCategory,
    };
  },
});

// getProductsByCategory - Ver productos por categoría
export const getProductsByCategory = tool({
  description:
    "Lista productos por categoría. Preguntas: 'hamburguesas', 'acompañamientos', 'pan al por mayor'",
  inputSchema: z.object({
    category: z
      .enum(["hamburguesa", "acompanamiento", "pan_mayorista", "tragos_vip", "bebidas", "alcohol", "empanadas"])
      .describe("Categoría a listar"),
  }),
  execute: async ({ category }) => {
    const rows = await db
      .select({
        id: products.id,
        name: products.name,
        description: products.description,
        price: products.price,

        available: products.available,
      })
      .from(products)
      .where(eq(products.category, category))
      .orderBy(asc(products.sortOrder));

    const categoryLabels: Record<string, string> = {
      hamburguesa: "Hamburguesas",
      acompanamiento: "Acompañamientos",
      pan_mayorista: "Pan al Por Mayor",
      tragos_vip: "Tragos VIP",
      bebidas: "Bebidas",
      alcohol: "Alcohol",
      empanadas: "Empanadas",
      pizzas: "Pizzas",
    };

    return {
      category: categoryLabels[category] ?? category,
      count: rows.length,
      products: rows.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        price: p.price,

      })),
    };
  },
});

// getProductById - Ver un producto específico
export const getProductById = tool({
  description: "Consulta un producto por su ID. Preguntas: 'detalle del producto 5'",
  inputSchema: z.object({
    productId: z.number().describe("ID del producto"),
  }),
  execute: async ({ productId }) => {
    const [row] = await db
      .select({
        id: products.id,
        name: products.name,
        description: products.description,
        price: products.price,
        category: products.category,

        available: products.available,
        imageUrl: products.imageUrl,
      })
      .from(products)
      .where(eq(products.id, productId))
      .limit(1);

    if (!row) {
      return { error: "Producto no encontrado" };
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      price: row.price,
      category: row.category,

      available: row.available,
      image: row.imageUrl,
    };
  },
});

// searchProducts - Buscar productos
export const searchProducts = tool({
  description:
    "Busca productos por nombre. Preguntas: 'busca hamburguesa bookbinder', 'tiene vegetariano?'",
  inputSchema: z.object({
    query: z.string().describe("Término de búsqueda"),
  }),
  execute: async ({ query }) => {
    const rows = await db
      .select({
        id: products.id,
        name: products.name,
        description: products.description,
        price: products.price,
        category: products.category,
        available: products.available,
      })
      .from(products)
      .orderBy(asc(products.sortOrder));

    // Filtrar en memoria (contiene)
    const q = query.toLowerCase();
    const filtered = rows.filter(
      (p) =>
        p.name?.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q)
    );

    return {
      query,
      count: filtered.length,
      products: filtered.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        price: p.price,
        category: p.category,
      })),
    };
  },
});

// getProductAvailability - Ver disponibilidad
export const getProductAvailability = tool({
  description:
    "Verifica si un producto está disponible. Preguntas: 'tienen stock de X', 'hay toro?'",
  inputSchema: z.object({
    productName: z.string().describe("Nombre del producto"),
  }),
  execute: async ({ productName }) => {
    const rows = await db
      .select({
        id: products.id,
        name: products.name,
        available: products.available,
        comingSoon: products.comingSoon,
      })
      .from(products);

    const q = productName.toLowerCase();
    const found = rows.find(
      (p) => p.name?.toLowerCase().includes(q)
    );

    if (!found) {
      return { available: false, message: "Producto no encontrado" };
    }

    if (!found.available) {
      return {
        available: false,
        message: found.comingSoon ? "Próximamente" : "Sin stock",
      };
    }

    return {
      available: true,
      name: found.name,
      message: "Disponible",
    };
  },
});

// createProduct - Crear nuevo producto
export const createProduct = tool({
  description:
    "Crea un nuevo producto en el catálogo. Preguntas: 'agregar producto', 'nuevo producto', 'alta de producto'",
  inputSchema: z.object({
    name: z.string().describe("Nombre del producto"),
    description: z.string().optional().describe("Descripción del producto"),
    price: z.number().optional().describe("Precio del producto"),
    category: z
      .enum(["hamburguesa", "acompanamiento", "pan_mayorista", "tragos_vip", "bebidas", "alcohol", "empanadas", "pizzas"])
      .describe("Categoría del producto"),
    available: z.boolean().default(true).describe("Si el producto está disponible"),
    comingSoon: z.boolean().default(false).describe("Si el producto es próximamente"),
  }),
  execute: async ({ name, description, price, category, available, comingSoon }) => {
    const [created] = await db
      .insert(products)
      .values({
        name,
        description,
        price: price !== undefined ? String(price) : undefined,
        category,
        available,
        comingSoon,
      })
      .returning({
        id: products.id,
        name: products.name,
        description: products.description,
        price: products.price,
        category: products.category,

        available: products.available,
        comingSoon: products.comingSoon,
      });

    return {
      success: true,
      message: `Producto "${created.name}" creado con ID #${created.id}`,
      product: created,
    };
  },
});

// updateProduct - Actualizar un producto existente
export const updateProduct = tool({
  description:
    "Actualiza un producto existente. Preguntas: 'modificar producto', 'cambiar precio', 'actualizar disponibilidad'",
  inputSchema: z.object({
    id: z.number().describe("ID del producto a actualizar"),
    name: z.string().optional().describe("Nuevo nombre"),
    description: z.string().optional().describe("Nueva descripción"),
    price: z.number().optional().describe("Nuevo precio"),
    category: z
      .enum(["hamburguesa", "acompanamiento", "pan_mayorista", "tragos_vip", "bebidas", "alcohol", "empanadas", "pizzas"])
      .optional()
      .describe("Nueva categoría"),
    available: z.boolean().optional().describe("Disponibilidad"),
    comingSoon: z.boolean().optional().describe("Próximamente"),
    sortOrder: z.number().optional().describe("Orden de visualización"),
  }),
  execute: async ({ id, name, description, price, category, available, comingSoon, sortOrder }) => {
    const [existing] = await db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(eq(products.id, id))
      .limit(1);

    if (!existing) {
      return { success: false, message: "Producto no encontrado" };
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (price !== undefined) updates.price = String(price);
    if (category !== undefined) updates.category = category;

    if (available !== undefined) updates.available = available;
    if (comingSoon !== undefined) updates.comingSoon = comingSoon;
    if (sortOrder !== undefined) updates.sortOrder = sortOrder;

    const [updated] = await db
      .update(products)
      .set(updates)
      .where(eq(products.id, id))
      .returning({
        id: products.id,
        name: products.name,
        description: products.description,
        price: products.price,
        category: products.category,

        available: products.available,
        comingSoon: products.comingSoon,
        sortOrder: products.sortOrder,
      });

    return {
      success: true,
      message: `Producto "${updated.name}" (#${updated.id}) actualizado`,
      product: updated,
    };
  },
});

// deleteProduct - Eliminar un producto
export const deleteProduct = tool({
  description:
    "Elimina un producto del catálogo. Preguntas: 'eliminar producto', 'borrar producto', 'dar de baja producto'",
  inputSchema: z.object({
    id: z.number().describe("ID del producto a eliminar"),
  }),
  execute: async ({ id }) => {
    const [existing] = await db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(eq(products.id, id))
      .limit(1);

    if (!existing) {
      return { success: false, message: "Producto no encontrado" };
    }

    await db.delete(products).where(eq(products.id, id));

    return {
      success: true,
      message: `Producto "${existing.name}" (#${existing.id}) eliminado`,
    };
  },
});

// Export all manageProduct tools
export const manageProductTools = {
  getAllProducts,
  getProductsByCategory,
  getProductById,
  searchProducts,
  getProductAvailability,
  createProduct,
  updateProduct,
  deleteProduct,
};