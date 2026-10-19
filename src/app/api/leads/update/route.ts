import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { leads } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";
import { revalidatePath } from "next/cache";
import { normalizePhone } from "@/lib/phone-utils";
import { UpdateLeadSchema } from "./helpers";

export async function POST(request: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
    }

    const parsed = UpdateLeadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation error", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const { id, name, phone, email, address, notes, type, tags } = parsed.data;

    // Normalizar teléfono si se proporciona — y exigir que siga pareciendo
    // un teléfono: sirve de lookup key cuando falta el id, así que un valor
    // que se normaliza a "" matchearía la fila vacía equivocada.
    const normalizedPhone = phone !== undefined ? normalizePhone(phone) : undefined;
    if (normalizedPhone !== undefined && !/^\d{7,15}$/.test(normalizedPhone)) {
      return NextResponse.json({ error: "Teléfono inválido" }, { status: 400 });
    }

    // Buscar el lead por ID o por teléfono
    let leadId = id;
    if (!leadId && normalizedPhone) {
      const [found] = await db
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.phone, normalizedPhone))
        .limit(1);
      if (found) leadId = found.id;
    }

    if (!leadId) {
      return NextResponse.json({ error: "ID o teléfono requerido" }, { status: 400 });
    }

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (normalizedPhone !== undefined) updates.phone = normalizedPhone;
    if (email !== undefined) updates.email = email || null;
    if (address !== undefined) updates.address = address;
    if (notes !== undefined) updates.notes = notes;
    if (type !== undefined) updates.type = type;
    if (tags !== undefined) updates.tags = tags;

    await db.update(leads).set(updates).where(eq(leads.id, leadId));

    // Revalidar TODAS las páginas que muestran datos del cliente
    revalidatePath("/admin/clients");
    revalidatePath("/admin/clients/[id]", "page");
    revalidatePath("/admin/leads");
    revalidatePath("/admin/orders");
    revalidatePath("/admin/conversations");
    revalidatePath("/admin");

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("[api/leads/update]", e);
    return NextResponse.json({ error: "Error al actualizar" }, { status: 500 });
  }
}
