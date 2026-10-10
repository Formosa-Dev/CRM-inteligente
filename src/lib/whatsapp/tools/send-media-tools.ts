import { tool } from "ai";
import { z } from "zod";

/**
 * Tool: enviar imagen genérica al cliente (comprobantes, capturas, fotos).
 * NO envía directo — devuelve data para que el webhook orquestre el orden.
 */
export function createSendImageTool(_conversationId: number, _customerPhone: string) {
  return tool({
    description:
      "Envía una imagen al cliente desde una URL pública. Usar cuando el cliente pide una foto de un producto que no está en el menú, un comprobante, o cualquier imagen que no sea del menú.",
    inputSchema: z.object({
      imageUrl: z.string().url().describe("URL pública de la imagen a enviar"),
      caption: z.string().optional().describe("Texto opcional que acompaña la imagen"),
    }),
    execute: async ({ imageUrl, caption }) => {
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
 * NO envía directo — devuelve data para que el webhook orquestre el orden.
 */
export function createSendDocumentTool(_conversationId: number, _customerPhone: string) {
  return tool({
    description:
      "Envía un documento PDF al cliente desde una URL pública. Usar para enviar menús en PDF, facturas, listas de precios, etc.",
    inputSchema: z.object({
      documentUrl: z.string().url().describe("URL pública del documento PDF a enviar"),
      caption: z.string().optional().describe("Texto opcional que acompaña el documento"),
      fileName: z.string().optional().describe("Nombre del archivo que verá el cliente (ej: menu-muzzarella.pdf)"),
    }),
    execute: async ({ documentUrl, caption, fileName: _fileName }) => {
      return JSON.stringify({
        _media: true,
        type: "document",
        url: documentUrl,
        caption: caption || "",
        dbContent: caption ? `📄 ${caption}` : "📄 Documento enviado",
      });
    },
  });
}
