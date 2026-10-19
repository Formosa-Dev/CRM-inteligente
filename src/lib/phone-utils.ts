/**
 * Normaliza un número de teléfono a formato canónico NUMÉRICO PURO.
 * Elimina +, espacios, guiones, paréntesis y cualquier caracter no dígito.
 *
 * @example
 *   normalizePhone("+54 9 3704 111111")  // → "5493704111111"
 *   normalizePhone("+5493704111111")     // → "5493704111111"
 *   normalizePhone("11-4123-4567")       // → "1141234567"
 *   normalizePhone("+54 (11) 4123-4567") // → "541141234567"
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

/**
 * Valida que un teléfono normalizado tenga formato argentino válido
 * (empieza con 549 y tiene entre 10 y 13 dígitos).
 *
 * @example
 *   isValidPhone("5493704111111")  // → true
 *   isValidPhone("1141234567")     // → false
 */
export function isValidPhone(phone: string): boolean {
  return /^549\d{7,11}$/.test(phone);
}

/**
 * A value is phone-like only when it is composed of phone punctuation/digits
 * and has a plausible length. Provider IDs such as `waba-2` or `acc-123` are
 * NOT phone-like, so they are never matched by digit suffix.
 */
export function looksLikePhone(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    /^[+\d\s().-]+$/.test(trimmed) &&
    normalizePhone(trimmed).length >= 7
  );
}

/** Compare configured identities using the same canonical digits on both sides. */
export function phoneMatches(a: string, b: string): boolean {
  if (!looksLikePhone(a) || !looksLikePhone(b)) return false;
  const left = normalizePhone(a);
  return left.length > 0 && left === normalizePhone(b);
}

export function phoneInList(phone: string, entries: readonly { phone: string }[]): boolean {
  return entries.some((entry) => phoneMatches(phone, entry.phone));
}
