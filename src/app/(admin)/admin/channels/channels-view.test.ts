import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(
  "src/app/(admin)/admin/channels/channels-view.tsx",
  "utf8"
);

describe("admin channels warning copy", () => {
  it("states that Instagram/Facebook/Reddit persist messages without agent auto-reply", () => {
    assert.doesNotMatch(source, /Para IG\/FB\/Reddit no aplica/);
    assert.match(source, /Instagram,\s+Facebook y Reddit también guardan/);
    assert.match(source, /todavía no tienen\s+auto-reply del agente/);
  });

  it("keeps the WhatsApp Zernio/Kapso caveat accurate", () => {
    assert.match(source, /Zernio o Kapso guardan/);
    assert.match(source, /solo funciona con la cuenta WhatsApp de YCloud/);
  });
});
