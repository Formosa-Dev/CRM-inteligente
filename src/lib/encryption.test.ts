import assert from "node:assert/strict";
import test from "node:test";
import { encrypt, decryptIfEncrypted, isEncrypted } from "@/lib/encryption";

const WEBHOOK_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef"; // 48 hex chars

process.env.AUTH_SECRET = "test-secret-for-encryption-round-trip";

test("encrypts the webhook token into a varchar(255)-sized ciphertext and round-trips", () => {
  const cipher = encrypt(WEBHOOK_TOKEN);
  assert.ok(cipher.length <= 255, "ciphertext must fit the varchar(255) column");
  assert.ok(isEncrypted(cipher), "ciphertext must be recognized as encrypted");
  assert.equal(decryptIfEncrypted(cipher), WEBHOOK_TOKEN);
});

test("decryptIfEncrypted returns legacy plaintext tokens unchanged", () => {
  assert.equal(decryptIfEncrypted(WEBHOOK_TOKEN), WEBHOOK_TOKEN);
  assert.equal(decryptIfEncrypted(null), "");
});
