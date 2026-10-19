# A-58 — Persisted `orders.total` (design only)

Status: **proposal** — no code change in this slice. This document is the
spec for whoever picks it up.

## Problem

`orders` has no persisted total. The money value lives inside the `items`
JSONB blob, and every reader recomputes it in JS **doubles**:

```ts
// src/lib/telegram/toolsAnalytics.ts:24
(sum, item) => sum + ((item.price ?? item.unitPrice ?? 0) * (item.quantity ?? 1))
```

Two failure modes compound:

1. **Heterogeneous item shape.** Four writer paths persist `items` with
   different price keys — `price` vs `unitPrice` — so every reader must
   guess (`price ?? unitPrice`) and silently drops a line when neither key
   is present.
2. **Float arithmetic.** `0.1 + 0.2` sums leak into analytics, cash-session
   reports (`cash/session.ts` `orderTotal`), client LTV (`client-utils.ts`),
   and tool replies (`Nuevo total: $${total.toFixed(2)}`). No single source
   of truth means different screens can show different totals for the same
   order.

Writer paths today (all must agree before a persisted column is trustworthy):

| Writer | File |
| --- | --- |
| WhatsApp agent create-order | `src/lib/whatsapp/tools/create-order.ts` |
| Telegram agent order tools | `src/lib/telegram/toolsOrder.ts` |
| WhatsApp add-to-order edit | `src/lib/whatsapp/tools/order-management-tools.ts` |
| Admin UI create/edit | `src/app/(admin)/admin/orders/create-order-action.ts`, `order-edit-modal.tsx` |
| Web checkout | `src/lib/checkout/service.ts` |

`orders.delivery_fee numeric(10,2)` already exists as a separate column —
the persisted total must define clearly whether it includes it (see below).

## Proposal

### Column

```sql
ALTER TABLE orders ADD COLUMN total numeric(12,2);
```

`numeric`, not `double precision`/`real` — money never goes through binary
floats on the DB side. `jsonb` items stay as the line-item detail; `total`
becomes the authoritative scalar for sums, lists, and reports.

Semantics: `total = Σ(line price × qty) + delivery_fee`. Persist the
**all-in customer-facing** number — that's what "total" means to every
reader (analytics, cash, LTV, chat replies). Readers that want the items
subtotal can still subtract `delivery_fee`, which is already a column.

### Alternative considered: integer cents

Storing `total_cents integer` avoids numeric parsing and forces cents
discipline in app code (`checkout/service.ts` already computes with
`Math.round(unitPrice * 100)`). Rejected for this codebase: `numeric`
matches `products.price`/`delivery_fee`/`cash_sessions.*` conventions, is
SQL-aggregate friendly (`SUM(total)` in analytics/cash queries), and keeps
the JSONB→column backfill trivial. If a future ledger needs strict integer
math, wrap it in cents at that boundary, not here.

### Writer rules

1. Compute the total **once at write time** from the priced items the
   writer just persisted — using the writer's own resolved prices, not a
   second pass over JSONB.
2. Normalise the item shape first: pick one key (recommend `unitPrice`,
   matching checkout/cart) and write it consistently. Persisting `total`
   alongside four divergent JSONB shapes just relocates the guessing.
3. Every mutation of `items` or `delivery_fee` must recompute `total` in
   the same statement — `UPDATE orders SET items = ..., total = ...`
   together, never two writes.
4. neon-http has no `db.transaction()` — never split item edit and total
   update into two statements.

## Migration plan

1. **Add column** (nullable): `ALTER TABLE orders ADD COLUMN total numeric(12,2);`
   in its own additive migration.
2. **Backfill** in the same or a follow-up migration:

   ```sql
   UPDATE orders SET total = sub.total + COALESCE(orders.delivery_fee, 0)
   FROM (
     SELECT o.id,
       SUM(
         COALESCE(
           (item ->> 'unitPrice')::numeric,
           (item ->> 'price')::numeric,
           0
         ) * COALESCE((item ->> 'quantity')::numeric, 1)
       ) AS total
     FROM orders o, jsonb_array_elements(o.items) AS item
     GROUP BY o.id
   ) sub
   WHERE orders.id = sub.id;
   ```

   Verify a sample against `cash/session.ts`'s `orderTotal()` output before
   marking backfill done — same key precedence (`unitPrice` first? decide
   and document; today readers use `price ?? unitPrice`).
3. **Code deploy**: writers start persisting `total`; schema gains
   `total: numeric("total", { precision: 12, scale: 2 })` (nullable while
   backfill races may exist).
4. **Harden**: `ALTER COLUMN total SET NOT NULL` once every row has a value
   and all five writers ship. Optionally a `CHECK (total >= 0)`.

### Reader migration order

Do not flip readers until backfill + writers are live:

1. `src/lib/telegram/toolsAnalytics.ts` — aggregate sums become
   `SUM(total)` / `SUM(total - delivery_fee)` in SQL, not JS.
2. `src/lib/cash/session.ts` `orderTotal()` — read the column; keep the
   JSONB path as fallback during rollout, then remove.
3. `src/lib/client-utils.ts` `totalSpent` — same.
4. `src/lib/conversations/queries.ts:202` (`total: null` today) — expose it.
5. Chat-facing `Nuevo total` strings — read the persisted value after each
   item mutation.

Keep `items` JSONB as the line detail — this change adds a derived scalar,
it doesn't restructure items into a child table (that's a bigger, separate
move: `order_items` with FK + per-line numeric price would let the DB sum
natively, but isn't required to fix A-58).

## Verification

- Reconcile `SUM(total)` per day against the old JS-float computation for a
  trailing window; investigate deltas > $0.01 (they'll mostly be the float
  noise this change removes).
- Add a regression test next to `cash/session.test.ts` asserting an order
  with N items + fee reports `total` exactly.
