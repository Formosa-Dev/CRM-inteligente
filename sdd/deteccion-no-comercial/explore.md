# Explore: Detección No-Comercial

## Problema

El bot no distingue entre un cliente que quiere comprar y alguien que:
- Es amigo del dueño saludando ("Que ondaaa cumpa")
- Está jodiendo/exagerando (cantidades irrealess, productos que no existen)
- Pregunta por temas no relacionados al negocio
- Habla con el dueño que ahora atiende desde el mismo número

Cuando esto pasa, el bot arranca el flujo de venta como si fuera un cliente y termina:
- Dando respuestas sin sentido
- Repitiendo loops de "¿qué te preparamos?"
- Generando confusión

## Evidencia (Chat 6)

```
Cliente: "Que ondaaa cumpa"
Bot: "No encontré ningún pedido, me pasás el número de pedido o decime qué compraste?"

(interrumpe el dueño)
Bot: "Holaa amigo como estas?"
Cliente: "Tb amigo vos que onda"
Bot: [audio]
Cliente: "Todo tranqui vro en la lucha"
Cliente: "No tenes esa shit ? Por 10"
Bot: [audio]
Cliente: "De una de una"
```

El bot claramente no entiende que es una conversación entre amigos.

## Evidencia (Chat 1)

```
Cliente: "Eh?"
Bot: "Te pregunté qué querés pedir, ¿querés que te mande el menú?"
Cliente: "Mándame si"
Bot: "Holaa — ¿qué te preparamos?"
Cliente: "Jajaja"
Bot: "Holaa ¿qué te preparamos?"
Cliente: "Q pendejo jajaja"
Bot: "¿qué te preparamos?"
Bot: "Holaaa"
```

El cliente claramente está jodiendo y el bot no lo detecta.

## Estado Actual

Ya existe en el prompt V6:
- `[HUMOR Y EXAGERACIONES]` — detecta cantidades irreales y productos que no existen
- `[NO HACÉS]` — reglas generales
- Anti-loop (CHANGE-03) — detecta repetición de mensajes

Pero NO existe:
- Detección de "amigo del dueño" / conversación no-comercial
- Transferencia automática a humano cuando se detecta
- Clasificación del primer mensaje como comercial vs no-comercial

## Lo que falta

1. Clasificar el **primer mensaje** de una conversación:
   - Comercial: "Hola, quería pedir...", "Tienen hamburguesas?", etc.
   - No-comercial: "Que onda cumpa", "Todo bien?", hablando de otra cosa
   - Ambiguo: "Holaa", "Buenas"

2. Respuesta según clasificación:
   - No-comercial: "Holaa, ¿todo bien?" + si insiste no-comercial → "Ahí te paso con el dueño, yo estoy para cosas del negocio"
   - Ambiguo: responder normal, pero si los próximos 2 mensajes no son comerciales → transferir a humano
   - Comercial: flujo normal

3. Detectar **después de los primeros mensajes** si la conversación derivó a no-comercial

## Archivos afectados

- `src/lib/whatsapp/agent.ts` — agregar clasificación pre-flight
- `src/lib/whatsapp/prompt-builder.ts` — agregar sección [NO COMERCIAL] al prompt V6
- `src/lib/whatsapp/anti-loop.ts` — ya tiene classifyMessageType, extender para no-comercial
