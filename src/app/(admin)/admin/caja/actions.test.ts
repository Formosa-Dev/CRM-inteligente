/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the module hooks */
/**
 * A-01: addCashMovementAction writes cash_movements with a forged audit
 * identity — it must require the admin role before touching anything.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const Module = require("node:module") as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const prevLoad = Module._load;

let session: unknown = { user: { id: "1", role: "admin" } };
const movements: Array<{
  direction: string;
  amount: number;
  reason: string;
  createdBy: string;
}> = [];

Module._load = function (request, parent, isMain): unknown {
  if (request === "@/auth") {
    return { auth: async () => session };
  }
  if (request === "next/cache") {
    return { revalidatePath: () => undefined };
  }
  if (request === "@/lib/cash/session") {
    return {
      addMovement: async (
        direction: string,
        amount: number,
        reason: string,
        createdBy: string
      ) => {
        movements.push({ direction, amount, reason, createdBy });
        return { id: movements.length };
      },
    };
  }
  return prevLoad.call(this, request, parent, isMain);
};

const { addCashMovementAction } = require("./actions") as typeof import("./actions");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const VALID = { direction: "out", amount: "150.5", reason: "Compra insumos" };

describe("A-01 — addCashMovementAction auth gate", () => {
  it("rejects anonymous callers before any write", async () => {
    session = null;
    const before = movements.length;
    const result = await addCashMovementAction(form(VALID));
    assert.deepEqual(result, { error: "No autorizado" });
    assert.equal(movements.length, before);
  });

  it("rejects a viewer session — reads are allowed, mutations are not", async () => {
    session = { user: { id: "2", role: "viewer" } };
    const before = movements.length;
    const result = await addCashMovementAction(form(VALID));
    assert.deepEqual(result, { error: "No autorizado" });
    assert.equal(movements.length, before);
  });

  it("runs the auth gate before input validation", async () => {
    session = null;
    const result = await addCashMovementAction(form({}));
    assert.deepEqual(result, { error: "No autorizado" });
  });

  it("admits an admin and records the movement with the panel audit tag", async () => {
    session = { user: { id: "1", role: "admin" } };
    const result = await addCashMovementAction(form(VALID));
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(movements.at(-1), {
      direction: "out",
      amount: 150.5,
      reason: "Compra insumos",
      createdBy: "admin-panel",
    });
  });

  it("still validates amount and reason for admins", async () => {
    session = { user: { id: "1", role: "admin" } };
    const before = movements.length;
    const result = await addCashMovementAction(
      form({ direction: "out", amount: "-5", reason: "" })
    );
    assert.deepEqual(result, { error: "Monto y motivo son obligatorios." });
    assert.equal(movements.length, before);
  });
});
