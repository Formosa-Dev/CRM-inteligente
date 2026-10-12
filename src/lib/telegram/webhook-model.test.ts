import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Regresión del incidente de producción: el webhook de Telegram usaba
// getMainModel() → provider(cfg.model) → Responses API (/responses). Un
// proveedor OpenAI-compatible tipo DeepSeek sólo soporta /chat/completions,
// así que la llamada 404aba, generateText lanzaba y el .catch fire-and-forget
// se lo tragaba: el bot nunca respondía. Debe usar getMainChatModel()
// (provider.chat()), igual que el agente de WhatsApp.

const ROUTE = "src/app/api/telegram/webhook/[token]/route.ts";

test("el webhook de Telegram usa getMainChatModel y no getMainModel", () => {
  const source = readFileSync(ROUTE, "utf8");
  assert.match(source, /getMainChatModel\s*\(/);
  assert.doesNotMatch(source, /\bgetMainModel\s*\(/);
});

test("el webhook importa getMainChatModel desde @/lib/ai/config y no getMainModel", () => {
  const source = readFileSync(ROUTE, "utf8");
  assert.match(
    source,
    /import\s*\{[^}]*\bgetMainChatModel\b[^}]*\}\s*from\s*"@\/lib\/ai\/config"/,
  );
  assert.doesNotMatch(source, /\bgetMainModel\b/);
});

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `missing ${signature}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("\n}", open);
  assert.ok(open !== -1 && close !== -1, `unterminated body for ${signature}`);
  return source.slice(open, close);
}

test("getMainChatModel usa .chat() y getMainModel no (proveedores tipo DeepSeek)", () => {
  const config = readFileSync("src/lib/ai/config.ts", "utf8");
  const chatBody = functionBody(config, "export async function getMainChatModel");
  assert.match(chatBody, /provider\.chat\(cfg\.model\)/);

  const mainBody = functionBody(config, "export async function getMainModel");
  assert.doesNotMatch(mainBody, /\.chat\(/);
  assert.match(mainBody, /provider\(cfg\.model\)/);
});
