import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * F10 — Telegram webhook secret_token. The webhook URL path token alone
 * proves nothing about who sent the request; Telegram's secret_token adds
 * an X-Telegram-Bot-Api-Secret-Token header the route must verify BEFORE
 * parsing the update.
 *
 * Same source-inspection style as webhook-model.test.ts — the route needs
 * a live DB config to run end-to-end, so the contract is asserted on the
 * code itself.
 */

const ROUTE = "src/app/api/telegram/webhook/[token]/route.ts";
const BOT = "src/lib/telegram/bot.ts";

test("the route verifies X-Telegram-Bot-Api-Secret-Token before parsing", () => {
  const source = readFileSync(ROUTE, "utf8");
  assert.match(source, /x-telegram-bot-api-secret-token/);

  // The header check must sit between the URL-token check and the body
  // parse — a forged update must never reach JSON.parse.
  const headerIdx = source.indexOf("x-telegram-bot-api-secret-token");
  const parseIdx = source.indexOf("JSON.parse(bounded.rawBody)");
  assert.ok(headerIdx !== -1 && parseIdx !== -1);
  assert.ok(
    headerIdx < parseIdx,
    "secret-token check must run before the update is parsed"
  );
});

test("the secret-token comparison is timing-safe", () => {
  const source = readFileSync(ROUTE, "utf8");
  const headerIdx = source.indexOf("x-telegram-bot-api-secret-token");
  const tail = source.slice(headerIdx);
  assert.match(tail, /timingSafeEqual/);
});

test("setTelegramWebhook registers secret_token with Telegram", () => {
  const source = readFileSync(BOT, "utf8");
  const fnStart = source.indexOf("export async function setTelegramWebhook");
  assert.ok(fnStart !== -1);
  const body = source.slice(fnStart, source.indexOf("\n}", fnStart));
  assert.match(body, /secret_token/);
});

test("the webhook token read path tolerates encrypted values", () => {
  // At-rest encryption is pending a varchar(100)→text column widen; when it
  // lands, decryptIfEncrypted already resolves both formats.
  const source = readFileSync(BOT, "utf8");
  assert.match(source, /decryptIfEncrypted\(config\.telegramWebhookToken\)/);
});
