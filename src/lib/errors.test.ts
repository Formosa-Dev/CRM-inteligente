/**
 * F13: caught internals (SQL detail, provider responses) are logged
 * server-side under a correlation id; clients only ever see the generic
 * message + ref.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { reportInternalError } from "./errors";

describe("reportInternalError", () => {
  it("logs the full error under a correlation ref and returns it", () => {
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      const ref = reportInternalError("test.tag", new Error("db said: relation x"));
      assert.match(ref, /^[0-9a-f]{8}$/);
      assert.equal(logged.length, 1);
      const [first, err] = logged[0] as [string, Error];
      assert.match(first, /^\[test\.tag\] ref=/);
      assert.ok(first.includes(`ref=${ref}`));
      assert.equal(err.message, "db said: relation x");
    } finally {
      console.error = original;
    }
  });
});

describe("F13 — owned admin actions return generic messages", () => {
  const files = [
    "src/app/(admin)/admin/agent/actions.ts",
    "src/app/(admin)/admin/meta/actions.ts",
    "src/app/(admin)/admin/orders/actions.ts",
    "src/app/(admin)/admin/conversations/actions.ts",
  ] as const;

  for (const file of files) {
    it(`${file} never interpolates a caught error's message into the response`, () => {
      const src = readFileSync(file, "utf8");
      // No `e.message` / `err.message` / `error.message` reaching client output.
      assert.doesNotMatch(src, /\b(e|err|error)\.message\b/);
      assert.match(src, /reportInternalError|Error al guardar|No autorizado/);
    });
  }
});
