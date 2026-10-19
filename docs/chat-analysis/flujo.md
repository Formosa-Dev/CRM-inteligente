# Flujo de venta del operador humano (WhatsApp)

**Faceta:** cómo el operador convierte una consulta en pedido.
**Fuente:** `chat_messages` (roles `user`=cliente, `human`=operador), `conversations`, `orders`, `leads`. Solo lectura.
**Período:** 2026-06-04 → 2026-10-12 (jun–oct).
**Método:** los threads de WhatsApp son de por vida por cliente, así que se segmentó en **episodios** = ráfagas de mensajes separadas por >4h de silencio. Un episodio "confirmado" contiene al menos un mensaje del operador de cierre verificado ("ya esta todo", "ya salio", "en camino", etc.).

## Volumen y caveats de datos

| Métrica | Valor |
|---|---|
| Msgs operador (`human`) | 26.180 |
| Msgs cliente (`user`) | 23.918 |
| Conversaciones (1 por teléfono) | 653 (589 con msgs del operador) |
| Episodios totales (gap >4h) | ~3.860 |
| Episodios con cierre verbal | ~334 |
| Pedidos en tabla `orders` | 163 (90 delivered, 82 pan_mayorista, 81 hamburguesas) |

**Caveat crítico:** ~15% de los mensajes del operador son placeholders sin contenido:
- `[Mensaje desde WhatsApp Business]` ×3.571 — escritos desde la app de WA Business directamente; el contenido real no se sincronizó (probablemente respuestas rápidas, catálogo, o texto).
- `[image]` ×3.163, `[audio]` ×771, `[video]` ×58, `[document]` ×9.

El análisis de frecuencias subestima lo que el operador dice — especialmente porque gran parte del menú se comunica **mandando imágenes, no texto**.

## El flujo real: 6 etapas con orden flexible

Leyendo episodios completos, el patrón dominante de venta es:

```
CL: consulta/pedido (abre el cliente en ~83% de los episodios confirmados: 277 de 334)
OP: "holaa buenas, sii"  (+ ráfaga de imágenes de menú si pidió carta/precio)
CL: define qué quiere (producto/cantidad, a veces promo de historias)
OP: "Dalee" + UNA pregunta faltante ("Con envio?")
CL: responde / manda ubi / manda comprobante
OP: precio total "Xmil seria todo" + alias si es transferencia
OP: "Ya esta todo" (retiro) | "Ya salio su pedido" + ETA (envío)
```

### Verbatim — venta con envío + transferencia (conv 437, 2026-10-08)

```
01:36 CL | Puede ser esa promoción y una muzza?
01:39 OP | Dalee
01:40 OP | Con envio?
01:40 CL | Si mi bebé — Cuánto sería todo?
01:40 OP | 36mil seria todo
01:41 CL | Pásame tu alias
01:42 OP | [alias]
01:42 OP | [titular]
01:44 CL | [image]              ← comprobante de transferencia
01:44 CL | Muchas gracias — Espero el pedido — Dentro de cuanto?
01:47 OP | Dentro de 30minutos
02:21 OP | Ya salio su pedido
```

### Verbatim — venta con retiro (conv 282, 2026-10-12)

```
03:04 CL | Holaa, todavía atienden?
03:05 OP | Holaa buenas, sii
03:06 CL | Me podes pasar la carta
03:06 OP | [image] ×12          ← el menú se manda como ráfaga de fotos
03:09 CL | Te queda la promo de las 4 hambur?
03:10 OP | Sii — Por 10mil
03:15 CL | 2 promos de 10 mil y 1/2 doc de empanadas de jyq
03:16 OP | Puede ser 6 de carne? — Pq sin stock de jyq
03:16 CL | 2 promos de las hambur nomas entonces
03:29 OP | En 5 minutos esta todo
03:40 OP | Ya esta todo
03:44 CL | Dale ahi voy
03:55 CL | Estoy                ← avisa que llegó
03:55 OP | Muchas gracias
```

### Orden típico y variantes

- **No es un checklist rígido.** De 334 episodios confirmados: solo 120 tienen pregunta envío/retiro del operador, 67 tienen pedido de ubicación, 87 mención de alias/pago. La secuencia estricta envío→ubi→alias aparece en solo 5 episodios. **Pregunta solo lo que falta.**
- Posición mediana de cada tema dentro del episodio (0=inicio, 1=fin): cantidad ~0.17 (temprano, lo dice el cliente) → envío/ubicación ~0.46-0.50 → precio ~0.57 → sabor/pago ~0.65-0.67 → **confirmación ~0.74** (no es el último mensaje: sigue charla post-venta).
- Precios siempre en formato abierto: `10mil`, `36mil seria todo`, `50mil`, `21mil seria todo`, `$19mil es todo`.

## Qué PIDE vs qué INFIERE

| Dato | Pide explícitamente | Infie­re/omite |
|---|---|---|
| Envío vs retiro | **La pregunta gate.** "Con envio?" / "Con envio o buscas?" — 560 msgs en 281 conversaciones. Es lo primero que resuelve después del pedido. | Nunca asume: siempre lo pregunta cuando el cliente no lo dijo. |
| Ubicación | "Pasame tu ubi" / "me pasas tu ubi" (56 exactas) — 400 msgs de ubicación en 227 conversaciones. Solo si hay envío. | Con clientes regulares o cuando el cliente manda la ubi primero (345 pines compartidos en 221 conversaciones — el cliente la manda **sin que se la pidan** con frecuencia), no pregunta. Marcadores "de siempre/la misma" son raros (11 msgs): la inferencia es silenciosa, no verbalizada. |
| Pago | "Tenes transferencia" temprano; alias en 2 mensajes (alias + nombre del titular — ~350 envíos combinados, top-10 de mensajes cortos). 506 msgs de pago en 156 conversaciones. | No pide nombre del titular, no valida comprobante en texto: el `[image]` del cliente = pagó. |
| Cantidad/producto | Casi nunca pregunta cantidad (67 msgs en 40 convs): toma el pedido como viene y lo repite dentro del total ("y una mozzarella nomas quiere?"). | Cuando falta stock ofrece sustitución directa: "Puede ser 6 de carne? Pq sin stock de jyq", "No hay pizzas". |
| Horario | "para las X?", "Dentro de 30minutos" — 89 msgs en 55 convs. La demora la comunica él, no la negocia. | — |
| Nombre | Prácticamente nunca (34 msgs en 33 convs). | El cliente se identifica por el perfil/nombre de WhatsApp. |

## Cuántos mensajes toma cerrar

Por episodio confirmado (no por conversación entera):

| Métrica | Mediana | p90 |
|---|---|---|
| Msgs del operador | **14** | ~29 |
| Msgs del cliente | **13** | ~25 |
| Duración del episodio | **~83 min** | ~210 min |
| Latencia respuesta OP→CL | ~1,4 min (82 s) | ~21 min |

Episodios mínimos típicos: el cliente llega con el pedido ya armado ("2 promos de las hambur") → 4-6 mensajes del operador y se cierra. Los episodios largos (>30 msgs) son negociación, espera de cocina, o delivery con coordinación.

## Cuando falta un dato crítico: de a UNO

Evidencia dura: en episodios confirmados, mensajes del operador que tocan 2+ temas a la vez = **14**, vs **326** que tocan uno solo. Mensajes con 2+ `?` en todo el dataset analizado: **1**.

Patrón secuencial real (conv 513, 2026-10-12 — envío saturado, improvisa):

```
00:37 CL | Con envio
00:42 OP | Tenes transferencia          ← pago primero
00:45 OP | Pasame tu ubi                 ← después ubicación
00:45 CL | [Ubicacion]: ubicación compartida (-26.••, -58.••)
00:47 OP | $19mil es todo
00:49 OP | Tenes uber? — Podes mandar a retirar — Pq tengo una banda de pedidos y el delivery no llega
00:53 OP | El envio nomas pagale lo otro tranferime   ← acordata: cobra el delivery, el cliente paga comida por MP
```

Cuando el delivery propio no da abasto, **improvisa la alternativa** (Uber que retira) en vez de perder la venta. Otro recurso: "No tengo delivery" → empuja retiro.

## Cómo confirma

La confirmación **no es "te anoté"** ("anotado" aparece solo 3 veces en 26.180 mensajes). Confirma anunciando el estado del pedido:

| Frase | Frecuencia | Uso |
|---|---|---|
| `ya esta todo` | 119 (+ "ya esta" 64) | Retiro: pedido listo, "podes venir" |
| `ya salio` / `ya salio tu/su pedido` | ~80 | Envío: despachado |
| `en X minutos` / `dentro de 30` | ~15 | ETA |
| `te mandamos` / `mandamos` | ~10 | Envío programado |

Split global: mensajes de "listo para retirar" ~679 vs "despachado/en camino" ~134 → **el negocio es ~5:1 retiro sobre envío**. Post-cierre: "Muchas gracias" / "Me avisa cuando llegue" (retiro) o ETA (envío).

Acks universales: `dalee` (559), `sii` (485), `dale` (312), `sisi`, `okey`, `nop`, risas `jajaja` (~270). Tono muy informal con regulares: "primo", "dale amigo", "Payaso", "gil".

## Conversaciones abandonadas

- ~2.165 episodios con ≥3 mensajes del cliente terminan **sin cierre verbal**; ~644 incluyen charla de precio.
- Se cortan parejo: en ~1.080 el último mensaje es del cliente (él desaparece), en ~1.085 es del operador (el cliente no responde).
- Punto de fuga típico: **después del menú/precio.** Cliente pide carta → ráfaga de imágenes → silencio (conv 872, 2026-10-12: pidió precio de hamburguesas + horario → "Hasta las 00hs" → nunca volvió). O "Me desocupo y te aviso" (conv 864) y no avisa.
- El operador **no hace follow-up de recuperación**: cuando el episodio muere, muere. Reaparece cuando el cliente vuelve a escribir otro día.

## Otras señales del oficio

- Horario real: opera de noche; episodios confirmados a las 2-3 AM son normales. "Hasta las 00hs" dicho a las 2 AM — horario elástico.
- Equipo: "[compañera] esta cocinando" — el que escribe (el operador/dueño) a veces no es quien cocina. "d1"/"Dale d1 [nombre]" = delivery asignado.
- Menú = imágenes: ráfagas de **12-15 `[image]`** en <3 min cuando piden carta/precios.
- El `[Mensaje desde WhatsApp Business]` sugiere uso de respuestas rápidas/etiquetas/catálogo de la app — contenido invisible para nosotros.

## REGLAS PARA EL AGENTE DE VENTAS

1. **Vendé, no encuestes.** El cliente abre con consulta o pedido; respondé directo. Si pidió carta → mandá el menú. Si pidió algo concreto → "Dalee" + lo que falta. No interrogar.
2. **Una pregunta por mensaje.** Nunca juntar envío+ubicación+pago+nombre en un solo globo. Secuencia como el operador: `Con envio?` → `Pasame tu ubi` → `Tenes transferencia` → total → confirmación.
3. **Preguntá envío-vs-retiro apenas el pedido quedó claro** ("Con envio o buscas?"). Es la bifurcación central: ~5 de cada 6 ventas son retiro.
4. **Ubicación solo si hay envío.** Si el cliente ya mandó pin/dirección o es conocido, no la pidas de nuevo. Pedila así: `Pasame tu ubi`.
5. **Precio siempre como total cerrado:** "Xmil seria todo" — en miles, sin decimales, incluyendo lo acordado. Si falta un dato para el total, no des el total.
6. **Pago:** si transfiere, mandá el alias en dos líneas (alias / nombre del titular) y esperá el comprobante (imagen). No pedir validaciones extra. "Tenes transferencia" sale temprano cuando hay que moverse rápido.
7. **Confirmar = anunciar estado, no tomar nota.** Nada de "tu pedido fue registrado": `Ya esta todo` (retiro) + `podes venir`, o `Ya salio su pedido` + ETA realista (`Dentro de 30minutos`) en envío.
8. **Sin stock = oferta, no muro.** "No hay pizzas", "sin stock de jyq" + sustituto concreto: "Puede ser 6 de carne?". Nunca un "no" seco.
9. **Delivery saturado → alternativa, no cancelación.** El operador ofrece que retiren por Uber/tercero y separa quién cobra qué ("El envio nomas pagale, lo otro tranferime").
10. **Tono: barrial cálido.** Minúsculas, abreviaciones ("dalee", "sii"), emojis ligeros, confianza con regulares. Nada de lenguaje corporativo ni "estimado cliente".
11. **Cierre con gracia:** "Muchas gracias" / "Me avisa cuando llegue" (retiro) o ETA (envío). Y si el cliente desaparece tras el precio, **no perseguir** — queda para la próxima.
12. **No inventar datos:** el operador nunca asume dirección, ni cantidad, ni promo. Solo repite lo que el cliente dijo. Cuando duda, pregunta UNA cosa.
