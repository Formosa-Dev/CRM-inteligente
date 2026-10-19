# ClinicForge Tools Architecture → MuzApp Reference

## 1. ClinicForge Tools Architecture (`nova_tools.py`)

### 1.1 Schema-as-Source-of-Truth

ClinicForge define 77+ tools en UNA sola lista `NOVA_TOOLS_SCHEMA` que es la **fuente de verdad única** para:

- **OpenAI Realtime API** (formato plano: `{type, name, description, parameters}`)
- **Chat Completions API** (formato anidado: `{type, function: {name, description, parameters}}`)

```
NOVA_TOOLS_SCHEMA → nova_tools_for_voice()    → filtrado por _VOICE_ALLOWED_TOOLS + meta-tool
                  → nova_tools_for_page(page)   → filtrado por _EXCLUDED_TOOLS_BY_PAGE
                  → nova_tools_for_chat_completions() → wrapper al formato Chat Completions
```

### 1.2 Tool Structure

Cada tool en `NOVA_TOOLS_SCHEMA` es un dict con:
- `type`: siempre `"function"`
- `name`: snake_case, único (ej: `"buscar_paciente"`, `"ver_agenda"`)
- `description`: texto largo en español, instructivo para el LLM
- `parameters`: JSON Schema con `"type": "object"`, `properties` tipadas, `required` array

Ejemplo:
```python
{
    "type": "function",
    "name": "buscar_paciente",
    "description": "Busca un paciente por nombre, apellido, DNI o telefono...",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Nombre, apellido..."}
        },
        "required": ["query"],
    },
}
```

### 1.3 Categorías de Tools

Organizadas por secciones en el schema (NO en el código):
- **A. Pacientes** (6): buscar, ver, registrar, convertir_lead, actualizar, historial_clinico
- **B. Turnos** (6): ver_agenda, proximo_paciente, verificar_disponibilidad, agendar, cancelar, confirmar
- **C. Tratamientos/Facturación** (3): listar_tratamientos, registrar_pago, facturacion_pendiente
- **D. Analytics/Config** (3): resumen_semana, rendimiento_profesional, actualizar_faq
- **E. Navegación** (2): ir_a_pagina, ir_a_paciente (devuelven JSON `{type:"navigation"}`)
- **F. Multi-sede CEO** (4): resumen_sedes, comparar_sedes, switch_sede, onboarding_status
- **G. Staff** (8+): listar_profesionales, reprogramar_turno, ver_configuracion, etc.
- **H. Anamnesis** (3): guardar, ver, enviar_anamnesis
- **H2. Odontograma** (2): ver_odontograma, modificar_odontograma (42 estados, 5 superficies)
- **I. Consultas avanzadas** (3): consultar_datos, resumen_marketing/financiero
- **J. CRUD genérico** (4): obtener/actualizar/crear/contar_registros (cualquier tabla)
- **K. RAG / Knowledge Base** (1): buscar_en_base_conocimiento
- **L. Obras sociales** (2): consultar_obra_social, ver_reglas_derivacion
- **M. Fichas Digitales** (4): generar/enviar_ficha_digital, enviar_pdf_telegram, generar_reporte_personalizado
- **N. Plantillas WhatsApp** (3): listar_plantillas, enviar_plantilla, accion_masiva
- **O. Presupuestos** (10+): crear/ver/aprobar presupuestos, items, PDF, email, liquidaciones
- **P. Memoria persistente** (3): guardar/buscar/ver_contexto_memorias
- **K3. Patient Memories** (2): ver/agregar_memoria_paciente

### 1.4 El Dispatcher

```python
async def execute_nova_tool(name, args, tenant_id, user_role, user_id) -> str:
    # Cadena de elifs → ~80 branches
    if name == "buscar_paciente":
        return await _buscar_paciente(args, tenant_id)
    elif name == "ver_paciente":
        return await _ver_paciente(args, tenant_id)
    # ... 75+ elifs ...
    else:
        return f"Tool '{name}' no reconocida."
```

Patrones clave:
- **Siempre recibe `tenant_id`** (contexto de la clínica) y **`user_role`** (para RBAC)
- **Siempre devuelve `str`** — texto plano que OpenAI Realtime vocaliza
- **Excepciones** capturadas con try/except global, logueadas, devuelven string de error
- **Tools de navegación** devuelven JSON string con `type:"navigation"` para el frontend

### 1.5 El Meta-Tool: `herramienta_avanzada`

Es un **proxy** que permite al LLM llamar CUALQUIER tool de las 77 aunque no esté cargada en el schema actual.

```python
_META_TOOL_SCHEMA = {
    "name": "herramienta_avanzada",
    "parameters": {
        "tool_name": {"type": "string", "enum": [listado de ~40 tools]},
        "args": {"type": "object"},
    }
}
```

Se usa en **voice** (Realtime API), donde el modelo `gpt-4o-mini-realtime-preview` solo recibe ~35 tools directas + la meta-tool. Si necesita hacer algo que no está en las directas, llama `herramienta_avanzada` con `tool_name` y `args`, y el dispatcher redirige recursivamente:

```python
elif name == "herramienta_avanzada":
    inner_name = args.get("tool_name", "")
    inner_args = args.get("args", {}) or {}
    return await execute_nova_tool(inner_name, inner_args, tenant_id, user_role, user_id)
```

Beneficio: el LLM tiene acceso a **las 77 tools** sin cargarlas todas en el schema (lo que saturaría el contexto del modelo mini).

### 1.6 Filtrado por Page/Channel

```python
_EXCLUDED_TOOLS_BY_PAGE = {
    "telegram": {"ir_a_pagina", "ir_a_paciente", "switch_sede", "onboarding_status"},
    "dashboard": {"ir_a_paciente"},
    "agenda": {"onboarding_status"},
}

_VOICE_ALLOWED_TOOLS = {set de ~35 tools core}
```

Dos estrategias:
1. **Exclusion set** (`nova_tools_for_page`): carga todas las tools, excluye un subconjunto por página
2. **Inclusion set** (`nova_tools_for_voice`): carga solo las tools explicitamente listadas + meta-tool

### 1.7 Error Handling

```python
def _role_error(tool_name, allowed):
    return f"No tenes permiso para usar '{tool_name}'. Solo disponible para: {', '.join(allowed)}."
```

Patrón en cada tool sensible:
```python
if user_role not in ("ceo", "secretary"):
    return _role_error("crear_presupuesto", ["ceo", "secretary"])
```

Try/except global envuelve todo el dispatcher:
```python
try:
    # ... branches ...
except Exception as e:
    logger.error(f"Error executing nova tool '{name}': {e}", exc_info=True)
    return f"Error al ejecutar '{name}': {str(e)}"
```

### 1.8 Argument Parsing

Helper functions:
- `_parse_date_str(d)` → maneja `YYYY-MM-DD`, `DD/MM/YYYY`, `date`, `datetime`
- `_parse_datetime_str(d, tz)` → múltiples formatos con timezone
- `_fmt_date(d)`, `_fmt_money(amount)` → formateo para output speech

Las tools **nunca validan tipos estrictamente** — acceden directamente a `args.get("field")` y convierten con `int()`, `float()`, etc. Esto funciona porque OpenAI function calling ya garantiza el tipo.

---

## 2. MuzApp Tools Architecture (Current)

### 2.1 Arquitectura Actual

**5 archivos** + 1 barrel:

| Archivo | Tools | Dominio |
|---------|-------|---------|
| `tools.ts` | Barrel: exporta 37 tools en grupos + flat | Organización |
| `toolsQuery.ts` | 6 tools | Consulta de pedidos |
| `toolsClient.ts` | 6 tools | Gestión de clientes |
| `toolsOrder.ts` | 10 tools | Gestión de pedidos |
| `toolsManagement.ts` | 18 tools | Gestión interna (clientes, config, analytics) |
| `toolsProduct.ts` | 8 tools | Catálogo de productos |
| `toolsAnalytics.ts` | 4 tools | Métricas de negocio |
| `toolsWhatsApp.ts` | 2 tools | Comunicación WhatsApp |

**Total**: 37+ tools definidas con el patrón `tool()` de Vercel AI SDK + `zod` schemas.

### 2.2 Cómo se definen las tools

```typescript
import { tool } from "ai";
import { z } from "zod";

export const getOrderById = tool({
  description: "Consulta un pedido específico por su ID...",
  inputSchema: z.object({
    orderId: z.number().describe("ID del pedido a consultar"),
  }),
  execute: async ({ orderId }) => {
    // ... query Drizzle, return objeto
  },
});
```

Patrón de Vercel AI SDK:
- `description`: string instructivo para el LLM
- `inputSchema`: zod schema que define + valida parámetros
- `execute`: async function que recibe los args tipados por zod
- **Return**: objeto plano (no string necesariamente)

### 2.3 Organización: Tool Groups

```typescript
export const manageOrder = {
  name: "manageOrder",
  description: "Grupo de herramientas para crear y gestionar pedidos...",
  tools: manageOrderTools,
};
```

7 grupos que contienen sub-tools. Los grupos se exportan en `toolGroups`.

Además hay un **flat export** en `internalAgentTools` que mapea cada tool individual a su nombre plano (37 entries).

### 2.4 Cómo se consume

No hay dispatcher central. Cada tool es una función independiente. El handler de Vercel AI SDK recibe function calls y las mapea. Cada tool recibe solo sus propios argumentos — no recibe contexto global como `tenant_id` o `user_role`.

### 2.5 Ausencias Notables

- **NO hay filtrado por página/canal**: todas las tools están disponibles siempre
- **NO hay meta-tool**: no hay `herramienta_avanzada`
- **NO hay CRUD genérico**: `queryDataTool` en toolsManagement es lo más cercano pero limitado (8 tablas hardcodeadas)
- **NO hay RBAC**: no hay verificación de roles
- **NO hay dispatcher central**: la resolución de qué tool ejecutar está en el handler de Vercel AI SDK
- **NO hay error handling unificado**: cada tool maneja errores independientemente

---

## 3. Differences and What to Adopt for MuzApp

### 3.1 What ClinicForge Does Better

| Aspecto | ClinicForge | MuzApp | Prioridad |
|---------|-------------|--------|-----------|
| **Meta-tool** | `herramienta_avanzada` permite acceder a ~40+ tools sin cargar su schema | No existe. Cada tool nueva aumenta el schema del LLM | **ALTA** |
| **Filtrado por página** | 3 páginas (telegram, dashboard, agenda) + voice con inclusion set | Sin filtrado. Todas las tools disponibles siempre | **ALTA** |
| **Dispatcher central** | `execute_nova_tool` con try/catch global | Sin dispatcher; mapeo en handler externo | **MEDIA** |
| **RBAC** | `user_role` en cada tool sensible | Sin roles | **MEDIA** |
| **CRUD genérico** | `obtener_registros`, `actualizar_registro`, `crear_registro`, `contar_registros` para CUALQUIER tabla | `queryDataTool` con 8 tablas hardcodeadas | **MEDIA** |
| **Memoria persistente** | `guardar_memoria`, `buscar_memorias`, `ver_contexto_memorias` con tipos semánticos | No existe | **ALTA** |
| **Formateo de fechas/moneda** | Helpers centralizados `_fmt_date`, `_fmt_money`, `_parse_date_str` | Inline en cada tool, repetido | **BAJA** |
| **Consistencia de return** | Siempre string plano | A veces string, a veces objeto | **BAJA** |
| **Descriptions de tools** | Largas, instructivas, con ejemplos de uso | Cortas, funcionales | **BAJA** |

### 3.2 What to Adopt (Ordered by Impact)

#### 1. Meta-Tool Pattern (ALTA)

Crear una herramienta `herramienta` o `advancedTool` que reciba `{toolName, args}` y redirija. Esto permite:
- Tener ~10-15 tools directas (las de uso frecuente) en el schema del LLM
- El resto (~20+ tools de baja frecuencia) accesibles vía la meta-tool
- Reducir drásticamente el contexto consumido por el schema de tools

```typescript
// Esquema conceptual
export const advancedTool = tool({
  description: "Ejecuta cualquier herramienta avanzada...",
  inputSchema: z.object({
    toolName: z.enum(["getBusinessHours", "updateAgentConfig", ...]),
    args: z.record(z.any()),
  }),
  execute: async ({ toolName, args }) => {
    return await toolExecutor(toolName, args);
  },
});
```

#### 2. Filtrado por Canal (ALTA)

Separar qué tools están disponibles en:
- **Telegram admin**: todas (37)
- **WhatsApp agent**: subset (consulta de productos, estado de pedido, etc.)
- **Voice/audio**: subset mínimo + meta-tool

```typescript
const ALLOWED_TOOLS_BY_CHANNEL = {
  telegram: new Set(["createOrder", "getOrders", ...]), // inclusion
  whatsapp: new Set(["getOrderStatus", "getAllProducts", ...]),
  voice: new Set(["getOrderStatus", "searchProducts", ...]),
};
```

#### 3. Dispatcher Central con Error Handling Unificado (MEDIA)

Un solo `executeTool(name, args)` con try/catch global y logging. Esto elimina el try/catch repetido en cada tool.

#### 4. CRUD Genérico (MEDIA)

Expandir `queryDataTool` para aceptar CUALQUIER tabla (no solo 8 hardcodeadas), y agregar `createRecord`, `updateRecord`, `deleteRecord` como tools independientes.

#### 5. Memoria Persistente del Agente (ALTA)

Implementar herramientas para que el agente recuerde entre sesiones:
- `guardarNota`: guarda una observación sobre un cliente o el negocio
- `buscarNotas`: recupera notas previas por texto libre
- `verNotasRecientes`: al inicio de sesión, restaura contexto

Esto es crítico para Mrs Muzzarella porque el dueño no tiene pantalla y necesita que el agente **recuerde** decisiones pasadas.

#### 6. RBAC Simplificado (BAJA)

Aunque MuzApp tiene 1 solo usuario admin, el patrón de roles es útil para tools destructivas (eliminar productos, cancelar pedidos). Versión simplificada:

```typescript
function roleError(tool: string): string {
  return `No tenés permiso para usar '${tool}'. Solo admin puede usarla.`;
}
```

---

## 4. Specific Tool Descriptions That Need Improvement for MuzApp

### 4.1 Tools con descriptions débiles (prioridad alta)

| Tool actual | Description actual | Problema | Mejora sugerida |
|------------|-------------------|----------|-----------------|
| `updateClient` | "Actualiza datos de un cliente..." | No dice QUÉ preguntas del owner disparan esta tool | Agregar ejemplos: "cambiá el teléfono de Cliente A a +5493704111111", "corregí el nombre de Juan" |
| `getBusinessHours` | "Muestra los horarios de atención..." | No aclara que también responde "estamos abiertos?" | Agregar "Útil para preguntas como 'estamos abiertos?', 'a qué hora cierran?'" |
| `updateOrderStatus` | "Cambia el estado de un pedido..." | No dice que el owner lo usa para mover pedidos en la cocina | Agregar "Cuando el dueño dice 'el pedido 5 está listo' o 'ya se entregó el 3'" |
| `cancelOrder` | "Cancela un pedido..." | Muy genérico | Agregar "Preguntas del owner: 'cancela el pedido 5 porque no tiene pan'" |
| `sendWhatsAppMessage` | "Envía un mensaje de WhatsApp..." | No aclara cuándo usarla vs batchSend | Agregar "Para mensajes RÁPIDOS del admin a un cliente específico. NO para notificaciones automáticas del sistema." |

### 4.2 Tools que deberían ser meta-tools (baja frecuencia)

Estas tools se usan con baja frecuencia y saturan el schema del LLM sin necesidad:

- `createProduct` / `updateProduct` / `deleteProduct` — cambios de catálogo, uso esporádico
- `updateBusinessHours` — cambios de horario, uso raro
- `setClientAlias` — configuración única
- `createDeliveredOrder` — backfill, excepción

Todas ellas pueden ir detrás de la meta-tool `herramienta` y no cargarse en el schema directo.

### 4.3 Tools que deberían existir y no existen (gaps)

| Tool faltante | Justificación | Categoría |
|--------------|---------------|-----------|
| `guardarNota` / `buscarNotas` / `verNotasRecientes` | El owner necesita que el agente recuerde cosas entre sesiones (precios, clientes problemáticos, decisiones) | **ALTA** |
| `getCocinaStatus` + `toggleCocina` | El owner pregunta "está abierta la cocina?" frecuentemente | **ALTA** |
| `getDeliveryZone` / `checkDeliveryAvailability` | Consultas de delivery frecuentes en WhatsApp | **MEDIA** |
| `recordPayment` | Registrar pago de un pedido (separado de markAsPaid que solo cambia flag) | **MEDIA** |
| `getInventoryStock` / `updateStock` | El owner necesita saber stock de pan, papas, etc. | **MEDIA** |
| `getDailySummary` | Resumen consolidado del día en 1 llamada (pedidos, ingresos, pendientes) | **MEDIA** |

### 4.4 Structura de descriptions recomendada

Basado en ClinicForge, cada `description` debería seguir esta estructura:

```
[Qué hace la tool en 1 oración]. 
[Preguntas/escenarios exactos que disparan esta tool]. 
[Qué NO hacer con esta tool (si aplica)].
```

Ejemplo:
```typescript
description:
  "Actualiza datos de contacto de un cliente existente. " +
  "PREGUNTAS DEL DUEÑO: 'cambiá el teléfono de Cliente A a +5493704111111', " +
  "'corregí el email de García', 'actualizá los datos de Juan'. " +
  "SOLO actualiza datos de contacto. No usar para crear pedidos o cambiar estados."
```

---

## Resumen de Acciones para MuzApp

1. **Implementar meta-tool** `advancedTool` con dispatcher → reduce schema size ~60%
2. **Implementar filtrado por canal** → telegram (37), whatsapp (12), voice (8+meta)
3. **Agregar tools de memoria persistente** → `guardarNota`, `buscarNotas`, `verNotasRecientes`
4. **Mejorar descriptions** siguiendo el patrón "qué hace + preguntas gatillo + qué NO hacer"
5. **Unificar error handling** con try/catch en el dispatcher
6. **Mover tools de baja frecuencia** detrás de la meta-tool (CRUD productos, horarios, alias)
7. **Agregar tools faltantes** de alta frecuencia (cocina status, daily summary)
