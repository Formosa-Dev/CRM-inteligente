import { revalidatePath } from "next/cache";
import { checkoutSchema } from "@/lib/checkout/contract";
import { CheckoutError, submitCheckout } from "@/lib/checkout/service";
import { checkRateLimit } from "@/lib/infra/rate-limit";
import { isAllowedCheckoutOrigin } from "@/lib/checkout/origin";

export async function POST(request: Request) {
  if (!isAllowedCheckoutOrigin(request)) return Response.json({ error: "Origen no permitido." }, { status: 403 });
  if (!request.headers.get("content-type")?.includes("application/json")) return Response.json({ error: "Formato no válido." }, { status: 415 });
  try {
    // A failing rate-limit backend must not block sales — the requestId dedup
    // in submitCheckout already protects against duplicate orders.
    let limited = false;
    try {
      const limit = await checkRateLimit(`checkout:${request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"}`);
      limited = !limit.success;
    } catch { /* fail open */ }
    if (limited) return Response.json({ error: "Esperá un minuto antes de volver a confirmar." }, { status: 429, headers: { "Retry-After": "60" } });
    if (Number(request.headers.get("content-length")) > 16000) return Response.json({ error: "Pedido demasiado grande." }, { status: 413 });
    const text = await request.text();
    if (text.length > 16000) return Response.json({ error: "Pedido demasiado grande." }, { status: 413 });
    let body: unknown;
    try { body = JSON.parse(text); } catch { return Response.json({ error: "Pedido no válido." }, { status: 400 }); }
    const parsed = checkoutSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues.find(problem => problem.path[0] === "deliveryAddress");
      return Response.json({ error: issue?.message ?? "Revisá tu nombre, WhatsApp y las cantidades del pedido." }, { status: 400 });
    }
    const receipt = await submitCheckout(parsed.data);
    // Revalidation failure must not report a persisted order as failed.
    try { revalidatePath("/admin/orders"); } catch { /* order is already stored */ }
    return Response.json(receipt, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof CheckoutError) return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status });
    console.error("[checkout] Could not persist order", error instanceof Error ? `${error.name}: ${error.message}` : "UnknownError");
    return Response.json({ error: "No pudimos confirmar el registro. Reintentá desde este mismo pedido." }, { status: 503 });
  }
}
