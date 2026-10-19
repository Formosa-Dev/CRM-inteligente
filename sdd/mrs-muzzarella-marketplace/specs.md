# SPECS: Mrs Muzzarella Marketplace + Order Flow + UI Upgrade

## Overview
E-commerce minimal para Mrs Muzzarella con:
1. Marketplace premium estilo Citronela/ClinicForge
2. Redirection a WhatsApp con mensaje precargado
3. Procesamiento automático de pedidos por agente
4. UI premium dark con gold accents

---

## ARCHITECTURE

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Landing    │───▶│ WhatsApp    │───▶│  Agente     │
│  (cards)    │    │ (mensaje)  │    │ (procesa)   │
└─────────────┘    └─────────────┘    └─────────────┘
                                            │
                   ┌─────────────────────────┤
                   ▼                         ▼
           ┌──────────────┐         ┌──────────────┐
           │ DB: Cliente  │         │  Telegram    │
           │ + Pedido    │         │  (Lichas)    │
           └──────────────┘         └──────────────┘
```

---

## FASE 1: PRODUCT CARDS + WHATSAPP

### 1.1 ProductCard Component
```
Location: src/components/products/product-card.tsx

Props:
- product: { id, name, price, description, imageUrl, line, category }
- onWhatsAppClick?: (product) => void

UI:
- Card glassmorphism (dark bg, gold border on hover)
- Imagen del producto (150x150, object-cover, rounded-xl)
- Nombre (Playfair Display, 18px, white)
- Precio (bold, gold #D4A017, 20px)
- Línea badge (pollo/carne/pan) - pill style
- Botón "Pedir por WhatsApp" - gold gradient, wa icon
- Hover: scale(1.02), gold glow shadow

Interaction:
- Click → window.open(`wa.me/5493704111111?text=${mensaje}`)
- GA event: "add_to_cart", { product_id, product_name }
```

### 1.2 WhatsApp Message Builder
```
Function: buildOrderMessage(product)

Template: "Hola! Quiero pedir:%0A- ${product.name}%0A- Precio: ${product.price}%0A%0APedido desde la web"
```

### 1.3 Product Grid
```
Layout:
- Mobile: 1 columna
- Tablet: 2 columnas
- Desktop: 3-4 columnas
- Gap: 24px
- Max-width: 1280px centered
```

---

## FASE 2: ORDER FLOW AUTOMATIZADO

### 2.1 Order Detection (Agent Tool)
```
Keywords: "quiero", "pedir", "me llevo", "dame", "2 de", "una", "una unidad"
Pattern: {cantidad} {product_name}

Examples:
- "Quiero 2 genesis" → detect: Genesis x2
- "Pedirme una deli deli" → detect: Deli Deli x1

Tool: extractOrderFromMessage(text) → { items: [{name, qty}], confidence }
```

### 2.2 Customer Creation/Update
```
Logic:
- Si phone existe → actualizar cliente + agregar pedido
- Si phone nuevo → crear cliente con tags: ["lead", "cliente"]

Schema:
leads: { phone, name, tags: ["pedido", "hamburguesa"] }
orders: { phone, customer_name, order_type, items: [], status: "pending" }
```

### 2.3 Order Response
```
Agent response:
"Perfecto! Tu pedido:
🥩 Genesis x2 - $7,600
🥗 Deli Deli x1 - $3,200

Total: $10,800
Confirmás? Tu pedido lo preparamos en 20 min."
```

### 2.4 Telegram Notification (Lichas)
```
Trigger: order_type = "pan_mayorista"

Message:
"🫓 *NUEVO PEDIDO PAN MAYORISTA*

*Cliente:* ${customerName}
*Teléfono:* ${phone}
*Pedido:*
${items}

*Total:* $${total}

⏰ Hora: ${timestamp}

Enviar a: [Dirección del cliente]"
```

Env:
- TELEGRAM_LICHAS_CHAT_ID = ID de Lichas
```

---

## FASE 3: UI PREMIUM UPGRADE

### 3.1 Dashboard Style
```
Theme: Dark Premium (ClinicForge style)
- Background: #0a0a0a (not pure black)
- Cards: rgba(255,255,255,0.03) + blur(16px)
- Borders: 1px solid rgba(212,160,23,0.15)
- Accents: Gold #D4A017, Orange #E8712A
- Text: white/70 (secondary), white (primary)
- Font: Playfair Display (headings), system (body)
```

### 3.2 Animations
```
Library: framer-motion

Page entrance:
- staggerChildren: 0.05s delay between items
- fadeUp: { y: 20, opacity: 0 } → { y: 0, opacity: 1 }

Cards hover:
- scale: 1.02
- boxShadow: "0 0 24px rgba(212,160,23,0.2)"

Buttons:
- gold gradient on hover
- subtle pulse on CTA
```

### 3.3 Navigation
```
Sidebar (admin):
- Width: 280px (collapsed: 80px)
- Items: Dashboard, Pedidos, Clientes, Productos, Conversaciones, Analytics
- Active state: gold left border + bg highlight
- Icons: Lucide React
- Hover: subtle gold glow
```

### 3.4 Dashboard Cards (ClinicForge style)
```
Stats Cards:
- Glass effect (backdrop-blur-xl)
- Icon: gold gradient circle
- Value: big number (48px), Playfair
- Label: muted text, uppercase, tracking-wide

Recent Activity:
- Timeline style with gold dots
- Time relative ("hace 5 min")
- Hover: expand details
```

### 3.5 Orders View
```
Table:
- Columns: ID, Cliente, Items, Total, Estado, Fecha, Acciones
- Status badges: gold (pending), green (ready), red (cancelled)
- Row hover: subtle highlight
- Actions: Ver, Cambiar estado, Notificar

Filters:
- Por estado (tabs: Todos, Pendientes, Preparando, Listos)
- Por fecha (Hoy, Esta semana, Este mes)
```

### 3.6 Clients View
```
Cards grid (like ClinicForge):
- Avatar circle (initials)
- Name, phone
- Tags: pills with icons
- Last order date
- Total orders count

Detail view:
- Info panel left
- Orders history right
- Tags management
- Notes section
```

### 3.7 Typography Scale
```
Display: 48px, Playfair Display, black
H1: 36px, Playfair Display, bold
H2: 24px, Playfair Display, semibold
H3: 18px, system, semibold
Body: 14px, system, regular
Caption: 12px, system, muted
```

---

## ACCEPTANCE CRITERIA

### Fase 1
- [ ] ProductCard muestra imagen, nombre, precio, línea
- [ ] Botón "Pedir por WhatsApp" funciona
- [ ] Mensaje se carga correctamente en WhatsApp
- [ ] Responsive en mobile/tablet/desktop

### Fase 2
- [ ] Agente detecta pedido ("quiero 2 genesis")
- [ ] Cliente se crea/actualiza en DB
- [ ] Pedidos pan → notificación Telegram a Lichas
- [ ] Dashboard muestra historial de pedidos

### Fase 3
- [ ] Dashboard estilo dark premium
- [ ] Animaciones suaves (framer-motion)
- [ ] Sidebar navigation funcional
- [ ] Cards con glassmorphism
- [ ] Tipografía Playfair + gold accents

---

## TECH STACK

- Next.js 16 (App Router)
- Tailwind CSS
- Framer Motion
- Drizzle ORM
- Neon PostgreSQL
- YCloud WhatsApp API
- Telegram Bot API
- Lucide React Icons