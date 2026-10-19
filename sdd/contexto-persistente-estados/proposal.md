# Proposal: Persistencia de Contexto en Estados + Fix Doble Respuesta + Echo Humano

## Intent

El bot envía mensajes automáticos de cambio de estado ("🍞 Ya esta tu pedido") que **no incluyen contexto del pedido** y **no siempre se persisten** correctamente en `chat_messages`. Además, cuando el dueño responde desde WhatsApp Business App, sus mensajes **no siempre se capturan como echo** (no se guardan como `human` en DB), lo que deja al AI ciego. Sumado a esto, el AI genera **respuestas duplicadas/inconsistentes** porque el contexto está incompleto.

El caso concreto: Cliente A (+54 3704 ••••••) preguntando por prepizzas — el humano respondió "Sisi ya estan" desde el celular, el AI no lo vio, y contestó dos veces con información contradictoria ("no hay pedido en curso" + "nos vemos mañana").

## Scope

### In Scope

1. **Fix echo de humano**: Asegurar que los mensajes enviados desde WhatsApp Business App (humano) sean capturados como echo e insertados como `role: "human"` en `chat_messages`, con `humanOverrideUntil` correcto. Diagnóstico del edge case donde el echo no se persiste.

2. **Status messages con contexto de pedido**: Los mensajes de cambio de estado (`buildWhatsAppMessage`) deben incluir el ID del pedido y guardarse con `role: "system"` + `contentAttributes` con metadata estructurada para que el AI pueda interpretarlos.

3. **Status messages con wamid**: Los mensajes enviados desde `updateOrderStatus()` (via `sendText()`) no guardan `platformMessageId`. El echo handler los trata como mensajes del AI (busca el `platformMessageId` y no lo encuentra), pero como no se puede verificar si son propios, el dedup no funciona bien. Fix: guardar `platformMessageId` también en esos mensajes.

4. **Prevención de respuesta AI durante interacción humana**: Si el humano está respondiendo activamente (múltiples echos en ventana corta), el buffer debe abortar procesamiento incluso si el lock ya se adquirió.

### Out of Scope

- Mejora del prompt del AI para manejo de contexto (eso es otro cambio)
- Refactor de `sendWhatsAppBubbles()` o `splitIntoBubbles()`
- Cambios en la estructura de la tabla `chat_messages` (schema)
- Mejora del anti-loop system
- UI del admin panel

## Approach

### Fix 1: Echo Humano Robusto

**Problema**: El echo del humano a veces no se persiste. Posibles causas:
- El callback del buffer se ejecuta ANTES de que llegue el echo (race condition)
- El echo llega pero pasa dedup porque el contenido coincide con un mensaje assistant reciente
- El echo payload tiene estructura inesperada (no se extrae el mensaje)

**Fix**:
1. En `handleEcho()`, eliminar el dedup temporal de 30s para mensajes del humano (solo aplicarlo a echos propios del AI)
2. Agregar un log structured con el payload completo cuando el extract falla, para diagnosticar
3. En el callback del buffer, después de chequear `humanOverride` (que se setea en el echo), también verificar si hay mensajes `human` en los últimos 60 segundos y abortar si es así

### Fix 2: Status Messages con Contexto

**Problema**: `buildWhatsAppMessage()` genera texto genérico sin ID de pedido. `insertMessage()` los guarda como assistant sin metadata.

**Fix**:
1. Modificar `buildWhatsAppMessage()` para incluir el ID del pedido: `"🍞 Pedido #123 — Ya esta tu pedido de pan, retiralo por Neuquen 1245."`
2. Guardar el mensaje con `role: "system"` (no "assistant") para que el AI sepa que es una notificación, no una respuesta del bot
3. Pasarlo como `system` al build del historial de AI, no como assistant

### Fix 3: wamid en Status Messages

**Problema**: `sendText()` no devuelve el `wamid` (message ID), entonces `insertMessage()` guarda sin `platformMessageId`. El echo handler no puede hacer dedup.

**Fix**:
1. Modificar `sendText()` o la llamada en `updateOrderStatus()` para capturar el `id` de la respuesta de YCloud
2. Pasar ese `id` como `platformMessageId` a `insertMessage()`

### Fix 4: Buffer Abort por Actividad Humana

**Problema**: Si el humano responde durante la ventana de buffer (3s de debounce), el echo puede llegar después de que el buffer ya disparó el AI.

**Fix**:
1. Agregar un chequeo en el callback del buffer: si hay mensajes `human` en los últimos 60 segundos, abortar
2. Además, en el buffer processor, si durante el debounce se detecta `humanOverride` en la conversación, cancelar el procesamiento

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/app/api/whatsapp/webhook/route.ts` | Modify | handleEcho() dedup fix + buffer callback abort check |
| `src/app/(admin)/admin/orders/actions.ts` | Modify | buildWhatsAppMessage() con order ID + wamid capture |
| `src/lib/ycloud.ts` | Modify | sendText() devuelve wamid en el resultado |
| `src/lib/buffer/processor.ts` | Modify | Abort si hay actividad humana reciente |
| `src/lib/channels/router.ts` | Minor | insertMessage() acepta platformMessageId (ya lo hace, verificar) |
| `src/lib/whatsapp/agent.ts` | Minor | Contexto carga system messages como contexto adicional |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Fix de echo introduce falsos positivos (mensajes del AI no dedup) | Medium | Solo eliminar dedup de 30s para HUMANOS, mantener para assistants |
| `sendText()` cambiar firma rompe otros callers | Low | Audit trail de todos los callers de sendText() antes de cambiar |
| Human override abort muy agresivo corta respuestas legítimas | Low | Solo abortar si hay human message en últimos 60s Y no hay user message después |

## Rollback Plan

1. Revertir cambios en `actions.ts` (vuelve a mensajes sin order ID)
2. Revertir cambios en `webhook/route.ts` (vuelve a dedup original)
3. Revertir cambios en `ycloud.ts` si se cambió
4. Si no se puede revertir parcialmente, revertir commit completo

## Dependencies

- YCloud API debe devolver `id` en la respuesta de sendText (ya lo hace, solo no lo capturamos)
- El echo de WhatsApp Business App debe llegar como `whatsapp.message.echo` (ya funciona, solo hay edge cases)

## Success Criteria

- [ ] Mensajes del humano (WhatsApp Business App) aparecen como `role: "human"` en `chat_messages` consistentemente
- [ ] Mensajes de cambio de estado incluyen ID de pedido y se guardan como `role: "system"`
- [ ] `sendText()` captura el `wamid` y lo persiste
- [ ] AI no responde si el humano respondió en los últimos 60 segundos
- [ ] AI usa los mensajes `system` de notificaciones como contexto
- [ ] El caso del Cliente A no se repite: AI no contesta "no hay pedido en curso" cuando el humano acaba de coordinar la entrega
