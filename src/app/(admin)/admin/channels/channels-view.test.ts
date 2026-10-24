import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(
  "src/app/(admin)/admin/channels/channels-view.tsx",
  "utf8"
);

describe("admin channels warning copy", () => {
  it("states the agent auto-replies on WhatsApp (any provider) and Telegram", () => {
    assert.match(source, /responde automáticamente en WhatsApp \(cualquier\s+proveedor\) y Telegram/);
  });

  it("states other channels persist to the inbox without agent auto-reply", () => {
    assert.match(source, /guardan los mensajes en la bandeja de entrada, sin\s+auto-reply del agente/);
  });

  it("offers a connect button per live-verified Zernio platform", () => {
    for (const platform of [
      "instagram",
      "facebook",
      "linkedin",
      "tiktok",
      "youtube",
      "threads",
      "pinterest",
      "discord",
      "slack",
    ]) {
      assert.match(
        source,
        new RegExp(`platform: "${platform}"`),
        `missing connect button for ${platform}`
      );
    }
  });
});
