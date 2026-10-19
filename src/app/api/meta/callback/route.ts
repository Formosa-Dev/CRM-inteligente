import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/require-admin";
import { cookies } from "next/headers";
import { timingSafeEqual } from "crypto";
import { exchangeCodeForToken, getMetaBusinessInfo, encryptToken } from "@/lib/meta/oauth";
import { db } from "@/db";
import { agentConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import { META_OAUTH_STATE_COOKIE } from "@/lib/meta/oauth";

export async function GET(req: NextRequest) {
  // Only an authenticated admin may connect a Meta account — this route writes
  // the access token into agent_config.
  if (!(await requireAdmin())) {
    return new NextResponse(
      buildClosingHtml("error", "No autorizado — iniciá sesión en el admin"),
      { status: 401, headers: { "Content-Type": "text/html" } }
    );
  }

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");

  // CSRF check: the state in the URL must match the nonce cookie issued by the
  // admin session that started the OAuth flow. One-shot — clear it on use.
  const cookieStore = await cookies();
  const expectedState = cookieStore.get(META_OAUTH_STATE_COOKIE)?.value ?? "";
  // The state cookie is set with path "/api/meta" (generateMetaOAuthState) —
  // the delete must use the SAME path or the browser keeps the nonce alive
  // for its whole TTL and the "one-shot" CSRF check stays replayable.
  cookieStore.delete({ name: META_OAUTH_STATE_COOKIE, path: "/api/meta" });
  const a = Buffer.from(state ?? "");
  const b = Buffer.from(expectedState);
  if (!expectedState || a.length !== b.length || !timingSafeEqual(a, b)) {
    return new NextResponse(
      buildClosingHtml("error", "Estado OAuth inválido — reintentá la conexión"),
      { status: 403, headers: { "Content-Type": "text/html" } }
    );
  }

  // Handle error from Meta
  if (error) {
    return new NextResponse(
      buildClosingHtml("error", `Error de Meta: ${error}`),
      { headers: { "Content-Type": "text/html" } }
    );
  }

  if (!code) {
    return new NextResponse(
      buildClosingHtml("error", "No se recibió código de autorización"),
      { headers: { "Content-Type": "text/html" } }
    );
  }

  try {
    // Build redirect URI (must match exactly what was sent)
    const host = req.nextUrl.origin;
    const redirectUri = `${host}/api/meta/callback`;

    // Exchange code for token
    const { accessToken, expiresIn } = await exchangeCodeForToken(code, redirectUri);

    // Get business info
    const businessInfo = await getMetaBusinessInfo(accessToken);

    // Encrypt and save
    const encryptedToken = encryptToken(accessToken);
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    await db
      .update(agentConfig)
      .set({
        metaAccessToken: encryptedToken,
        metaTokenExpiresAt: expiresAt,
        metaBusinessName: businessInfo.name,
        metaPhoneNumberId: businessInfo.phoneNumberId,
        metaConnected: true,
        updatedAt: new Date(),
      })
      .where(eq(agentConfig.id, 1));

    return new NextResponse(
      buildClosingHtml("success", `Conectado a: ${businessInfo.name}`),
      { headers: { "Content-Type": "text/html" } }
    );
  } catch (err) {
    console.error("[meta/callback] Error:", err);
    return new NextResponse(
      buildClosingHtml("error", "Error al conectar con Meta"),
      { headers: { "Content-Type": "text/html" } }
    );
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildClosingHtml(status: string, message: string): string {
  const safeMessage = escapeHtml(message);
  const safeMessageJs = JSON.stringify(message);
  return `<!DOCTYPE html>
<html>
<head><title>Meta Connect</title></head>
<body style="background:#0a0a0a;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
  <div style="text-align:center;">
    <p style="font-size:1.5rem;">${status === "success" ? "✅" : "❌"} ${safeMessage}</p>
    <p style="color:#888;">Cerrando ventana...</p>
  </div>
  <script>
    window.opener?.postMessage({ type: "META_OAUTH_${status.toUpperCase()}", message: ${safeMessageJs} }, window.location.origin);
    setTimeout(() => window.close(), 2000);
  </script>
</body>
</html>`;
}
