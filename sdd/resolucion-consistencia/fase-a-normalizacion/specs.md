# Specs Fase A: Función Central de Normalización de Teléfonos

## Archivo a Crear

`src/lib/phone-utils.ts`

## Interfaz

```typescript
/**
 * Normaliza un número de teléfono a formato canónico NUMÉRICO PURO.
 * - Elimina: +, espacios, guiones, paréntesis, cualquier caracter no dígito
 * - NO modifica el prefijo de país (549, 54, etc.)
 * - NO agrega ni saca prefijos
 *
 * @example
 *   normalizePhone("+54 9 3704 111111")  // → "5493704111111"
 *   normalizePhone("+5493704111111")     // → "5493704111111"
 *   normalizePhone("03704 111-111")      // → "03704111111"
 *   normalizePhone("11-4123-4567")       // → "1141234567"
 *   normalizePhone("+54 (11) 4123-4567") // → "541141234567"
 */
export function normalizePhone(phone: string): string;

/**
 * Valida que un teléfono normalizado tenga formato argentino válido.
 * Debe empezar con 549 y tener entre 10 y 13 dígitos en total.
 *
 * @example
 *   isValidPhone("5493704111111")  // → true
 *   isValidPhone("1141234567")     // → false (no empieza con 549)
 */
export function isValidPhone(phone: string): boolean;
```

## Implementación

```typescript
export function normalizePhone(phone: string): string {
  // Saca TODO lo que no sea dígito: +, espacios, guiones, paréntesis, puntos
  return phone.replace(/[^\d]/g, "");
}

export function isValidPhone(phone: string): boolean {
  return /^549\d{7,11}$/.test(phone);
}
```

## Refactor de `order-utils.ts`

```typescript
// CAMBIO: importar desde phone-utils en vez de tenerlo inline
import { normalizePhone, isValidPhone } from "@/lib/phone-utils";

// cleanPhone() se mantiene POR AHORA para no romper imports existentes,
// pero DELEGA en normalizePhone()
export function cleanPhone(phone: string): string {
  return normalizePhone(phone);
}
```

## Criterios de Aceptación

- ✅ `normalizePhone("+54 9 3704 111111")` → `"5493704111111"`
- ✅ `normalizePhone("+5493704111111")` → `"5493704111111"`
- ✅ `normalizePhone("11-4123-4567")` → `"1141234567"`
- ✅ `normalizePhone("")` → `""`
- ✅ `cleanPhone()` delega y produce el mismo resultado que antes
- ✅ `isValidPhone("5493704111111")` → `true`
- ✅ `isValidPhone("1141234567")` → `false`
