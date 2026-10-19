import assert from "node:assert/strict";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";

const dialect = new PgDialect();

// Intercept "@/db" BEFORE the module under test binds it — same pattern as
// src/lib/messaging/security-round5.test.ts.
const executed: { sql: string; params: unknown[] }[] = [];
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require("node:module") as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const prevLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean): unknown {
  if (request === "@/db") {
    return {
      db: {
        execute: async (query: unknown) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          executed.push(dialect.sqlToQuery(query as any));
          return { rows: [] };
        },
      },
      getDb: () => ({}),
    };
  }
  return prevLoad.call(this, request, parent, isMain);
};

const { deleteLeadCascade, deleteLeadCascadeSql } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("@/lib/leads/delete-lead") as typeof import("@/lib/leads/delete-lead");

function render(leadId: number, phone: string | null) {
  const { sql: text, params } = dialect.sqlToQuery(deleteLeadCascadeSql(leadId, phone));
  return { text, params };
}

test("emits ONE statement: a data-modifying CTE ending in the leads delete", () => {
  const { text } = render(7, "5493704111111");
  const trimmed = text.trim();
  assert.match(trimmed, /^WITH target_orders/i);
  assert.match(trimmed, /DELETE FROM leads WHERE id = \$\d+$/i);
  // A second statement would show a semicolon inside the text.
  assert.equal(trimmed.includes(";"), false);
});

test("clears every restrictive FK before deleting the lead", () => {
  const { text } = render(7, "5493704111111");
  const order = (needle: string) => text.indexOf(needle);
  // attachments.lead_id is NO ACTION and populated on inbound media.
  assert.match(text, /DELETE FROM attachments WHERE lead_id/);
  // orders can hang off lead_id even when phone_number differs.
  assert.match(text, /WHERE lead_id = \$\d+\s+OR \(\$\d+ IS NOT NULL AND phone_number = \$\d+\)/);
  // orders.id is referenced by session states and reconcile candidates —
  // both must be detached BEFORE the orders delete runs.
  assert.match(text, /UPDATE conversation_session_states\s+SET active_order_id = NULL/);
  assert.match(text, /UPDATE reconcile_candidates\s+SET order_id = NULL/);
  assert.ok(order("detach_session_states") < order("deleted_orders"));
  assert.ok(order("deleted_attachments") < order("deleted_orders"));
  assert.ok(order("deleted_orders") < order("DELETE FROM leads"));
});

test("phone-less leads still match their orders by lead_id only", () => {
  const { text, params } = render(9, null);
  // The NULL guard keeps `phone_number = NULL` from silently matching.
  assert.match(text, /IS NOT NULL AND phone_number =/);
  assert.deepEqual(params, [9, null, null, 9, 9]);
});

test("binds parameters in statement order (leadId, phone×2, leadId×2)", () => {
  const { params } = render(42, "5493704111111");
  assert.deepEqual(params, [42, "5493704111111", "5493704111111", 42, 42]);
});

test("deleteLeadCascade ships the single CTE statement to db.execute", async () => {
  executed.length = 0;
  await deleteLeadCascade({ leadId: 7, phone: "5493704111111" });
  assert.equal(executed.length, 1);
  assert.match(executed[0].sql.trim(), /^WITH target_orders/);
  assert.deepEqual(executed[0].params.slice(-1), [7]);
});
