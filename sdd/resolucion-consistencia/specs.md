# Spec Técnica: Resolución de Consistencia — Mrs Muzzarella

## Diagnóstico Completado (Basado en código real)

He analizado los ~40k líneas del repo. Esto es lo que encontré:

### Archivos Relevantes Identificados

| Archivo | Rol | Problema |
|---------|-----|----------|
| `src/db/schema.ts` | Schema Drizzle | `leads.phone` sin UNIQUE |
| `src/lib/order-utils.ts` | Utilidades | `cleanPhone()` existe pero SOLO lo usan los tools de Telegram |
| `src/lib/client-utils.ts` | Utilidades cliente | NO tiene normalización de teléfono |
| `src/app/(admin)/admin/clients/actions.ts` | Server Actions CRUD | `updateClient()` usa `eq(leads.phone, phone)` sin sanitizar |
| `src/app/(admin)/admin/clients/[id]/page.tsx` | Server Component detalle | Lee `params.id` como teléfono, lo pasa directo a DB |
| `src/app/(admin)/admin/clients/[id]/client-edit-form.tsx` | Formulario edición | Phone EDITABLE — inconsistente |
| `src/app/(admin)/admin/clients/clients-view.tsx` | Lista clientes | Modal inline con phone DISABLED — inconsistente |
| `src/lib/telegram/toolsOrder.ts` | Tools Telegram | `createOrder` y `createDeliveredOrder` usan `cleanPhone()` |
| `src/lib/telegram/toolsClient.ts` | Tools Telegram | `createClient`, `updateClient`, `getClientByPhone` NO sanitizan |
| `src/lib/telegram/toolsManagement.ts` | Tools Telegram | `searchClient`, `getClientDetail` NO sanitizan |
| `src/lib/whatsapp/lead-capture.ts` | Captura WhatsApp | NO sanitiza teléfono |
| `src/app/api/leads/route.ts` | API REST leads | NO sanitiza teléfono |
| `src/app/api/meta/webhook/route.ts` | Webhook Meta Ads | (por verificar) |
| `src/app/api/webhook/whatsapp/route.ts` | Webhook WhatsApp | NO sanitiza teléfono |

---

## Especificación de Cambios

### Problema A: Normalización Universal de Teléfonos (REQUISITO BASE)

**Archivo a crear:** `src/lib/phone-utils.ts`

```typescript
/**
 * Teléfono NUMÉRICO puro. Saca: +, espacios, guiones, paréntesis.
 * El formato canónico es sin +, sin espacios, sin guiones.
 * Ej: "+54 9 3704 111111" → "5493704111111"
 */
export function normalizePhone(phone: string): string;

/**
 * Valida que un teléfono normalizado sea argentino válido (empiece con 549...)
 */
export function isValidPhone(phone: string): boolean;
```

**Archivos a modificar — agregar `normalizePhone()` en TODOS estos entry points:**

1. `src/lib/order-utils.ts` — Refactor `cleanPhone()` para que llame a `normalizePhone()` de `phone-utils.ts`
2. `src/lib/whatsapp/lead-capture.ts` — En `captureLeadIfNew()`, normalizar `phone` ANTES de buscar/insertar
3. `src/app/api/leads/route.ts` — En `POST /api/leads`, normalizar `data.phone` antes de insertar
4. `src/lib/telegram/toolsClient.ts` — En `createClient`, `updateClient`, `getClientByPhone`, normalizar phone
5. `src/lib/telegram/toolsManagement.ts` — En `searchClient`, `getClientDetail`, normalizar query si es numérico
6. `src/lib/telegram/toolsOrder.ts` — Ya usa `cleanPhone()`, refactor para usar `normalizePhone()`

### Problema B: UNIQUE Constraint en `leads.phone`

**Archivo a modificar:** `src/db/schema.ts`

Agregar `.unique()` en `leads.phone`:
```typescript
phone: varchar("phone", { length: 50 }).notNull().unique(),
```

**Archivo a crear:** Migración Drizzle (`drizzle/0002_unique_phone.sql`)

Contenido de la migración:
```sql
-- Primero limpiar duplicados (quedarse con el más reciente por teléfono)
DELETE FROM leads a USING leads b 
WHERE a.id < b.id AND a.phone = b.phone;

-- Luego agregar unique constraint
ALTER TABLE leads ADD CONSTRAINT leads_phone_unique UNIQUE (phone);
```

### Problema C: Desincronización Frontend + Inconsistencia Edit Forms

**Archivos a modificar:**

1. **`src/app/(admin)/admin/clients/[id]/client-edit-form.tsx`:**
   - Hacer el campo phone `disabled` (no editable)
   - En `handleSave()`, pasar `encodeURIComponent(phone)` si se necesita
   - NO pasar phone en el objeto data de `updateClient`

2. **`src/app/(admin)/admin/clients/actions.ts` — `updateClient()`:**
   - Antes de consultar, normalizar el `phone` con `normalizePhone()`
   - El teléfono NO debe ser actualizable desde el form (se pasa como identificador, no como campo a modificar)
   - Mejorar mensajes de error y try/catch

3. **`src/app/(admin)/admin/clients/[id]/page.tsx`:**
   - Normalizar `params.id` con `normalizePhone()` ANTES de consultar la DB
   - Si `lead?.phone` existe, usar ese como fuente de verdad (no el params.id raw)

### Problema D: Flujo Atómico Telegram Bot

**Archivo a modificar:** `src/lib/telegram/toolsOrder.ts`

En `createOrder` y `createDeliveredOrder`:

1. **Normalización obligatoria:** Llamar `normalizePhone()` al recibir el phone
2. **Búsqueda con fallback:** Si no encuentra por teléfono exacto, buscar con `ilike` por número parcial (para casos donde el bot mande `3704...` sin prefijo)
3. **Atomicidad lead→cliente→pedido:**
   - `createOrder`: Actualmente YA busca si existe lead y rechaza si no. Esto es correcto para pedidos nuevos. NO CAMBIAR esta lógica — el flujo correcto es que primero exista un lead.
   - `createDeliveredOrder`: Actualmente YA crea el lead si no existe. Es correcto para backfill. Pero falta normalizar phone.

### Problema E: Captura de Leads desde WhatsApp

**Archivo a modificar:** `src/lib/whatsapp/lead-capture.ts`

En `captureLeadIfNew()`:
1. Normalizar `phone` al inicio
2. Si ya existe un lead con ese teléfono normalizado → no crear duplicado (RETURN isNew: false)
3. Si no existe → crear con teléfono normalizado

### Problema F: API REST de Leads

**Archivo a modificar:** `src/app/api/leads/route.ts`

En `POST /api/leads`:
1. Normalizar `data.phone` con `normalizePhone()` ANTES de insertar
2. Verificar si ya existe un lead con ese teléfono → si existe, actualizar, no duplicar
3. (Opcional) Validar el teléfono y rechazar si no es válido

---

## Orden de Implementación

1. **FASE BASE:** Crear `src/lib/phone-utils.ts` — la función `normalizePhone()` central
2. **FASE DB:** Migración UNIQUE constraint en `leads.phone` (con limpieza de duplicados)
3. **FASE ENTRY POINTS:** Aplicar `normalizePhone()` en todos los entry points (Telegram tools, WhatsApp capture, API leads)
4. **FASE FRONTEND:** Corregir edit forms + actions del frontend
5. **FASE VERIFICACIÓN:** Revisar que ningún punto de entrada permita guardar teléfonos sin sanitizar

---

## Esquema del Flujo de Datos (Post-Fix)

```
ENTRADA (cualquier formato)
  "+54 9 3704 111111"
  "5493704111111"
  "03704 111111"
         │
         ▼
  normalizePhone() ←───── CENTRAL, se llama SIEMPRE
         │
         ▼
  "5493704111111"  ←─── Formato canónico NUMÉRICO puro
         │
         ▼
  DB: leads.phone = "5493704111111"  (UNIQUE)
         │
         ▼
  URL: /admin/clients/5493704111111  (encodeURIComponent seguro)
         │
         ▼
  [id]/page.tsx: normalizePhone(params.id) → query
```
