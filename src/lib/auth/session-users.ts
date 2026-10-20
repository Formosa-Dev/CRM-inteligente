import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

/**
 * F9: JWT sessions are stateless — claims minted at sign-in (id, role) go
 * stale the moment an operator demotes or deletes the row in `users`. To keep
 * those claims honest without a per-request query, the role is re-read from
 * the DB through a short-lived (60s) module-level cache. Demotion/deletion
 * therefore propagates in at most ~1 minute on a single-business install.
 *
 * Deliberately NOT a tokenVersion/sessionEpoch claim: `users` has no version
 * column (schema is fixed), so the cheapest correct revocation signal is the
 * row itself — missing row kills the session, changed role updates it.
 */
const ROLE_CACHE_TTL_MS = 60_000;
const ROLE_CACHE_MAX_ENTRIES = 500;

interface RoleCacheEntry {
  role: string | null;
  at: number;
}

export type RoleLookupResult =
  | { status: "ok"; role: string | null }
  | { status: "error" };

export interface RoleLookup {
  lookup(userId: string | number): Promise<RoleLookupResult>;
  invalidate(userId?: string | number): void;
  sweep(): void;
}

export function createRoleLookup(
  deps: {
    ttlMs?: number;
    now?: () => number;
    maxEntries?: number;
  } = {}
): RoleLookup {
  const ttl = deps.ttlMs ?? ROLE_CACHE_TTL_MS;
  const now = deps.now ?? (() => Date.now());
  const maxEntries = deps.maxEntries ?? ROLE_CACHE_MAX_ENTRIES;
  const cache = new Map<string, RoleCacheEntry>();

  function evictExpired(at: number) {
    for (const [key, entry] of cache) {
      if (at - entry.at >= ttl) cache.delete(key);
    }
  }

  return {
    /**
     * Live role for a user id, or null when the row no longer exists.
     * { status: "error" } on DB failure — the caller decides whether the
     * previously minted claim may stand (a DB blip must not log everyone out).
     */
    async lookup(userId) {
      const key = String(userId);
      const at = now();
      const cached = cache.get(key);
      if (cached && at - cached.at < ttl) {
        return { status: "ok", role: cached.role };
      }

      const numericId = Number(userId);
      let row: { role: string } | undefined;
      try {
        if (Number.isInteger(numericId)) {
          [row] = await db
            .select({ role: users.role })
            .from(users)
            .where(eq(users.id, numericId))
            .limit(1);
        }
        // Non-integer ids are malformed claims — treated as a missing row so
        // the session dies instead of silently keeping a stale role.
      } catch (error) {
        console.error("[auth] role revalidation query failed:", error);
        return { status: "error" };
      }

      if (cache.size >= maxEntries) {
        evictExpired(at);
        // Hard bound: if nothing expired, drop the oldest-inserted entry
        // (Map iterates in insertion order) so the cache cannot grow without
        // limit between sweeps.
        for (const oldest of cache.keys()) {
          if (cache.size < maxEntries) break;
          cache.delete(oldest);
        }
      }
      cache.set(key, { role: row?.role ?? null, at });
      return { status: "ok", role: row?.role ?? null };
    },
    invalidate(userId) {
      if (userId === undefined) cache.clear();
      else cache.delete(String(userId));
    },
    sweep() {
      evictExpired(now());
    },
  };
}

const defaultLookup = createRoleLookup();

// Bounded cleanup — mirrors src/lib/infra/rate-limit.ts. unref so the timer
// never keeps a process (or a test runner) alive.
const sweeper = setInterval(() => defaultLookup.sweep(), ROLE_CACHE_TTL_MS);
sweeper.unref?.();

/**
 * Live role for a user id, or null when the row no longer exists.
 * { status: "error" } on DB failure — the caller decides whether the
 * previously minted claim may stand (a DB blip must not log everyone out).
 */
export function lookupUserRole(
  userId: string | number
): Promise<RoleLookupResult> {
  return defaultLookup.lookup(userId);
}

export function invalidateUserRoleCache(userId?: string | number): void {
  defaultLookup.invalidate(userId);
}
