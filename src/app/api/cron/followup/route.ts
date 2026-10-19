import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { db } from "@/db";
import { orders, conversations } from "@/db/schema";
import { eq, and, lte } from "drizzle-orm";
import { getArgentinaHour } from "@/lib/argentina-time";

/**
 * Endpoint para procesar follow-ups de pedidos entregados.
 * 
 * Busca pedidos con:
 * - status = "delivered"
 * - followupSent = false
 * - deliveredAt <= hace 30 minutos
 * 
 * Envía el mensaje y marca followupSent = true.
 * 
 * Llamar desde un cron job en Render cada 15 minutos:
 * GET https://muzapp.onrender.com/api/cron/followup?key=CRON_SECRET
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key");

  // Fail closed: without a cron secret configured (DB or env), nobody gets in.
  const { getIntegrationSecrets } = await import("@/lib/integrations");
  const secret = (await getIntegrationSecrets()).cronSecret;
  const a = Buffer.from(key ?? "");
  const b = Buffer.from(secret ?? "");
  if (!secret || a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const now = new Date();
  const hora = getArgentinaHour();

  // No enviar follow-ups fuera de horario hábil (9-22hs)
  if (hora < 9 || hora >= 22) {
    return NextResponse.json({ message: "Fuera de horario hábil", processed: 0 });
  }

  try {
    // Buscar pedidos entregados hace >= 30 min que no tengan followup
    const cutoff = new Date(now.getTime() - 30 * 60 * 1000);

    const pendingFollowups = await db
      .select({
        id: orders.id,
        phoneNumber: orders.phoneNumber,
        customerName: orders.customerName,
      })
      .from(orders)
      .where(
        and(
          eq(orders.status, "delivered"),
          eq(orders.followupSent, false),
          lte(orders.deliveredAt, cutoff),
        )
      )
      .limit(20);

    let processed = 0;

    for (const order of pendingFollowups) {
      if (!order.phoneNumber) continue;

      // Atomic claim: another cron invocation cannot send this same order.
      // The flag remains claimed on ambiguous provider/network errors to favor
      // at-most-once delivery; such failures need manual review.
      const claimed = await db.update(orders)
        .set({ followupSent: true, updatedAt: new Date() })
        .where(and(eq(orders.id, order.id), eq(orders.followupSent, false)))
        .returning({ id: orders.id });
      if (!claimed.length) continue;

      const followupText = `Holaa, ¿todo bien con el pedido? No te olvides de etiquetarnos en ig porfa 🙌`;

      try {
        // S15 — honor the conversation's channel_account binding when one
        // exists; unbound → placeholder (identical legacy behavior). An
        // unresolvable binding stays claimed for manual review.
        const { messenger } = await import("@/lib/messaging");
        const { resolveConversationAccountForPhone } = await import(
          "@/lib/channels/router"
        );
        const phoneNorm = order.phoneNumber.startsWith("+")
          ? order.phoneNumber
          : `+${order.phoneNumber}`;
        const binding = await resolveConversationAccountForPhone(phoneNorm);
        if (binding.kind === "unresolvable") {
          console.warn(
            `[followup] Order #${order.id} bound to unresolvable channel_account #${binding.accountId}; claimed for manual review`
          );
          continue;
        }
        const result = await messenger.send(
          {
            to: order.phoneNumber,
            type: "text",
            text: followupText,
          },
          binding.kind === "resolved"
            ? { channel: "whatsapp", account: binding.account }
            : {}
        );

        if (result.ok) {
          processed++;
          console.log(`[followup] Sent for order #${order.id} to ${order.phoneNumber}`);

          try {
            // Save follow-up in conversation history so AI has context (role "system")
            const { insertMessage } = await import("@/lib/channels/router");
            const phone = order.phoneNumber.startsWith("+") ? order.phoneNumber : `+${order.phoneNumber}`;
            const conv = await db
              .select({ id: conversations.id })
              .from(conversations)
              .where(eq(conversations.whatsappId, phone))
              .limit(1);
            if (conv[0]) {
              await insertMessage(conv[0].id, "system", followupText, undefined, result.providerMessageId || undefined);
              console.log(`[followup] Follow-up saved to conversation #${conv[0].id} (role=system, wamid=${result.providerMessageId})`);
            }
          } catch (historyError) {
            console.warn(`[followup] Sent order #${order.id}, but could not save conversation history:`, historyError);
          }
        } else {
          console.warn(`[followup] Provider rejected order #${order.id}; claimed for manual review: ${result.error}`);
        }
      } catch (e) {
        console.warn(`[followup] Ambiguous send for order #${order.id}; claimed for manual review:`, e);
      }
    }

    return NextResponse.json({
      message: `Procesados ${processed} de ${pendingFollowups.length} follow-ups`,
      processed,
      total: pendingFollowups.length,
    });
  } catch (e) {
    console.error("[followup] Error:", e);
    return NextResponse.json({ error: "Error interno" }, { status: 500 });
  }
}
