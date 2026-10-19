/**
 * Postgres 23505 (unique_violation) — neon-http surfaces it on `code`, but
 * match the message too so wrapped errors still classify correctly.
 */
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "23505") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /23505|duplicate key|unique constraint/i.test(message);
}

/**
 * Parses a ?from=/?to= filter. Invalid dates return null so the param is
 * simply ignored — `new Date("garbage")` inside a Drizzle comparison throws
 * a RangeError that used to surface as a 500.
 */
export function parseDateParam(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
