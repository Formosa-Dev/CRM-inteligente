# Explore Fase D: Normalización en WhatsApp + API REST

## Objetivo

Aplicar `normalizePhone()` en todos los entry points de WhatsApp (captura de leads, agent tools) y API REST de leads.

## Contexto Actual

### WhatsApp Lead Capture (`src/lib/whatsapp/lead-capture.ts`)

```typescript
export async function captureLeadIfNew(phone: string, name: string | null, firstMessage: string) {
  const existing = await db.select({ id: leads.id }).from(leads).where(eq(leads.phone, phone)).limit(1);
  // Si no existe → inserta con phone raw
```

**Problema:** `phone` viene con formato WhatsApp (`+5493704111111`) y se guarda así.

### API REST de Leads (`src/app/api/leads/route.ts`)

```typescript
const CreateLeadSchema = z.object({
  phone: z.string().min(1, "phone is required"),
  // ...
});
```

En línea 69-86:
```typescript
const [lead] = await db.insert(leads).values({
  phone: data.phone,  // ← SIN SANITIZAR
  // ...
});
```

**Problema:** El phone llega como lo mande el frontend o Meta Ads, sin normalizar.

### Webhook de WhatsApp (path pendiente de verificación)

Delegado en proceso para webhooks.

## Archivos Conocidos a Modificar

- `src/lib/whatsapp/lead-capture.ts`
- `src/app/api/leads/route.ts`

## Dependencias

- Depende de la Fase A (`phone-utils.ts`)
- Depende de la Fase B (UNIQUE) — si no hay UNIQUE, sanitizar solo no previene duplicados históricos

## Estrategia

En `lead-capture.ts`:
1. Normalizar `phone` al inicio
2. Buscar con teléfono normalizado
3. Insertar con teléfono normalizado

En `POST /api/leads`:
1. Normalizar `data.phone` después del parseo de Zod
2. Verificar si existe duplicado → si existe, responder con error claro
3. Insertar con teléfono normalizado

## Pendiente

Esperar resultados del delegado para:
- Webhook de WhatsApp (hay dos: `/api/webhook/whatsapp/` y `/api/whatsapp/webhook/`)
- Webhook de Meta
- Tools del agente de WhatsApp (`src/lib/whatsapp/tools/`)
