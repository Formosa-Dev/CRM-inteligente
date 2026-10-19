import assert from "node:assert/strict";
import test from "node:test";
import { deleteLead, type DeleteLeadDeps } from "./actions";

type LeadRow = { id: number; phone: string };
type OrderRow = { id: number; phoneNumber: string };

/**
 * In-memory boundary that mirrors the production seam: `deleteLeadWithOrders`
 * is ONE atomic operation — check and delete cannot interleave — matching the
 * single data-modifying-CTE statement it stands in for.
 */
function fakeDeps(options: {
  isAdmin?: boolean;
  leads?: LeadRow[];
  orders?: OrderRow[];
  failDelete?: Error;
} = {}) {
  const leads = [...(options.leads ?? [])];
  const orders = [...(options.orders ?? [])];
  const deleteCalls: Array<{ phone: string; leadId: number }> = [];
  const deps: DeleteLeadDeps = {
    async isAdmin() {
      return options.isAdmin ?? true;
    },
    async findLeadIdByPhone(phone) {
      return leads.find((l) => l.phone === phone)?.id ?? null;
    },
    async deleteLeadWithOrders(phone, leadId) {
      deleteCalls.push({ phone, leadId });
      if (options.failDelete) throw options.failDelete;
      for (let i = orders.length - 1; i >= 0; i--) {
        if (orders[i].phoneNumber === phone) orders.splice(i, 1);
      }
      const idx = leads.findIndex((l) => l.id === leadId);
      if (idx >= 0) leads.splice(idx, 1);
    },
  };
  return { deps, leads, orders, deleteCalls };
}

const PHONE = "+54 9 3704 111111";
const NORMALIZED = "5493704111111";

test("rejects callers without the admin role before touching the store", async () => {
  const { deps, leads, orders } = fakeDeps({
    isAdmin: false,
    leads: [{ id: 1, phone: NORMALIZED }],
    orders: [{ id: 10, phoneNumber: NORMALIZED }],
  });
  const result = await deleteLead(PHONE, deps);
  assert.deepEqual(result, { success: false, error: "No autorizado" });
  assert.equal(leads.length, 1);
  assert.equal(orders.length, 1);
});

test("returns not found when the normalized phone matches no lead", async () => {
  const { deps, deleteCalls } = fakeDeps({ leads: [{ id: 1, phone: "5491100000000" }] });
  const result = await deleteLead(PHONE, deps);
  assert.deepEqual(result, { success: false, error: "Lead no encontrado" });
  assert.equal(deleteCalls.length, 0);
});

test("deletes the lead and all its orders in a single atomic call, scoped to the normalized phone", async () => {
  const { deps, leads, orders, deleteCalls } = fakeDeps({
    leads: [
      { id: 7, phone: NORMALIZED },
      { id: 8, phone: "5491100000000" },
    ],
    orders: [
      { id: 1, phoneNumber: NORMALIZED },
      { id: 2, phoneNumber: NORMALIZED },
      { id: 3, phoneNumber: "5491100000000" },
    ],
  });

  const result = await deleteLead(PHONE, deps);

  assert.deepEqual(result, { success: true });
  // The whole lead+orders removal happened inside ONE atomic call — the only
  // shape that preserves all-or-nothing semantics without db.transaction().
  assert.deepEqual(deleteCalls, [{ phone: NORMALIZED, leadId: 7 }]);
  assert.deepEqual(leads, [{ id: 8, phone: "5491100000000" }]);
  assert.deepEqual(orders, [{ id: 3, phoneNumber: "5491100000000" }]);
});

test("a store failure surfaces as a generic error with no partial claim of success", async () => {
  const { deps, leads, orders } = fakeDeps({
    leads: [{ id: 7, phone: NORMALIZED }],
    orders: [{ id: 1, phoneNumber: NORMALIZED }],
    failDelete: new Error("connection reset"),
  });
  const result = await deleteLead(PHONE, deps);
  assert.deepEqual(result, { success: false, error: "Error al eliminar" });
  // Atomicity lives in the single statement; the in-memory op threw before
  // mutating anything, mirroring a statement-level failure.
  assert.equal(leads.length, 1);
  assert.equal(orders.length, 1);
});
