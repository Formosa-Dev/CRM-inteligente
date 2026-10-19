# Delta Specs: Rediseño Bot de Ventas WhatsApp (Karen V6)

## Dominio: Echo Handler & Human Override

### ADDED: REQ-ECHO-1 — Echo handler NO debe setear human override

El sistema **NO DEBE** setear `humanOverrideUntil` cuando procesa un echo de un mensaje enviado por el propio AI. Solo debe setearlo cuando detecta una respuesta humana genuina (desde WhatsApp Business App).

#### Scenario: Echo de respuesta propia
- GIVEN el AI acaba de enviar "Dale, ya sale" vía YCloud
- WHEN YCloud genera un echo event con type "whatsapp.message.echo"
- THEN el sistema procesa el echo para dedup pero NO actualiza humanOverrideUntil
- AND el AI sigue respondiendo al próximo mensaje del cliente

### ADDED: REQ-ECHO-2 — Echo dedup por platformMessageId

El sistema **DEBE** usar `platformMessageId` (wamid) como mecanismo primario de dedup de echos, no comparación de strings.

#### Scenario: Echo dedup exitoso
- GIVEN el AI envió un mensaje con wamid "wamid-123"
- WHEN YCloud envía echo con msg.id = "wamid-123"
- THEN `isMessageDuplicate("wamid-123")` retorna true
- AND el echo es ignorado sin guardar mensaje duplicado

### REMOVED: REQ-ECHO-3 — Comparación de contenido para dedup

(Reason: Causaba falsos negativos cuando el contenido no coincidía exactamente. Reemplazado por REQ-ECHO-2.)

---

## Dominio: Context Injection

### ADDED: REQ-CTX-1 — Contexto inyectado como system, no user

Todo contexto inyectado (order summary, addresses, tipo de cliente) **DEBE** usar `role: "system"` o integrarse en el system prompt. **NO DEBE** usar `role: "user"`.

#### Scenario: Contexto inyectado correctamente
- GIVEN el buffer procesa mensajes para una conversación activa
- WHEN se inyecta order summary, addresses, o tipo de cliente
- THEN se inyecta como `role: "system"` en aiMessages o se pasa a buildSystemPrompt
- AND el LLM puede distinguir entre input del cliente e instrucciones del sistema

### REMOVED: REQ-CTX-2 — Inyección duplicada en webhook

(Reason: agent.ts ya carga customer context y lo pasa a buildSystemPrompt. La inyección adicional en route.ts:610-637 es redundante y contaminante. Eliminar.)

---

## Dominio: Tool Chain & Order Flow (CRITICAL)

### ADDED: REQ-TOOL-1 — Flujo de órdenes unificado

El sistema **DEBE** proveer un flujo de órdenes donde `createOrder` consuma automáticamente los items de `orderContextItems` (o su reemplazo). El agente **NO DEBE** poder pasar items inventados como parámetros.

#### Scenario: Creación correcta de pedido
- GIVEN el cliente pidió 2x Genesis via addItem
- WHEN el agente llama a createOrder (sin parámetro items)
- THEN createOrder lee los items de orderContextItems/conversation
- AND crea el pedido con los items reales

### MODIFIED: REQ-TOOL-2 — resolveItems() ignora precios del LLM

`resolveItems()` **DEBE** usar SIEMPRE el precio real de la DB cuando encuentra un match de producto. **DEBE** ignorar `item.price` e `item.unitPrice` provenientes del LLM.

#### Scenario: Precio correcto de DB
- GIVEN el LLM pasa `{ name: "Genesis", unitPrice: 999999 }`
- WHEN resolveItems() encuentra el producto en DB con precio 4500
- THEN retorna `{ name: "Genesis", unitPrice: 4500 }` (precio real)
- AND el pedido se crea con el precio correcto

### REMOVED: REQ-TOOL-3 — Tool chaining obligatorio

(Reason: El dueño NO confirma explícitamente. Cuando dice "Dale", el pedido se considera aceptado. No necesita un paso de confirmación separado. addOrderItem → createOrder es suficiente.)

---

## Dominio: Prompt V6 (Estilo Dueño Real)

### ADDED: REQ-PROMPT-V6-1 — System prompt rewrite

El system prompt **DEBE** ser reescrito completamente basado en el análisis de 1378 mensajes reales del dueño (`docs/aprendizaje-chats-dueno.md`). El prompt **DEBE**:
- NO tener estructura de pasos (PASO 1-6)
- NO tener confirmación explícita
- NO pedir nombre, dirección completa, paymentStatus, paymentMethod antes de tiempo
- Enviar menú como imagen SIEMPRE
- Preguntar solo: "¿delivery o buscás?" (una vez)
- Pedir ubi si es delivery
- Decir precio SOLO si preguntan
- Decir alias SOLO si preguntan
- Decir "Ya estaa" cuando esté listo
- Pedir etiquetado en IG al entregar

#### Scenario: Flujo completo como el dueño
- GIVEN el cliente dice "quiero una genesis y una toro"
- WHEN el bot procesa el mensaje
- THEN responde "Dale" y registra los productos
- AND pregunta una vez "¿delivery o buscás?"
- WHEN el cliente dice "delivery"
- THEN pide "me pasas ubi"
- WHEN preguntan precio
- THEN dice el total nomas: "17mil"
- WHEN preguntan alias
- THEN dice "[alias]"
- WHEN el pedido está listo
- THEN dice "Ya estaa" o "Ya salió"

---

## Dominio: Prompt Security

### MODIFIED: REQ-SEC-1 — Sin falsos positivos con backticks

El detector de inyección **NO DEBE** marcar backticks `` ` `` como patrón de inyección. Solo debe detectar patrones claros de jailbreak (ignorar instrucciones, nuevo prompt, etc.).

#### Scenario: Backtick no bloqueado
- GIVEN el cliente envía "las hamburguesas `doble carne` son las mejores"
- WHEN detectInjection() evalúa el mensaje
- THEN retorna detected=false
- AND el mensaje se procesa normalmente
