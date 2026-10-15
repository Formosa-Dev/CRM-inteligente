"use server";

import { revalidatePath } from "next/cache";
import { addMovement } from "@/lib/cash/session";

// Carga una entrada/salida de efectivo (egresos: gastos, insumos, retiros;
// entradas: cambio, ajustes). La sesión se auto-abre si hace falta.
export async function addCashMovementAction(formData: FormData) {
  const direction = formData.get("direction") === "in" ? "in" : "out";
  const amount = Number(formData.get("amount"));
  const reason = String(formData.get("reason") ?? "").trim();

  if (!Number.isFinite(amount) || amount <= 0 || !reason) {
    return { error: "Monto y motivo son obligatorios." };
  }

  await addMovement(direction, amount, reason, "admin-panel");
  revalidatePath("/admin/caja");
  return { ok: true };
}
