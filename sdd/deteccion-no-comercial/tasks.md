# Tasks: Detección No-Comercial

## T-06.1: Extender classifyMessageType en anti-loop.ts
- [ ] Agregar categoría `non_commercial` con keywords: "cumpa", "vro", "amigo", "jajaja", "q pendejo", "todo bien?", "que onda", "como estas", "cómo estás", etc.
- [ ] Si el mensaje es SOLO emoji(s) → classify como non_commercial (ya existe en prompt pero no en código)

## T-06.2: Agregar sección [NO COMERCIAL] en prompt V6
- [ ] Instrucciones: si el primer mensaje o la conversación no es sobre el negocio → "Holaa, ¿todo bien?" sin vender
- [ ] Si 2 intercambios no-comerciales → "Ahí te paso con el dueño, yo estoy para cosas del negocio"
- [ ] Si es ambiguo ("Holaa") → tratar como comercial hasta que se demuestre lo contrario

## T-06.3: Implementar detección pre-flight en agent.ts
- [ ] Leer últimos 2 mensajes del usuario
- [ ] Llamar classifyMessageType
- [ ] Si non_commercial consecutivo (2+) → inyectar directiva en prompt: "NO arranques flujo de venta. Respondé amable pero sin vender"
- [ ] Si non_commercial persistente → ejecutar transferToHuman
