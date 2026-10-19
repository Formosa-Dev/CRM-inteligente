# Design Fase E: Sincronización del Frontend

## Estrategia

Tres cambios clave:

### 1. `actions.ts` — updateClient: buscar por ID, no por phone

PROBLEMA: `updateClient` actualizaba con `eq(leads.phone, phone)`. Si el teléfono en la URL venía con formato distinto al de la DB, no encontraba el registro.

SOLUCIÓN:
- Normalizar el phone al inicio
- Buscar el lead por su `id` (usando el phone solo para localizarlo inicialmente)
- Actualizar por `id` (más seguro, determinístico)

### 2. `client-edit-form.tsx` — phone disabled

PROBLEMA: El teléfono era editable, creando inconsistencia entre el form state y los datos reales.

SOLUCIÓN:
- Phone field disabled
- Usar `lead.phone` (prop) en lugar de `phone` (state) para `updateClient`

### 3. `[id]/page.tsx` — normalizar params.id

PROBLEMA: `params.id` puede venir con `+` escapado como `%2B` o decodificado. Next.js deserializa `+` como espacio.

SOLUCIÓN:
- `normalizePhone(params.id)` antes de cualquier query
- El teléfono se guarda sin `+`, así que la query matchea

## Flujo Post-Fix

```
URL: /admin/clients/+5493704111111
  → params.id = "+5493704111111" (o "+54 9..." si vino con espacios)
  → normalizePhone("+5493704111111") = "5493704111111"
  → eq(leads.phone, "5493704111111") ← MATCH
```
