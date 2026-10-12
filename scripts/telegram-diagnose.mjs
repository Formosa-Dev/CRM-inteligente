#!/usr/bin/env node
/**
 * scripts/telegram-diagnose.mjs — diagnóstico READ-ONLY del bot de Telegram.
 *
 * Reporta SOLO presencia/estado de las columnas telegram_* de agent_config id=1
 * (nunca sus valores) y, si hay un token disponible, consulta getMe +
 * getWebhookInfo. No escribe nada.
 *
 * Token para la API: primero env TELEGRAM_BOT_TOKEN; si no, desencripta
 * telegram_bot_token de la DB con AUTH_SECRET (mismo mecanismo que la app).
 *
 * Uso:
 *   node scripts/telegram-diagnose.mjs            # usa DATABASE_URL del env/.env
 *   node scripts/telegram-diagnose.mjs --database-url <URL>
 */
import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import {
  getMe,
  getWebhookInfo,
  maskToken,
  maskChatId,
  maskWebhookUrl,
  maskDbHost,
  decrypt,
  isEncrypted,
  getAuthSecret,
  parseArgs,
} from "./lib/telegram-ops.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl =
    (typeof args["database-url"] === "string" ? args["database-url"] : process.env.DATABASE_URL) || "";
  if (!databaseUrl) {
    console.error("✖ Falta DATABASE_URL (env o --database-url).");
    process.exit(1);
  }
  const authSecret = getAuthSecret();

  console.log("═══ Diagnóstico del bot de Telegram (read-only) ═══");
  console.log(`  DB host     : ${maskDbHost(databaseUrl)}`);
  console.log(`  AUTH_SECRET : ${authSecret ? "presente" : "(faltante — no se puede desencriptar el token de la DB)"}`);

  const sql = neon(databaseUrl);
  let cfg;
  try {
    const rows = await sql`select telegram_bot_token, telegram_webhook_token, telegram_chat_id, telegram_enabled
      from agent_config where id = 1 limit 1`;
    cfg = rows[0];
  } catch (err) {
    console.error(`✖ No se pudo leer agent_config: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  if (!cfg) {
    console.log("\n✖ No existe la fila agent_config id=1.");
    process.exit(1);
  }

  console.log("\n── agent_config id=1 (presencia, sin valores) ──");
  const botState = !cfg.telegram_bot_token
    ? "vacío"
    : isEncrypted(cfg.telegram_bot_token)
      ? "presente (encriptado)"
      : "presente (SIN encriptar)";
  console.log(`  telegram_bot_token     : ${botState}`);
  console.log(`  telegram_webhook_token : ${cfg.telegram_webhook_token ? "presente" : "vacío"}`);
  const chatIds = cfg.telegram_chat_id
    ? String(cfg.telegram_chat_id).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  console.log(`  telegram_chat_id       : ${chatIds.length ? `${chatIds.length} id(s): ${chatIds.map(maskChatId).join(", ")}` : "vacío"}`);
  console.log(`  telegram_enabled       : ${cfg.telegram_enabled}`);

  console.log("\n── env (presencia) ──");
  console.log(`  TELEGRAM_BOT_TOKEN       : ${process.env.TELEGRAM_BOT_TOKEN ? "presente" : "vacío"}`);
  console.log(`  TELEGRAM_WEBHOOK_TOKEN   : ${process.env.TELEGRAM_WEBHOOK_TOKEN ? "presente" : "vacío"}`);
  console.log(`  TELEGRAM_ALLOWED_CHAT_IDS: ${process.env.TELEGRAM_ALLOWED_CHAT_IDS ? "presente" : "vacío"}`);

  // Resolver un token usable: env primero, luego DB (desencriptado o legacy).
  let token = process.env.TELEGRAM_BOT_TOKEN || "";
  let source = token ? "env TELEGRAM_BOT_TOKEN" : "";
  if (!token && cfg.telegram_bot_token) {
    if (isEncrypted(cfg.telegram_bot_token)) {
      if (authSecret) {
        const decrypted = decrypt(cfg.telegram_bot_token, authSecret);
        if (decrypted) {
          token = decrypted;
          source = "DB (desencriptado)";
        }
      }
    } else {
      token = cfg.telegram_bot_token;
      source = "DB (plaintext legacy)";
    }
  }

  if (!token) {
    console.log("\n⚠ No hay token disponible para consultar la API de Telegram. Fin del diagnóstico.");
    return;
  }

  console.log(`\n── Telegram API (token ${maskToken(token)} vía ${source}) ──`);
  const me = await getMe(token);
  console.log(`  getMe          : ${me.ok ? `OK — @${me.username} (id ${me.id})` : `ERROR — ${me.error}`}`);

  const info = await getWebhookInfo(token);
  if (!info.ok) {
    console.log(`  getWebhookInfo : ERROR — ${info.error}`);
  } else {
    console.log(`  webhook url    : ${info.url ? maskWebhookUrl(info.url) : "(sin webhook registrado)"}`);
    console.log(`  pending_updates: ${info.pendingUpdateCount}`);
    if (info.lastErrorMessage) console.log(`  último error   : ${info.lastErrorMessage}`);
  }

  console.log("\n(Read-only: no se escribió nada.)");
}

main().catch((err) => {
  console.error("ERR", err instanceof Error ? err.message : err);
  process.exit(1);
});
