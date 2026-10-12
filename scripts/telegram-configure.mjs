#!/usr/bin/env node
/**
 * scripts/telegram-configure.mjs — configura el bot de Telegram del agente interno.
 *
 * Idempotente y DRY-RUN por defecto: no escribe en la DB ni registra el webhook
 * salvo que se pase --apply.
 *
 * Inputs (CLI > env):
 *   --token         | TELEGRAM_BOT_TOKEN
 *   --chat-ids      | TELEGRAM_ALLOWED_CHAT_IDS      ("123456, 789012")
 *   --public-url    | AUTH_URL / NEXT_PUBLIC_APP_URL / RENDER_EXTERNAL_URL
 *   --webhook-token | opcional; reusa el de la DB si existe, si no se genera
 *   --database-url  | DATABASE_URL
 * AUTH_SECRET / NEXTAUTH_SECRET: requerido para --apply (encripta el token con
 * el MISMO mecanismo que la app: src/lib/encryption.ts).
 *
 * Nunca imprime valores de tokens: siempre quedan enmascarados.
 *
 * Uso:
 *   node scripts/telegram-configure.mjs --token <TOKEN> --chat-ids <ID> \
 *     --public-url https://mi-app.onrender.com            # dry-run
 *   node scripts/telegram-configure.mjs ... --apply        # aplica
 */
import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { randomBytes } from "node:crypto";
import {
  encrypt,
  getMe,
  setWebhook,
  getWebhookInfo,
  maskToken,
  maskChatId,
  maskWebhookUrl,
  maskDbHost,
  resolvePublicUrl,
  getAuthSecret,
  parseArgs,
} from "./lib/telegram-ops.mjs";

function usage() {
  console.log(`Uso: node scripts/telegram-configure.mjs [opciones]

Configura el bot de Telegram del agente interno (agent_config id=1).

Opciones:
  --token <token>          Bot token de @BotFather (o TELEGRAM_BOT_TOKEN)
  --chat-ids <a,b,c>       Chat IDs autorizados (o TELEGRAM_ALLOWED_CHAT_IDS)
  --public-url <url>       URL pública del deploy
                           (o AUTH_URL / NEXT_PUBLIC_APP_URL / RENDER_EXTERNAL_URL)
  --webhook-token <token>  Reemplaza el webhook token (opcional)
  --database-url <url>     Postgres/Neon (o DATABASE_URL)
  --apply                  Escribe en la DB y registra el webhook (default: dry-run)
  -h, --help               Esta ayuda

Los valores de tokens nunca se imprimen (quedan enmascarados).`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    return;
  }

  const apply = args.apply === true || args.apply === "true";
  const token =
    (typeof args.token === "string" ? args.token : process.env.TELEGRAM_BOT_TOKEN) || "";
  const chatIdsRaw =
    (typeof args["chat-ids"] === "string"
      ? args["chat-ids"]
      : process.env.TELEGRAM_ALLOWED_CHAT_IDS) || "";
  const publicUrl =
    ((typeof args["public-url"] === "string" ? args["public-url"] : resolvePublicUrl()) || "")
      .replace(/\/$/, "");
  const databaseUrl =
    (typeof args["database-url"] === "string"
      ? args["database-url"]
      : process.env.DATABASE_URL) || "";
  const explicitWebhookToken =
    typeof args["webhook-token"] === "string" ? args["webhook-token"].trim() : "";
  const authSecret = getAuthSecret();

  const chatIds = chatIdsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const invalidChatIds = chatIds.filter((id) => !/^-?\d+$/.test(id));

  console.log("═══ Plan de configuración del bot de Telegram ═══");
  console.log(`  Modo          : ${apply ? "APPLY (escribe DB + registra webhook)" : "DRY-RUN (no toca la DB)"}`);
  console.log(`  Bot token     : ${token ? maskToken(token) : "(faltante)"}`);
  console.log(`  Chat IDs      : ${chatIds.length ? chatIds.map(maskChatId).join(", ") : "(faltante)"}`);
  console.log(`  Chats inválidos: ${invalidChatIds.length ? invalidChatIds.join(", ") : "ninguno"}`);
  console.log(`  URL pública   : ${publicUrl || "(faltante)"}`);
  console.log(`  Webhook token : ${explicitWebhookToken ? maskToken(explicitWebhookToken) + " (override)" : "(reusar de DB o generar)"}`);
  console.log(`  DB host       : ${databaseUrl ? maskDbHost(databaseUrl) : "(faltante)"}`);
  console.log(`  AUTH_SECRET   : ${authSecret ? "presente" : "(faltante)"}`);
  console.log("");

  const problems = [];
  if (!token) problems.push("Falta el bot token (--token o TELEGRAM_BOT_TOKEN).");
  if (chatIds.length === 0) problems.push("Falta al menos un chat ID (--chat-ids o TELEGRAM_ALLOWED_CHAT_IDS).");
  if (invalidChatIds.length) problems.push(`Chat IDs inválidos (deben ser numéricos): ${invalidChatIds.join(", ")}`);
  if (!publicUrl) problems.push("Falta la URL pública (--public-url o AUTH_URL/NEXT_PUBLIC_APP_URL/RENDER_EXTERNAL_URL).");
  if (apply && !databaseUrl) problems.push("Falta DATABASE_URL (--database-url o env).");
  if (apply && !authSecret) problems.push("Falta AUTH_SECRET/NEXTAUTH_SECRET (requerido para encriptar el token).");
  if (apply && publicUrl && !publicUrl.startsWith("https://")) problems.push("Telegram exige una URL pública HTTPS para el webhook.");
  if (problems.length) {
    console.error("✖ Configuración incompleta:");
    for (const p of problems) console.error(`   - ${p}`);
    if (!apply) console.error("\n(Dry-run: es solo un chequeo. No se escribió nada.)");
    process.exitCode = 1;
    return;
  }

  // Validar el token contra Telegram (no toca la DB).
  const me = await getMe(token);
  if (!me.ok) {
    console.error(`✖ Token inválido: getMe falló → ${me.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✔ Token válido: @${me.username} (id ${me.id})`);

  if (!apply) {
    console.log("\n— Dry-run completo. No se escribió nada. Reejecutá con --apply para aplicar. —");
    return;
  }

  // ── APPLY ──────────────────────────────────────────────────────────────────
  // A partir de acá SÍ se toca la DB (solo con --apply).
  const sql = neon(databaseUrl);

  let existing;
  try {
    const rows = await sql`select telegram_webhook_token, telegram_bot_token, telegram_chat_id, telegram_enabled
      from agent_config where id = 1 limit 1`;
    existing = rows[0];
  } catch (err) {
    console.error(`✖ No se pudo leer agent_config: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  }
  if (!existing) {
    console.error("✖ No existe la fila agent_config id=1.");
    process.exitCode = 1;
    return;
  }

  // Reusar el webhook token existente para no invalidar una URL ya registrada;
  // generar uno nuevo solo si falta.
  const webhookToken =
    explicitWebhookToken || existing.telegram_webhook_token || randomBytes(24).toString("hex");
  const webhookUrl = `${publicUrl}/api/telegram/webhook/${webhookToken}`;

  const encryptedToken = encrypt(token, authSecret);
  const chatIdStr = chatIds.join(",");

  await sql`update agent_config set
      telegram_bot_token = ${encryptedToken},
      telegram_webhook_token = ${webhookToken},
      telegram_chat_id = ${chatIdStr},
      telegram_enabled = true,
      updated_at = now()
    where id = 1`;
  console.log("✔ DB actualizada (token encriptado, webhook token, chat ids, telegram_enabled=true).");

  const setRes = await setWebhook(token, webhookUrl);
  if (!setRes.ok) {
    console.error(`✖ setWebhook falló: ${setRes.error}`);
    console.error("  La DB quedó configurada; corregí la URL y reejecutá (es idempotente).");
    process.exitCode = 1;
    return;
  }
  console.log(`✔ setWebhook OK → ${maskWebhookUrl(webhookUrl)}`);

  const info = await getWebhookInfo(token);
  console.log("\n═══ getWebhookInfo ═══");
  if (!info.ok) {
    console.error(`  ✖ ${info.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  url             : ${info.url ? maskWebhookUrl(info.url) : "(sin webhook)"}`);
  console.log(`  pending_updates : ${info.pendingUpdateCount}`);
  if (info.lastErrorMessage) console.log(`  último error    : ${info.lastErrorMessage}`);

  console.log("\n✅ Bot de Telegram configurado y webhook registrado.");
  console.log("⚠ Verificá que AUTH_SECRET sea el MISMO que usa el deploy: si no, el app no podrá desencriptar el token.");
}

main().catch((err) => {
  console.error("ERR", err instanceof Error ? err.message : err);
  process.exit(1);
});
