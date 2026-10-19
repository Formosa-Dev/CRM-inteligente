# TypeSafe AI + Jev en Muzapp
## Documento técnico de arquitectura e implementación

**Repositorio:** adriangmrraa/muzapp  
**Fecha de análisis:** 22 de septiembre de 2026  
**Estado:** propuesta de implementación sobre el código actual de main  
**Objetivo:** integrar Jev, el System One Model de TypeSafe AI, como capa de decisión probabilística y tipada dentro del CRM agéntico de Muzapp, sin reemplazar las validaciones deterministas ni a los LLM que generan lenguaje.

---

## 1. Resumen ejecutivo

Muzapp ya tiene una arquitectura agéntica funcional con dos superficies principales:

1. **Agente de atención al cliente por WhatsApp**, que usa GPT y herramientas de negocio para menú, stock, delivery, carrito, pedidos, promociones, multimedia y derivación humana.
2. **Agente interno por Telegram**, con acceso a operaciones administrativas, clientes, productos, pedidos, configuración, analytics y envíos de WhatsApp.

Jev encaja bien en Muzapp, pero no como reemplazo directo de GPT.

La función recomendada de Jev es convertirse en el **decision plane** del sistema: una capa rápida que interpreta estados y devuelve decisiones tipadas con probabilidades. GPT continúa siendo el **generation/reasoning plane**: redacta mensajes, entiende instrucciones abiertas, combina información y conversa.

La arquitectura objetivo es:

**Código determinista → Jev decide → GPT actúa cuando corresponde → Jev verifica → código ejecuta side effects.**

Los usos de mayor valor para Muzapp son:

- clasificación de intención antes de invocar GPT;
- routing hacia lógica determinista, GPT, agente especializado o humano;
- detección semántica de frustración, reclamos, solicitudes humanas y prompt injection;
- reducción del conjunto de tools expuesto al agente interno;
- guardia previa a tool calls de riesgo;
- comprobación de confirmación explícita antes de operaciones sensibles;
- verificación de la respuesta generada antes de enviarla;
- reemplazo progresivo de regex/keywords frágiles por decisiones probabilísticas;
- observabilidad de cada decisión, incluyendo confianza, versión del modelo y acción tomada.

**No debe usarse Jev para calcular precios, totales o delivery, escribir en la base de datos, generar la respuesta al cliente, ejecutar side effects, ni sustituir las validaciones deterministas que ya existen.**

---

## 2. Qué es TypeSafe AI

TypeSafe AI es una empresa de IA enfocada en automatización de software. Fue presentada públicamente en septiembre de 2026 después de aproximadamente dos años en stealth.

Su propuesta difiere de la de los LLM tradicionales: en vez de optimizar un modelo para generar strings para humanos, desarrolla modelos orientados a producir decisiones estructuradas que el software pueda consumir directamente.

La empresa denomina a esta familia **System One Models**, inspirándose en la idea de decisiones rápidas e intuitivas. Su primer modelo público es **Jev**.

El equipo fundador incluye a **Diogo Almeida, Erik Gafni y Sasha Sheng**. Almeida trabajó previamente en OpenAI. En septiembre de 2026, DCVC anunció una ronda seed de USD 40 millones liderada por la firma.

TypeSafe describe su método de entrenamiento como **Reinforcement Learning for Calibrated Decisions (RLCD)**.

### Qué cambia conceptualmente

Un LLM tradicional suele producir:

entrada no estructurada → tokens → texto → parsing → validación → acción

Jev está diseñado para:

estado → preguntas tipadas → respuestas tipadas + probabilidades → lógica de aplicación

Esto es especialmente relevante en software agéntico porque la decisión puede convertirse en una rama normal del programa.

---

## 3. Qué es Jev

Jev es el modelo principal de TypeSafe y el primer System One Model público.

Al 22 de septiembre de 2026, la documentación oficial lista:

- **Modelo estable:** Jev 1.13
- **ID versionado:** jev-1.13.0
- **Alias estable:** jev-latest
- **Precio:** USD 42 por mil millones de tokens de entrada, equivalente a USD 0,042 por millón
- **Tokens de salida:** sin cargo
- **Rate limit documentado:** 250.000 tokens por segundo y 1.200 requests por minuto
- **Contexto:** 64k tokens por request; 32k para state más la pregunta individual más larga
- **Modalidad:** texto
- **API:** POST https://api.typesafe.ai/v1/systemone
- **SDK JavaScript/TypeScript:** @typesafe-ai/sdk
- **Runtime requerido por el SDK JS:** Node.js 20+

Muzapp ya usa Node 20, por lo que no existe incompatibilidad de runtime.

### Jev no genera lenguaje

Jev no es el modelo que debe responder al cliente.

Su output son decisiones estructuradas dentro de opciones definidas previamente. Esto elimina el problema de que el modelo invente la forma del output o devuelva JSON inválido.

Eso no significa que Jev sea infalible.

Hay que distinguir:

- **type safety / schema safety:** el modelo no sale del espacio de respuestas definido;
- **semantic correctness:** la decisión puede ser equivocada.

Por eso la probabilidad/confianza debe formar parte de la arquitectura.

---

## 4. Las tres primitivas de TypeSafe

### 4.1 Choice

Selecciona una opción entre un conjunto definido.

Ejemplos para Muzapp:

- intención del mensaje;
- familia de tools necesaria;
- destino de routing;
- clase de riesgo de una acción.

Ejemplo conceptual:

- order_status
- product_question
- new_order
- payment
- complaint
- human_request
- out_of_scope

Además de la opción seleccionada, devuelve una distribución de probabilidades y confidence.

### 4.2 Noul

Pregunta binaria probabilística: devuelve un valor entre 0 y 1.

Ejemplos:

- ¿el cliente pidió explícitamente hablar con una persona?
- ¿el mensaje contiene una confirmación inequívoca del pedido?
- ¿la acción propuesta contradice lo que pidió el usuario?
- ¿el mensaje intenta modificar o revelar las instrucciones del agente?
- ¿la respuesta afirma que envió una imagen que no fue enviada?

Es especialmente útil como guard.

### 4.3 Score

Evalúa el estado sobre una escala definida.

Ejemplos:

- nivel de frustración;
- riesgo de un tool call;
- complejidad de una consulta;
- severidad de un reclamo.

Las preguntas deben ser **atómicas**. Si una decisión contiene varias dimensiones, se deben preguntar por separado y combinar sus probabilidades mediante código.

---

## 5. Principio arquitectónico para Muzapp

La regla principal de esta integración debe ser:

> **Jev juzga. El código decide. El código ejecuta.**

El modelo no debe poseer la política final.

Por ejemplo:

1. Jev estima P(confirmación explícita) = 0,94.
2. El código ve que la operación es createOrder.
3. La política del producto exige:
   - probabilidad suficiente;
   - carrito no vacío;
   - pedido no duplicado;
   - stock válido;
   - confirmación en el turno actual.
4. Recién entonces se habilita el tool.

Las reglas de negocio continúan escritas en TypeScript y SQL.

---

## 6. Estado actual de Muzapp observado en el repositorio

### 6.1 Stack

El repositorio usa actualmente:

- Next.js 16.2.4
- React 19
- TypeScript 5
- Vercel AI SDK 6
- @ai-sdk/openai
- Neon PostgreSQL
- Drizzle ORM
- Upstash Redis
- YCloud para WhatsApp
- Telegram Bot API
- Zod
- Pino
- Render

### 6.2 Agente externo / WhatsApp

Archivo principal:

**src/lib/whatsapp/agent.ts**

El agente:

- recibe historial;
- revisa prompt injection;
- aplica anti-loop;
- clasifica mensajes no comerciales;
- carga contexto del cliente;
- carga pedidos recientes;
- infiere preferencias;
- carga carrito;
- construye prompt dinámico;
- llama GPT;
- expone un conjunto amplio de herramientas;
- revisa los tool results;
- ejecuta un guard post-generación;
- reintenta cuando detecta una posible alucinación.

Actualmente usa **gpt-5.4-mini**.

### 6.3 Heurísticas que Jev puede mejorar

Hay dos módulos particularmente claros:

**src/lib/whatsapp/tools/prompt-security.ts**

Actualmente detecta prompt injection con regex.

**src/lib/whatsapp/anti-loop.ts**

Actualmente clasifica tipos de mensajes con listas de keywords.

Esto funciona, pero es frágil ante:

- paráfrasis;
- errores ortográficos;
- jerga local;
- mensajes ambiguos;
- mezcla de intenciones;
- sarcasmo;
- referencias al historial;
- formas no previstas de jailbreak.

Jev puede complementar o sustituir gradualmente las decisiones semánticas, manteniendo los chequeos deterministas baratos como primera barrera.

### 6.4 Guard anti-alucinación actual

El agente revisa después de la generación si:

- el usuario pidió media;
- el asistente afirmó haber enviado media;
- se ejecutaron o no tools;
- se llamó una tool de datos pero no una de media.

Es una buena arquitectura defensiva.

Jev permitiría añadir una segunda capa semántica:

- ¿la respuesta contiene una afirmación que no está respaldada por tool results?
- ¿contradice el estado real?
- ¿afirma haber hecho una acción que no aparece en los tool calls?
- ¿responde a otra intención distinta?
- ¿debería derivarse en vez de responder?

### 6.5 Reglas deterministas que deben conservarse

El repositorio ya tiene protecciones valiosas.

Por ejemplo **src/lib/whatsapp/tools/create-order.ts**:

- bloqueo de pedidos activos duplicados;
- validación de stock;
- lectura del carrito;
- resolución de items contra productos reales;
- cálculo por código;
- persistencia en DB.

No deben trasladarse a Jev.

Jev puede decidir si existe intención/confirmación suficiente, pero la DB sigue siendo la fuente de verdad.

### 6.6 Human override

Muzapp ya persiste **humanOverrideUntil** y la tool **transferToHuman** activa 24 horas de intervención humana.

Esto hace que la integración con Jev sea natural: una decisión de baja confianza, frustración alta o riesgo alto puede terminar en un mecanismo de handoff que ya existe.

---

## 7. El problema más importante del agente interno

El agente interno vive principalmente en:

- src/lib/telegram/handler.ts
- src/lib/telegram/tools.ts
- src/lib/telegram/system-prompt.ts

Actualmente el handler entrega al LLM el conjunto completo de tools.

Aunque el comentario del archivo todavía habla de “37 tools”, el objeto **internalAgentTools** expone actualmente alrededor de **55 entradas**.

Entre ellas existen operaciones de bajo riesgo y operaciones con side effects importantes.

### Lectura / bajo riesgo

- getOrderById
- getOrderStatus
- getClientDetail
- searchClient
- getBusinessSummary
- getAnalytics
- getTopProducts

### Escritura

- createClient
- updateClient
- createOrder
- addItemToOrder
- updateOrderStatus
- updateBusinessHours

### Destructivas o sensibles

- deleteLead
- deleteProduct
- cancelOrder
- markAsPaid
- updateAgentConfig
- setHumanOverride

### Efectos externos

- sendWhatsAppMessage
- sendMessageAsOperator
- broadcastWhatsApp

**broadcastWhatsApp** puede alcanzar múltiples destinatarios y hoy depende principalmente de la interpretación del LLM.

Este es probablemente el punto de mayor valor para Jev dentro de Muzapp.

---

# 8. Arquitectura objetivo

~~~text
WHATSAPP
   |
   v
Webhook + firma + dedup + reglas deterministas
   |
   v
JEV INPUT TRIAGE
   |
   +--> ruta determinista
   |
   +--> derivación humana
   |
   +--> GPT WhatsApp con tools permitidas
              |
              v
         TOOL PROPOSAL
              |
              v
         JEV TOOL GUARD
              |
         +----+----+
         |         |
       deny      allow
                   |
                   v
            guards de dominio
                   |
                   v
                execute
                   |
                   v
              GPT response
                   |
                   v
           JEV OUTPUT GUARD
                   |
              pass/retry/human
                   |
                   v
                 YCloud


TELEGRAM / AGENTE INTERNO
   |
autorización + media preprocessing
   |
   v
JEV INTENT + TOOL-FAMILY ROUTER
   |
   v
GPT interno con SUBSET de tools
   |
   v
JEV TOOL GUARD + política de riesgo
   |
   +--> execute
   +--> pedir confirmación
   +--> deny
   |
   v
respuesta
~~~

---

# 9. Implementación propuesta — capa común de Jev

Crear:

~~~text
src/lib/jev/
  client.ts
  config.ts
  types.ts
  policies.ts
  telemetry.ts
  customer-triage.ts
  response-guard.ts
  tool-guard.ts
  internal-router.ts
~~~

## 9.1 package.json

Agregar:

~~~bash
npm install @typesafe-ai/sdk
~~~

## 9.2 Variables de entorno

Agregar a **.env.example**:

~~~env
# --- TypeSafe AI / Jev ---
TYPESAFE_API_KEY=
JEV_ENABLED=false
JEV_MODEL=jev-1.13.0
JEV_TIMEOUT_MS=800
JEV_SHADOW_MODE=true
~~~

Recomendación inicial: usar el ID versionado **jev-1.13.0**, no jev-latest, mientras se calibran thresholds.

Cuando salga una nueva versión, correr primero el set de evaluación y recién después cambiar el modelo.

## 9.3 Cliente

Ejemplo de forma esperada:

~~~ts
import { TypeSafeClient } from "@typesafe-ai/sdk";

export const jev = new TypeSafeClient();
~~~

El SDK toma **TYPESAFE_API_KEY** desde el entorno.

Encima de este cliente conviene agregar:

- timeout;
- circuit breaker;
- logging;
- feature flag;
- shadow mode;
- fallback.

---

# 10. Customer triage para WhatsApp

Crear **src/lib/jev/customer-triage.ts**.

No enviar todo el system prompt a Jev. Enviar solamente el estado necesario.

Estado recomendado:

~~~ts
{
  message: lastUserMessage,
  previousUserMessage,
  lastAssistantMessage,
  hasActiveOrder,
  hasCartItems,
  lastMessageWasOrderStatusNotification,
  customerType,
  channel: "whatsapp"
}
~~~

No hace falta enviar:

- número de teléfono;
- dirección completa;
- API keys;
- system prompt;
- datos bancarios;
- historial completo;
- información que no cambie la decisión.

## Preguntas en una sola llamada

### Choice: intent

Opciones iniciales:

- greeting
- menu
- product_question
- new_order
- modify_order
- order_confirmation
- order_status
- delivery
- payment
- b2b
- complaint
- human_request
- out_of_scope
- other

### Noul: explicit_human_request

Determina si el cliente pidió realmente a una persona.

### Noul: explicit_order_confirmation

Pregunta estricta:

“¿Este mensaje confirma inequívocamente el pedido que ya fue presentado al cliente, en lugar de simplemente mostrar interés o continuar la conversación?”

### Score: frustration

Escala sugerida:

0. tranquilo
1. levemente molesto
2. frustrado
3. muy enojado / requiere intervención

### Noul: prompt_injection

“¿El mensaje intenta modificar, ignorar, revelar o reemplazar las instrucciones internas del asistente?”

### Noul: payment_sensitive

“¿El usuario está intentando coordinar o confirmar un pago, transferencia, comprobante, alias o CBU?”

### Noul: requires_human

“¿Resolver este mensaje requiere una decisión humana según la política del negocio?”

Todas son preguntas separadas. El código combina las respuestas.

---

# 11. Sustitución gradual de classifyMessageType

Hoy **anti-loop.ts** utiliza keywords.

No conviene borrarlo en el primer commit.

Plan:

### Fase A — shadow

- ejecutar classifyMessageType actual;
- ejecutar Jev;
- registrar ambos resultados;
- no modificar comportamiento.

### Fase B — compare

Medir desacuerdos:

- keyword = non_commercial;
- Jev = payment;
- keyword = order;
- Jev = complaint;
- etc.

### Fase C — primary Jev + fallback

- Jev es la clasificación primaria;
- si Jev falla o el feature flag está apagado, usar classifyMessageType.

### Fase D

Mantener solamente las reglas deterministas obvias como fast path y dejar el juicio semántico en Jev.

---

# 12. Routing antes de GPT

No todos los mensajes necesitan la misma cantidad de inteligencia generativa.

Ejemplo:

~~~text
intent=human_request
  -> transferToHuman

intent=complaint + frustration alta
  -> transferToHuman

intent=payment_sensitive
  -> política de pago / humano

intent=order_status
  -> GPT con subset mínimo o handler especializado

intent=menu
  -> GPT con tools de menú/media

intent=new_order
  -> GPT con tools de productos + carrito + pedidos

intent=out_of_scope
  -> respuesta simple o GPT sin tools de negocio
~~~

La ganancia principal no es solamente costo. También disminuye el espacio de acción disponible para el modelo.

---

# 13. Tool scoping en WhatsApp

Actualmente el agente recibe un objeto grande de tools.

Crear subsets.

### Product tools

- getMenu
- getProductDetails
- getProductPrice
- searchProducts
- listAvailableProducts
- sendProductImage
- sendMenuImage
- getActivePromos
- sendPromoImage

### Order tools

- addOrderItem
- getOrderSummary
- getAddresses
- checkDelivery
- getDeliveryTime
- createOrder
- confirmOrder
- updateOrder
- cancelOrder
- getOrderStatus

### Support tools

- transferToHuman
- getBusinessHours

La decisión de Jev no debería elegir directamente el tool final en todos los casos. Es más robusto que elija una **familia de capacidad** y GPT elija dentro de esa familia.

---

# 14. Tool Guard para side effects

Este es el segundo gran componente.

Crear **src/lib/jev/tool-guard.ts**.

Antes de ejecutar una herramienta sensible, evaluar:

~~~ts
{
  actor: "customer" | "admin",
  channel: "whatsapp" | "telegram",
  latestUserMessage,
  conversationSummary,
  proposedTool: {
    name,
    arguments
  }
}
~~~

Preguntas atómicas:

### Noul: requested_by_user

¿La acción propuesta está realmente solicitada por el usuario?

### Noul: arguments_supported

¿Los argumentos importantes están respaldados por el mensaje/contexto y no fueron inventados?

### Noul: destructive

¿La operación elimina, cancela o modifica información de forma difícil de revertir?

### Noul: external_side_effect

¿La operación envía algo a una persona externa o cambia el mundo fuera de la conversación?

### Noul: needs_confirmation

¿Esta acción debería requerir una confirmación explícita inmediatamente antes de ejecutarse?

### Choice: risk_class

- read_only
- reversible_write
- business_write
- destructive
- financial
- external_message
- bulk_external

El código convierte esas evaluaciones en allow / confirm / deny.

---

# 15. Política inicial de riesgo

Estos valores son **hipótesis iniciales para evaluación**, no defaults oficiales de TypeSafe.

| Clase | Ejemplos Muzapp | Política inicial |
|---|---|---|
| read_only | getAnalytics, getOrderStatus | permitir con confidence moderada |
| reversible_write | notas, alias | confidence mayor |
| business_write | createOrder, updateOrderStatus | alta confidence + validaciones |
| destructive | deleteLead, deleteProduct, cancelOrder | confirmación explícita |
| financial | markAsPaid | confirmación explícita + alta confidence |
| external_message | sendWhatsAppMessage | validar destinatario y contenido |
| bulk_external | broadcastWhatsApp | SIEMPRE segundo paso de confirmación |

Para **broadcastWhatsApp**, Jev no debe poder eliminar la confirmación humana aunque tenga 0,99 de confianza.

La política determinista debe ser:

1. el agente prepara el broadcast;
2. muestra cantidad de destinatarios, filtro y mensaje;
3. pide confirmación;
4. solamente un mensaje posterior inequívoco desbloquea el envío.

---

# 16. createOrder: cómo usar Jev correctamente

createOrder tiene side effects y ya posee guards de dominio.

Agregar un guard previo, pero conservar:

- duplicate order guard;
- stock;
- resolución de productos;
- carrito;
- persistencia;
- cálculo.

## Política sugerida

Para habilitar createOrder:

1. existe carrito o items válidos;
2. no hay bloqueo determinista;
3. el turno actual contiene confirmación explícita;
4. P(explicit_order_confirmation) supera el threshold definido;
5. la intención no está ambigua;
6. si no alcanza el threshold, preguntar nuevamente.

No usar Jev para:

- decidir precios;
- inventar items;
- calcular subtotal;
- calcular delivery;
- decidir stock.

---

# 17. El agente interno debe usar routing de tools

Este cambio puede ser más importante que usar Jev en WhatsApp.

Crear **src/lib/jev/internal-router.ts**.

Antes de llamar GPT, Jev clasifica la solicitud administrativa en:

- query_orders
- client_read
- client_write
- product_read
- product_write
- order_write
- analytics
- business_config
- customer_communication
- broadcast
- ambiguous

Después se construye dinámicamente el ToolSet de GPT.

Ejemplos:

~~~text
"cómo vendimos hoy"
  -> analytics tools solamente

"buscá a Héctor"
  -> client_read

"marcá el pedido 231 como listo"
  -> order_write

"borrá a Juan"
  -> client_write + destructive guard

"mandales a todos que hoy cerramos"
  -> broadcast + confirmación obligatoria
~~~

## Beneficio

GPT deja de tener unas 55 posibles acciones en cada turno.

Eso reduce:

- selección accidental de tools;
- collisions de descripciones;
- errores por herramientas parecidas;
- superficie de prompt injection;
- riesgo de side effects.

---

# 18. Confirmaciones en el agente interno

El system prompt actual dice en varios casos que el agente debe ejecutar inmediatamente.

Para operaciones sensibles conviene cambiar el modelo mental.

### Sin confirmación extra

- búsquedas;
- analytics;
- detalles de pedido;
- detalle de cliente;
- stock;
- resumen del negocio.

### Confirmación condicional

- updateClient;
- updateProduct;
- updateOrderStatus;
- updateBusinessHours.

### Confirmación obligatoria

- deleteLead;
- deleteProduct;
- cancelOrder cuando la referencia pueda ser ambigua;
- markAsPaid;
- broadcastWhatsApp;
- cambios críticos de agentConfig;
- operaciones masivas;
- mensajes externos a múltiples clientes.

La confirmación debe persistirse en estado, no inferirse solamente del historial.

---

# 19. Estado de confirmación recomendado

Agregar un pequeño estado de autorización de acción.

Puede vivir inicialmente en Redis.

Ejemplo conceptual:

~~~ts
{
  actionId: "...",
  actorId: "...",
  proposedTool: "broadcastWhatsApp",
  argumentsHash: "...",
  summary: "...",
  expiresAt: "...",
  status: "awaiting_confirmation"
}
~~~

Cuando el admin responde “sí, mandalo”:

1. Jev evalúa explicit_confirmation;
2. el código verifica que existe una acción pendiente;
3. verifica que argumentsHash sea el mismo;
4. ejecuta exactamente esa acción.

Así “sí” nunca autoriza una acción distinta.

---

# 20. Response Guard para WhatsApp

Crear **src/lib/jev/response-guard.ts**.

Se ejecuta después de GPT pero antes de YCloud.

State:

~~~ts
{
  userMessage,
  proposedReply,
  executedTools,
  toolResultsSummary,
  pendingMediaCount,
  conversationState
}
~~~

Preguntas:

### Noul: unsupported_claim

¿La respuesta afirma un dato de negocio que no aparece en los tool results o el estado confiable?

### Noul: claimed_unexecuted_action

¿Afirma que envió, creó, canceló, transfirió o actualizó algo que no fue ejecutado?

### Noul: contradicts_tools

¿Contradice resultados devueltos por las tools?

### Noul: missed_handoff

¿La respuesta intenta resolver por sí misma algo que la política requiere derivar?

### Noul: wrong_intent

¿La respuesta responde a una intención distinta a la del usuario?

El código puede producir:

- pass;
- retry;
- force_handoff.

No reemplazar las comprobaciones deterministas existentes de media. Una condición como:

**pendingMedia.length === 0 + respuesta dice “te mandé la foto”**

sigue siendo mejor resolverla con código.

Jev agrega semántica para casos que el regex no cubra.

---

# 21. Prompt injection

La detección actual por regex debe mantenerse como capa cero.

Pipeline:

~~~text
sanitize determinista
   ->
regex de ataques conocidos
   ->
Jev prompt_injection
   ->
política
~~~

No hace falta que Jev reciba el system prompt completo para saber si un texto intenta alterar las instrucciones.

Si la probabilidad está en una zona intermedia, puede:

- limitar tools;
- tratar el turno como out_of_scope;
- escalar;
- enviar una respuesta neutra.

---

# 22. Fallback y tolerancia a fallos

Jev no puede convertirse en un single point of failure.

## Si TypeSafe no responde

### Acciones de lectura

Fail-open hacia el flujo actual.

Ejemplos:

- consultas de menú;
- analytics;
- búsquedas.

### Acciones irreversibles/sensibles

Fail-safe.

Ejemplos:

- delete;
- financial;
- broadcast;
- cambios críticos.

En ese caso:

- pedir confirmación;
- requerir intervención humana;
- o usar las reglas deterministas actuales.

## Circuit breaker

Muzapp ya posee **src/lib/infra/circuit-breaker.ts**.

Conviene generalizarlo o crear una instancia separada para TypeSafe.

No compartir el mismo estado de fallos entre OpenAI y TypeSafe.

---

# 23. Shadow mode

La primera implementación de Jev no debería modificar producción.

Con **JEV_SHADOW_MODE=true**:

1. se consulta Jev;
2. se registran respuestas;
3. el flujo continúa exactamente como hoy;
4. se comparan decisiones Jev vs resultado real.

Esto permite calibrar con lenguaje argentino real antes de activar routing.

Es importante porque la documentación de Jev indica que el inglés es su idioma principal y donde actualmente obtiene mejor precisión. Muzapp usa español rioplatense, voseo, abreviaturas y mensajes informales.

La evaluación local es obligatoria.

---

# 24. Dataset de evaluación para Muzapp

Crear un set anonimizado con categorías.

No almacenar teléfonos ni direcciones en el dataset.

Clases mínimas:

- saludo;
- menú;
- consulta producto;
- consulta precio;
- pedido;
- modificación;
- confirmación;
- no-confirmación;
- estado;
- pago;
- B2B;
- reclamo;
- frustración;
- humano;
- fuera de tema;
- prompt injection;
- mensaje ambiguo.

Agregar ejemplos con:

- errores de ortografía;
- mensajes cortos;
- audios transcritos;
- Formoseñismos/argentinismos;
- emojis;
- mensajes concatenados;
- “dale”, “sí”, “de una” en distintos contextos;
- negaciones: “sí pero todavía no lo mandes”;
- referencia: “el mismo de antes”.

---

# 25. Métricas que deben medirse

## Triage

- accuracy por intent;
- precision/recall de human_request;
- precision/recall de payment;
- confusion matrix;
- tasa de low confidence.

## Pedidos

La métrica más importante:

**false positive de order_confirmation.**

Un falso negativo obliga a preguntar otra vez.

Un falso positivo puede crear un pedido no solicitado.

Por eso deben tener costos distintos.

## Tool Guard

- side effects bloqueados correctamente;
- acciones válidas bloqueadas;
- acciones riesgosas ejecutadas sin confirmación;
- falsos positivos por tool.

## Response Guard

- respuestas incorrectas detectadas;
- retries evitables;
- claims de acciones no ejecutadas;
- latencia agregada.

## Economía

- llamadas GPT evitadas;
- tokens GPT evitados;
- costo Jev;
- costo total por conversación;
- p50/p95 de latencia.

---

# 26. Costos

Precio oficial documentado actualmente:

**USD 0,042 por 1 millón de tokens de entrada.**

Ejemplo matemático:

Si un triage consume 500 tokens:

~~~text
0,042 / 1.000.000 × 500
= USD 0,000021 por triage
~~~

100.000 triages de ese tamaño:

~~~text
≈ USD 2,10
~~~

Si se hacen dos evaluaciones equivalentes por turno —input + output—:

~~~text
≈ USD 4,20 por cada 100.000 turnos
~~~

Esto es únicamente un ejemplo. El costo real depende del tamaño del state, questions y tráfico.

Jev no debería recibir historiales gigantes. La calidad y el costo mejoran cuando recibe el estado mínimo suficiente.

---

# 27. Privacidad

La documentación de TypeSafe indica que Jev no se entrena con los requests o responses de clientes. También documenta opciones de Zero Data Retention para clientes enterprise.

Aun así, aplicar data minimization:

### No enviar salvo necesidad

- teléfono;
- dirección;
- nombre completo;
- datos bancarios;
- tokens;
- cookies;
- claves;
- documentos completos;
- conversaciones completas.

### Enviar

- mensaje que se evalúa;
- estado booleano/enum;
- resumen reducido;
- nombres de tools;
- argumentos estrictamente necesarios.

---

# 28. Audio e imágenes

Jev 1.13 recibe texto, no imagen/audio/video.

Muzapp ya tiene la capa correcta:

- audio → Whisper/transcripción;
- imagen → modelo de visión/descripción;
- documento → extracción/preprocesamiento.

Jev entra después.

Ejemplo:

~~~text
audio
 -> transcripción
 -> Jev intent/risk
 -> GPT/handler

imagen
 -> Vision
 -> descripción estructurada
 -> Jev
 -> handler
~~~

---

# 29. Observabilidad

En la primera versión no hace falta crear inmediatamente una tabla nueva.

Usar Pino:

~~~text
event=jev_decision
channel=whatsapp
decision=customer_triage
model=jev-1.13.0
intent=new_order
intent_confidence=...
latency_ms=...
route=gpt_order
shadow=true
~~~

No loggear texto sensible completo.

## Segunda etapa

Agregar tabla **jev_decisions**:

- id
- conversationId nullable
- channel
- actorType
- decisionType
- model
- answers jsonb
- thresholds jsonb
- actionTaken
- inputTokens
- latencyMs
- shadow
- createdAt

Esto permite evaluar cambios de modelo y thresholds.

---

# 30. Archivos concretos a modificar

| Archivo | Cambio |
|---|---|
| package.json | agregar @typesafe-ai/sdk |
| .env.example | configuración Jev |
| src/lib/jev/client.ts | cliente común + timeout/fallback |
| src/lib/jev/config.ts | flags/model |
| src/lib/jev/policies.ts | thresholds y riesgo |
| src/lib/jev/customer-triage.ts | intent/frustration/handoff |
| src/lib/jev/tool-guard.ts | guard de tool calls |
| src/lib/jev/response-guard.ts | validación semántica del output |
| src/lib/jev/internal-router.ts | routing de agente interno |
| src/lib/jev/telemetry.ts | logging |
| src/lib/whatsapp/agent.ts | integrar pre/post decision layer |
| src/lib/whatsapp/anti-loop.ts | fallback + metadata basada en Jev |
| src/lib/whatsapp/tools/prompt-security.ts | conservar regex y sumar Jev |
| src/lib/telegram/handler.ts | pre-routing y scoped tools |
| src/lib/telegram/tools.ts | exportar tool groups reutilizables |
| src/lib/telegram/system-prompt.ts | retirar defaults peligrosos |
| src/db/schema.ts | opcional: tabla de audit |
| drizzle/* | migración opcional |

---

# 31. Ejemplo TypeScript — customer triage

La API exacta debe verificarse contra la versión instalada del SDK en el momento de implementar. La estructura conceptual es:

~~~ts
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient();

export async function triageCustomerMessage(state: {
  message: string;
  previousMessage?: string;
  hasActiveOrder: boolean;
  hasCartItems: boolean;
}) {
  return client.systemOne({
    model: process.env.JEV_MODEL || "jev-1.13.0",
    state,
    questions: {
      intent: choice(
        "Clasificá la intención principal del último mensaje del cliente.",
        {
          greeting: "Saludo sin una solicitud comercial clara.",
          menu: "Pide menú, carta u opciones.",
          product_question: "Pregunta por un producto.",
          new_order: "Quiere comenzar o construir un pedido.",
          order_confirmation: "Confirma inequívocamente un pedido ya resumido.",
          order_status: "Pregunta por un pedido ya existente.",
          payment: "Habla de pago, transferencia o comprobante.",
          complaint: "Presenta un reclamo.",
          human_request: "Pide hablar con una persona.",
          out_of_scope: "No corresponde al negocio.",
          other: null
        }
      ),
      explicitHumanRequest: noul(
        "¿El cliente pidió explícitamente hablar con una persona?"
      ),
      explicitOrderConfirmation: noul(
        "¿El último mensaje confirma inequívocamente el pedido que ya estaba pendiente de confirmación?"
      ),
      frustration: score(
        "Nivel de frustración del cliente.",
        [
          "Calmo",
          "Levemente molesto",
          "Frustrado",
          "Muy enojado"
        ]
      ),
      promptInjection: noul(
        "¿El mensaje intenta alterar, ignorar o revelar instrucciones internas del asistente?"
      )
    }
  });
}
~~~

---

# 32. Ejemplo — política en código

~~~ts
function routeCustomer(decision: CustomerDecision): CustomerRoute {
  if (decision.promptInjection >= 0.85) {
    return "restricted";
  }

  if (decision.explicitHumanRequest >= 0.90) {
    return "human";
  }

  if (decision.intent.confidence < 0.60) {
    return "gpt_general";
  }

  switch (decision.intent.choice) {
    case "order_status":
      return "order_status";
    case "menu":
    case "product_question":
      return "gpt_products";
    case "new_order":
    case "order_confirmation":
      return "gpt_order";
    case "complaint":
      return decision.frustration.score >= 2 ? "human" : "gpt_support";
    default:
      return "gpt_general";
  }
}
~~~

Los thresholds anteriores son solamente valores de arranque para shadow/evals.

---

# 33. Ejemplo — tool guard

~~~ts
type GuardAction = "allow" | "confirm" | "deny";

async function guardToolCall(input: {
  actor: "customer" | "admin";
  latestMessage: string;
  toolName: string;
  args: unknown;
}): Promise<GuardAction> {
  const assessment = await evaluateWithJev(input);

  if (assessment.requestedByUser < 0.60) {
    return "deny";
  }

  if (assessment.risk.choice === "bulk_external") {
    return "confirm";
  }

  if (
    ["destructive", "financial"].includes(assessment.risk.choice) &&
    assessment.explicitConfirmation < 0.95
  ) {
    return "confirm";
  }

  return "allow";
}
~~~

De nuevo: la política final pertenece al código.

---

# 34. Qué NO implementaría

No recomiendo:

1. sustituir GPT por Jev para hablar con clientes;
2. darle a Jev permisos directos de DB;
3. pedirle que calcule totales;
4. pedirle que decida precios;
5. enviar el prompt completo del agente en cada evaluación;
6. reemplazar idempotencia o duplicate-order guard;
7. hacer depender broadcast solamente de confidence;
8. reemplazar autorización de Telegram por clasificación;
9. borrar los regex existentes el primer día;
10. usar jev-latest en producción sin registrar la versión devuelta;
11. confiar en los thresholds sin evaluación en español argentino.

---

# 35. Orden recomendado de implementación

## F0 — infraestructura

- instalar SDK;
- configurar env;
- cliente;
- timeout;
- circuit breaker;
- telemetry;
- feature flag.

## F1 — shadow triage WhatsApp

- intent;
- prompt injection;
- frustration;
- payment;
- human request;
- order confirmation.

No cambia comportamiento.

## F2 — routing real WhatsApp

- reemplazar clasificación semántica por Jev;
- mantener fallback;
- scoped tools;
- human routing.

## F3 — output guard

- verificar respuesta antes del envío;
- conservar guards deterministas existentes.

## F4 — internal router

- clasificar familia de intención;
- entregar a GPT sólo las tools necesarias.

## F5 — tool risk guard

- read/write/destructive/financial/outbound/bulk;
- confirmaciones persistidas.

## F6 — direct deterministic paths

Una vez que el routing esté validado, algunos intents simples pueden evitar GPT completamente.

Ejemplo futuro:

~~~text
"estado del pedido 351"
 -> Jev: order_status
 -> handler determinista
 -> DB
 -> template de respuesta
~~~

Esto reduce costo y latencia todavía más.

---

# 36. Criterios de aceptación antes de activar side effects

No activar guardias con poder de ejecución hasta cumplir al menos:

- eval versionada;
- confusion matrix por intent;
- dataset representativo de español argentino;
- thresholds calibrados;
- logs con versión de Jev;
- fallback probado;
- Jev timeout probado;
- simulación de 429/529;
- pruebas de API outage;
- test específico de confirmaciones negadas/ambiguas;
- test de broadcast;
- test de delete;
- test de markAsPaid;
- test de prompt injection;
- test de frases cortas tipo “dale” según distintos historiales.

Para órdenes, el objetivo debe priorizar minimizar falsos positivos de confirmación por encima de automatizar al máximo.

---

# 37. Conclusión técnica

Jev tiene sentido en Muzapp porque el proyecto ya posee exactamente el problema para el que fue diseñado:

**muchos puntos donde el software necesita un juicio semántico corto antes de ejecutar lógica tradicional.**

Hoy parte de esos juicios se resuelve con:

- regex;
- keywords;
- prompt engineering;
- toolChoice;
- una segunda llamada al LLM;
- retry heurístico.

La implementación correcta no es “cambiar GPT por Jev”.

Es separar responsabilidades:

### Jev

- clasifica;
- puntúa;
- detecta;
- enruta;
- estima confianza;
- actúa como guard.

### GPT

- conversa;
- redacta;
- entiende solicitudes abiertas;
- combina contexto;
- decide dentro de un conjunto de capacidades permitido.

### TypeScript / PostgreSQL

- valida;
- calcula;
- aplica la política;
- ejecuta;
- persiste;
- controla side effects.

En Muzapp, el mayor retorno esperado está en:

1. **routing de WhatsApp**;
2. **reemplazo de heurísticas semánticas frágiles**;
3. **guard pre/post LLM**;
4. **tool-family routing del agente interno**;
5. **protección de operaciones destructivas y masivas**;
6. **reducción del número de tools visibles en cada llamada GPT**.

La integración debe comenzar en shadow mode y avanzar mediante evidencia medida, no solamente por confianza en benchmarks del proveedor.

---

# 38. Fuentes

## TypeSafe AI — oficiales

- https://typesafe.ai/
- https://typesafe.ai/blog/introducing-system-one-models-and-jev
- https://docs.typesafe.ai/introduction
- https://docs.typesafe.ai/models
- https://docs.typesafe.ai/api
- https://docs.typesafe.ai/sdk/javascript
- https://docs.typesafe.ai/patterns/intent-routing
- https://docs.typesafe.ai/patterns/confidence-routing
- https://docs.typesafe.ai/cookbooks/llm_guardrails
- https://api.typesafe.ai/docs

## Empresa / financiación / contexto

- https://www.dcvc.com/news-insights/typesafe-emerges-from-stealth-with-a-new-way-of-doing-ai/
- https://techcrunch.com/2026/09/18/a-new-kind-of-ai-model-from-a-chatgpt-inventor-is-thrilling-developers/

## Código auditado de Muzapp

Este documento fue preparado contra la rama **main** de:

- https://github.com/adriangmrraa/muzapp

Archivos principales inspeccionados:

- README.md
- package.json
- .env.example
- src/lib/whatsapp/agent.ts
- src/lib/whatsapp/anti-loop.ts
- src/lib/whatsapp/tools/prompt-security.ts
- src/lib/whatsapp/tools/create-order.ts
- src/lib/whatsapp/tools/order-context-tools.ts
- src/lib/whatsapp/tools/transfer-to-human.ts
- src/lib/telegram/handler.ts
- src/lib/telegram/tools.ts
- src/lib/telegram/toolsOrder.ts
- src/lib/telegram/toolsManagement.ts
- src/lib/telegram/toolsWhatsApp.ts
- src/lib/telegram/system-prompt.ts
- src/lib/infra/circuit-breaker.ts
- src/db/schema.ts

---

## Nota final de implementación

Este archivo es una especificación de arquitectura. No modifica todavía el runtime de Muzapp.

El siguiente cambio lógico en el repositorio es crear una especificación SDD para **jev-integration**, implementar F0 + F1 en shadow mode y agregar un set de evaluación antes de habilitar cualquier decisión de Jev que altere side effects.


---

# 39. Segunda pasada de arquitectura — revisión ampliada

Fecha: 22 de septiembre de 2026.

Esta sección amplía y, donde se indica, corrige la primera propuesta después de revisar nuevamente el repositorio, sus SDD históricas y la documentación actual de TypeSafe.

## 39.1 Hallazgos nuevos principales

1. Muzapp no tiene sólo dos actores agénticos. Existe también un agente interno para vendedores por WhatsApp.
2. La política debe distinguir customer, seller, admin y automation.
3. El seller agent puede ejecutar operaciones de negocio relevantes, entre ellas markAsPaid, cancelOrder, sendWhatsAppMessage y broadcastWhatsApp.
4. Las SDD existentes ya contienen casos reales etiquetados y deben convertirse en el primer eval suite de Jev.
5. Jev puede aportar valor fuera del request path mediante conversation intelligence, enriquecimiento CRM, evaluación de follow-ups y análisis de pérdidas de ventas.
6. Jev 1.13 tiene límites que deben afectar el diseño: lectura literal, menor precisión fuera del inglés, debilidad con números y fechas, degradación con state irrelevante y sensibilidad a contenido adversarial.
7. El SDK JavaScript reintenta por defecto. Un timeout por intento no equivale a un presupuesto total de latencia.
8. El mejor patrón para Muzapp es una evaluación preflight con fan-out de preguntas atómicas, no varias llamadas secuenciales.
9. En comandos internos simples se puede crear un Direct Command Lane que evite GPT cuando la función y sus argumentos son cerrados y verificables.
10. Hace falta una fuente de verdad para tools, roles, riesgo y confirmaciones.

---

# 40. Correcciones importantes a la primera propuesta

## 40.1 Jev no es una barrera anti-jailbreak infalible

La documentación de Jev 1.13 indica que el state no se trata como hostil por defecto y que contenido adversarial puede mover una clasificación.

Pipeline correcto:

~~~text
normalización y límites
  -> reglas deterministas de ataques conocidos
  -> Jev como señal semántica adicional
  -> restricción de capacidades
  -> política en código
~~~

Nunca habilitar una tool sensible sólo porque Jev juzgó el mensaje como seguro.

## 40.2 Noul no tiene confidence

Noul devuelve P(true) entre 0 y 1.

Choice y Score devuelven distribución de probabilidades y confidence.

Los thresholds deben separarse por primitiva. No se debe reutilizar un threshold calibrado para Noul en Choice, ni al revés.

## 40.3 Números, conteos, fechas y ventanas quedan en código

No usar Jev para:

- comparar timestamps;
- determinar si pasaron 24 horas;
- contar repeticiones;
- sumar items;
- calcular totales;
- comparar cantidades;
- calcular delivery;
- ordenar fechas.

## 40.4 Reducir indirection y contexto

No enviar prompts enormes. Para la mayoría de decisiones alcanza con último mensaje, turno previo relevante y flags como hasCartItems, deliveryAgreed, hasActiveOrder y pendingAction.

## 40.5 Presupuesto real de latencia

El SDK tiene retries configurables y timeout por intento.

Propuesta inicial:

~~~env
JEV_REALTIME_TIMEOUT_MS=700
JEV_REALTIME_MAX_RETRIES=0
JEV_INTERNAL_TIMEOUT_MS=1500
JEV_INTERNAL_MAX_RETRIES=1
~~~

Cuando sea necesario, agregar AbortController para un deadline total.

## 40.6 Logging

No habilitar debug del SDK en producción para requests con conversaciones. El wrapper de Muzapp debe registrar metadata y resultados sanitizados, no cuerpos completos.

---

# 41. Decision Plane V2

La integración debe evolucionar de un intent classifier a un vector de decisiones semánticas por turno.

## 41.1 Contexto normalizado

~~~ts
export type AgentActor =
  | "customer"
  | "seller"
  | "admin"
  | "automation";

export type DecisionContext = {
  actor: AgentActor;
  channel: "whatsapp" | "telegram" | "meta";
  message: string;
  conversation: {
    hasCartItems: boolean;
    hasActiveOrder: boolean;
    deliveryAgreed: boolean;
    waitingForOrderConfirmation: boolean;
    repliedToStatusNotification: boolean;
    pendingActionType?: string;
    previousSemanticTopic?: string;
  };
  media?: {
    kind: "none" | "audio" | "image" | "document" | "video" | "location";
    semanticSummary?: string;
  };
};
~~~

Evitar PII si no modifica la decisión.

## 41.2 Una única llamada preflight

Usar speculative fan-out. Preguntas iniciales:

### Choice: primaryIntent

- greeting
- product_discovery
- price_question
- new_order
- modify_order
- order_confirmation
- order_status
- pickup
- delivery
- payment
- complaint
- human_request
- internal_query
- internal_write
- outbound_message
- out_of_scope
- other

### Noul: priceOnly

Pregunta si el usuario únicamente consulta precio sin intención de compra. Cubre directamente la SDD agente-precio-no-es-compra.

### Noul: explicitOrderConfirmation

Pregunta si el mensaje confirma inequívocamente un pedido ya presentado y pendiente de confirmación.

### Noul: pickupCommitment

Pregunta si el usuario afirma que ya va, está saliendo o pasará a retirar.

La acción final combina la señal con hasCartItems y deliveryAgreed en código.

### Noul: nonLiteralOrJoking

Pregunta si el mensaje parece humorístico, exagerado o no literal.

Los umbrales numéricos siguen en código.

### Noul: customerConfused

Pregunta si el usuario expresa que no entendió o que el agente entendió mal.

El conteo de repeticiones sigue en código.

### Noul adicionales

- explicitHumanRequest
- paymentSensitive
- injectionAttempt
- actionRequested

### Score: frustration

Niveles:

- calm
- annoyed
- frustrated
- very_angry

---

# 42. Actor model: customer / seller / admin / automation

## Customer

Puede consultar, construir carrito, confirmar pedido, modificar/cancelar según reglas y pedir humano.

## Seller

Existe en:

- src/lib/whatsapp/seller-prompt.ts
- src/app/api/whatsapp/webhook/route.ts

El vendedor se detecta por sellerPhoneIds y ejecuta GPT con internalSellerTools.

Ese ToolSet incluye operaciones de escritura, financieras y externas, por lo que necesita policy propia.

## Admin

Telegram posee el catálogo de mayor privilegio. Las operaciones financieras, destructivas y masivas deben tener confirmación explícita y trazabilidad.

## Automation

Cron jobs, follow-ups y futuras sales_tasks constituyen un actor separado y nunca deben heredar implícitamente permisos de admin.

---

# 43. Tool Manifest — nueva pieza central

Crear:

~~~text
src/lib/agent-policy/
  tool-manifest.ts
  roles.ts
  risk.ts
  confirmation.ts
~~~

Ejemplo:

~~~ts
export const TOOL_MANIFEST = {
  getOrderStatus: {
    family: "order_read",
    roles: ["customer", "seller", "admin"],
    risk: "read_only",
    sideEffect: false,
    confirmation: "never",
  },
  createOrder: {
    family: "order_write",
    roles: ["customer", "seller", "admin"],
    risk: "business_write",
    sideEffect: true,
    confirmation: "policy",
  },
  markAsPaid: {
    family: "financial",
    roles: ["seller", "admin"],
    risk: "financial",
    sideEffect: true,
    confirmation: "explicit",
  },
  broadcastWhatsApp: {
    family: "bulk_external",
    roles: ["admin"],
    risk: "bulk_external",
    sideEffect: true,
    confirmation: "always",
  },
} as const;
~~~

Recomendación: broadcastWhatsApp no debe quedar disponible a vendedores por defecto.

Si se habilita en el futuro, debe requerir permiso determinista, preview, filtro, cantidad de destinatarios, texto exacto, confirmación posterior, límite máximo y audit log.

---

# 44. Drift encontrado entre prompts y capacidades

## Seller prompt

El prompt indica que borrar/eliminar debe ejecutar deleteLead o cancelOrder, pero internalSellerTools no expone deleteLead.

La IA recibe una instrucción para una capacidad que no posee.

## Precios hardcodeados

BASE_SELLER_PROMPT contiene precios estáticos y buildSellerPrompt agrega después el menú dinámico desde DB.

Esto puede crear dos verdades dentro del mismo prompt.

src/lib/telegram/system-prompt.ts también contiene mapeos y precios estáticos.

Recomendación:

- quitar precios estáticos;
- DB como fuente de verdad;
- tools/product resolver para valores;
- mantener sólo aliases/sinónimos cuando realmente sean necesarios.

## Conteos/comentarios de tools

Hay comentarios con cantidades históricas de tools que ya no representan el ToolSet actual.

El Tool Manifest debe convertirse en fuente de verdad para permisos, grupos, riesgo, documentación, subsets y tests.

---

# 45. Tool routing V2 — progressive disclosure

Primera etapa: Jev ve familias, no 50+ tools.

Familias:

- order_read
- order_write
- client_read
- client_write
- product_read
- product_write
- analytics
- config
- outbound_message
- broadcast

Preguntas:

- Choice: mejor familia
- Noul: realmente necesita una tool

Segunda etapa, cuando haga falta: mostrar sólo las tools de la familia elegida con sus descripciones completas.

El resultado puede:

1. reducir el ToolSet que ve GPT; o
2. entrar al Direct Command Lane.

---

# 46. Direct Command Lane — nuevo scope de alto valor

Para comandos internos simples, Jev puede evitar GPT.

## Estado de pedido

~~~text
"el 428 está listo"
~~~

1. regex extrae 428;
2. Jev Choice resuelve status=ready;
3. policy valida actor;
4. código ejecuta updateOrderStatus.

## Pago

~~~text
"el 512 ya pagó"
~~~

1. código extrae orderId;
2. Jev identifica mark_paid;
3. policy verifica confirmación;
4. código ejecuta.

## Analytics

~~~text
"cómo vendimos hoy"
~~~

Jev resuelve intent=analytics y period=today; el código ejecuta la query.

## Entidades

No pedir a Jev que genere nombres o IDs abiertos.

Pipeline:

~~~text
mensaje
  -> candidatos por DB/search/regex
  -> Jev Choice entre candidatos
  -> código usa ID exacto
~~~

Si hay argumentos abiertos o ambiguos, fallback a GPT.

---

# 47. Las SDD actuales deben convertirse en el primer eval suite

Prioridad:

- sdd/agente-humor-deteccion/specs.md
- sdd/agente-ya-voy-confirmacion/specs.md
- sdd/agente-precio-no-es-compra/specs.md
- sdd/deteccion-no-comercial/specs.md
- sdd/anti-loop-y-deteccion/specs.md
- sdd/contexto-persistente-estados/specs.md

Crear:

~~~text
evals/jev/
  customer-turns.jsonl
  seller-turns.jsonl
  admin-turns.jsonl
  fixtures.ts
  metrics.ts
  thresholds.ts
~~~

Agregar casos ambiguos/adversariales:

- "sí, pero todavía no lo mandes"
- "dale después veo"
- "ya voy" con delivery acordado
- "ya voy" sin carrito
- "100 burgers jajaja"
- "100 panes para un evento" real
- "cuánto está? si está a buen precio llevo dos"
- "marcá como pago... no, pará"
- "mandales a todos... bueno mejor no"
- mensajes partidos por buffer
- transcripciones con errores

---

# 48. Evaluación y calibración

Medir por decisión:

- precision
- recall
- false positives
- false negatives
- calibration buckets
- autonomous coverage
- review rate

Los costos son asimétricos.

Para explicitOrderConfirmation, un falso positivo es mucho más costoso que un falso negativo.

Para humanRequest, conviene priorizar recall.

Para broadcast, ningún threshold sustituye la confirmación obligatoria.

---

# 49. Versionado de policy

Agregar una versión explícita:

~~~ts
export const JEV_POLICY_VERSION = "2026-09-22.1";
~~~

Registrar:

- policyVersion
- model
- questionSetVersion
- thresholdSetVersion

Así se puede separar un cambio causado por modelo, pregunta, threshold o routing.

---

# 50. Conversation Intelligence — uso nuevo fuera del request path

Cuando una conversación termina o un pedido se entrega, Jev puede convertir la interacción en features estructuradas.

## Features

Choice outcome:

- converted
- abandoned
- info_only
- complaint_resolved
- complaint_unresolved
- human_handoff
- unknown

Choice primary_objection:

- price
- delivery
- wait_time
- stock
- payment
- product_fit
- trust
- no_objection
- other

Noul:

- customer_received_answer
- customer_showed_purchase_intent
- agent_missed_purchase_signal
- agent_asked_unnecessary_question
- possible_upsell_opportunity
- unresolved_issue
- repeated_question
- customer_satisfied_post_delivery

Score:

- frustration
- conversation_effort
- purchase_readiness

Tabla sugerida:

~~~text
conversation_features
- id
- conversation_id
- model
- policy_version
- outcome
- primary_objection
- features jsonb
- generated_at
~~~

Esto habilita analytics reales de motivos de pérdida, handoffs, objeciones, demanda no cubierta y fallos del agente.

---

# 51. Enriquecimiento de leads

Agregar tags operativos derivados de la interacción:

- b2b_intent
- b2c_intent
- price_sensitive_conversation
- delivery_question
- repeat_customer
- complaint_open
- human_requested
- high_purchase_intent

No inferir rasgos sensibles. Los tags deben describir la interacción comercial.

---

# 52. Media intelligence

Muzapp ya preprocesa audio, imagen, video y documentos.

Después de Whisper/Vision/extracción, Jev puede clasificar mediaIntent:

- payment_receipt
- product_reference
- complaint_evidence
- address_or_location
- menu_or_price
- unrelated
- unknown

Aplicaciones:

- comprobante -> flujo de pago/humano
- evidencia de reclamo -> prioridad y attachment
- referencia de producto -> tools de producto
- documento interno -> handler adecuado

Jev recibe texto/estructura, nunca bytes.

---

# 53. Follow-ups y tareas diferidas

Superficies existentes:

- src/app/api/cron/followup/route.ts
- sendPendingFollowups() en src/lib/channels/router.ts
- docs/sales-tasks-system.md

Jev puede decidir semántica, pero scheduler y ventana temporal siguen siendo código.

Preguntas opcionales:

- followupStillNeeded — Noul
- followupGoal — Choice: feedback_request, review_request, product_followup, no_message

Al comienzo, el texto debe salir de templates revisados.

---

# 54. Unified channel decision layer

src/app/api/meta/webhook/route.ts todavía tiene un TODO para procesar mensajes con agente.

No integrar Jev por canal de manera separada.

Arquitectura:

~~~text
channel event
  -> normalizer
  -> DecisionContext
  -> Jev preflight
  -> policy/router
  -> agent/handler
~~~

WhatsApp, Telegram y futuros canales Meta comparten intent, risk, handoff, telemetry y policy version.

---

# 55. Context selector / memory relevance

No es prioritario con historiales cortos.

Cuando crezcan notas, documentos, pedidos y memoria persistente:

1. recuperar candidatos;
2. evaluar relevancia por bloque;
3. pasar a GPT sólo el contexto relevante.

Esto aplica el principio de evitar context rot tanto a Jev como al LLM generativo.

---

# 56. Response Guard V2 — basado en riesgo

Ejecutarlo siempre cuando:

- hubo tool con side effect;
- la respuesta contiene precio/stock/estado obtenido de tools;
- hubo pago;
- hubo reclamo;
- hubo handoff;
- hubo acción sensible.

Puede omitirse para saludos y turnos triviales sin datos de negocio.

Los guards deterministas existentes se mantienen.

---

# 57. Cache de decisiones

Key:

~~~text
jev:{model}:{policyVersion}:{hash(state+questions)}
~~~

Redis TTL corto.

No cachear por mensaje solamente. Dos "dale" pueden tener significado distinto según el estado.

---

# 58. Pending Actions — requisito para confirmaciones

Crear pending_agent_actions:

~~~text
id
actor_type
actor_id
channel
conversation_id
tool_name
arguments_json
arguments_hash
risk_class
status
expires_at
created_at
confirmed_at
executed_at
~~~

Estados:

- proposed
- awaiting_confirmation
- confirmed
- executed
- cancelled
- expired

Un "sí" autoriza solamente la acción exacta pendiente identificada por arguments_hash.

Nunca debe autorizar una acción nueva generada en ese mismo turno.

---

# 59. Tool-call provenance

Cada side effect debe poder responder:

- quién lo pidió;
- qué mensaje lo originó;
- qué actor tenía permiso;
- qué tool se propuso;
- qué decisión permitió/retuvo;
- si hubo confirmación;
- qué código ejecutó;
- cuál fue el resultado.

Agregar un agent_actions event log cuando se implemente enforcement.

---

# 60. Política de fallos V2

## read_only

Si Jev falla: usar router actual/GPT.

## customer conversational

Continuar con fallback actual.

## business_write

Usar validaciones deterministas; si la intención queda ambigua, pedir confirmación.

## destructive

Nunca ejecutar por fallback semántico incierto.

## financial

Confirmación explícita o revisión.

## external_message

Destinatario verificable desde DB/argumento.

## bulk_external

No ejecutar sin pending action confirmado.

---

# 61. Retry policy recomendada

Realtime customer:

~~~ts
{
  timeout: 700,
  retry: { maxRetries: 0 }
}
~~~

Seller/admin:

~~~ts
{
  timeout: 1500,
  retry: { maxRetries: 1 }
}
~~~

Offline analytics/evals puede tolerar retries normales.

Estos números deben medirse desde el deployment antes de fijarse.

---

# 62. Policy constants en un solo lugar

Crear:

~~~text
src/lib/jev/policy/
  customer.ts
  seller.ts
  admin.ts
  output.ts
  thresholds.ts
  version.ts
~~~

No dispersar preguntas ni thresholds por handlers.

---

# 63. CI y regression harness

Agregar:

~~~bash
npm run eval:jev
npm run eval:agent-policy
~~~

eval:jev mide juicio del modelo.

eval:agent-policy mide si la aplicación toma la acción correcta dada una decisión fixtureada.

Esto separa errores de modelo de errores de policy.

---

# 64. Canary rollout

Después de shadow:

~~~env
JEV_ENFORCEMENT_PERCENT=5
~~~

Cohorte determinista por hash de conversationId/actorId.

Subir 5% -> 20% -> 50% -> 100% sólo con métricas dentro de tolerancia.

---

# 65. Prioridad revisada

## P0

1. Tool Manifest + roles/risk.
2. Resolver drift de prompts/capacidades.
3. Eval fixtures desde SDD.
4. Wrapper Jev con deadline, retry, telemetry y versionado.
5. Shadow preflight en customer, seller y admin.

## P1

6. WhatsApp semantic state vector.
7. Seller tool scoping.
8. Admin tool-family routing.
9. Pending actions para financial/destructive/bulk.
10. Retirar broadcastWhatsApp del seller por defecto.

## P2

11. Direct Command Lane.
12. Risk-based output guard.
13. Product/entity candidate resolution.
14. Decision cache.

## P3

15. Conversation Intelligence.
16. Lead enrichment.
17. Follow-up eligibility/template routing.
18. Media intent routing.
19. Meta/Instagram/Facebook sobre unified decision layer.

---

# 66. Arquitectura objetivo V2

~~~text
CHANNEL ADAPTERS
WA / TG / Meta
      |
auth / signature / dedup
      |
NORMALIZED DECISION CONTEXT
      |
JEV PREFLIGHT
fan-out questions
      |
POLICY ENGINE
roles / risk / thresholds
   /      |       \
direct   scoped   human
handler    GPT     handoff
   |        |
   |    proposed tool
   |        |
   |    TOOL POLICY
   |   allow/confirm/deny
   |        |
   +--------+
      |
deterministic domain guards
      |
execute
      |
response
      |
risk-based output guard
      |
channel send
      |
telemetry / audit


OFFLINE
completed conversations
      |
Jev feature extraction
      |
CRM analytics / evals / policy calibration
~~~

---

# 67. Qué queda explícitamente fuera del scope de Jev

Mantener determinista:

- YCloud signature
- Telegram authorization
- seller/admin role membership
- idempotencia
- webhook dedup
- human override TTL
- Redis queue
- DLQ
- retry counters
- fechas
- ventana 24h
- rate limiting
- precios
- stock
- totales
- delivery fee
- duplicate-order checks
- DB constraints
- order IDs
- permisos
- ejecución real de tools

Jev participa sólo cuando existe ambigüedad semántica real.

---

# 68. Conclusión después de la segunda pasada

La integración óptima ya no debe pensarse como "poner Jev delante del agente".

Debe construirse un Decision Plane transversal para Muzapp que sirva a customer, seller, admin, automation y futuros canales Meta.

Antes del enforcement hay tres fundamentos obligatorios:

1. Tool Manifest con roles y riesgo.
2. Eval suite basada en las SDD reales.
3. Pending Actions para confirmaciones exactas.

La oportunidad principal no es ahorrar tokens. Es sacar decisiones semánticas de regex, listas de keywords y prompt engineering disperso y convertirlas en una capa explícita, versionable, observable y calibrable.


---

# 69. Deuda técnica preexistente detectada en la segunda auditoría

Estos puntos no son responsabilidades de Jev. Deben resolverse antes o durante Phase -1 para que el Decision Plane no se apoye sobre flujos inconsistentes.

## 69.1 Seller capturado como lead

En el webhook de WhatsApp se resuelve isSeller, pero más adelante captureLeadIfNew(customerPhone, customerName, textForLead) se ejecuta sin excluir vendedores.

Eso permite que un teléfono configurado como vendedor sea insertado en leads si no existía previamente.

Recomendación: actor resolution debe ocurrir antes de cualquier lógica CRM específica de customer, y el lead capture debe ejecutarse sólo para customer.

## 69.2 Posible duplicación del último mensaje en seller context

En el callback del vendedor: el inbound ya fue persistido; getConversationMessages(conversationId, 4) puede incluir ese mensaje; después se agrega combinedText nuevamente como un nuevo user turn.

El customer path reemplaza el último user por el buffer combinado; el seller path lo agrega. Esto puede presentar dos veces el mismo contenido al modelo y sesgar selección de tools.

Recomendación: normalizar customer y seller mediante un único helper de construcción de historial buffered.

## 69.3 Dos ejecutores de follow-up con riesgo de carrera

Actualmente existen al menos dos mecanismos: src/app/api/cron/followup/route.ts y sendPendingFollowups() en src/lib/channels/router.ts, invocado al final del webhook.

Ambos consultan pedidos delivered con followupSent=false, envían y recién después marcan followupSent=true. Si se solapan, dos workers pueden leer el mismo pedido antes de que cualquiera lo marque y producir un follow-up duplicado.

Esto no se resuelve con Jev. Conviene elegir un único scheduler/worker como owner o implementar claim atómico e idempotency key por orderId + followupType.

Jev puede decidir si semánticamente hace falta el follow-up, pero la exclusión mutua y exactamente-una-vez pertenecen al código.

## 69.4 Meta webhook todavía no está listo para compartir el Decision Plane

src/app/api/meta/webhook/route.ts persiste mensajes y contiene un TODO para ejecutar el agente. Antes de conectarlo a la capa común debe alcanzar los mismos requisitos operativos que WhatsApp/YCloud: autenticidad del webhook, deduplicación por provider message ID, normalización de actor/canal, persistence consistente, human override, buffer/idempotencia, media handling y observabilidad.

## 69.5 Allowed IDs y normalización

Seller detection utiliza normalizePhone, mientras que el check de allowedPhoneIds compara directamente entry.phone con customerPhone. Conviene normalizar ambos lados de toda comparación de identidad telefónica y centralizarla en actor resolution.

## 69.6 El seller prompt favorece ejecución inmediata incluso para tools sensibles

El prompt base del vendedor contiene reglas orientadas a ejecutar inmediatamente sin confirmar. Eso puede servir para operaciones de bajo riesgo, pero no debe gobernar markAsPaid, cancelOrder ambiguo, mensajes externos sensibles ni broadcast.

La policy de seguridad debe vivir fuera del prompt y ejecutarse antes de la tool.

## 69.7 Gate adicional de Phase -1

Antes de enforcement Jev: excluir sellers de lead capture; unificar construcción del historial buffered; consolidar o idempotentizar follow-ups; normalizar identity matching; endurecer Meta webhook; y separar instrucciones de productividad del seller de la autorización real de tools.

Estos cambios mejoran Muzapp incluso aunque Jev se desactive completamente.
