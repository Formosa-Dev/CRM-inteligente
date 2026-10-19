# SDD Tasks: Diferenciación B2B / B2C

## Fase 1: Secciones de Prompt en `prompt-builder.ts`

**Archivo**: `src/lib/whatsapp/prompt-builder.ts`

### Task 1.1 — Agregar sección `[DETECCION DE LINEA]` en DEFAULT_SYSTEM_PROMPT

**Changes**:
- Insertar nueva sección `[DETECCION DE LINEA]` inmediatamente después de `[ROL]` (línea 338)
- Contenido: instrucciones para detectar B2C vs B2B por keywords del primer mensaje
- Si hay ambigüedad (keywords de ambas líneas): preguntar "¿Todo junto o son pedidos separados?"
- B2B si contiene: pan, prepizza, pre-pizza, docena, mayorista, medialuna, pan de lomito, pan de hamburguesa, factura, chipá, chipita, al por mayor
- B2C en cualquier otro caso (default)

### Task 1.2 — Renombrar `[FLUJO]` a `[FLUJO B2C]`

**Changes**:
- Renombrar sección `[FLUJO]` (línea 358) a `[FLUJO B2C]`
- Mantener contenido actual

### Task 1.3 — Agregar sección `[FLUJO B2B]`

**Changes**:
- Insertar después de `[FLUJO B2C]`
- Contenido:
  - Fórmula de tiempo: `getWaitTime("pan_mayorista")`, 10min por pedido B2B
  - Solo retiro: "el pan mayorista es solo retiro por Neuquen 1245. ¿Cuándo pasás?"
  - Alias de pago B2B: el configurado en `aliasB2b`
  - Productos: mostrar menú de pan con `sendMenuImage('pan')`
  - Si preguntan por hamburguesas siendo B2B: "Eso es otro rubro, ¿querés que te pase con lo de hamburguesas?"
  - Docenas como unidad base de venta

### Task 1.4 — Actualizar `[TIEMPO DE DEMORA]` para usar getWaitTime con orderType

**Changes**:
- Modificar sección `[TIEMPO DE DEMORA]` (línea 583) para indicar que use `getWaitTime` con el orderType detectado
- B2C: fórmula actual (hamburguesas pendientes × 7min + 15min delivery)
- B2B: solo contar pedidos B2B pendientes, 10min por pedido

### Task 1.5 — Actualizar `[PAGO — PRECIO ≠ COMPRA]` con alias por línea

**Changes**:
- En la línea 491, donde dice el alias hardcodeado, cambiar para que use el alias según orderType
- Si B2C: alias configurado en aliasB2c
- Si B2B: alias configurado en aliasB2b

---

## Fase 2: Lógica de Detección de Línea en `agent.ts`

**Archivo**: `src/lib/whatsapp/agent.ts`

### Task 2.1 — Agregar función de detección `detectOrderType`

**Changes**:
- Crear función `detectOrderType(messages: Array<{role: string; content: string}>): "hamburguesas" | "pan_mayorista" | "ambiguo"`
- Buscar keywords B2B en el primer mensaje del usuario
- Si encuentra solo keywords B2B → `"pan_mayorista"`
- Si encuentra keywords de AMBAS líneas → `"ambiguo"`
- Si no encuentra keywords B2B → `"hamburguesas"` (default)
- Exportar la función

### Task 2.2 — Inyectar `orderType` en `customerContext`

**Changes**:
- Después de la línea 167 (cierre del bloque de customerContext), detectar orderType del primer mensaje
- Si `orderType === "ambiguo"`: no inyectar, dejar que el agente pregunte
- Si `orderType === "pan_mayorista"` o `"hamburguesas"`: inyectar en customerContext
- Agregar campo `orderType: string | undefined` al tipo `customerContext`
- Pasar al prompt como `🧭 TIPO DE CLIENTE: B2B (pan mayorista)` o `🧭 TIPO DE CLIENTE: B2C (hamburguesas)`

### Task 2.3 — Pasar `orderType` al prompt en `buildSystemPrompt`

**Changes**:
- En `buildSystemPrompt` (prompt-builder.ts líneas 231-332), cuando exista `customerContext.orderType`, agregar línea al context antes de "---"
- Formato: `🧭 TIPO DE CLIENTE: B2B (pan mayorista)` o `🧭 TIPO DE CLIENTE: B2C (hamburguesas)`

---

## Fase 3: `getWaitTimeTool` con Filtro por `orderType`

**Archivo**: `src/lib/whatsapp/tools/extended-tools.ts`

### Task 3.1 — Agregar parámetro opcional `orderType` al inputSchema

**Changes**:
- Cambiar `inputSchema: z.object({})` a `inputSchema: z.object({ orderType: z.enum(["hamburguesas", "pan_mayorista"]).optional() })`

### Task 3.2 — Modificar lógica de cálculo según orderType

**Changes**:
- Si `orderType === "pan_mayorista"`:
  - Filtrar solo pedidos B2B pendientes (orders donde `orderType === "pan_mayorista"` y `status === "pending"`)
  - Calcular: `pedidosB2B.length * 10` (10min por pedido B2B)
  - Mensaje: `"Hay X pedidos de pan antes. A 10 min cada uno, serían Y min aproximadamente"`
- Si `orderType === "hamburguesas"` o sin parámetro:
  - Filtrar solo pedidos B2C pendientes (orders donde `orderType === "hamburguesas"` y `status === "pending"`)
  - Contar hamburguesas: fórmula actual (items × 7min + 15min delivery)
- Esquema de respuesta actualizado para reflejar ambos casos

---

## Fase 4: `suggestProductsTool` con Filtro por `orderType`

**Archivo**: `src/lib/whatsapp/tools/client-tools.ts`

### Task 4.1 — Agregar parámetro opcional `orderType` al inputSchema

**Changes**:
- Cambiar `inputSchema` a: `z.object({ phone: z.string().optional(), orderType: z.enum(["hamburguesas", "pan_mayorista"]).optional() })`

### Task 4.2 — Filtrar sugerencias según orderType

**Changes**:
- Si `orderType === "pan_mayorista"`:
  - Consultar productos de línea `"pan"` disponibles
  - Basado en historial del cliente (si tiene) o populares de pan
  - Retornar: `"Prepizza x Docena, Pan de Lomito x 4u, Chipitas. ¿Querés alguna?"`
  - NO sugerir hamburguesas bajo ningún concepto
- Si `orderType === "hamburguesas"` o sin parámetro: comportamiento actual

---

## Fase 5: Context Injection en `agent.ts`

**Archivo**: `src/lib/whatsapp/agent.ts`

### Task 5.1 — Detectar orderType en el flujo principal

**Changes**:
- Después de construir `customerContext` (línea 167), obtener el primer mensaje del usuario
- Ejecutar `detectOrderType(messages)` 
- Si el resultado no es `"ambiguo"`: asignar `customerContext.orderType = detectedOrderType`

### Task 5.2 — Persistir orderType en el contexto durante toda la conversación

**Changes**:
- El orderType detectado en el primer mensaje DEBE persistir para toda la conversación
- Si la conversación ya tiene un orderType detectado en turnos anteriores, NO redetectar
- (Esto se maneja naturalmente porque customerContext se reconstruye cada turno — si el orderType se deriva del historial de la conversación, se necesitaría almacenarlo en chatMessages o similar; alternativamente, detectar solo la primera vez y cachear)

---

## Fase 6: Seller Prompt Sync

**Archivo**: `src/lib/whatsapp/seller-prompt.ts`

### Task 6.1 — Agregar información de línea al `BASE_SELLER_PROMPT`

**Changes**:
- En la sección `═══ ESTRUCTURA DE LA BASE DE DATOS ═══` (línea 265):
  - Actualizar `orders: id, leadId, phoneNumber, customerName, items, status, deliveryFee, paymentStatus` para incluir `orderType`
- En `getBusinessStatus()` (línea 107):
  - Ya existe `aliasB2c` y `aliasB2b` (líneas 115-116) — OK
  - Ya existe `hamburguesasSinStock` (línea 113) — OK
- En los ejemplos del prompt (líneas 196-227):
  - Todos los ejemplos de `createOrder` usan `orderType:"hamburguesas"` — OK, pero agregar al menos un ejemplo B2B
- Agregar ejemplo B2B:
```
Vendedor: "carga 5 docenas de prepizza para pedro"
Bot: createOrder({customerName:"pedro", items:[{name:"Prepizza x Docena", quantity:5}], orderType:"pan_mayorista"})
→ "Dale. Creado #75 para Pedro — 5x Prepizza x Docena, Total: $48.000. Solo retiro por Neuquen 1245."
```

---

## Fase 7: Verify

- [ ] 7.1 TypeScript compile check
- [ ] 7.2 Revisar que todos los imports estén actualizados
- [ ] 7.3 Verificar que `getWaitTime` con `orderType` no rompa llamadas existentes (parámetro opcional)
- [ ] 7.4 Verificar que `suggestProducts` con `orderType` no rompa llamadas existentes
- [ ] 7.5 Commit y push

## Orden de implementación sugerido

```
1. Task 1.1 — [DETECCION DE LINEA] en DEFAULT_SYSTEM_PROMPT
2. Task 1.2 — Renombrar [FLUJO] → [FLUJO B2C]
3. Task 1.3 — [FLUJO B2B] nueva sección
4. Task 1.4 — [TIEMPO DE DEMORA] actualizado
5. Task 1.5 — [PAGO] alias por línea
6. Task 2.1 — Función detectOrderType
7. Task 2.2 — Inyectar orderType en customerContext
8. Task 2.3 — Pasar orderType al prompt
9. Task 3.1 + 3.2 — getWaitTimeTool con filtro
10. Task 4.1 + 4.2 — suggestProductsTool con filtro
11. Task 5.1 + 5.2 — agent.ts detección + persistencia
12. Task 6.1 — seller-prompt.ts sync
13. Verify (7.1-7.5)
```
