import { auth } from "@/auth";

/**
 * Requires a session with the "admin" role. The `viewer` role exists for
 * read-only accounts — any authenticated user may read admin data, but only
 * admins can mutate. For single-business deployments there is exactly one
 * admin user; create additional accounts as "viewer" to grant read access.
 *
 * F9: `auth()` revalidates the user row through the jwt callback (60s TTL
 * cache, see src/auth/index.ts and src/lib/auth/session-users.ts) — a demoted
 * or deleted user loses access within ~1 minute even though the JWT itself
 * is not revoked.
 */
export async function requireAdmin(): Promise<boolean> {
  const session = await auth();
  return (session?.user as { role?: string } | undefined)?.role === "admin";
}
