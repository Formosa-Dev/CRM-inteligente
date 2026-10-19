# Design: Rediseño Bot de Ventas WhatsApp (Karen V6)

## IMPORTANTE: Aprendizaje de Chats Reales

Este diseño se basa en el análisis de **1378 mensajes de 57 clientes reales** en los últimos 3 días de producción. El dueño responde personalmente TODOS los mensajes. El documento completo está en `docs/aprendizaje-chats-dueno.md`.

**Hallazgo crítico**: El dueño NO sigue ningún proceso estructurado. NO confirma explícitamente. NO pide datos formales. Solo dice "Dale" y cocina. El bot actual intenta forzar un proceso de ventas que NO existe en la realidad. El rediseño debe IMITAR al dueño, no reemplazarlo con un proceso "correcto".

## Technical Approach

Basado en los chats reales, el enfoque cambia radicalmente:

1. **ELIMINAR toda la estructura de pasos** (PASO 1-6). El dueño no sigue pasos.
2. **ELIMINAR la confirmación explícita**. El dueño nunca confirma — solo dice "Dale".
3. **SIMPLIFICAR a 3 acciones**: (a) Tomar pedido, (b) Preguntar delivery/retiro, (c) Decir "Ya está".
4. **Mínima fricción**: menos preguntas = más ventas.
5. **Fix críticos**: echo handler, context injection, precios inventados.

Los cambios se agrupan en 4 capas: (1) Echo Handler + dedup, (2) Context Injection, (3) Prompt simplificado (estilo dueño), (4) Tool consolidation.

## Architecture Decisions

### Decision: ELIMINAR orderContextItems y state machine

**Choice**: NO agregar `conversations.step`. NO usar `orders.draft`. Simplificar: el prompt es lo único que necesita el bot. Si el prompt imita al dueño correctamente, no necesita estructura adicional.
**Alternatives**: State machine en DB, orders.draft, paso a paso.
**Rationale**: El dueño NO tiene estado. No sigue pasos. No confirma. La estructura actual (PASO 1-6) es lo que ROMPE al bot. Los chats reales muestran que el dueño simplemente escucha y responde. Menos estructura = más natural.

### Decision: createOrder NO acepta items[] del LLM

**Choice**: createOrder solo guarda lo que recibe. El fix NO es evitar que el LLM pase items — el fix es que el prompt ya no le diga que cree el pedido en PASO 1.
**Alternatives**: Leer de orderContextItems. Que createOrder valide contra DB.
**Rationale**: Si el prompt se simplifica a estilo dueño, el LLM ya no va a inventar pedidos porque no va a estar presionado a "crear el pedido en PASO 1". El dueño primero ESCUCHA, después procesa. El bot debe hacer lo mismo.

### Decision: Echo handler filtra por remitente, no por contenido

**Choice**: handleEcho solo setea humanOverride si detecta que el remitente del echo NO ES el bot. Si el remitente es el bot → no override.
**Alternatives**: Eliminar handleEcho.
**Rationale**: Este es el bug #5 del audit (CRITICAL). Los 25 human override activos en producción probablemente son por este bug. Fix inmediato.

### Decision: NO consolidar tools por ahora

**Choice**: Dejar las 24+ tools pero corregir sus DESCRIPCIONES y nombres. La consolidación puede venir después.
**Alternatives**: Consolidar a 18 tools.
**Rationale**: Los bugs reales son de prompt y flujo, no de cantidad de tools. Consolidar ahora agrega riesgo sin beneficio claro. Priorizar fixes que impactan clientes reales.

```
Webhook POST (YCloud)
    │
    ├── type=echo → handleEcho()
    │   ├── Buscar mensaje original por wamid en chatMessages
    │   ├── Si el remitente es el bot → NO setear humanOverride
    │   └── Si el remitente NO es el bot → setear humanOverride 24h
    │
    └── type=inbound → procesar mensaje
        │
        ├── isMessageDuplicate (wamid) → skip si duplicado
        ├── Guardar en chatMessages con role:"user"
        ├── Actualizar conversations.step según contenido
        ├── BufferManager.enqueue (debounce 20s → reducido a 10s)
        │
        └── Buffer firea → aiMessages sin contexto como "user"
            ├── buildSystemPrompt() incluye customerContext + step
            ├── NO inyectar orderContext ni addresses como role:"user"
            ├── runWhatsAppAgent() con state machine
            └── Response → YCloud → guardar wamid en chatMessage
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/app/api/whatsapp/webhook/route.ts` | Modify | Echo handler: NO setear override para echos propios (líneas 162-170) |
| `src/app/api/whatsapp/webhook/route.ts` | Modify | Eliminar inyección de contexto como user (líneas 609-637) |
| `src/lib/whatsapp/prompt-builder.ts` | **Major rework** | Reescribir prompt completo estilo dueño. Eliminar PASO 1-6. Eliminar menu data. Agregar estilo dueño real. |
| `src/lib/whatsapp/agent.ts` | Modify | Eliminar detectEmotionalTrigger, eliminar dead-end recovery. Simplificar. |
| `src/lib/whatsapp/tools/create-order.ts` | Modify | Fix resolveItems() para ignorar precios del LLM |
| `src/lib/whatsapp/tools/order-context-tools.ts` | Modify | Unificar flujo: addOrderItem ya no necesita confirmOrder |
| `src/lib/whatsapp/tools/prompt-security.ts` | Modify | Eliminar backtick patterns (falsos positivos) |
| `src/lib/whatsapp/conversation.ts` | Delete | Legacy muerto |
| `src/lib/order-utils.ts` | Modify | resolveItems() IGNORA item.price y item.unitPrice |
| `src/lib/buffer/config.ts` | Modify | debounceMs 20000→10000 |
| `src/lib/channels/router.ts` | Modify | handleEcho: no setear override si msg es del bot |
| `src/lib/addresses.ts` | Modify | Eliminar instrucción embebida en formatAddressesForPrompt |

## Interfaces / Contracts

```typescript
// PROMPT V6 - Basado en chats reales del dueño
// NO tiene estructura de pasos. NO tiene confirmación explícita.
// Estilo: dueño directo, 1 línea, responde mientras cocina.
const PROMPT_V6 = `[ROL]
Te llamás [nombre del dueño], atendés el WhatsApp de Mrs Muzzarella.
Vendés hamburguesas, pan mayorista, tragos.

[ESTILO (IMPORTANTE - basado en cómo respondo YO)]
- Mensajes de 1 línea. Máximo 2.
- "Dale", "Sii", "Nop", "Dalee"
- Voseo natural: "querés", "che", "pasá", "dame"
- Sin "por favor", sin "disculpá", sin "estimado"
- Si preguntan precio -> decí el número nomas: "17mil"
- Si preguntan menú -> "te mandé la foto" y ejecutá sendMenuImage
- Si preguntan dirección -> "Neuquen 1245"
- Si preguntan alias -> "[alias]"

[FLUJO (no es lineal - pasa por todos en paralelo)]
1. Cliente dice qué quiere -> "Dale" + registrá en addOrderItem
2. Preguntá una vez: "¿delivery o buscás?"
   - Si delivery -> "me pasas ubi"
   - Si retiro -> "pasá por Neuquen 1245"
3. Precio: solo si preguntan
4. Alias: solo si preguntan
5. Cuando esté listo -> "Ya estaa" o "Ya salió"
6. Al entregar -> "Me etiquetas en ig porfa"

[SIN STOCK]
- "Nop" + "¿querés la hamburguesa igual?"
- Si el cliente se queja -> ofrecé valor extra

[REGLAS]
- NO preguntes nombre (ya está en el perfil de WhatsApp)
- NO preguntes dirección completa (solo "me pasas ubi")
- NO confirmes el pedido (es implícito cuando decís "Dale")
- NO des precio antes de que pregunten
- NO expliques el menú a menos que pregunten algo específico
- SIEMPRE pedí etiquetado en IG al entregar
- Si no tenés algo -> decí "sin stock" + alternativa`;

// MODIFICADO: resolveItems IGNORA precios del LLM
function resolveItem(item: { name: string; quantity: number; unitPrice?: number }): ResolvedItem {
  const match = findInDB(item.name);
  if (match) {
    // SIEMPRE usar precio real de la DB. Ignorar lo que venga del LLM.
    return { name: match.name, quantity: item.quantity, unitPrice: Number(match.price) };
  }
  // Si no hay match en DB, precio = 0 (el pedido igual se puede crear, el admin lo corrige)
  return { name: item.name, quantity: item.quantity, unitPrice: 0 };
}
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | resolveItems() ignora precios LLM | Test con precio inventado → verificar que usa DB price |
| Unit | handleEcho no setea override | Mock YCloud echo → verificar humanOverride no cambia |
| Unit | Conversation step progression | Simular mensajes → verificar step cambia correctamente |
| Integration | createOrder sin items[] | Llamar createOrder → verifica que lee de context |
| E2E | Flujo completo orden | Cliente → addItem → confirm → createOrder → verificar DB |

## Migration / Rollout

1. **Commit 1** (CRITICAL): Fix echo handler — no setear humanOverride para echos propios
2. **Commit 2** (CRITICAL): Fix resolveItems() — ignorar precios del LLM
3. **Commit 3** (HIGH): Nuevo prompt V6 (estilo dueño) — reemplazar DEFAULT_SYSTEM_PROMPT
4. **Commit 4** (HIGH): Eliminar inyección de contexto como user + legacy conversation.ts
5. **Commit 5** (MEDIUM): Fix prompt-security (backticks) + address format
6. **Commit 6** (MEDIUM): Reducir buffer debounce 20s→10s

Cada commit es autónomo y reversible.

## Open Questions

- [ ] Ninguna — los chats reales del dueño definen TODO el comportamiento. No hay preguntas abiertas.
