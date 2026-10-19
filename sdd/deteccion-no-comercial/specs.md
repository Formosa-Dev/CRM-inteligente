# Specs: Detección No-Comercial

## Requerimientos

### R1: Clasificación del primer mensaje
- El sistema debe clasificar el primer mensaje de cada conversación como "commercial", "non_commercial" o "ambiguous"
- "non_commercial" = saludo de amigo ("que onda cumpa", "todo bien?"), joda, temas no relacionados
- "commercial" = pedido, consulta de precio, menú, horarios
- "ambiguous" = "Holaa", "Buenas", "Hola" sin contexto adicional

### R2: Respuesta según clasificación
- "non_commercial" → "Holaa ¿todo bien?" + NO arrancar flujo de venta. Si el próximo mensaje también es no-comercial → "Ahí te paso con el dueño, yo estoy para cosas del negocio"
- "ambiguous" → flujo normal. Si los próximos 2 mensajes son no-comerciales → "Ahí te paso con el dueño..."
- "commercial" → flujo normal

### R3: Transferencia a humano
- Cuando se detecta conversación no-comercial persistente, ejecutar `transferToHuman` automáticamente

### R4: Prompt V6
- Agregar sección [NO COMERCIAL] con las instrucciones

## Escenarios

### E1: Amigo del dueño saluda
- Input: "Que ondaaa cumpa"
- Clasificación: non_commercial
- Output: "Holaa amigo, ¿todo bien?" (no menú, no venta)

### E2: Cliente nuevo saluda
- Input: "Holaa"
- Clasificación: ambiguous
- Output: "Holaa, ¿todo bien? Decime" (flujo normal)

### E3: Cliente jodiendo
- Input: "Eh?", "Jajaja", "Q pendejo jajaja" (repetido)
- Clasificación: non_commercial progresivo
- Output: después de 2 no-commercial → transferencia a humano
