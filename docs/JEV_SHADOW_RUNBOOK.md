# Jev shadow: operación inicial

## Preparación

1. Aplicar la migración `drizzle/0003_orange_chronomancer.sql` antes de desplegar el cron actualizado (`npm run db:migrate` contra la base correcta). Si se omite, el cron no puede reclamar follow-ups. La columna es nullable y no altera pedidos anteriores.
2. Configurar `CRON_SECRET` y programar solamente `GET /api/cron/followup?key=...` como owner. El webhook ya no ejecuta follow-ups. El claim atómico por pedido evita solapamientos ordinarios; una caída después del envío y antes de guardar `followupSent` puede reintentar pasado el lease de cinco minutos. Investigar idempotencia del proveedor antes de prometer entrega exactamente una vez.
3. Configurar `TYPESAFE_API_KEY` sólo en servidor. El SDK oficial instalado es `@typesafe-ai/sdk@0.6.0` (Node 20+). El cliente fija `logLevel: "off"` para evitar registrar el state o la clave.

### Obtener acceso a TypeSafe

Entrar a [console.typesafe.ai/login](https://console.typesafe.ai/login) y registrarse con Google o correo. Crear una API key desde la consola y guardarla exclusivamente como secreto del entorno servidor (`TYPESAFE_API_KEY`); no pegarla en issues, chats ni commits. Si la consola no permite crear claves, solicitar habilitación a [hello@typesafe.ai](mailto:hello@typesafe.ai) indicando el correo de la cuenta, que se quiere evaluar `@typesafe-ai/sdk` con SystemOne/Jev en español argentino y que se necesita acceso al modelo pinneado `jev-1.13.0` o información sobre la versión disponible. No activar observación en producción antes de ejecutar la eval real y verificar cuota/modelo concedido.

| Variable | Valor inicial | Uso |
| --- | --- | --- |
| `JEV_ENABLED` | `false` | Interruptor general de observación |
| `JEV_SHADOW_MODE` | `true` al habilitar | Obligatorio junto a `JEV_ENABLED`; no existe enforcement |
| `JEV_MODEL` | `jev-1.13.0` | Versión fijada; el alias `jev-latest` se rechaza |
| `JEV_POLICY_VERSION` | `shadow-v1` | Versión en cache y telemetría |
| `JEV_REALTIME_TIMEOUT_MS` | `700` | Timeout por intento customer |
| `JEV_REALTIME_MAX_RETRIES` | `0` | Reintentos adicionales customer |
| `JEV_INTERNAL_TIMEOUT_MS` | `1500` | Timeout por intento seller/admin |
| `JEV_INTERNAL_MAX_RETRIES` | `1` | Reintento adicional seller/admin |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | opcional | Cache de decisiones 60 s; falla abierta |

Con ambos interruptores activos, Jev observa turnos WhatsApp customer/seller y Telegram admin antes de GPT. No interviene en las respuestas, tools ni envíos. La latencia se suma al turno (hasta dos intentos en seller/admin; timeout es **por intento**, no plazo total). Desactivar inmediatamente poniendo `JEV_ENABLED=false` o `JEV_SHADOW_MODE=false`; reiniciar el proceso si el host no recarga env automáticamente.

## Evals y pruebas

- `npm run eval:agent-policy`: ejecuta fixtures locales, una **proyección de policy sobre respuestas Jev simuladas** y permisos del manifiesto, sin credenciales. Sus métricas no miden precisión de Jev.
- `npm run eval:jev`: valida 32 fixtures del dominio y, si hay `TYPESAFE_API_KEY`, consulta el modelo fijado y calcula precision, recall, FP y FN por señal. Sin clave informa `SKIPPED`, no inventa scores.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` verifican la rama. Lint global contiene deuda previa; mirar también lint focalizado.
- Ejecutar el conjunto real en español argentino antes de fijar thresholds o activar canary. Priorizar los falsos positivos de `explicitOrderConfirmation` y los falsos negativos de `explicitHumanRequest`. Los umbrales actuales son exploratorios y sólo se usan en métricas/ruta hipotética.

## Lectura de eventos

Buscar `[jev:shadow]` en logs. Cada evento trae `timestamp`, actor, canal, `requestedModel`, `returnedModel`, versiones de policy/question set/threshold, `latencyMs`, `usage`, answers (probabilidades y confidencias), `currentRoute`, `proposedRoute`, `proposedToolFamily`, `confirmationCandidate`, `vetoReasons`, `mode` y `fallbackReason`. No se registra el state completo ni razonamiento interno. `fallbackReason` indica timeout, 429, respuesta inválida, circuit breaker o falta de clave; el agente existente continúa. Ningún campo `proposed*` habilita o ejecuta acciones.

## Siguiente fase

Calibrar umbrales con mensajes reales anonimizados; comparar variantes de redacción de preguntas españolas, observar p95/p99 y uso de tokens, completar autorización determinista de tools sensibles y guardar métricas agregadas durablemente. Ninguna de estas decisiones está activa en producción.
