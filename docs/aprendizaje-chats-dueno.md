# Aprendizaje de Chats Reales: Estilo del Dueño

> Basado en 1378 mensajes de 57 clientes únicos en los últimos 3 días de producción (24-31 Mayo 2026).
> El bot de IA tiene 0 intervenciones humanas (role=human). Todos los mensajes "assistant" son del dueño.

## Datos Clave

| Métrica | Valor |
|---------|-------|
| Total mensajes históricos | 5,047 |
| Mensajes IA (assistant) | 2,455 (48.6%) |
| Mensajes usuarios | 2,592 (51.4%) |
| Mensajes role=human | **0** — nunca se usó |
| Human override activos ahora | 25 conversaciones |
| Clientes únicos (3 días) | 57 |
| Conversaciones activas/día | 3-24 |

## Patrón de Comunicación del Dueño

### 1. Saludo: INEXISTENTE o mínimo

El dueño **NUNCA** saluda formalmente. Cuando responde:

```
Cliente: "Hola"
Dueño: "Holaa sii"
```

```
Cliente: "Hola hasta que hora trabajan?"
Dueño: "Buenas, hasta las 00hs"
```

```
Cliente: "Holiii, seguís trabajando?"
Dueño: "Sii"
Dueño: "Decime"  ← SEGUNDO mensaje, pidiendo que avance
```

**Regla aprendida**: Saludo mínimo de 1-3 palabras. Si el cliente ya preguntó algo, responder DIRECTO sin saludo.

### 2. Tono: Directo, coloquial, voseo, sin formalidades

NUNCA usa:
- "por favor"
- "disculpá"
- "estimado"
- "amablemente"
- "muchas gracias" (salvo excepciones raras)

SIEMPRE usa:
- "Dale", "Dalee", "Sii", "Nop"
- "Che", "amigo/a", "amigoo"
- "Me pasas ubi"
- "Confirmas?"
- "Dale, te preparo"
- "Ya estaa"

### 3. Estructura del mensaje: 1 línea, máximo 2

El 90% de las respuestas del dueño tienen MENOS de 10 palabras.

Ejemplos reales:
```
"Dale"
"Sii"
"Nop"
"12mil seria todo"
"Ya estaa"
"Dentro de 15 maso"
"[alias]"
"Sii, dalee te preparo"
"$3000"
```

### 4. El menú: siempre lo envía como IMAGEN, nunca como texto

Patrón consistente en CADA conversación donde piden menú:
1. Cliente: "pasame el menú" / "me pasas los precios" / "qué tienen?"
2. Dueño: envía 3-5 imágenes del menú
3. NO explica nada a menos que pregunten específicamente

```
Cliente: "me pueden pasar el menu porfass"
Dueño: [image] [image] [image] [image]
```

```
Cliente: "quería saber los precios"
Dueño: [image] [image] [image] [image] [image]
```

### 5. Flujo de pedido: RAPIDÍSIMO, sin confirmación paso a paso

El dueño NO sigue un proceso estructurado. El flujo real es:

**Fase 1: Producto**
```
Cliente: "Quiero 1 BookBinder y 1 toro asado"
Dueño: "Dalee"
```

**Fase 2: Delivery/Retiro (pregunta UNA VEZ)**
```
Dueño: "Buscas?"
O: "Con envio?"
O: "Me pasas ubi"
```

**Fase 3: Precio (cuando preguntan o al final)**
```
Cliente: "En cuanto estaría?"
Dueño: "17mil seria"
```

**Fase 4: Alias de pago (cuando preguntan)**
```
Cliente: "Me pasas tu alias"
Dueño: "[alias]"
```

**Fase 5: "Ya está" (cuando está listo)**
```
Dueño: "Ya estaa"
O: "Ya salio tu pedido"
O: "Ya esta todo"
```

### 6. Manejo de errores / cambios: INMEDIATO, sin drama

Cuando el cliente cambia el pedido:
```
Cliente: "Cambiame el pedido, la 2 y la 4 haceme"
Dueño: "Dale"  ← Sin preguntar nada, acepta
```

Cuando no hay stock de algo:
```
Cliente: "1 mamita y 1 toro con papas fritas puede ser?"
Dueño: "Papas sin stock"
Dueño: "Queres la Hamburguesa igual?"
```

Cuando se queda sin patys (carne):
```
Dueño: "Amigo, tengo un problema. Nos quedamos sin patys.
Tengo para la toro y la book nomas."
```

### 7. Post-venta: Pide etiquetado en Instagram SIEMPRE

Cada vez que entrega un pedido:
```
"Me etiquetas en ig porfaaa"
"Etiquetame porfis"
"Nos etiquetas en ig"
```

### 8. Clientes B2B (pan mayorista): Misma velocidad, misma estructura

```
Cliente: "Para mañana tendría? Una docena"
Dueño: "Sii, dalee te preparo"
```

```
Dueño: "Buenos dias ya tenemos su pedido"  ← Proactivo! Avanza solo
```

### 9. El dueño ES el delivery y la cocina

El dueño personalmente:
- Recibe el pedido
- Prepara (está en la cocina)
- A veces entrega
- Responde entremedio

```
"Ya voooy"  ← mientras cocina
"Perdoon"
```

```
"Ya esta su pedido"  ← terminó de cocinar
```

```
"Dentro de 15 maso"  ← tiempo de preparación
```

### 10. Clientes recurrentes: Reconocimiento natural

```
Cliente: "Hola [nombre] cómo estás?"
Dueño: "Holaa, sii. Como estas [nombre]"  ← usa su nombre!
```

```
Dueño: "Pedile a [conocida] nomas ella tiene mi transferencia"  ← conoce a la gente
```

### 11. Resolución de problemas en caliente

Cuando un cliente quiere cancelar porque ya salió el pedido:
```
Cliente: "amigo te puedo cancelar el pedido"
Dueño: "Amigo ya esta yendo tu pedido"
Dueño: "Le llenamos de panceta y cheddar"  ← OFRECE VALOR AGREGADO para compensar
```

### 12. NUNCA da información no solicitada

El dueño NUNCA:
- Da el precio antes de que pregunten
- Explica el menú si no preguntan
- Pide nombre (ya sabe quién es o lo deduce)
- Pide dirección completa (solo "me pasas ubi")
- Pregunta método de pago por adelantado

## Comparación: Dueño vs Bot Actual

| Situación | Dueño | Bot (Karen V5) |
|-----------|-------|-----------------|
| Saludo | "Holaa sii" o nada | Prompt le dice "Dale" pero a veces saluda formal |
| Menú | Envía imágenes | Prompt dice "te mandé la foto" pero depende de la tool |
| Crear pedido | "Dale" + cocina | 3 tools separadas (addOrderItem, confirmOrder, createOrder) |
| Preguntar datos | "Con envío?" o "Buscas?" | Pregunta deliveryFee, paymentMethod, notas |
| Precio | Solo si preguntan | Prompt le dice que lo dé al final |
| Dirección | "Me pasas ubi" | Pide dirección estructurada |
| Confirmación | No pide confirmación | Tool description dice "SIEMPRE confirmar" |
| Tono | Dueño directo | Prompt lo intenta pero tools lo hacen burocrático |
| Velocidad | 1-2 líneas, inmediato | 3-5 pasos, lento |
| Post-venta | "Etiquetame en ig" | No existe |
| Cambios | "Dale" y lo hace | updateOrder con parámetros |
| Sin stock | "Nop" + alternativa | checkAvailability + sugerir |

## Insights Clave para el Rediseño

1. **ELIMINAR la confirmación explícita**: El dueño NUNCA dice "¿confirmás tu pedido de X items por $Y?". Solo dice "Dale" y cocina. La confirmación es implícita.

2. **ELIMINAR la estructura de pasos**: El dueño no sigue PASO 1, PASO 2, etc. Escucha, procesa, cocina, responde. TODO en paralelo.

3. **INTEGRAR cocina + respuesta**: El dueño responde MIENTRAS cocina. El bot debería poder decir "Dale" y después "Ya estaa" sin estructura.

4. **MÍNIMA fricción**: Menos preguntas = más ventas. El dueño solo pregunta lo ESTRICTAMENTE necesario.

5. **SIN datos estructurados**: El dueño no pide "nombre del cliente", "teléfono", "dirección completa". Usa la ubicación de WhatsApp y el nombre del perfil.

6. **POST-VENTA es VENTA**: "Etiquetame en ig" no es opcional — es parte del proceso.

7. **PRECIOS DINÁMICOS**: El dueño cambia precios sobre la marcha ("Esta carta es vieja ya, pero con los precios actualizados").

8. **ERROR = OPORTUNIDAD**: Cuando algo sale mal, el dueño ofrece valor extra ("Le llenamos de panceta y cheddar"), no cancela.
