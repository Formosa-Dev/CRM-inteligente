import { tool } from "ai";
import { z } from "zod";
import { resolveAgentConfig } from "@/lib/agent-config-scope";

// A-24: the model must never push an arbitrary external URL through our
// business WhatsApp account. Outbound media is allowlisted to:
//   1. same-origin hosts (RENDER_EXTERNAL_URL / NEXT_PUBLIC_APP_URL /
//      AUTH_URL / VERCEL_URL) — where the app serves its own assets,
//   2. media-library hosts — hosts already used by admin-configured media
//      (product imageUrl, menu image urls in agent_config),
//   3. operator-configured domains — WHATSAPP_MEDIA_ALLOWED_HOSTS env
//      (comma-separated hostnames).
// https only; host comparison is exact, lowercase, port-free.

function configuredEnvHosts(): Set<string> {
  const hosts = new Set<string>();
  const addUrl = (value?: string | null) => {
    if (!value) return;
    try {
      const host = new URL(
        value.includes("://") ? value : `https://${value}`,
      ).hostname.toLowerCase();
      if (host) hosts.add(host);
    } catch {
      // ignore malformed env url
    }
  };
  addUrl(process.env.RENDER_EXTERNAL_URL);
  addUrl(process.env.NEXT_PUBLIC_APP_URL);
  addUrl(process.env.AUTH_URL);
  addUrl(process.env.VERCEL_URL);
  for (const raw of (process.env.WHATSAPP_MEDIA_ALLOWED_HOSTS ?? "").split(",")) {
    const host = raw.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  return hosts;
}

async function mediaLibraryHosts(): Promise<Set<string>> {
  const hosts = new Set<string>();
  const addUrl = (value?: string | null) => {
    if (!value) return;
    try {
      const host = new URL(value).hostname.toLowerCase();
      if (host) hosts.add(host);
    } catch {
      // relative/admin asset — same-origin check covers it
    }
  };
  try {
    const config = await resolveAgentConfig();
    addUrl(config?.menuImageUrlHamburguesas);
    addUrl(config?.menuImageUrlPan);
  } catch {
    // non-fatal
  }
  try {
    const { db } = await import("@/db");
    const { products } = await import("@/db/schema");
    const { isNotNull } = await import("drizzle-orm");
    const rows = await db
      .select({ imageUrl: products.imageUrl })
      .from(products)
      .where(isNotNull(products.imageUrl));
    for (const row of rows) addUrl(row.imageUrl);
  } catch {
    // non-fatal
  }
  return hosts;
}

export async function isAllowedMediaUrl(rawUrl: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  const allowed = configuredEnvHosts();
  if (allowed.has(host)) return true;
  const library = await mediaLibraryHosts();
  return library.has(host);
}

/**
 * Tool: enviar imagen genérica al cliente (comprobantes, capturas, fotos).
 * NO envía directo — devuelve data para que el webhook orquestre el orden.
 * La URL queda restringida al allowlist de medios del negocio (A-24).
 */
export function createSendImageTool(_conversationId: number, _customerPhone: string) {
  return tool({
    description:
      "Envía una imagen al cliente. SOLO acepta URLs de medios del negocio (mismo dominio de la app, imágenes de productos/menú configuradas, o dominios habilitados por el operador). NO inventes URLs externas. Usar cuando el cliente pide una foto de un producto que no está en el menú o una imagen configurada.",
    inputSchema: z.object({
      imageUrl: z.string().url().describe("URL pública https de la imagen — debe pertenecer al allowlist de medios del negocio"),
      caption: z.string().optional().describe("Texto opcional que acompaña la imagen"),
    }),
    execute: async ({ imageUrl, caption }) => {
      if (!(await isAllowedMediaUrl(imageUrl))) {
        console.warn(`[sendImage] blocked non-allowlisted media URL host`);
        return "No puedo enviar esa imagen: la URL no pertenece a los medios del negocio. Usá sendMenuImage/sendProductImage o pedile al admin que suba el archivo.";
      }
      return JSON.stringify({
        _media: true,
        type: "image",
        url: imageUrl,
        caption: caption || "",
        dbContent: caption ? `📸 ${caption}` : "📸 Imagen enviada",
      });
    },
  });
}

/**
 * Tool: enviar documento PDF al cliente.
 * A-23: el pipeline inbound NO implementa envío de documentos — devolver
 * éxito acá producía un "Documento enviado" fantasma en el historial sin
 * que el cliente recibiera nada. La tool queda registrada pero responde
 * failure explícito para que el modelo no prometa el envío.
 */
export function createSendDocumentTool(_conversationId: number, _customerPhone: string) {
  return tool({
    description:
      "El envío de documentos/PDF NO está disponible por WhatsApp en este momento. Si el cliente pide un menú usá sendMenuImage; si pide una lista de precios o factura, respondé que no se puede enviar documentos y ofrecé la info por texto o imagen.",
    inputSchema: z.object({
      documentUrl: z.string().url().optional().describe("No usado — el envío de documentos está deshabilitado"),
      caption: z.string().optional().describe("No usado"),
      fileName: z.string().optional().describe("No usado"),
    }),
    execute: async () => {
      return "El envío de documentos/PDF no está disponible en este canal. No le digas al cliente que se lo enviaste — ofrecé mandarle la info como texto o imagen (sendMenuImage/sendProductImage).";
    },
  });
}
