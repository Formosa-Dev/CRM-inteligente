import { db } from "@/db";
import { sql } from "drizzle-orm";

/**
 * Deletes a lead and every row that can block the delete, in ONE statement.
 *
 * neon-http has no `db.transaction()` — a data-modifying CTE is the only
 * atomic shape available. Plain `references()` FKs default to NO ACTION, so
 * the statement must clear them in dependency order:
 *
 *  - `attachments.lead_id` is populated on inbound media → delete by lead_id.
 *  - `orders.lead_id` may point at orders whose `phone_number` differs from
 *    the lead's normalized phone → delete by `lead_id OR phone_number`.
 *  - `conversation_session_states.active_order_id` and
 *    `reconcile_candidates.order_id` reference the orders being removed →
 *    NULL them out first (detach, not delete — the rows outlive the lead).
 *  - `lead_identities.lead_id` is `ON DELETE CASCADE` → handled by Postgres.
 *
 * `phone` is nullable: phone-less (social) leads match orders by lead_id only.
 */
export function deleteLeadCascadeSql(leadId: number, phone: string | null) {
  return sql`
    WITH target_orders AS (
      SELECT id FROM orders
      WHERE lead_id = ${leadId}
         OR (${phone} IS NOT NULL AND phone_number = ${phone})
    ),
    detach_session_states AS (
      UPDATE conversation_session_states
      SET active_order_id = NULL
      WHERE active_order_id IN (SELECT id FROM target_orders)
    ),
    detach_reconcile_candidates AS (
      UPDATE reconcile_candidates
      SET order_id = NULL
      WHERE order_id IN (SELECT id FROM target_orders)
    ),
    deleted_attachments AS (
      DELETE FROM attachments WHERE lead_id = ${leadId}
    ),
    deleted_orders AS (
      DELETE FROM orders WHERE id IN (SELECT id FROM target_orders)
    )
    DELETE FROM leads WHERE id = ${leadId}
  `;
}

export async function deleteLeadCascade(input: {
  leadId: number;
  phone: string | null;
}): Promise<void> {
  await db.execute(deleteLeadCascadeSql(input.leadId, input.phone));
}
