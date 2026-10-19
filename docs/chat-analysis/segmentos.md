# Análisis: Segmentos de clientes — cómo varía el trato del operador

Fuente: `chat_messages` (Neon, producción), jun-oct 2026. Solo lectura.
Roles: `human` = operador/dueño (~26.180 msgs), `user` = cliente (~23.918), `assistant` = Karen (~878).
Base: 653 conversaciones (570 con nombre), 32 leads marcados `b2b`, 163 orders.

> Nota de método: "días activos" = días distintos con al menos 1 mensaje en la conversación. Los segmentos se infieren de `leads.type`, `orders.order_type` y vocabulario real de los mensajes.

---

## Mapa de segmentos detectados

| Segmento | Tamaño aprox | Cómo se reconoce |
|---|---|---|
| **Personal** (amigos/familia/pareja) | ~10-15 convs muy activas | Charla sin negocio: birras, "gato", "loco", "mi re amoor" |
| **B2B / pan mayorista** | 32 leads `b2b`, ~20 convs activas | "docena", "prepizzas", "para mañana", pago por comprobante |
| **B2C recurrente** | ~86 convs con 4+ días activos | "lo de siempre", pide directo sin menú |
| **B2C ocasional/nuevo** | ~292 convs de 1 solo día | Pide menú/promo, pregunta envío y precio |

**Caveat importante**: las conversaciones con MÁS mensajes no son clientes — varias del top son personales (229, 211, 203, 214, 637, 615, 738, 731, 439, 210, 213, 273). Volumen de chat ≠ volumen de compra.

---

## 1. Recurrentes vs nuevos

### Con recurrentes: va directo, sin saludo formal

Solo ~6,7% de los 26.180 mensajes del operador abren con saludo ("hola/buenas/..."). Con clientes de todos los días, el primer mensaje del día es directamente operativo o proactivo:

- `[207|Cliente A, 20-jun]` "Dale señor"
- `[212|Cliente B, 12-jun]` "Dalee amigo"
- `[204|Cliente C, 16-jun]` "Holaa ya tengo panes"
- `[208|Cliente D, 3-ago]` "Cuantos necesitas"
- `[212|Cliente B, 9-jun]` "Queres Prepizzas?"
- `[208|Cliente D, 20-jul]` "Ya tengo panes si queres pasar a buscar"

**Vende proactivamente**: le anticipa la necesidad al mayorista:
- `[207|Cliente A, 6-jun]` "Buenas Noches señor como le va ? Quería saber si va a necesitar Prepizzas para mañana"
- `[234|Cliente E, 27-ago]` "Vas a necesitar panes para hoy"

### Con nuevos: saluda, confirma y pide datos

- `[217|Cliente F]` "Holaa buenaas, tenemos esa promo"
- `[288|Cliente G]` "Holaa buenas noches, siii" → "La promoción nomas" → "El envio es aparte" → "Me confirmas cual es tu pedido"
- `[286|Cliente H]` "Buenas noches" → "Para envio?"
- `[294|Cliente I]` "Con envio?" / "ya cerramos"
- `[299|Cliente J]` "Buenaas hoy no abrimos"

Patrón: con el nuevo el operador (a) confirma que tiene la promo/stock, (b) pregunta si es envío o retiro, (c) da el total con envío ("28 seria con el envio", "19mil seria todo con envio"), (d) avisa si está cerrado o sin stock en vez de dejar colgado.

### Asume el pedido de siempre

Los clientes mismos lo piden así — y el operador responde sin repreguntar:
- `[397|Cliente K, 6-jul]` cliente: "Puede ser el mismo pedido de siempre?" / `[20-jul]` "Lo de siempre nomas porfa" / `[6-ago]` "Tenes el cheddar de siempre?"
- `[444|Cliente L, 25-ago]` operador: "La misma de siempre?"
- `[262|Cliente M, 18-jun]` operador: "Donde siempre te llevo?" — recuerda la dirección sin pedirla
- `[253, 21-sep]` "Como siempre nomas entonces"

## 2. Mayoristas (B2B) vs consumidor final (B2C)

### Vocabulario y operación B2B

Todo gira alrededor de **docenas, unidades, prepizzas y "para mañana"**:

- `[212|Cliente B]` "2 docenas parmesano", "voy a querés dos docenas más de pan para hamburguesas parmesano para hoy"
- `[204|Cliente C]` "te pido una docena más si podes porfa, osea 36" — suma sobre pedido anterior
- `[234|Cliente E]` "Voy a querer 3 docenas de panes para hoy", "Para mañana quiero 4 docenas", "Cuantas docenas tenes?"
- `[208|Cliente D]` "1 docena de pan de lomito x 12 parmesano Y 1 docena de pan de hamburguesa pero quiero 6 de parmesano Y 6 de sesamo"
- `[230|Cliente N]` "te encargo para mañana una bolsita de 4 unidades de lomito"
- `[215]` "quiero 18 unidades con parmesano...tdo junto en una sol bolsa"

### Precio B2B = lista fija por docena, sin regateo por volumen

El operador pasa la lista completa como bloque (verbatim, repetido en varias convs, jun 2026):

> "Panes de Hamburguesas x Docena: Los simples $4200 Los de sésamo $4400 Parmesano $4600. Panes de Lomito x Docena: Los simples $4400 Los de sésamo $4600 Parmesano $5000. Prepizzas $800 c/u apartir de 1"

- `[302|Cliente O]` cliente: "Si te compro 60unidades el mismo precio" → respuesta: mantiene precio por docena ("60 sésamo serían $22.000"). **No hay descuento por volumen.**
- `[318|Cliente P]` "5000 la docena del pan de lomito" — responde el precio puntual primero, después la lista.

### Cobro B2B/B2C: transferencia + comprobante

"Me pasas comprobante" es el cierre de cobro dominante (aparece docenas de veces, a Clientes E, I, G y otros mayoristas). El operador insiste si no llega: `[743|Cliente Q]` "todavía no me paso el comprobante de pago", `[234]` "Falta 10, me pasa comprobante".

### Dos registros dentro de B2B

- **Formal ("Señor" + usted)**: con Cliente A (`207`) — "Buenos Diaas Señor, ya esta su pedido", "mil disculpas por la tardanza", "Si señor". Cliente mayor, trato deferente.
- **Camarada ("amigo"/"ami")**: Clientes D, B, V — "Holaa amigoo recien tengo todo", "Veni amigo", "Dale ami".

En números (msgs `human`): B2B usa MÁS términos de afecto por mensaje (~3,8% vs ~1,6% en el resto) pero CASI NADA de risas "jaja" (~0,4% vs ~2,6%). Trato cálido pero todo-negocio.

## 3. Conocidos/amigos vs desconocidos

### Segmento personal (off-business)

Las convs más activas del sistema son charlas sin venta: 229 (117 días, pareja/familia — "No te olvides tu coca", "En el freezer"), 203 Contacto A ("Andá a cagar"), 211 (amigo, "la final del mundial"), 214 (favores entre amigos), 637 ("estas para unas birras"), 439 (pareja: "regálame una hamburguesa si tanto soy tu amor" → "Dos te voy a regalar"), 213 ("Que onda gato"), 210 ("bro").

Registro: voseo guarro, chistes, favores, regalos de comida. **Karen ya desvía este segmento**: `[213]` assistant: "Ahí te paso con el dueño, yo estoy para cosas del negocio" — y handoff al humano.

### Grises: amigos que también compran

`731`: "Estamos en casa con [amigo], te pinta caer" … y el mismo amigo después pide "La onda un combo de este / Cuánto el envío al fontana?". El operador mezcla plan personal y venta en el mismo hilo sin cambiar de tono.

### Desconocidos

Trato correcto y corto, adapta género/edad percibida del nombre: "Holaa señora, ya tengo su pedido" (215), "Buenos Diaas [nombre] como estas?" (205), "Holaa mami buen dia" (206), "Holaa amigo, buenas" (226).

## 4. Nombres propios recurrentes y frecuencia

Top clientes comerciales por actividad (excluidos personales; días = días con mensajes jun-oct):

| Cliente | Conv | Segmento | Días activos | Nota |
|---|---|---|---|---|
| Cliente E | 234 | B2B pan | 116 | La mayorista #1: pide docenas casi a diario |
| Cliente U | 236 | B2B pan | 113 | También compra pizzetas ("3 paquetes de 24 unidades") |
| Cliente T | 755 | B2C | 28 | Hiperactiva sep-oct: 1135 msgs en 1 mes |
| (anónimo) | 211 | personal | 89 | Amigo, no cliente |
| Contacto A | 203 | personal/B2B lead | 47 | Charla de amigos; figura como lead b2b |
| Cliente W | 219 | B2C | 49 | "Que lo que queres" — trato directo |
| Cliente (display "-.-") | 793 | B2B prob. | 18 | 351 msgs en 18 días |
| Cliente R | 392 | B2C | 33 | charla + aviso off-topic ("las luces de tu camioneta") |
| Cliente S | 233 | B2B | 52 | 4 orders pan_mayorista en jun |
| Contacto B | 273 | personal+compra | 24 | mixta |

Orders (jun, tabla `orders`): top compradores pan_mayorista = Cliente D 5, Cliente V 5, Cliente C 5, Cliente A 4, Cliente X 4, Cliente S 4, Cliente B 4; hamburguesas = Cliente Y 3 y varios con 2. Nota: `orders` registra sobre todo junio — el volumen real de pedidos por WhatsApp es mucho mayor que lo que la tabla captura.

## 5. Personalización

- **Recuerda direcciones**: "Donde siempre te llevo?" — no repregunta la dire a recurrentes.
- **Recuerda gustos**: "Tenes el cheddar de siempre?", "La misma de siempre?".
- **Anticipa por historial**: a Cliente E le dice "Vas a necesitar panes para hoy"; a Cliente A le ofrece prepizzas el día antes.
- **Registra contexto de vida**: "Sabes que, las luces de tu camioneta estan prendidas" (392) — relación que excede la transacción.
- **Voseo universal, usted casi nulo**: "usted" aparece ~15 veces en 26.180 msgs (0,06%); verbos en voseo ~789+. El "su pedido/señor" se reserva a mayores o muy nuevos.
- **Casi sin emojis**: solo ~80 msgs con emoji (0,3%). Su canal de calidez es "amigo/reina/mami/dalee/sabes", no emojis. Sí manda mucha imagen: ~3.163 `[image]` (menú, fotos de producto, comprobantes) y ~771 audios.

## 6. Horarios y patrones por segmento

**B2B (pan)**: activo 8-21h, pico 19-21h, nada 4-7h. Pide "para hoy" o "para mañana". **Pico sábado** (652 msgs user sábado vs 253 domingo) — el pan de finde se encarga el sábado. Domingo flojo.

**B2C (hamburguesas)**: pico 20-23h y sigue hasta ~1am (compra nocturna de cena). Fuerte jueves-domingo (~3.500-4.000 msgs/día), baja lunes-martes.

**Ritual de estados**: avisa cada hito — "ya esta todo" (~119), "ya salio tu/su pedido" (~50), "llega el delivery y sale tu pedido", "recien salio del horno", "ya tengo panes". Si hay demora: "La verdad que estábamos explotados de pedidos", "mil disculpas por la tardanza", "Por la lluvia el envio seria $3500".

**Transparencia IA**: cuando retoma un chat que manejó Karen, lo aclara: "estabas hablando con el chatbot", "te estaba contestando el asistente de wsp", "Ese precio te mando el chat bot".

---

## REGLAS PARA EL AGENTE DE VENTAS

Reglas accionables extraídas del comportamiento real del operador:

1. **Segmentar antes de responder.** Detectar: personal (handoff inmediato: "Ahí te paso con el dueño, yo estoy para cosas del negocio"), B2B (docenas/unidades/prepizzas/"para mañana"), B2C recurrente (historial >4 días o pedido repetible), B2C nuevo.
2. **Voseo siempre. "Usted" solo si el cliente lo usa primero** o es claramente mayor. Nunca "usted" por defecto — el operador no lo usa (0,06%).
3. **Ir directo al punto con recurrentes.** Si el cliente tiene historial, no abrir con saludo + menú completo. Abrir con lo operativo: "Holaa [nombre], lo de siempre?" o confirmar cantidad: "Cuantos necesitas".
4. **Asumir y confirmar el pedido habitual.** Si el cliente dice "lo de siempre" y hay historial, confirmar items/dirección sin repreguntar todo ("La misma de siempre? Envío a [dirección conocida]?").
5. **B2B: hablar en docenas y unidades, nunca en promos B2C.** Precio fijo por docena según lista vigente; NO ofrecer descuento por volumen (el operador mantiene el mismo precio aunque pidan 60 unidades). Aceptar "para hoy" y "para mañana".
6. **Venta proactiva a mayoristas conocidos:** si el recurrente B2B escribe de día, es válido anticipar: "Vas a necesitar panes para hoy?" / "Prepizzas va a necesitar para mañana?". El sábado es el pico de pan.
7. **Cobro = transferencia + comprobante.** Pedir comprobante ni bien se acuerda el pago ("Me pasas comprobante"); reclamarlo sin vueltas si no llega.
8. **Avisar cada estado del pedido** con la frase ritual: "ya tengo tu pedido" → "ya esta todo" → "ya salio tu pedido". Si hay demora o sin stock, decirlo de entrada ("estabamos explotados", "nos quedamos sin stock de papas"), nunca dejar colgado.
9. **Preguntar envío o retiro temprano** con clientes nuevos, dar el total CON envío incluido y aclarar "el envio es aparte" si corresponde. Si está cerrado: "hoy no abrimos" y ofrecer para el día siguiente.
10. **Tono por sub-segmento:** "Señor/Señora" + frases deferentes ("mil disculpas") para B2B formal/mayores; "amigo/ami/dalee" para B2B jóvenes y B2C; nunca emojis como muleta (el operador usa ~0) — calidez por palabra, no por sticker.
11. **Aclarar cuando el humano toma el control** si hubo confusión previa de la IA ("disculpa, te estaba contestando el asistente") — y al revés: si el chat es personal, avisar y derivar al dueño.
12. **Mandar foto/lista de precios cuando piden precios** — el operador responde precio puntual y después pega la lista completa por docena. En B2C nuevo, mandar menú (imágenes) antes de negociar.
