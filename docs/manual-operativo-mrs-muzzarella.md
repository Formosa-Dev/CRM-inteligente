# Manual Operativo — Mrs Muzzarella

## Cómo usar la plataforma (dueños, cocina, delivery, administración)

---

# Parte 1: ¿Qué es esta plataforma?

Mrs Muzzarella tiene un **sistema digital** que reemplaza el papel y los mensajes sueltos. Acá pasa TODO:

- **Los clientes piden por WhatsApp** — lo atiende **Karen** (un agente automático)
- **El negocio se gestiona desde el Panel Web** — en `muzapp.onrender.com/admin`
- **El dueño/encargado maneja todo desde Telegram** — un bot interno con el que hablás
- **Cocina ve los pedidos en el Panel Web** — y va cambiando estados
- **Delivery recibe los pedidos por WhatsApp** — automáticamente cuando se confirma

### Las 3 interfaces del sistema

```
┌─────────────────────────────────────────────────────────┐
│                    MRS MUZZARELLA                        │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  1. WHATSAPP (Clientes ↔ Karen)                          │
│     Los clientes piden acá. Karen los atiende sola.      │
│                                                          │
│  2. PANEL WEB (Cocina + Admin)                           │
│     muzapp.onrender.com/admin                            │
│     Acá se ven los pedidos, se cambian estados,           │
│     se configura todo.                                   │
│                                                          │
│  3. TELEGRAM (Dueño/Encargado)                           │
│     @MrsMuzzarellaBot — el dueño maneja el negocio       │
│     desde acá: productos, clientes, stats, delivery.      │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

# Parte 2: Los estados de un pedido (ENTENDÉ ESTO PRIMERO)

Cada pedido pasa por estos estados. **Es IMPORTANTE que todos entiendan esto** porque coordina a todo el equipo:

```
  ┌──────────┐
  │ PENDING  │  ← Acá aparece cuando el cliente pide
  │          │    (o cuando alguien crea un pedido manual)
  └────┬─────┘
       │
  [Cocina empieza a preparar]
       │
       ▼
  ┌────────────┐
  │ PREPARING  │  ← La cocina está trabajando en el pedido
  └─────┬──────┘
        │
   [Cocina termina]
        │
        ▼
  ┌────────┐
  │ READY  │  ← Listo para entregar o que el cliente retire
  └───┬────┘
      │
  [Se entrega al cliente]
      │
      ▼
  ┌───────────┐
  │ DELIVERED │  ← Entregado. Fin del ciclo.
  └───────────┘

  CUALQUIER estado → CANCELLED (solo si se cancela)
```

### ¿Qué significa cada estado?

| Estado | Significa | Quién lo cambia | Lo que pasa automáticamente |
|--------|-----------|-----------------|------------------------------|
| **PENDING** | Pedido recibido, hay que hacerlo | Se crea solo | Llega notificación a Telegram |
| **PREPARING** | La cocina lo está preparando | Cocina (panel web) o Telegram | WhatsApp al cliente: "tu pedido ya está en preparación" |
| **READY** | Está listo para entregar/retirar | Cocina (panel web) o Telegram | WhatsApp al cliente: "ya está listo" + según delivery o retiro |
| **DELIVERED** | Entregado al cliente | Delivery/Admin (panel web) o Telegram | WhatsApp al cliente: "espero que lo hayas disfrutado" |
| **CANCELLED** | Cancelado | Admin (panel web) o Telegram | WhatsApp al cliente: "tu pedido fue cancelado" |

### Después de entregado: Follow-up automático

**30 minutos después** de marcar un pedido como `delivered`, el sistema le manda automáticamente al cliente:

> "Hola [nombre], quería saber si todo estuvo bien con tu pedido. Cualquier cosa, acá estoy."

Esto se hace SOLO y no hay que tocarlo.

---

# Parte 3: Para cada rol — ¿Qué mirar y qué hacer?

## 👨‍🍳 COCINA

### ¿Qué tenés que mirar?

**El Panel Web → sección "Pedidos / Cocina"** (`/admin/orders`)

Acá ves TODOS los pedidos en tarjetas (cards). Cada card muestra:

```
┌─────────────────────────────────────┐
│ #123             🍔 Hamburguesas    │
│                                     │
│ Juan Pérez                          │
│ +549370XXXXXXX                      │
│                                     │
│ 2x Génesis                          │
│ 1x Cheddar Fries                    │
│                                     │
│ "Sin cebolla" (nota del cliente)    │
│                                     │
│ 🟡 Pendiente · Hace 5 min          │
│                                     │
│   [→ Preparando]  [🔔]             │
└─────────────────────────────────────┘
```

### Los filtros arriba te ayudan:

```
[Todos (45)]  [Pendiente (12)]  [Preparando (8)]  [Listo (5)]  [Entregado]  [Cancelado]
```

### ¿Qué tenés que hacer?

| Situación | Acción | Botón |
|-----------|--------|-------|
| Agarrás un pedido nuevo para hacer | Cliqueá "→ Preparando" | ✅ |
| Terminaste de preparar | Cliqueá "→ Listo" | ✅ |
| El cliente retiró o se entregó | Cliqueá "→ Entregado" | ✅ |

**Importante:** Cada vez que cliqueás, el sistema automáticamente le manda un WhatsApp al cliente avisándole. No tenés que hacer nada más.

### ¿Y si hay un problema?

- **Botón 🔔 (campana):** Reenvía el WhatsApp del estado actual al cliente (por si no le llegó)
- Si tenés que **cancelar un pedido**, solo desde el estado "Pendiente" — avisale al encargado que lo haga por Telegram

### ¿Qué NO te compete?

- ❌ Crear productos nuevos
- ❌ Modificar precios
- ❌ Hablar con clientes por WhatsApp
- ❌ Configurar horarios

---

## 🚚 DELIVERY

### ¿Cómo te llegan los pedidos?

**Por WhatsApp, al número de delivery que está configurado.**

Cuando un cliente confirma un pedido con dirección, te llega automáticamente:

```
🚚 NUEVO PEDIDO #42 PARA DELIVERY

👤 Juan Pérez
📱 +549370XXXXXXX
📍 Av. Siempre Viva 123
🗺️ https://www.google.com/maps?q=-26.123,-58.123

• 2x Génesis — $7.000
• 1x Cheddar Fries — $1.200

💰 Total: $8.200
```

### ¿Qué tenés que hacer?

1. **Cuando recibís el pedido** → andá a buscarlo a la cocina
2. **Cuando estás por salir** → esperá que esté en estado "READY" (listo)
3. **Cuando llegás al domicilio** → mandá cualquier mensaje de texto al número de WhatsApp del local. El sistema detecta que fuiste vos y le avisa al cliente:
   > "¡Hola [nombre]! El delivery ya está afuera con tu pedido. Que lo disfrutes 🍔"

### Tips:
- No hace falta que escribas "llegué" — cualquier texto funciona
- Si no hay pedidos pendientes, el sistema te responde "Gracias, no hay pedidos pendientes."
- Si tenés dudas sobre la dirección, contactá al encargado por otro medio (no por el WhatsApp del bot)

---

## 👑 DUEÑO / ADMINISTRACIÓN

Vos tenés la plataforma COMPLETA. Podés usar DOS interfaces:

### Opción 1: Telegram Bot (@MrsMuzzarellaBot) — para el día a día

El bot de Telegram es tu **asistente ejecutivo**. Le hablás y él hace. Cosas que podés pedirle:

| Qué querés hacer | Decile al bot | Ejemplo |
|-----------------|---------------|---------|
| Ver resumen del negocio | "cómo vamos?" | Te dice cocina, pedidos, stock, leads |
| Ver pedidos pendientes | "qué pedidos hay pendientes?" | Lista todo lo que hay que hacer |
| Cambiar estado de pedido | "el pedido 5 está listo" | Cambia estado y avisa al cliente |
| Ver perfil de un cliente | "dame el perfil de Juan" | Muestra pedidos, dirección, notas |
| Ver el pedido actual de un chat | "mostrame el contexto del chat 5" | Muestra items + direcciones + historial |
| Agregar nota a un cliente | "dejale una nota a María que prefiere pollo" | Agrega nota interna |
| Crear producto | "creá hamburguesa de carne, hornela, 5000" | Crea el producto en el catálogo |
| Ver analytics | "cómo vamos hoy?" o "ventas de esta semana" | Muestra métricas |
| Cambiar configuración | "abrí la cocina" o "cambiá horario a 05-23" | Cambia al instante |
| Mandar WhatsApp a un cliente | "mandale a Juan 'tu pedido ya salió'" | Envía el mensaje |
| Tomar control de un chat | "tomá control del chat 5" | Desactiva a Karen, vos podés responder |
| Ver conversaciones | "mostrame los chats" | Últimas conversaciones |

### Opción 2: Panel Web — para gestión más visual y cocina

**Dashboard** (`/admin`): Resumen del día con tarjetas de métricas y actividad reciente.

**Productos** (`/admin/products`): CRUD completo de productos. Podés crear, editar, desactivar, eliminar.

**Pedidos / Cocina** (`/admin/orders`): Todos los pedidos en cards. La cocina labura acá.

**Agente IA** (`/admin/agent`): Configuración COMPLETA del negocio:
- Prender/apagar a Karen
- Horarios de atención
- Estado de cocina (prendida/apagada)
- Stock de pan en docenas
- Alias de Mercado Pago (B2C y B2B)
- Promociones activas
- Zonas de delivery (con costo y tiempo)
- Número de WhatsApp del delivery
- Imágenes del menú
- Contexto extra para entrenar a Karen

**Telegram Bot** (`/admin/telegram`): Configuración del bot de Telegram (token, webhook).

**Meta Ads** (`/admin/meta`): Conexión con Meta (Facebook/Instagram Ads), Pixel, Conversion API.

**Conversaciones** (`/admin/conversations`): Inbox de todas las conversaciones. Podés leer, responder, tomar control manual.

**Clientes** (`/admin/clients`): Personas que ya compraron (tienen al menos un pedido).

**Leads** (`/admin/leads`): Todos los contactos (hayan comprado o no). Acá ves atribución UTM.

**Analytics** (`/admin/analytics`): Estadísticas: leads totales, esta semana, top campaña, tasa de conversión, gráfico de leads por fuente y tabla de campañas.

---

# Parte 4: Cómo funciona el flujo completo (para entender el sistema)

## 1. El cliente escribe por WhatsApp

```
Cliente: "hola, una Génesis"
Karen responde automáticamente
```

Karen usa su **flujo de venta**:
1. Escucha qué producto pide → confirma precio
2. Pregunta cantidad
3. Pregunta delivery o retiro
4. Si delivery → pide dirección + ubicación GPS
5. Pregunta método de pago
6. Cuando el cliente confirma → CREA EL PEDIDO automáticamente

## 2. Cuando se crea un pedido

Pasan TRES cosas automáticamente:

**A. Notificación a Telegram** del dueño/encargado:
```
🍔 Nuevo Pedido #42
👤 Cliente: Juan Pérez
📦 Items: 2x Génesis
💰 Total: $7.000
📋 Estado: pending
```

**B. Notificación al delivery** (si tiene dirección):
```
🚚 NUEVO PEDIDO #42 PARA DELIVERY
👤 Juan Pérez 📱 +549370...
📍 Dirección + link de Maps
Items + total
```

**C. El pedido aparece en el Panel Web** (`/admin/orders`) como tarjeta **amarilla "Pendiente"**

## 3. Ciclo de vida del pedido en cocina

```
📱 Cliente pide → 🟡 PENDING (visible en cocina)
                       ↓ cocina empieza
                   🔵 PREPARING (cliente recibe WhatsApp)
                       ↓ cocina termina
                   🟢 READY (cliente recibe WhatsApp)
                       ↓ se entrega
                   ✅ DELIVERED (cliente recibe WhatsApp)
                       ↓ 30 min después
                   📨 Follow-up automático "todo bien?"
```

## 4. Si el delivery notifica llegada

Cuando el delivery manda un WhatsApp (cualquier texto) al número del negocio:

```
Delivery: "llegué" (o cualquier texto)
  → Sistema detecta que es el delivery
  → Busca el último pedido pending/preparing
  → Le manda WhatsApp al cliente:
    "¡Hola Juan! El delivery ya está afuera con tu pedido. 🍔"
```

## 5. Si un humano responde desde el WhatsApp Business

Cuando vos (o alguien autorizado) respondés desde la app de WhatsApp Business:

```
  → El sistema DETECTA que respondió un humano
  → Activa "control manual" por 24 horas
  → Karen DEJA de responder automáticamente a ese cliente
  → El mensaje del humano queda registrado en el historial
```

Si querés que Karen vuelva a responder, desactivás el control manual desde el panel de Conversaciones o con Telegram:
> "desactivá override de la conversación 3"

## 6. Si Karen no puede resolver (derivación a humano)

Cuando un cliente pide algo que Karen no puede manejar (reclamo, problema serio, B2B complejo):

```
  → Karen activa "control manual" por 24 horas
  → Manda un email de aviso
  → El cliente queda en espera de que un humano lo atienda
  → Te llega notificación
```

---

# Parte 5: Preguntas frecuentes por rol

## Para cocina

**¿Cada cuánto actualizo el panel?**
Cada vez que termines un pedido o empieces uno nuevo. Es importante mantener los estados al día porque:
- El cliente recibe WhatsApp automático de cada cambio
- El delivery sabe cuándo está listo para salir
- El dueño sabe lo que está pasando

**¿Qué hago si un cliente viene a retirar y no está marcado como "Listo"?**
Igual entregale el pedido. Después avisale al encargado que lo marque como entregado en el panel.

**¿Puedo crear un pedido desde cocina?**
Sí, el botón "+ Nuevo Pedido" arriba a la derecha. Usalo si un cliente llama por teléfono o viene al local.

## Para delivery

**¿Cada vez que llego mando un WhatsApp?**
Sí, apenas llegues al domicilio. Cualquier texto sirve — el sistema entiende que llegaste.

**¿Qué hago si el cliente no está?**
Contactá al encargado. No le mandes mensajes propios al cliente por WhatsApp.

**¿Me llega la dirección con link a Google Maps?**
Sí, el mensaje incluye `🗺️ link de Maps` para que puedas navegar directo.

## Para el dueño

**¿Qué no puede hacer Karen?**
- No maneja reclamos serios (deriva a humano)
- No da datos bancarios ni de pago
- No modifica pedidos entregados
- No habla de productos que el cliente no preguntó

**¿Puedo confiar en que Karen vende bien?**
Sí, pero siempre podés revisar las conversaciones en la sección Conversaciones del panel web o pedirle contexto al bot de Telegram.

**¿Qué hago si el sistema falla?**
- Revisá que el agente esté activo en `/admin/agent` (switch "Activar/Desactivar")
- Revisá que Telegram esté configurado en `/admin/telegram`
- Si todo falla, contactá al desarrollador

---

# Parte 6: Glosario rápido

| Término | Significa |
|---------|-----------|
| **Karen** | El agente automático que atiende WhatsApp |
| **Pending** | Pedido nuevo, sin empezar |
| **Preparing** | En preparación (cocina trabajando) |
| **Ready** | Listo para entregar/retirar |
| **Delivered** | Entregado al cliente |
| **Cancelled** | Cancelado |
| **Lead** | Persona que contactó pero todavía no compró |
| **Cliente** | Persona que ya hizo al menos un pedido |
| **Human Override** | Control manual: un humano está atendiendo, Karen no responde |
| **Order Context** | Memoria del pedido actual (lo que el cliente va pidiendo) |
| **TTL 30min** | Si el cliente tarda más de 30 min en confirmar, se pierde el pedido en curso |
| **Notify Delivery** | Mensaje automático al delivery con dirección y items |
| **Follow-up** | Mensaje automático 30 min después de entregado |
| **B2C** | Consumidor final (hamburguesas) |
| **B2B** | Business (pan al por mayor) |

---

# Parte 7: Resumen visual — QUÉ MIRA CADA QUIEN

| Rol | Interfaz principal | Qué mira | Qué hace |
|-----|-------------------|----------|----------|
| 👨‍🍳 **Cocina** | Panel Web → Pedidos/Cocina | Cards de pedidos por estado | Cambia estados pending→preparing→ready |
| 🚚 **Delivery** | WhatsApp (delivery phone) | Mensajes de nuevos pedidos | Recibe pedidos, confirma llegada |
| 👑 **Dueño** | Telegram + Panel Web | TODO | Gestiona clientes, productos, analytics, override, delivery |
| 🤖 **Karen** | — (automático) | WhatsApp entrantes | Vende, toma pedidos, respuestas automáticas |

---

**Versión:** 1.0 — Mayo 2026  
**Plataforma:** muzapp.onrender.com  
**Bot Telegram:** @MrsMuzzarellaBot  
**WhatsApp Business:** Número configurado en el sistema
