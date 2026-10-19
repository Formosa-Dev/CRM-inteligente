import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { promotions } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { resolveAgentConfigId } from "@/lib/agent-config-scope";
import fs from "fs";
import path from "path";

// ─── STICKERS ───────────────────────────────────────────────────────────────
// Stickers de confirmación estilo Ed, Edd y Eddy / Flama
// Se almacenan como imágenes en public/assets/images/stickers/

const STICKER_DIR = path.join(process.cwd(), "public", "assets", "images", "stickers");

const STICKER_MAP: Record<string, { file: string; emoji: string }> = {
  flama: { file: "flama.webp", emoji: "🔥" },
  ok: { file: "ok.webp", emoji: "👍" },
  dale: { file: "dale.webp", emoji: "✅" },
  corazon: { file: "corazon.webp", emoji: "❤️" },
};

type StickerName = keyof typeof STICKER_MAP;

function stickerExists(name: StickerName): boolean {
  try {
    const filePath = path.join(STICKER_DIR, STICKER_MAP[name].file);
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function getBaseUrl(): string {
  return process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, "") ||
    "https://muzapp.onrender.com";
}

// ─── sendSticker ────────────────────────────────────────────────────────────
export function createSendStickerTool(_conversationId: number, _customerPhone: string) {
  return tool({
    description:
      "Envía un sticker de confirmación al cliente. Usar SOLO después de confirmar pedido, pago recibido, o cuando el cliente confirma algo. 🚫 NO usar cuando el cliente pide ver el menú, promos, ofertas, carta, fotos de productos, o cualquier contenido visual — para eso están sendMenuImage, sendPromoImage y sendProductImage. Stickers: flama (🔥 épico), ok (👍 confirmación), dale (✅ aprobación), corazon (❤️ feedback/agradecimiento).",
    inputSchema: z.object({
      sticker: z
        .enum(["flama", "ok", "dale", "corazon"])
        .describe("Sticker: flama (confirmación épica), ok (okey), dale (dale nomás), corazon (❤️ feedback/agradecimiento)"),
    }),
    execute: async ({ sticker }) => {
      const name = sticker as StickerName;
      const info = STICKER_MAP[name];
      if (!info) return "No tengo ese sticker.";

      // Si la imagen existe, devolver data para que el webhook la envíe en orden
      if (stickerExists(name)) {
        const imageUrl = `${getBaseUrl()}/assets/images/stickers/${info.file}`;
        const labelMap: Record<string, string> = {
          flama: "🔥 confirmación épica",
          ok: "👍 confirmación",
          dale: "✅ aprobación",
          corazon: "❤️ agradecimiento",
        };
        return JSON.stringify({
          _media: true,
          type: "sticker",
          url: imageUrl,
          caption: info.emoji,
          dbContent: `[Sticker: ${labelMap[name] || name}]`,
        });
      }

      // Fallback: emoji nomas
      return info.emoji;
    },
  });
}

// ─── sendMenuImage ──────────────────────────────────────────────────────────
export function createSendMenuImageTool(_conversationId: number, _customerPhone: string) {
  return tool({
    description:
      "Envía la foto del menú al cliente. Usar cuando piden 'menu', 'carta', 'que tienen'. El agente no necesita especificar tipo, se detecta automáticamente del contexto.",
    inputSchema: z.object({
      tipo: z
        .enum(["hamburguesas", "pan"])
        .optional()
        .default("hamburguesas")
        .describe("Tipo: hamburguesas (menu completo) o pan (solo panaderia)"),
    }),
    execute: async ({ tipo }) => {
      const baseUrl = getBaseUrl();

      // ─── Si hamburguesas sin stock, avisar explícitamente ──
      let resolvedTipo = tipo || "hamburguesas";
      if (resolvedTipo === "hamburguesas") {
        try {
          const { db } = await import("@/db");
          const { agentConfig } = await import("@/db/schema");
          const { eq } = await import("drizzle-orm");
          const [cfg] = await db
            .select({ sinStock: agentConfig.hamburguesasSinStock })
            .from(agentConfig)
            .where(eq(agentConfig.id, await resolveAgentConfigId()))
            .limit(1);
          if (cfg?.sinStock) {
            if (tipo === "hamburguesas") {
              return "Hoy solo tenemos pan mayorista, ¿querés ver el menú de pan?";
            }
            resolvedTipo = "pan";
          }
        } catch {
          // non-fatal
        }
      }

      // Obtener URL del menú (DB primero, fallback estático)
      let imageUrl = "";
      const caption = "Acá tenés el menú";

      try {
        const { db } = await import("@/db");
        const { agentConfig } = await import("@/db/schema");
        const { eq } = await import("drizzle-orm");

        const rows = await db
          .select({
            hamb: agentConfig.menuImageUrlHamburguesas,
            pan: agentConfig.menuImageUrlPan,
          })
          .from(agentConfig)
          .where(eq(agentConfig.id, await resolveAgentConfigId()))
          .limit(1);

        const config = rows[0];
        const dbUrl = resolvedTipo === "hamburguesas" ? config?.hamb : config?.pan;

        if (dbUrl) {
          imageUrl = dbUrl.startsWith("http") ? dbUrl : `${baseUrl}${dbUrl}`;
        }
      } catch (err) {
        console.warn("[menuImage] DB query failed, using fallback:", err);
      }

      // Fallback: archivos estáticos
      if (!imageUrl) {
        const filename = resolvedTipo === "hamburguesas" ? "menu-pizzas.jpeg" : "menu-pan.jpeg";
        imageUrl = `${baseUrl}/assets/images/${filename}`;
      }

      const menuLabel = resolvedTipo === "pan" ? "pan mayorista" : "hamburguesas";
      return JSON.stringify({
        _media: true,
        type: "image",
        url: imageUrl,
        caption,
        dbContent: `Menú de ${menuLabel} 📸`,
        description: `Menú de ${menuLabel} enviado`,
      });
    },
  });
}

// ─── sendPromoImage ─────────────────────────────────────────────────────────
export function createSendPromoImageTool(_conversationId: number, _customerPhone: string) {
  return tool({
    description:
      "Envía la foto de UNA O VARIAS PROMOCIONES al cliente por WhatsApp. Podés mandar un array de IDs (promoIds) para enviar varias, o buscar por ID individual (promoId) o por nombre (promoName, ej: 'Combo 17'). Es OBLIGATORIO ejecutar esta tool cuando el cliente pide ver promos. NO digas 'te mando foto' sin ejecutar la tool.",
    inputSchema: z.object({
      promoId: z.number().optional().describe("ID de una promoción individual (alternativa a promoIds)"),
      promoName: z.string().optional().describe("Nombre de la promo para buscar individual (alternativa a promoIds). Ej: 'Combo 17', 'Combo 10'"),
      promoIds: z.array(z.number()).optional().describe("Array de IDs de promos para enviar VARIAS en un solo llamado. Usar cuando el cliente pide ver TODAS o VARIAS promos. Máximo 6."),
    }),
    execute: async ({ promoId, promoName, promoIds }) => {
      const baseUrl = getBaseUrl();

      // ─── BATCH: múltiples promos por IDs ─────────────────────────────────
      if (promoIds && promoIds.length > 0) {
        const capped = promoIds.slice(0, 6);
        const rows = await db
          .select()
          .from(promotions)
          .where(and(eq(promotions.active, true)))
          .orderBy(promotions.id);

        const matched = rows.filter((p) => capped.includes(p.id));

        if (matched.length === 0) {
          return "No encontré esas promociones activas.";
        }

        const mediaItems = matched
          .filter((p) => p.imageUrl)
          .map((p) => {
            const priceText = p.customPrice
              ? `$${Number(p.customPrice).toLocaleString("es-AR")}`
              : "";
            const absoluteUrl = p.imageUrl!.startsWith("http") ? p.imageUrl! : `${baseUrl}${p.imageUrl}`;
            return {
              type: "image" as const,
              url: absoluteUrl,
              caption: `${p.name}${priceText ? ` — ${priceText}` : ""}`,
              dbContent: `Promo: ${p.name}${priceText ? ` — ${priceText}` : ""} 📸`,
            };
          });

        if (mediaItems.length === 0) {
          // Ninguna promo tiene imagen — devolver JSON con descripción
          const noImgDescription = matched
            .map((p) => {
              const priceText = p.customPrice
                ? `$${Number(p.customPrice).toLocaleString("es-AR")}`
                : "";
              const itemsList = ((p.items as { productName: string; quantity: number }[]) || [])
                .map((i) => `• ${i.quantity}x ${i.productName}`)
                .join("\n");
              return `${p.name}${priceText ? ` — ${priceText}` : ""}\n${p.description ? `${p.description}\n` : ""}${itemsList}`;
            })
            .join("\n\n");
          return JSON.stringify({ _batch: true, _media: [], description: noImgDescription });
        }

        const description = matched
          .map((p) => {
            const price = p.customPrice ? `$${Number(p.customPrice).toLocaleString("es-AR")}` : "";
            const itemsList = ((p.items as { productName: string; quantity: number }[]) || [])
              .map((i) => `• ${i.quantity}x ${i.productName}`)
              .join("\n");
            return `${p.name}${price ? ` — ${price}` : ""}${p.description ? `: ${p.description}` : ""}\n${itemsList}`;
          })
          .join("\n\n");

        return JSON.stringify({
          _batch: true,
          _media: mediaItems,
          description,
        });
      }

      // ─── SINGLE: por ID o nombre (backwards compat) ─────────────────────
      let promo;

      if (promoId) {
        [promo] = await db
          .select()
          .from(promotions)
          .where(and(eq(promotions.id, promoId), eq(promotions.active, true)))
          .limit(1);
      } else if (promoName) {
        const all = await db
          .select()
          .from(promotions)
          .where(eq(promotions.active, true))
          .orderBy(promotions.id);
        const q = promoName.toLowerCase();
        promo = all.find((p) => p.name?.toLowerCase().includes(q));
      }

      if (!promo) {
        return "No encontré esa promoción activa.";
      }

      const priceText = promo.customPrice
        ? `$${Number(promo.customPrice).toLocaleString("es-AR")}`
        : "";

      if (promo.imageUrl) {
        const absoluteUrl = promo.imageUrl.startsWith("http") ? promo.imageUrl : `${baseUrl}${promo.imageUrl}`;
        const caption = `${promo.name}${priceText ? ` — ${priceText}` : ""}`;

        const promoItemsList = ((promo.items as { productName: string; quantity: number }[]) || [])
          .map((i) => `• ${i.quantity}x ${i.productName}`)
          .join("\n");
        return JSON.stringify({
          _media: true,
          type: "image",
          url: absoluteUrl,
          caption,
          dbContent: `Promo: ${promo.name}${priceText ? ` — ${priceText}` : ""} 📸`,
          description: `${promo.name}${priceText ? ` — ${priceText}` : ""}${promoItemsList ? `\n${promoItemsList}` : ""}`,
        });
      }

      // Fallback: texto si no hay imagen
      const itemsList = ((promo.items as { productName: string; quantity: number }[]) || [])
        .map((i) => `• ${i.quantity}x ${i.productName}`)
        .join("\n");
      const singleDescription = `${promo.name}${priceText ? ` — ${priceText}` : ""}\n${promo.description ? `${promo.description}\n` : ""}${itemsList}`;
      return JSON.stringify({ _batch: true, _media: [], description: singleDescription });
    },
  });
}
