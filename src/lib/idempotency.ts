// In-memory idempotency: key -> timestamp
// TTL: 5 minutes
const idempotencyCache = new Map<string, number>();
const TTL = 5 * 60 * 1000; // 5 min

export function checkIdempotency(key: string): boolean {
  const timestamp = idempotencyCache.get(key);
  if (!timestamp) return false;
  
  // Check if expired
  if (Date.now() - timestamp > TTL) {
    idempotencyCache.delete(key);
    return false;
  }
  
  return true; // duplicate
}

export function setIdempotency(key: string): void {
  idempotencyCache.set(key, Date.now());
  
  // Cleanup expired entries periodically
  if (idempotencyCache.size > 1000) {
    cleanupExpired();
  }
}

function cleanupExpired(): void {
  const now = Date.now();
  for (const [key, timestamp] of idempotencyCache) {
    if (now - timestamp > TTL) {
      idempotencyCache.delete(key);
    }
  }
}

/**
 * Clave de dedup por update de Telegram. `update_id` es único por bot para
 * cada update entregado — antes se usaba `message.date` (Unix en SEGUNDOS):
 * dos mensajes distintos del mismo operador dentro del mismo segundo
 * colisionaban y el segundo se acusaba `duplicate:true` y se perdía.
 */
export function createIdempotencyKey(updateId: number | string): string {
  return `tg_update_${updateId}`;
}