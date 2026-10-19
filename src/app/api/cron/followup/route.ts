import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { db } from "@/db";
import { orders } from "@/db/schema";
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
    let retryableFailures = 0;
    let dropped = 0;

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

      let decision;
      try {
        const { messenger } = await import("@/lib/messaging");
        const {
          resolveConversationAccountForPhone,
          resolveDefaultWhatsAppAccount,
        } = await import("@/lib/channels/router");
        const { decideSendAccount } = await import(
          "@/lib/messaging/send-account"
        );
        const phoneNorm = order.phoneNumber.startsWith("+")
          ? order.phoneNumber
          : `+${order.phoneNumber}`;

        decision = await decideSendAccount(phoneNorm, {
          resolveBinding: resolveConversationAccountForPhone,
          resolveDefaultAccount: resolveDefaultWhatsAppAccount,
        });

        if (decision.kind === "retry") {
          // Transient account lookup failure: release the claim so the next
          // cron tick retries. Never fall back to a global sender.
          await db
            .update(orders)
            .set({ followupSent: false, updatedAt: new Date() })
            .where(eq(orders.id, order.id));
          retryableFailures++;
          console.warn(
            `[followup] Order #${order.id} retryable account failure (${decision.reason}) — claim released`
          );
          continue;
        }
        if (decision.kind === "drop") {
          dropped++;
          console.warn(
            `[followup] Order #${order.id} no safe sender (${decision.reason}) — claimed for manual review`
          );
          continue;
        }

        const result = await messenger.send(
          {
            to: order.phoneNumber,
            type: "text",
            text: followupText,
          },
          decision.account
            ? { channel: "whatsapp", account: decision.account }
            : {}
        );

        if (!result.ok) {
          if (result.retryable) {
            await db
              .update(orders)
              .set({ followupSent: false, updatedAt: new Date() })
              .where(eq(orders.id, order.id));
            retryableFailures++;
            console.warn(
              `[followup] Order #${order.id} retryable send failure — claim released: ${result.error}`
            );
          } else {
            dropped++;
            console.warn(
              `[followup] Provider rejected order #${order.id}; claimed for manual review: ${result.error}`
            );
          }
          continue;
        }

        processed++;
        console.log(`[followup] Sent for order #${order.id} to ${order.phoneNumber}`);

        try {
          // Persist using the SAME account-scoped conversation identity —
          // never a phone-only legacy row.
          const { findOrCreateConversation, insertMessage } = await import(
            "@/lib/channels/router"
          );
          const conv = await findOrCreateConversation(
            "whatsapp",
            phoneNorm,
            order.customerName ?? undefined,
            phoneNorm,
            decision.channelAccountId
          );
          await insertMessage(
            conv.id,
            "system",
            followupText,
            undefined,
            result.providerMessageId || undefined,
            decision.channelAccountId
          );
          console.log(
            `[followup] Follow-up saved to conversation #${conv.id} (role=system, wamid=${result.providerMessageId})`
          );
        } catch (historyError) {
          console.warn(
            `[followup] Sent order #${order.id}, but could not save conversation history:`,
            historyError
          );
        }
      } catch (e) {
        // Any unexpected failure is ambiguous at-most-once: keep the claim
        // only when it is permanent; transient errors release it.
        const { classifyError } = await import("@/lib/messaging/errors");
        if (classifyError(e) === "retryable-db") {
          await db
            .update(orders)
            .set({ followupSent: false, updatedAt: new Date() })
            .where(eq(orders.id, order.id));
          retryableFailures++;
          console.warn(
            `[followup] Retryable failure for order #${order.id}; claim released:`,
            e
          );
        } else {
          dropped++;
          console.warn(
            `[followup] Permanent failure for order #${order.id}; claimed for manual review:`,
            e
          );
        }
      }
    }

    return NextResponse.json(
      {
        message: `Procesados ${processed} de ${pendingFollowups.length} follow-ups`,
        processed,
        total: pendingFollowups.length,
        retryableFailures,
        dropped,
      },
      { status: retryableFailures > 0 ? 503 : 200 }
    );
  } catch (e) {
    console.error("[followup] Error:", e);
    return NextResponse.json({ error: "Error interno" }, { status: 500 });
  }
}
