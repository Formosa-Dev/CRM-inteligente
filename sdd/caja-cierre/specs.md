# Spec — Sistema de Cierre de Caja (caja única, efectivo físico)

> CONTRATO DE INTEGRACIÓN para agentes en worktrees paralelos.
> No improvisar nombres ni firmas: este documento es la fuente de verdad.
> Rama de trabajo por agente: `feat/caja-<sufijo>`. Base: `origin/main`.
> Convenciones: drizzle-orm, zod para inputs de tools, mensajes al admin en
> español rioplatense (voseo), montos con `toLocaleString("es-AR")`.

## 1. Modelo de dominio

Caja física única. Las sesiones forman una **cadena continua**: cada sesión
abre donde cerró la anterior (nunca hay huecos ni solapamientos). Una sesión
cerrada es **inmutable** (asiento de auditoría).

### Tablas (YA EXISTEN en `src/db/schema.ts` y en la DB — no tocar)

```ts
cashSessions  // cash_sessions
  id serial pk | status 'open'|'closed' | openedAt | closedAt
  openingCash numeric(12,2) | expectedCash | actualCash | difference
  closedBy varchar(100) | report jsonb | notes | createdAt

cashMovements // cash_movements
  id serial pk | sessionId → cashSessions.id | direction 'in'|'out'
  amount numeric(12,2) | reason text | createdBy | createdAt
```

### Pedidos relevantes (`orders` — existe)

- `items` jsonb: `[{name, quantity, price?}]` — total = Σ(price×qty) + `deliveryFee`
- `paymentStatus`: 'paid' | 'pending' | null
- `paymentMethod`: texto libre — clasificar:
  - CASH: `efectivo`, `cash`, `contado`, `efvo`, `en mano`
  - DIGITAL: `mercadopago`, `mercado pago`, `mp`, `transferencia`, `alias`,
    `tarjeta`, `debito`, `credito`, `qr`, `modo`, `cuenta dni`
  - UNKNOWN: null o no matchea → bucket "sin método"
- Ventana de la sesión: `COALESCE(deliveredAt, createdAt)` dentro de
  `[openedAt, closedAt)`; excluir `status = 'cancelled'`.

## 2. `src/lib/cash/session.ts` — API EXACTA (WT1)

```ts
export type MoneyMethod = "cash" | "digital" | "unknown";
export function classifyMethod(paymentMethod: string | null): MoneyMethod;
export function orderTotal(o: { items: unknown; deliveryFee: string | null }): number;

export interface OrderLine { id: number; customer: string; total: number; method: string | null; }
export interface CashSnapshot {
  sessionId: number; openedAt: Date;
  openingCash: number;
  cashOrders: OrderLine[]; cashTotal: number;
  digitalByMethod: Record<string, { count: number; total: number }>; digitalTotal: number;
  unknownOrders: OrderLine[]; unknownTotal: number;
  pendingOrders: OrderLine[]; pendingTotal: number;   // paymentStatus != 'paid'
  movementsIn: number; movementsOut: number;
  expectedCash: number;  // opening + cashTotal + in - out
  totalSold: number;     // todos los pedidos del período (cualquier método, pagados)
}
export interface CloseResult extends CashSnapshot {
  closedAt: Date; actualCash: number; difference: number;
}

export async function getOpenSession(): Promise<typeof cashSessions.$inferSelect | null>;
export async function ensureOpenSession(): Promise<typeof cashSessions.$inferSelect>;
// Si no hay abierta: crea con openedAt = lastClosed.closedAt (o ahora si no hay
// historial), openingCash = lastClosed.actualCash (o 0). Devuelve la abierta.
export async function openSession(openingCash: number, openedBy?: string): Promise<...>;
// Falla si ya hay una abierta. openedAt = ahora.
export async function addMovement(direction: "in"|"out", amount: number, reason: string, by?: string): Promise<...>;
// Auto-ensure open session.
export async function getSnapshot(sessionId: number): Promise<CashSnapshot>;
// Calcula todo leyendo orders + cash_movements en la ventana [openedAt, now).
export async function closeSession(actualCash: number, closedBy: string, notes?: string): Promise<CloseResult>;
// ensureOpenSession → snapshot → update session (status closed, expected/actual/diff,
// report jsonb = snapshot serializado) → devuelve CloseResult. Idempotente: si la
// sesión ya estaba cerrada, devuelve error { error: string }.
export async function getHistory(limit: number): Promise<typeof cashSessions.$inferSelect[]>;
// Últimas sesiones cerradas, más recientes primero.
```

Reglas: import `db`, `cashSessions`, `cashMovements`, `orders` desde `@/db`
/`@/db/schema`. Usar `sql` template de drizzle para `COALESCE(delivered_at,
created_at)`. numeric llega como string → `Number(...)`.

## 3. Tools Telegram — `src/lib/telegram/toolsCash.ts` (WT2)

Exportar `cashTools` objeto; registrar con spread en `internalAgentTools`
(`src/lib/telegram/tools.ts` — ÚNICO archivo compartido que toca WT2).

| Tool | Input | Efecto |
|---|---|---|
| `openCash` | `{openingCash?: number}` | ensureOpenSession o openSession explícita |
| `registerCashMovement` | `{direction:'in'|'out', amount, reason}` | addMovement (auto-open si falta) |
| `getCashStatus` | `{}` | snapshot formateado en texto |
| `closeCash` | `{actualCash: number, note?: string}` | closeSession + texto reporte + `notifyAdmins(reporte)` |
| `getCashHistory` | `{limit?: number}` | últimos cierres: fecha, esperado, contado, dif |

`closeCash` SIEMPRE llama `notifyAdmins` (import de `@/lib/telegram/notifier`)
con el reporte completo. `closedBy` = "telegram-admin".

Formato del reporte de cierre (texto plano, sin parse_mode):

```
💰 CIERRE DE CAJA #<id> — <dd/mm hh:mm>
Ventana: <openedAt> → <closedAt>

🟢 Esperado en caja: $X
   inicial $A + efectivo $B + entradas $C − salidas $D
💵 Contado: $Y
✅/⚠️ Diferencia: $Z (✅ si 0, ⚠️ con signo si no)

📊 Ventas del período:
   Efectivo: N pedidos · $X
   Digital:  N pedidos · $X  (desglose por método)
   Sin método: N pedidos · $X
   Total vendido: $X (N pedidos)

⏳ Cobros pendientes: N · $X
📤 Movimientos: +$X entradas / −$X salidas
```

## 4. Prompt (WT3)

- `src/lib/telegram/system-prompt.ts`: agregar sección `CAJA` documentando las
  5 tools y reglas: cerrar caja pide SOLO el conteo físico si no lo dieron;
  antes de cerrar mostrar `getCashStatus`; movimientos se cargan sin preguntar
  ("salieron 800 para el delivery" → registerCashMovement out 800).
- `src/lib/telegram/prompt-builder.ts`: si hay sesión abierta, inyectar una
  línea de contexto (`Sesión de caja #N abierta desde <fecha>`) usando
  `getOpenSession` — tolerante si la tabla no responde (try/catch → omitir).

## 5. Admin `/admin/caja` (WT4)

Página nueva `src/app/(admin)/admin/caja/` siguiendo convenciones del proyecto:
leer `DESIGN.MD` y una página admin existente (ej. `/admin/telegram`) para el
estilo. Server component o actions según patrón actual. Mostrar:

- Sesión abierta actual: apertura, esperado actual, movimientos del día
- Historial de cierres: fecha, esperado, contado, diferencia (rojo si |dif|>0)
- Read-only (sin forms de cierre — el cierre es por el bot/Telegram)
- Si existe nav/sidebar de admin, agregar entrada "Caja". NO tocar
  `tools.ts`, `schema.ts`, ni archivos de otros worktrees.

## 6. Tests (WT5)

`src/lib/cash/session.test.ts` con `node --test` (patrón existente, ver
`src/lib/telegram/notifier.test.ts`). Cubrir con datos fake/funciones puras:
- `classifyMethod`: efectivo/mp/transferencia/null/casos raros
- `orderTotal`: items + deliveryFee
- Invariante continua: ensureOpenSession backdatea a lastClosed.closedAt
- Cierre idempotente: segunda llamada falla sin duplicar
- Agregar el archivo al script `test:agents` de `package.json`.

## 7. Reglas de integración (TODOS)

- Rama propia `feat/caja-<sufijo>`, un solo área de archivos por worktree.
- `tsc --noEmit` puede fallar por archivos hermanos aún no mergeados — escribir
  contra este contrato; la verificación final es del integrador.
- Commits conventional, SIN Co-Authored-By ni atribución de IA.
- NO tocar: `schema.ts`, `drizzle/`, `.env`, archivos fuera de su alcance.
- Reporte final: archivos creados/tocados, decisiones, bloqueos.
