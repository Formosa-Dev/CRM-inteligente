import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { conversations, chatMessages } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { sendEscalationEmail } from "./escalation-email";
import {
  DrizzleHandoffEffectRepository,
  HandoffEffectService,
} from "../human-handoff";
import { DrizzleSessionPolicyRepository } from "../session-store";

export function createTransferToHumanTool(conversationId: number) {
  return tool({
    description:
      "Deriva la conversación a un humano. Usá esto cuando: no podés resolver, el cliente lo pide explícitamente, hay reclamo grave, tema legal, alergia/salud, pedido B2B complejo, o cualquier situación que requiera intervención humana.",
    inputSchema: z.object({
      reason: z.string().describe("Motivo claro de la derivación"),
      category: z
        .enum([
          "reclamo",
          "salud_alergia",
          "pedido_b2b",
          "facturacion",
          "legal",
          "no_puede_resolver",
          "solicitud_cliente",
          "otro",
        ])
        .describe("Categoría de la derivación"),
      conversationSummary: z
        .string()
        .describe("Resumen breve de la conversación hasta ahora"),
    }),
    execute: async ({ reason, category, conversationSummary }) => {
      // 0. Claim the handoff effects through the shared idempotent service.
      //    Retries of the same episode are harmless: override, owner
      //    notification, and customer reply each happen at most once.
      //    The tool only runs inside an AI turn, so delivery is allowed.
      const session = await new DrizzleSessionPolicyRepository().load(conversationId);
      const episode = session?.episode ?? 0;
      const claims = await new HandoffEffectService(
        new DrizzleHandoffEffectRepository()
      ).claimHandoffEffects({
        conversationId,
        episode,
        inboundMessageId: `tool-transfer:${conversationId}:${episode}`,
        aiEnabled: true,
      });

      // 1. Mark conversation for human attention (only on first claim)
      if (claims.overrideClaimed) {
        await db
          .update(conversations)
          .set({
            humanOverrideUntil: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
          })
          .where(eq(conversations.id, conversationId));
      }

      // 2. Get conversation details
      const [conv] = await db
        .select({
          customerName: conversations.customerName,
          customerPhone: conversations.customerPhone,
        })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);

      // 3. Get last messages for context
      const lastMsgs = await db
        .select({ role: chatMessages.role, content: chatMessages.content })
        .from(chatMessages)
        .where(eq(chatMessages.conversationId, conversationId))
        .orderBy(desc(chatMessages.createdAt))
        .limit(8);

      const lastMessages = lastMsgs
        .reverse()
        .map((m) => `${m.role === "user" ? "Cliente" : "Bot"}: ${m.content.slice(0, 120)}`);

      // 4. Send escalation notification (only on first claim — retries stay silent)
      //    A-43: never tell the customer the owner was notified when no
      //    notification channel actually delivered.
      let ownerNotified = false;
      if (claims.ownerNotificationDeliverable) {
        const notified = await sendEscalationEmail({
          customerName: conv?.customerName || "Desconocido",
          customerPhone: conv?.customerPhone || "N/A",
          reason,
          category,
          conversationSummary,
          lastMessages,
        });
        ownerNotified = notified.ok;
        if (!notified.ok) {
          console.warn(`[transferToHuman] owner notification NOT delivered: ${notified.error}`);
        }
      }

      return ownerNotified
        ? "Te paso con el dueño, él se va a encargar personalmente. Gracias por esperar."
        : "Anoté tu caso para que te atienda una persona del equipo. (IMPORTANTE: el canal de aviso al equipo no está configurado — NO le confirmes al cliente que el dueño ya fue notificado; decile que lo van a contactar a la brevedad.)";
    },
  });
}
