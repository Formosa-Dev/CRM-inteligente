import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { telegramPlatformMessageId } from "./bot";

// Telegram's message_id is a per-chat monotonic counter — every chat has a
// message "1". chat_messages.platform_message_id is a GLOBALLY-unique dedup
// key, so storing the raw id lets a second authorized chat's early messages
// collide with the first chat's rows and get dropped as false duplicates.
// The dedup key must be namespaced by chat id.

const ROUTE = "src/app/api/telegram/webhook/[token]/route.ts";

test("telegramPlatformMessageId namespaces the per-chat counter", () => {
  assert.equal(telegramPlatformMessageId(123, 1), "tg_123_1");
  // Same message_id, different chat → different dedup key (the actual bug).
  assert.notEqual(
    telegramPlatformMessageId(123, 1),
    telegramPlatformMessageId(456, 1)
  );
  // String inputs compose identically (route passes number, tests may pass str).
  assert.equal(telegramPlatformMessageId("123", "1"), "tg_123_1");
});

test("the webhook route namespaces message_id via telegramPlatformMessageId", () => {
  const source = readFileSync(ROUTE, "utf8");
  assert.match(
    source,
    /const\s+messageId\s*=\s*telegramPlatformMessageId\(chatId,\s*message\.message_id\)/
  );
  // No bare numeric id may feed the platform_message_id dedup space.
  assert.doesNotMatch(
    source,
    /const\s+messageId\s*=\s*String\(message\.message_id\)/
  );
});
