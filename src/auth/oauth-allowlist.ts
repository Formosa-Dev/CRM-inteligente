import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

/**
 * A-03: OAuth sign-in is admitted only for emails already provisioned in the
 * `users` table — the same store the credentials provider authenticates
 * against. An unprovisioned email is denied, so a configured OAuth provider
 * can no longer mint sessions for arbitrary accounts.
 *
 * Returns the user's id and role so the caller can attach the real identity
 * to the session — an OAuth profile alone would leave `role` undefined.
 */
export async function findProvisionedUser(
  email: string
): Promise<{ id: number; role: string } | null> {
  const [row] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return row ?? null;
}
