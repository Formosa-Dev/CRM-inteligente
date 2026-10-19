# Delta Specs: Diferenciación B2B / B2C

## Dominio: Detección de Línea de Negocio

### ADDED: REQ-DETECT-1 — Detección automática de línea al inicio

El sistema **DEBE** detectar si el cliente es B2C (hamburguesas/tragos/rotisería) o B2B (pan mayorista/docenas) basado en keywords del primer mensaje del cliente. **DEBE** inyectar el `orderType` detectado en el contexto del agente.

La detección **DEBE** usar estas reglas:
- B2B si el mensaje contiene: "pan", "prepizza", "pre-pizza", "docena", "docenas", "mayorista", "medialuna", "pan de lomito", "pan de hamburguesa", "factura", "chipá", "chipita", "pan para hamburguesa", "al por mayor", "docenas de"
- B2C en cualquier otro caso (default)
- Si hay AMBIGÜEDAD ("hamburguesas y pan") el agente **DEBE** preguntar: "¿Todo junto o son pedidos separados?"

#### Scenario: Cliente B2B detectado por keyword
- GIVEN un cliente nuevo envía "Hola, querés 10 docenas de prepizza"
- WHEN el sistema procesa el mensaje entrante
- THEN detecta keyword "docenas" + "prepizza"
- AND asigna `orderType = "pan_mayorista"` al contexto del agente
- AND el agente responde con flujo B2B

#### Scenario: Cliente B2C default
- GIVEN un cliente nuevo envía "Holaa, querés una bookbinder"
- WHEN el sistema procesa el mensaje entrante
- THEN NO detecta keywords B2B
- AND asigna `orderType = "hamburguesas"` (default)
- AND el agente responde con flujo B2C

#### Scenario: Ambigüedad resuelta
- GIVEN un cliente envía "dame 2 bookbinder y 5 docenas de prepizza"
- WHEN el sistema detecta keywords de AMBAS líneas
- THEN el agente pregunta "¿Todo junto o son pedidos separados?"
- AND NO inicia flujo automático hasta recibir respuesta

---

## Dominio: Flujo B2C (Hamburguesas / Rotisería)

### ADDED: REQ-B2C-1 — Delivery disponible siempre para B2C

El sistema **DEBE** ofrecer delivery como opción para clientes B2C cuando delivery esté activo en la configuración. **DEBE** preguntar "¿delivery o buscás?" UNA VEZ.

#### Scenario: Delivery ofrecido en B2C
- GIVEN un cliente B2C con items en carrito
- WHEN aún no se preguntó delivery/retiro
- THEN el agente pregunta "¿delivery o buscás?"
- AND SI delivery activo en config, delivery es opción válida
- AND SI delivery NO activo, el agente dice solo "pasá por Neuquen 1245"

### ADDED: REQ-B2C-2 — Pago con alias B2C

Cuando un cliente B2C pregunta por alias de pago, el sistema **DEBE** usar el alias configurado en `agentConfig.aliasB2c`.

#### Scenario: Alias B2C devuelto
- GIVEN el cliente B2C pregunta "pasame para pagar"
- WHEN el agente ejecuta getPaymentAlias o responde directamente
- THEN usa el alias almacenado en `agentConfig.aliasB2c` (ej: "[alias]")
- AND NO usa `agentConfig.aliasB2b`

---

## Dominio: Flujo B2B (Pan Mayorista)

### ADDED: REQ-B2B-1 — Solo retiro para B2B

El sistema **DEBE** informar a clientes B2B que el pan mayorista es SOLO retiro en el local. **NO DEBE** ofrecer delivery para pedidos B2B.

#### Scenario: Retiro forzado en B2B
- GIVEN un cliente B2B con items de pan en carrito
- WHEN el agente va a preguntar delivery/retiro
- THEN el agente dice "el pan mayorista es solo retiro por Neuquen 1245. ¿Cuándo pasás?"
- AND NO ofrece delivery como opción

### ADDED: REQ-B2B-2 — Pago con alias B2B

Cuando un cliente B2B pregunta por alias de pago, el sistema **DEBE** usar el alias configurado en `agentConfig.aliasB2b`.

#### Scenario: Alias B2B devuelto
- GIVEN el cliente B2B pregunta "dónde te transfiero"
- WHEN el agente responde con alias
- THEN usa el alias almacenado en `agentConfig.aliasB2b`
- AND NO usa `agentConfig.aliasB2c`

---

## Dominio: Tools con Filtro por Línea

### MODIFIED: REQ-TOOL-WAIT-1 — getWaitTime acepta orderType

`getWaitTimeTool` **DEBE** aceptar un parámetro opcional `orderType: "hamburguesas" | "pan_mayorista"`. **DEBE** calcular distinto según el tipo:
- B2C: fórmula actual (hamburguesas pendientes × 7min + 15min delivery)
- B2B: solo contar pedidos B2B pendientes, tiempo fijo de 10min por pedido B2B (armado de cajas)

#### Scenario: Tiempo B2B
- GIVEN hay 3 pedidos B2B y 5 pedidos B2C pendientes
- WHEN el agente llama `getWaitTime("pan_mayorista")`
- THEN calcula solo los 3 pedidos B2B: 3 × 10min = 30min
- AND retorna "Hay 3 pedidos de pan antes. A 10 min cada uno, serían 30 min aproximadamente"

#### Scenario: Tiempo B2C (sin cambios)
- GIVEN hay 3 pedidos B2B y 5 pedidos B2C pendientes
- WHEN el agente llama `getWaitTime("hamburguesas")`
- THEN calcula solo hamburguesas: cuenta items de pedidos B2C pendientes × 7min + 15min

### MODIFIED: REQ-TOOL-SUGGEST-1 — suggestProducts filtra por línea

`suggestProductsTool` **DEBE** aceptar un parámetro opcional `orderType`. **DEBE**:
- Si `orderType = "pan_mayorista"`: sugerir productos de línea "pan" basados en historial B2B o populares de pan
- Si `orderType = "hamburguesas"` o sin parámetro: comportamiento actual (hamburguesas)

#### Scenario: Sugerencia B2B
- GIVEN un cliente B2B sin historial
- WHEN el agente llama `suggestProducts("pan_mayorista")`
- THEN retorna sugerencias de la línea "pan": "Prepizza x Docena, Pan de Lomito x 4u, Chipitas. ¿Querés alguna?"
- AND NO sugiere hamburguesas

### ADDED: REQ-TOOL-TIEMPO-1 — Tiempo de espera configurable por línea

La sección `[TIEMPO DE DEMORA]` en el prompt **DEBE** usar `getWaitTime(orderType)` para responder. El mensaje hardcodeado "30-40 min" del placeholder `{{TIEMPO_ESPERA}}` **DEBE** aplicarse solo a B2C.

---

## Dominio: Prompt — Secciones Separadas

### ADDED: REQ-PROMPT-B2B-1 — Nueva sección [FLUJO B2B]

El system prompt **DEBE** incluir una sección `[FLUJO B2B]` que defina:
- Fórmula de tiempo: getWaitTime("pan_mayorista"), 10min por pedido B2B
- Solo retiro: "el pan mayorista es solo retiro"
- Alias de pago B2B: el configurado en aliasB2b
- Productos: mostrar menú de pan con sendMenuImage('pan')
- Si preguntan por hamburguesas siendo B2B: "Eso es otro rubro, ¿querés que te pase con lo de hamburguesas?"
- Docenas como unidad base de venta

### ADDED: REQ-PROMPT-B2B-2 — Sección [DETECCION DE LINEA] al inicio

El system prompt **DEBE** incluir una sección `[DETECCION DE LINEA]` inmediatamente después de `[ROL]` que instruya al agente a detectar la línea de negocio del cliente basado en keywords del primer mensaje, y a comportarse según el flujo correspondiente.

### ADDED: REQ-PROMPT-B2C-1 — Sección [FLUJO B2C] actualizada

El system prompt **DEBE** renombrar la sección actual `[FLUJO]` a `[FLUJO B2C]` para dejar explícito que aplica solo a clientes B2C.

---

## Dominio: Inyección en Agent

### ADDED: REQ-AGENT-1 — orderType inyectado en customerContext

`agent.ts` **DEBE** detectar `orderType` al procesar el primer mensaje de la conversación e inyectarlo en `customerContext`. El orderType **DEBE** persistir en el contexto durante toda la conversación.

#### Scenario: Contexto inyectado con orderType
- GIVEN un cliente envía "quiero 5 docenas de prepizza"
- WHEN agent.ts procesa el mensaje
- THEN detecta orderType = "pan_mayorista" por keywords
- AND lo inyecta en customerContext
- AND buildSystemPrompt recibe el dato y lo pasa al prompt como `🧭 TIPO DE CLIENTE: B2B (pan mayorista)`
