"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { products } from "@/db/schema";
import { productSchema } from "@/lib/validations/product";
import { eq, asc, and, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { requireAdmin } from "@/lib/auth/require-admin";

const PAGE_SIZE = 30;

type ProductCategory = (typeof products.$inferSelect)["category"];
type ProductLine = (typeof products.$inferSelect)["line"];

export type ProductsResponse = {
  products: Array<{
    id: number;
    name: string;
    description: string | null;
    price: string | null;
    imageUrl: string | null;
    category: ProductCategory;
    line: ProductLine;
    stock: number | null;
    available: boolean;
    comingSoon: boolean;
    sortOrder: number;
  }>;
  totalPages: number;
  total: number;
};

export async function fetchProducts(params: {
  page?: number;
  category?: string;
  line?: string;
}): Promise<ProductsResponse> {
  const session = await auth();
  if (!session) {
    return { products: [], totalPages: 0, total: 0 };
  }

  const page = Math.max(1, params.page ?? 1);
  const offset = (page - 1) * PAGE_SIZE;

  const conditions: ReturnType<typeof eq>[] = [];
  if (params.category && params.category !== "all") {
    conditions.push(eq(products.category, params.category as ProductCategory));
  }
  if (params.line && params.line !== "all") {
    conditions.push(eq(products.line, params.line as ProductLine));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const total = conditions.length > 0
    ? (await db.select({ count: sql<number>`count(*)` }).from(products).where(where))[0]?.count ?? 0
    : (await db.select({ count: sql<number>`count(*)` }).from(products))[0]?.count ?? 0;

  const items = await db
    .select()
    .from(products)
    .where(where)
    .orderBy(asc(products.sortOrder), asc(products.name))
    .limit(PAGE_SIZE)
    .offset(offset);

  return {
    products: items.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: p.price,
      imageUrl: p.imageUrl,
      category: p.category,
      line: p.line,
      stock: p.stock,
      available: p.available,
      comingSoon: p.comingSoon,
      sortOrder: p.sortOrder,
    })),
    totalPages: Math.ceil(total / PAGE_SIZE),
    total,
  };
}

export async function createProduct(formData: FormData) {
  if (!(await requireAdmin())) {
    return { error: "No autorizado" };
  }

  const raw = {
    name: formData.get("name"),
    description: formData.get("description") || undefined,
    price: formData.get("price") ? Number(formData.get("price")) : undefined,
    category: formData.get("category"),
    line: formData.get("line"),
    imageUrl: formData.get("imageUrl") || undefined,
    stock: formData.get("stock") ? Number(formData.get("stock")) : undefined,
    available: formData.get("available") === "true",
    comingSoon: formData.get("comingSoon") === "true",
    sortOrder: formData.get("sortOrder") ? Number(formData.get("sortOrder")) : 0,
  };

  const parsed = productSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  }

  const { price, imageUrl, ...rest } = parsed.data;

  await db.insert(products).values({
    ...rest,
    price: price?.toString(),
    imageUrl: imageUrl || null,
  });

  revalidatePath("/admin/products");
  revalidatePath("/api/products");
  return { success: true };
}

export async function updateProduct(id: number, formData: FormData) {
  if (!(await requireAdmin())) {
    return { error: "No autorizado" };
  }

  const raw = {
    name: formData.get("name"),
    description: formData.get("description") || undefined,
    price: formData.get("price") ? Number(formData.get("price")) : undefined,
    category: formData.get("category"),
    line: formData.get("line"),
    imageUrl: formData.get("imageUrl") || undefined,
    stock: formData.get("stock") ? Number(formData.get("stock")) : undefined,
    available: formData.get("available") === "true",
    comingSoon: formData.get("comingSoon") === "true",
    sortOrder: formData.get("sortOrder") ? Number(formData.get("sortOrder")) : 0,
  };

  const parsed = productSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  }

  const { price, imageUrl, ...rest } = parsed.data;

  await db
    .update(products)
    .set({
      ...rest,
      price: price?.toString(),
      imageUrl: imageUrl || null,
      updatedAt: new Date(),
    })
    .where(eq(products.id, id));

  revalidatePath("/admin/products");
  revalidatePath("/api/products");
  return { success: true };
}

export async function deleteProduct(id: number) {
  if (!(await requireAdmin())) {
    return { error: "No autorizado" };
  }

  await db.delete(products).where(eq(products.id, id));
  revalidatePath("/admin/products");
  revalidatePath("/api/products");
  return { success: true };
}

export async function toggleProductAvailability(id: number, available: boolean) {
  if (!(await requireAdmin())) {
    return { error: "No autorizado" };
  }

  await db
    .update(products)
    .set({ available, updatedAt: new Date() })
    .where(eq(products.id, id));

  revalidatePath("/admin/products");
  revalidatePath("/api/products");
  return { success: true };
}
