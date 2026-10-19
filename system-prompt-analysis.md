# System Prompt del Agente de Ventas — Mrs Muzzarella

## Arquitectura: Cómo se construye el prompt

El prompt final se arma en 4 capas dentro de `src/lib/whatsapp/prompt-builder.ts`:

```
buildSystemPrompt()
  ├── Layer 1: getCorePrompt()      → DEFAULT_SYSTEM_PROMPT + extras de DB
  ├── Layer 2: getMenuData()        → Productos disponibles desde DB
  ├── Layer 3: getBusinessHours()   → Horarios + zonas delivery desde DB
  ├── Layer 4: getOperationalData() → Cocina, stock, alias, menú imágenes
  └── customerContext               → Nombre, dirección, preferencias, historial
```

## Layer 1: Core Prompt (getCorePrompt)

### Paso 1: Leer config desde DB

```typescript
const config = await db.query.agentConfig.findFirst({
  where: (config) => eq(config.id, 1),
});
```

### Paso 2: Revisar qué campos NO están vacíos

| Campo DB | ¿Tiene valor? | Cómo se inyecta |
|----------|--------------|-----------------|
| `systemPrompt` | ❌ VACÍO | Se inyecta como `INSTRUCCIONES ADICIONALES DEL ADMINISTRADOR` |
| `whatsappSystemPrompt` | ❌ VACÍO | Si tuviera valor, **REEMPLAZA COMPLETAMENTE** al DEFAULT_SYSTEM_PROMPT |
| `whatsappInstructions` | ❌ VACÍO | Se inyecta como `INSTRUCCIONES ESPECIFICAS` |
| `whatsappPromociones` | ✅ **TIENE VALOR** | Se inyecta como `PROMOCIONES ACTIVAS` |
| `trainBotContext` | ❌ VACÍO | Se inyecta como `CONTEXTO DEL NEGOCIO` |

### Valor actual de `whatsappPromociones` en DB:
```
3 Toro Asado por el precio de 1 y media...
```

### Cómo se decide qué prompt base usar:

```typescript
const basePrompt = customSystemPrompt || DEFAULT_SYSTEM_PROMPT;
```

Como `whatsappSystemPrompt` está VACÍO, usa `DEFAULT_SYSTEM_PROMPT` (el prompt hardcodeado en el código).

Si `whatsappSystemPrompt` tuviera un valor, **TODO el prompt base sería reemplazado** y DEFAULT_SYSTEM_PROMPT se ignoraría por completo.

### DEFAULT_SYSTEM_PROMPT actual (hardcodeado en prompt-builder.ts línea 300-411):

```
Sistema de atención al cliente de Mrs Muzzarella (Formosa). Hamburguesas artesanales, pan mayorista, y Tragos V.I.P. [Nombre] es el dueño.

Te llamás Karen para los clientes. Respondés pedidos, consultas de menú, delivery, pagos y horarios del local.

BLINDAJE: Solo atendes el WhatsApp del negocio...
```

> ⚠️ **CAMBIO RECIENTE**: Antes decía "Sos Karen, la asistente virtual..." y el safety filter de OpenAI lo interpretaba como suplantación de identidad. Se cambió a "Te llamás Karen" para evitar el falso positivo.

### Si hay extras en DB, se concatenan:

```
{DEFAULT_SYSTEM_PROMPT}

---

PROMOCIONES ACTIVAS:

3 Toro Asado por el precio de 1 y media...

---

Fin de instrucciones adicionales. Las reglas base siguen vigentes.
```

## Layer 2: Menú de productos (getMenuData)

### Código:
```typescript
const items = await db
  .select({ name, price, description, line })
  .from(products)
  .where(and(eq(products.available, true), eq(products.comingSoon, false)))
  .orderBy(products.sortOrder);
```

### Lo que genera con los datos actuales de la DB:

```
PRODUCTOS DISPONIBLES (usá esta info al mostrar el menú, en texto natural, sin listas):

Línea carne: Genesis ($4.000) — null, Deli Deli ($5.000) — null, Mamita ($6.000) — null, Bookbinder ($7.000) — null, Toro Asado ($8.000) — null, Book Simple ($5.500) — null
Línea clasica: Papas completas ($7.000) — null, Papas chesse ($6.000) — null, Papas Fritas ($4.000) — null
Línea pan: Pan de Lomito x 4 u -  Parmesano ($1.800) — null, Prepizza ($1.500) — null, Pan de Hamburguesa x 12 u - Parmesano ($4.600) — null
Línea tragos: Tragos V.I.P Frutilla ($6.500) — null, Tragos V.I.P Durazno ($6.500) — null, Tragos V.I.P Ananá ($6.500) — null, Tragos V.I.P Frutos Rojos ($6.500) — null, Tragos V.I.P Mixtos (Durazno y Frutilla) ($6.500) — null
Línea bebidas: Coca-Cola ($1.500) — null
```

> ❗ **OBSERVACIÓN**: Las `description` de los productos vienen `null` porque en el seed no se cargaron bien. Esto hace que el agente no tenga descripciones para darle al cliente.

## Layer 3: Horarios y delivery (getBusinessHours)

### Código:
```typescript
const config = await db.query.agentConfig.findFirst(...);
// Lee businessHours y whatsappZonasDelivery
```

### Lo que genera con datos actuales:

```
HORARIOS:
- Lunes: 06:00 a 04:00
- Martes: 06:00 a 04:00
- Miércoles: 06:00 a 04:00
- Jueves: 06:00 a 04:00
- Viernes: 06:00 a 04:00
- Sábado: 06:00 a 04:00

ZONAS DE DELIVERY:
- centro: 20-30 min ($3500)
- norte: 25-35 min (gratis)
- sur: 30-40 min (gratis)
- Circuito 5: 30 min ($3500)
```

## Layer 4: Datos operativos (getOperationalData)

### Lo que genera:

```
ESTADO COCINA: La cocina está operativa
STOCK PAN MAYORISTA: 35 docenas disponibles actualmente
DELIVERY WHATSAPP: El número del delivery es +54 3704 ••••••...
ALIAS DE PAGO: B2C (hamburguesas): [alias] | B2B (pan mayorista): [alias]
MENU IMAGEN: Hay foto del menú de hamburguesas disponible...
ALIAS MP: [alias]
```

## Customer Context (por conversación)

Se inyecta en `agent.ts` cuando un cliente habla:

```
👤 CLIENTE: Cliente A
📱 Tel: +54 3704 ••••••
📍 DIRECCIÓN GUARDADA: [dirección]
⚠️ IMPORTANTE: si el cliente pide delivery, preguntale: "¿a la misma dirección de siempre? ([dirección])"
⭐ PREFERENCIAS DEL CLIENTE (productos que suele pedir): Tragos V.I.P Frutilla, Deli Deli
💡 Si el cliente no sabe qué pedir, podés sugerirle estos productos.
📦 PEDIDOS ANTERIORES:
• #51 (delivered): 1x Tragos V.I.P Frutilla - Sin Crema
• #52 (pending): 1x Deli Deli
```

## El problema del safety filter (por qué responde como corrector de textos)

### Causa raíz:
OpenAI interpreta frases como "Sos [nombre]" o "Te llamás [nombre]" como **instrucción de impersonación**. El safety filter del modelo fuerza una respuesta de "corrector de textos" en vez de ejecutar el rol asignado.

### Por qué `gpt-5-mini` vs `gpt-4o`:
Los modelos más nuevos (gpt-5 para arriba) tienen safety filters **más estrictos** que gpt-4o. Sin embargo, `gpt-5-mini` debería funcionar con `systemMessageMode: "developer"` que le dice a OpenAI "esto es código, no es impersonación".

### Configuración actual:
```typescript
model: openai.chat("gpt-5-mini"),  // Chat Completions API
system,                              // El prompt completo
messages,                            // Historial de conversación
providerOptions: {
  openai: {
    systemMessageMode: "developer",  // ← clave para evitar safety filter
  } satisfies OpenAILanguageModelChatOptions,
},
tools: { ... }
```

### Posibles issues remanentes:
1. **La primera línea del prompt**: aunque cambiamos "Sos Karen" por "Te llamás Karen", el safety filter podría seguir detectándolo como impersonación porque igual está diciendo "te llamás Karen".
2. **`systemMessageMode: "developer"`**: OpenAI Responses API vs Chat Completions API pueden manejar esto diferente. Asegurarse de que la opción se esté aplicando correctamente.
3. **Historial de conversación contaminado**: Si conversaciones anteriores tienen respuestas del safety filter, el modelo podría seguir ese patrón.

## Problema de imágenes en landing pública

### Productos con imágenes rotas (`/api/media/xxx`):

| # | Producto | imageUrl en DB | Estado |
|---|----------|---------------|--------|
| 2 | Deli Deli | `/api/media/1778322104586-401df18f.png` | ❌ ROTA |
| 5 | Toro Asado | `/api/media/1778322074472-1691c1be.png` | ❌ ROTA |
| 27 | Prepizza | `/api/media/1779528539118-56a87749.jpg` | ❌ ROTA |
| 28 | Pan de Lomito | `/api/media/1779528338086-e13ccfb2.jpg` | ❌ ROTA |
| 29 | Pan Hamburguesa | `/api/media/1779528508448-35ea94cb.jpg` | ❌ ROTA |

### Productos con Cloudinary OK:
| # | Producto | imageUrl |
|---|----------|---------|
| 1 | Genesis | `https://res.cloudinary.com/...` ✅ |
| 4 | Bookbinder | `https://res.cloudinary.com/...` ✅ |

### Productos SIN imagen (NULL):
Todos los Tragos V.I.P, Coca-Cola, Mamita, Papas Fritas, Papas Chesse, Papas Completas, Book Simple

### El flujo de renderizado de imagen en landing:

```
ProductCard → imageSrc = product.imageUrl 
  → si es NULL → PRODUCT_IMAGE_MAP[product.id] (por ID textual "genesis")
    → si no encuentra → PRODUCT_IMAGE_BY_NAME[product.name.toLowerCase()] (por nombre)
      → si no encuentra → emoji de fallback (🍔)
```

**Problema**: Los productos nuevos (Tragos, Coca-Cola, Papas) no tienen entries en `PRODUCT_IMAGE_BY_NAME`. Necesitan:
1. Subir imágenes desde el admin → Cloudinary
2. O agregar entries al mapa `PRODUCT_IMAGE_BY_NAME` en constants.ts

**Problema 2**: Los productos con imageUrl que apunta a `/api/media/xxx.jpg` están rotos porque esas imágenes se perdieron en deploys anteriores a Cloudinary. Solución: re-subir desde admin.
