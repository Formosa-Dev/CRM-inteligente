# PROMPT CORREGIDO: Infraestructura - Solo Fase 1

## Objetivo
Sistema de procesamiento de mensajes nivel profesional.

## Tareas (SOLO estas - no más)

### Tarea 1: Rate Limiting (@upstash/ratelimit)
```
- Install: npm install @upstash/ratelimit
- Archivos: src/lib/ratelimit.ts
- Limite: 20 msg/min por chat_id, 100 global
- Response 429 si excede
```

### Tarea 2: Redis Queue (Upstash)
```
1. Setup Upstash (CREAR CUENTA en upstash.com)
2. REDIS_URL a .env + Render
3. Producer: src/lib/queue/producer.ts (LPUSH)
4. Consumer: src/lib/queue/worker.ts (RPOP + process)
```

### Tarea 3: Dead Letter Queue
```
- src/lib/queue/dlq.ts
- GET /api/admin/dlq (mostrar failed)
```

### Tarea 4: Exponential Backoff
```
- Retry: 1s → 2s → 4s → DLQ (max 3 retries)
```

### Tarea 5: Circuit Breaker (OpenAI)
```
- Si 5 errores consecutivos → circuitos abierto 60s
- Response "Servicio no disponible" si bloqueado
```

---

## NO HACER (ya lo hago yo)
- Idempotency key
- Logging estructurado
- Health check

---

## Ejemplo de delegacion
```typescript
// Usar task tool para sub-agentes
await task({
  prompt: "Agregar rate limiting con @upstash/ratelimit...",
  subagent_type: "code"
})
```

## Start
1. EMPEZAR con Tarea 1
2. Commit por completion
3. Signal `PHASE_1_DONE`, luego `INFRA_UPGRADE_COMPLETE`