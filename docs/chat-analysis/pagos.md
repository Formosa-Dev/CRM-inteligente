# Cómo cobra el operador por WhatsApp — análisis de PAGOS

Corpus: `chat_messages` (jun-oct 2026). role `human` = operador/dueño (26.180 msgs), `user` = cliente (23.918), `assistant` = Karen/bot (878). 653 conversaciones, 163 orders (la tabla `orders` casi no registra método de pago: `payment_method` es NULL en 145/163 — la verdad está en el chat).

Notas de método:
- Los mensajes `[Mensaje desde WhatsApp Business]`, `[image]`, `[audio]`, `[document]` en `human` son placeholders de media/auto-respuesta, no texto real del operador.
- En `user`, las imágenes están en `content_attributes` (345 imágenes: comprobantes, capturas de promo, ubicaciones).
- El corpus mezcla clientes con relaciones personales (familia, proveedores, amigos, pareja). Se separó lo comercial de lo personal al interpretar.

---

## 1. Métodos de pago mencionados (frecuencia aprox. en mensajes)

| Método | Operador | Cliente | Lectura |
|---|---|---|---|
| Transferencia (`transf*`) | ~58 | ~250 | Dominante como pago digital |
| `alias` (pedir/dar) | ~83 | ~164 convs | LA palabra del flujo; casi nunca "CBU" |
| Efectivo | ~51 | ~133 | Contraentrega / retiro |
| Comprobante/captura | ~33 pide OP | ~11 | Requisito del operador |
| Vuelto/cambio | ~49 | ~60 | Tema frecuente |
| "Mercado Pago" por nombre | 5 | 27 | Nadie dice "MP" para cobrar; se dice "alias" |
| CBU/CVU | 0 | 10 | Solo clientes que mandan su CBU para recibir vuelto |
| Tarjeta/débito/crédito/POS | ~8 | ~7 | Prácticamente inexistente |
| QR | 0 | 1 | No se usa |
| Seña/anticipo | 1 | ~6 | Informal, solo pedidos grandes |

**Conclusión: hay exactamente dos métodos reales — efectivo contraentrega y transferencia al alias del dueño.** Sin links de pago, sin QR, sin tarjeta, sin descuento por efectivo ("Descuento en efectivo hay? O es mismo precio que transferencia?" → "Mismo precio" — conv 386, 18-jun).

## 2. Cómo PIDE el pago

El operador casi nunca inicia el cobro: el cliente propone "te transfiero" y él responde con el alias. Su alias es información VOLÁTIL y viaja en texto plano:

- Junio–19 jul: `Lea..LEMON`
- Desde ~20 jul (cambió porque la gente mandaba mal): `Mrs..LEMON` — verbatim: "Holaa , cambie mi alias mrs..LEMON / Pasaron mal de vuelta y cambie nomas" (conv 229, 20-jul)
- Titular, a veces en el mismo mensaje y a veces en el siguiente: `Leandro Javier Patiño` (~197 menciones; ~378 msgs contienen "lemon")

Secuencia típica de cobro (transferencia):

```
CLI  Te transfiero / Me pasas tu alias / Pasame alias así te transfiero
OP   14500            ← total primero, solo
OP   Mrs..LEMON       ← alias solo en un mensaje
OP   Leandro Javier Patiño   ← titular (opcional, ~la mitad de las veces)
CLI  [image]          ← comprobante
OP   Gracias / Ya esta / Sisi
```

Ejemplos verbatim:
- "13mil seria todo / Lea..LEMON / Me pasas comprobante" (conv 294, 9-jun)
- "Sis, mrs..LEMON / Leandro Javier Patiño" ante "transferencia aceptas?" (conv 842, 2-oct)
- "Mrs..LEMON / Leandro Javier Patiño" ante "me pasas alias para señarte eso porfis" (conv 724, 9-sep)
- Cuando paga en efectivo: simplemente "Dalee" / "Si amigo" — no se pide nada más.

Pide comprobante de forma directa: "Me pasas comprobante", "Me pasas comprobante ni bien puedas", "Me pasas comprobante porfa", y justificación operativa: "Comprobante sino no anota dice" (conv 257, 2-oct — la persona que anota pedidos exige el ticket). Con frecuentes clientes a veces no hace falta ("Está bien no es necesario comprobantes" — clienta Silvia, conv 392).

## 3. Cómo CONFIRMA recepción

Estilo: 1 mensaje corto, informal, sin ceremonia. Del análisis imagen→respuesta (mediana: 1 mensaje de gap, ~2 min):

- "Gracias" / "Muchas gracias" / "Dalee franco gracias" — lo más común
- "Sii, llego / Gracias" (conv 258, 3-sep, tras chequear la cuenta)
- "Ya esta" / "Ya ta"
- "Dale" / "Sisi" / "Okis"
- A veces NO hay confirmación explícita: el placeholder de WhatsApp Business queda como única respuesta inmediata.

Cuando el dinero NO llega, lo dice igual de corto: "No le llego??" / "No" / "Todavia no me llego" / "Pasoo maaal" — y vuelve a pedir el comprobante para verificar qué pasó (conv 258, 3-sep; conv 214, 9-jun).

Si el comprobante muestra datos correctos pero en su cuenta no cayó, confía en la imagen: patrón observado: pide comprobante → cliente manda captura → "Sisi, llego / Gracias".

## 4. Pagos pendientes

- El operador marca saldos en el chat, directo y con monto: "quedo pendiente 2mil / De tu pedido" (conv 402, 20-jun), "14500 quedo pendiente" (conv 407, 20-jun), "Todavia quedo pendiente 100" (conv 325, 19-sep), "Falta 10, me pasa comprobante" (conv 234, 2-sep), "Falta 24mil del envio de jer9" (conv 229, 8-jun).
- Cuando falta plata en una transferencia ya hecha, desglosa la cuenta: "Disculpa faltan 1000 / Pq el pedido era 18 y el envio 3mil / Y me diste 20" — y si él se equivocó: "Ahh / Espera / Disculpa / Anote mal / Ya le despedimos al que anoto" (conv 444, 30-jun).
- Deudas corrientes se negocian en criollo: CLI "me debes dos mil / o te debo 7 mil yo" → OP "Me debes 8 nomas ya" (conv 236, 27-ago). CLI "Yo te debo 70" → OP "Pasame tu alias / Te mando 50" (conv 211, 9-oct — saldo parcial).
- No hay secuencias de recordatorio agresivas: un aviso factual con el monto alcanza. Si el cliente dice "después te pago", responde "Dale" y queda pendiente.

## 5. Vuelto

Es EL patrón distintivo de este negocio. El delivery casi nunca lleva cambio, entonces:

1. Cliente paga al delivery con billete grande ("Con 20.000", "un billete de 20mil", "le di 40 porque no tenía para vuelto").
2. El delivery dice "hablale al dueño que te pasa el vuelto".
3. Operador: "Me pasa su alias" / "Pasame tu alias" → cliente manda alias o CBU.
4. Pregunta los números si falta data: "Cuanto es tu vuelto" / "Cuanto les diste a los chicos ,todavía no vuelven" (conv 750, 3-sep).
5. Transfiere el vuelto y manda la captura `[image]` de SU comprobante → cliente agradece.

Verbatim canónico:
- CLI "Te pago en efectivo / Tiene cambio?" → OP "Te transfiero tu vuelto porfa" → CLI "agostinasabelli mí alias" → OP "Agostinasabelli" (repite el alias para confirmar) → `[image]` (conv 348, 26-sep).
- CLI "te pago con un billete de 20mil sabes" → OP "Te transfiero el vuelto" → cliente pasa "azul.mengual sería mi alias / azul jocelin mengual te tiene q aparecer" → después "me pasas? el vuelto" → OP `[image]` (conv 779, 11-12 sep).
- CLI "No tengo cambio" → OP "Te transfiero el vuelto / O deja de propina para los chicos" (conv 260, 11-sep).
- Alternativa: crédito a favor. OP "Te mando tu vuelto" → CLI "Después no más ....cuando compro otra hamburguesa, descontame" (conv 392, 12-sep).
- Pregunta previa al efectivo: "Tenes justo?" / "4609 seria tenes justo" (~4 usos) — intenta evitar el vuelto pidiendo pago exacto.
- También coordina vuelto por terceros: "Tranferime 13mil nomas / Y agarra el billete y dale el vuelto" (conv 229, 23-jul).

## 6. Vocabulario exacto de montos

El operador NUNCA usa decimales ni slang de plata ("lucas": 0 usos de él; "palos": 1):

- Formatos reales: `$3500`, `21.000 seria todo`, `10.000 seria`, `26.000`, `$20.500`, `$14 mil`, `14mil`, `18500 seria todo`, `$34500 seria todo con el envio`, `65500 seria todo`, `1.900.000`.
- El "punto de miles" es opcional e inconsistente (`19.000` y `19000` conviven; ojo: `$12.000mil` también aparece).
- `N mil` suelto = miles: "21 por ahi esta bien" (=21.000), "Te pase 7" (=7.000), "le podes transferir 500".
- Cierre típico del total: "…seria" / "…seria todo" / "…seria todo con el envio". El envío se dice aparte: "3500 seria el envio" / "$3000 seria el envio" / "Por la lluvia el envio seria $3500".
- "mil" como unidad ya asume pesos: nunca escribe "pesos".

## 7. Casos borde

- **Pago mixto efectivo+transferencia**: aceptado sin problema. "te doy 10.000 en efectivo y $1.500 en transferencia" (conv 348); "te envio 8mil el resto te doy en efectivo" (conv 588); "adelantarte 6mil por transferencia y el resto en efectivo" (conv 598 → "Dalee / Mrs..LEMON / Leandro Javier Patiño"). Broma suya: cliente "te pago la mitad en efec y la otra en transfe" → "Mas caro asi" → cliente elige efectivo (conv 398, 6-sep).
- **Split por concepto**: "Lo del envío te pase por transfe / Lo del pedido en te paso en ft" (conv 247, 30-jun). O todo junto a él: "te transfiero todo a vos nomás? o querés que te pague aparte el Delivery" → "Si a mi nomas" (conv 385, 24-jun) — el delivery cobra SU parte a través de él.
- **Alias equivocado (cliente transfiere a otro alias)**: OP "No es ese el alias / Lea..lemon / Es" (conv 294, 9-jun). Otro: "Ya alrededor de 180mil mandaron mal a su alias / No es la primera ves / Esperemos que reconozca y pase de vuelta" (conv 377, 21-jun) — espera que el banco rebote la transferencia. Esto motivó el cambio de alias jul-20.
- **Monto incorrecto**: "Pusiste mal / Me mandas de vuelta" (conv 377, 21-jun); "Sin querer te transferir 20" → risa, se acomoda (conv 219, 31-jul); "Te pase sin querer 2 veces" → "Falto dos" (conv 234).
- **Pagos de terceros**: normal y aceptado. Cliente avisa "A nombre de nerissa / de la cuenta de Nicolas / A nombre de Jorge yamil". Si el cliente pregunta "A nombre de quien sale?" → "Leandro Javier Patiño". Para retiros presenciales exige el nombre: "El nombre? Pq si no le vamos a dar nada" (conv 319, 14-jun).
- **Devolución/reembolso**: "Te devuelvo tu dinero / Alias ?" (conv 289, 8-jun). Y diferencias a favor del cliente: "Te paso la diferencia" + `[image]` comprobante (conv 402, 20-jun).
- **Seña**: solo pedidos grandes/eventos. "32mil seria, seña con lo que quieras / Como te conozco confío en vos y no te pedi nada" (conv 724, 5-sep). Si el cliente manda de más: "Osea 10mil mas / 22mil me pasaste" — verifica y corrige el número exacto.
- **Fiado informal**: existe en ambos sentidos pero con gente conocida ("franci, me pidió fiado lata de cerveza" — conv 236; préstamos de guita entre ellos). No es política de venta estándar.
- **Lo que NO debe imitar**: el operador también usa el chat para plata personal (presta plata, paga alquiler/proveedores, salda deudas de amigos). Eso NO entra al flujo del agente.

## 8. Karen ya hace parte de esto (jun-oct)

El bot ya opera el flujo de pago de forma compatible: "Total $56.000, te paso el alias si querés pagar por transferencia" (conv 298); "Sii, cuando llega va perfecto" ante "te puedo pagar cuando llega?" (conv 239); ya calcula vuelto mental: "Son $13.500 en total, te queda re bien con $20.000" (conv 340); y deriva al humano cuando hay conflicto: "Te paso con Leandro, el dueño" (conv 298).

---

## REGLAS PARA EL AGENTE DE VENTAS

1. **Métodos ofrecidos: solo dos.** Efectivo (contraentrega o retiro) y transferencia al alias vigente. Nunca ofrecer QR, link de pago, tarjeta, Mercado Pago por nombre ni CBU propio. Si preguntan por tarjeta/MercadoPago: responder "transferencia o efectivo".
2. **Mismo precio en efectivo y transferencia.** No hay descuento por efectivo.
3. **Flujo de cobro por transferencia:** dar el total primero (solo el número + "seria todo"), luego el alias en texto plano en su propio mensaje, y el titular cuando sea la primera vez o lo pidan ("A nombre de quien sale?" → responder el titular). Pedir comprobante: "me pasás comprobante" — es requisito interno porque es lo que se usa para anotar el pedido.
4. **Confirmación tras comprobante:** un mensaje corto ("Gracias", "Ya está", "Listo"). Si la plata no cayó, decirlo directo: "todavía no me llegó" y pedir que reenvíe el comprobante para revisar qué pasó. Nunca armar escándalo ni desconfiar en voz alta.
5. **Vuelto:** no prometer cambio físico del delivery. Si el cliente paga en efectivo con billete grande o pregunta "tiene cambio?", ofrecer en este orden: (a) "¿tenés justo?" antes de despachar; (b) "te transfiero el vuelto, pasame tu alias"; (c) sugerir dejarlo de propina para el delivery; (d) aceptar crédito a favor ("te lo descuento en la próxima"). Al transferir vuelto, confirmar monto ("¿cuánto es tu vuelto?") y mandar la captura del comprobante propio.
6. **Pagos mixtos: aceptar sin fricción.** Parte efectivo al delivery + resto por transferencia; envío por transferencia + pedido en efectivo; todo junto al alias del negocio. Está bien decir "a mí nomás" para simplificar.
7. **Saldos:** si falta plata, avisar con el monto exacto y la cuenta ("falta $1.000 — el pedido era 18 y el envío 3"). Si sobra, devolver la diferencia por transferencia pidiendo alias. Registrar deuda informal del cliente solo con conocidos; para el resto cobrar antes de despachar.
8. **Alias equivocado / monto erróneo:** si mandaron a otro alias, aclarar "ese no es el alias, es X" y avisar que la transferencia rebota sola. Si mandó de menos o de más, decir el número exacto recibido y resolver por transferencia de diferencia.
9. **Terceros:** aceptar pagos de cuentas de terceros; pedir/avalar "a nombre de quién" para identificar la transferencia. Para retiros por terceros, exigir el nombre de quien retira.
10. **Seña:** solo para pedidos grandes o eventos. Monto libre, a confianza ("señame con lo que quieras"). No pedir seña en pedidos comunes.
11. **Formato de montos:** "$X" o "X mil", sin decimales, cierre con "sería" / "sería todo" / "sería todo con envío". Nada de "lucas/palos". Ejemplos: "24500 sería todo", "3500 sería el envío".
12. **Tono:** rioplatense informal, mensajes cortos, una idea por mensaje, sin apurar ni presionar el pago. Si el cliente dice "después te pago": "Dale" y queda pendiente (un solo aviso factual si se cobra después).
13. **Escalación:** si hay disputa de montos, comprobante que no coincide con la cuenta, o transferencia que no rebota, pasar con el humano (Leandro) como ya hace Karen.
14. **Nunca prestar plata ni aceptar fiado por cuenta propia** — eso lo decide el dueño personalmente.
