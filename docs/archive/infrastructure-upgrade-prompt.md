# Prompt: Upgrade Infraestructura Profesional para Muzzarella

## Objetivo
Elevar la infraestructura de procesamiento de mensajes a nivel profesional, enterprise-ready.

## Contexto
- **Proyecto**: muzapp (Mrs Muzzarella)
- **Stack**: Next.js 16, Neon PostgreSQL, Render
- **Volumen actual**: Bajo (PME), pero debe soportar bursts

## Tareas a Ejecutar

### Fase 1: Quick Wins (CRÍTICO - hacer primero)

**Tarea 1.1: Idempotency Key**
```
Archivo: src/app/api/telegram/webhook/[token]/route.ts
- Agregar idempotency key usando update_id de Telegram
- Guardar en memoria o DB para evitar reprocesamiento
- Si idempotency key ya existe, responder 200 OK sin procesar
```

**Tarea 1.2: Logging Estructurado**
```
Instalar: yarn add pino
- Agregar correlation ID a cada request
- Loguear: request received, processing, response, errors
- Estructura: { timestamp, correlationId, event, data }
```

**Tarea 1.3: Rate Limiting**
```
Usar: @upstash/ratelimit (free tier)
- Rate limit por chat_id: 20 msg/min
- Rate limit global: 100 msg/min
- Responder 429 si excede
```

**Tarea 1.4: Health Check**
```
Nuevo archivo: src/app/api/health/route.ts
- GET /api/health
- Return: { status, timestamp, version, db }
```

---

### Fase 2: Cola Redis ( IMPORTANTE)

**Tarea 2.1: Setup Upstash Redis**
```
1. Crear cuenta en https://upstash.com
2. Obtener REDIS_URL
3. Agregar a .env.local y Render
4. Test de conexión
```

**Tarea 2.2: Producer Queue**
```
Nuevo archivo: src/lib/queue/producer.ts
- LPUSH mensaje a Redis
- Incluir correlationId, messageId, payload, timestamp
- Retry count = 0
```

**Tarea 2.3: Consumer Worker**
```
Nuevo archivo: src/lib/queue/worker.ts
- RPOP de Redis
- Procesar mensaje
- Si falla: RPUSH con retry+1
- Si retry > 3: DLQ
- Usar setInterval para polling (30 seg)
```

**Tarea 2.4: Dead Letter Queue**
```
- Archivo: src/lib/queue/dlq.ts
- Guardar mensajes fallidos con Error
- Endpoint para revisar DLQ: GET /api/admin/dlq
```

---

### Fase 3: Retry + Resilience

**Tarea 3.1: Exponential Backoff**
```
- Retry 1: 1 seg
- Retry 2: 2 seg
- Retry 3: 4 seg
- Retry 4: DLQ (máximo 3 retries)
```

**Tarea 3.2: Circuit Breaker para OpenAI**
```
- Si 5 errores consecutivos: abrir circuit
- After 60 seg: intentar de nuevo
- Mientras abierto: responder "Servicio temporalmente no disponible"
```

---

## Requisitos Obligatorios

### Patrón de Delegación (MUY IMPORTANTE)

**DELEGAR subtareas a sub-agentes**:
- NO hacer todo manualmente
- USAR Task tool para paralelizar
-示例:

```typescript
// Tarea 1: Logging
await task({
  prompt: "Agregar pino logging a src/app/api/telegram/webhook/[token]/route.ts...",
  subagent_type: "code",
  description: "Add pino logging"
})

// Tarea 2: Rate limit
await task({
  prompt: "Agregar @upstash/ratelimit...",
  subagent_type: "code", 
  description: "Add rate limiting"
})

// Ejecutar en paralelo cuando sea posible
```

### Comunicación con Orchestrator

**USAR skill: inter-agent-engram**
- Antes de empezar: LEER spec en `sdd/muzzarella-core/specs`
- Después de cada fase: ESCRIBIR señal en Engram
- Al terminar: signal "INFRA_UPGRADE_COMPLETE"

### Patrón de Código

- usar TypeScript strict
- errores tipados, no usar any
- tests básicos (puede ser console.log al final)
- NO modificar schema.ts existente

---

## Entregables por Fase

| Fase | Entregable |验收 |
|-----|-----------|------|
| 1.1 | idempotency.ts | Mensaje duplicado = 200 OK |
| 1.2 | logs/ | Logs en console |
| 1.3 | rate-limit | 429 si excede |
| 1.4 | /api/health | {"ok": true} |
| 2.1 | Upstash connected | Test ping |
| 2.2 | producer.ts | LPUSH funciona |
| 2.3 | worker.ts | Procesa mensajes |
| 2.4 | /api/admin/dlq | Lista failed |
| 3.1 | backoff | Retry works |
| 3.2 | circuit | Bloquea si falla |

---

## IMPORTANTE: No romper lo existente

- Webhook debe seguir respondiendo 200 OK
- Funcionalidad actual debe mantenerse
-逆: si algo falla, fallback a sync original

---

## Start Aquí

1. LEER specs en `sdd/muzzarella-core/specs` (si existen)
2. LEER código actual en `src/app/api/telegram/`
3. EMPEZAR con Fase 1 (Quick Wins)
4. Por cada completion: commit con mensaje claro
5. IMPORTANTE: comunicarte con orchestrator via Engram signal