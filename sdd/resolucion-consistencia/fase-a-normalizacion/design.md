# Design Fase A: Función Central normalizePhone()

## Decisión Arquitectónica

| Aspecto | Decisión | Alternativa | Por qué |
|---------|----------|-------------|---------|
| Ubicación | `src/lib/phone-utils.ts` (archivo nuevo) | Meter en `utils.ts` | Separación de concerns, fácil de encontrar |
| Nombre | `normalizePhone()` | `cleanPhone()`, `sanitizePhone()` | Más semántico: "normalizar" ≠ "limpiar" |
| Implementación | `replace(/[^\d]/g, "")` | Regex más compleja | Simple, cubre todos los casos (+, espacios, guiones, paréntesis, puntos) |
| Export | Named exports | Default export | Más explícito, tree-shakeable |
| Manejo de null | No manejar null, el caller debe asegurarse | Manejar null internamente | Principio de responsabilidad única |
| cleanPhone() existente | Delega en normalizePhone() | Reemplazar directamente | No romper imports existentes |

## Diagrama de Flujo

```
phone (string) → normalizePhone() → /[^\d]/g → string con solo dígitos
```

## Dependencias

- Cero dependencias externas
- Cero dependencias del proyecto

## Tests (a nivel conceptual)

```
normalizePhone("+54 9 3704 111111") → "5493704111111"
normalizePhone("+5493704111111")    → "5493704111111"
normalizePhone("11-4123-4567")      → "1141234567"
normalizePhone("+54 (11) 4123-4567") → "541141234567"
normalizePhone("")                   → ""

isValidPhone("5493704111111")   → true
isValidPhone("1141234567")      → false
isValidPhone("")                → false
```
