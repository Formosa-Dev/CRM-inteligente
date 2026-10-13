# Muzapp — Inventory of AI-Agent, Messaging, Telegram & Sales-Automation UX

Exploration-only inventory. **No product code, DB, env, dependency or destructive command was changed.**
Evidence is by source path + symbol/line. This repo is the `ai-backoffice-ux-inventory` worktree of
`Mrs Muzzarella / muzapp` (Next.js 16 App Router + React 19 + Tailwind 4 + Drizzle/Postgres + Vercel AI SDK).

- Method: `codebase-memory` MCP full index (`C-Users-Asus-orca-workspaces-muzapp-ai-backoffice-ux-inventory`,
  7318 nodes / 11733 edges), then direct reads of the UI/config/API/prompt files. `AGENTS.md`,
  `DESIGN.MD` and `sdd/` explored first as project guidance.
- Date of snapshot: branch `ai-backoffice-ux-inventory`, HEAD `b5755f0`.

---

## 1. Route / Page / Nav inventory

### Admin shell & navigation
- Nav is a single typed array: `src/components/admin/nav-items.ts:15` `navItems`. All entries `disabled:false`.
  | label | href | icon | relates to |
  |---|---|---|---|
  | Dashboard | `/admin` | `LayoutDashboardIcon` | agent action cards |
  | Productos | `/admin/products` | `PackageIcon` | |
  | Pedidos / Cocina | `/admin/orders` | `UtensilsCrossedIcon` | |
  | **Agente IA** | `/admin/agent` | `BotIcon` | agent settings |
  | **Telegram Bot** | `/admin/telegram` | `SendIcon` | internal agent config |
  | Meta Ads | `/admin/meta` | `MegaphoneIcon` | attribution |
  | **Conversaciones** | `/admin/conversations` | `MessageSquareIcon` | messaging |
  | Clientes | `/admin/clients` | `UserRoundIcon` | |
  | Leads | `/admin/leads` | `UsersIcon` | sales capture |
  | Promociones | `/admin/promos` | `MegaphoneIcon` | |
  | Caja | `/admin/caja` | `WalletIcon` | |
  | Analytics | `/admin/analytics` | `BarChart2Icon` | |
- Sidebar renders `AdminSidebarContent` (`src/components/admin/sidebar-content.tsx:15`), reused inside the
  mobile `Sheet` in the topbar (`src/components/admin/topbar.tsx:67`). Active-state logic at
  `sidebar-content.tsx:45` (exact match for `/admin`, `startsWith` otherwise). Brand wordmark uses
  `business.name` from `useBusiness()` (`sidebar-content.tsx:19,32`).

### Admin route tree (pages relevant to agents/messaging)
| Route | File |
|---|---|
| `/admin` | `src/app/(admin)/admin/page.tsx` (+ `dashboard-client.tsx`, `dashboard-actions.tsx`, `dashboard-actions-server.ts`) |
| `/admin/agent` | `src/app/(admin)/admin/agent/page.tsx` (+ `agent-config-form.tsx`, `actions.ts`) |
| `/admin/telegram` | `src/app/(admin)/admin/telegram/page.tsx` (+ `telegram-config.tsx`, `actions.ts`) |
| `/admin/conversations` | `.../conversations/page.tsx` (+ `conversations-inbox.tsx`, `conversations-table.tsx`, `actions.ts`) |
| `/admin/conversations/[id]` | `.../conversations/[id]/page.tsx` (legacy server-rendered reader) |
| `/admin/leads` | `.../leads/page.tsx` (+ `leads-table.tsx`) |
| `/admin/meta` | `.../meta/page.tsx` (+ `meta-config-client.tsx`, `meta-connection-section.tsx`) |
| `/login`, `/setup` | `src/app/login/*`, `src/app/setup/*` |

No separate "internal agents" route exists — the internal agent is configured through
`/admin/telegram` (Telegram) and `/admin/agent` (WhatsApp bot + sellers), and triggered from the
dashboard.

---

## 2. `/admin/agent` — "Agente de WhatsApp" (the agent-settings surface)

Page: `src/app/(admin)/admin/agent/page.tsx`.
- `metadata.title = "Agente — Admin"` (`page.tsx:6`).
- H1 `"Agente de WhatsApp"` + subtitle `"Configurá el comportamiento del agente de IA — credenciales, prompt, IDs permitidos y más"` (`page.tsx:153-158`).
- Server loads `agentConfig` row `id=1` and maps it into `AgentConfigFormData` (`page.tsx:75-148`).
  Secrets never reach the client — only `…Set` booleans (`ycloudApiKeySet`, `aiApiKeySet`,
  `ycloudWebhookSecretSet`, `cloudinaryApiSecretSet`, `metaAppSecretSet`,
  `metaWebhookVerifyTokenSet`, `cronSecretSet`) — see `page.tsx:92-93,130-145`.
- Defaults fallback `DEFAULT_CONFIG` (`page.tsx:20-71`) and `DEFAULT_BUSINESS_HOURS`
  (`page.tsx:10-18`): Lun–Sáb `09:00–22:00` open, Domingo closed.

Component: `src/app/(admin)/admin/agent/agent-config-form.tsx` (client, 1707 lines).
- Root `<form action={formAction}>` with `useActionState(saveAgentConfig, initialState)`
  (`agent-config-form.tsx:132,264`). Successful/failed state is surfaced via `sonner` toast
  (`agent-config-form.tsx:184-191`).
- Animated with `staggerContainer`/`fadeUpSmall` from `@/lib/animation-variants` (`:265-270`).

### Field-by-field (name → control → default / validation)

Zod schema: `src/app/(admin)/admin/agent/actions.ts:45-100` (`agentConfigSchema`).

| Section (form) | Field name | Control | Default / rule |
|---|---|---|---|
| 1 Estado del agente | `enabled` | hidden + `Switch` | `false`; toggles card border |
| 2 Configuración general | `phoneNumber` | `Input` | required `min(1)` (`actions.ts:47`) |
| | `systemPrompt` | `Textarea` rows 8 | `""` |
| 3 Credenciales YCloud | `ycloudApiKey` | password `Input` + Eye/EyeOff | write-only, `CLEAR` wipes |
| | `whatsappBotNumber` | `Input` | `""` |
| 3b Negocio | `businessName` | `Input` | max 160 |
| | `businessTagline` | `Input` | max 255 |
| | `businessAddress` | `Input` | max 255 |
| | `businessPhoneDisplay` | `Input` | max 50 |
| | `instagramHandle` | `Input` | max 100; `@` stripped on save (`actions.ts:204`) |
| | `businessWebsite` | `Input` | max 500 |
| | `businessDescription` | `Textarea` rows 2 | max 2000 |
| 3c Proveedor de IA | `aiApiKey` | password | write-only, `CLEAR` wipes |
| | `aiBaseUrl` | `Input` | placeholder `https://api.openai.com/v1` |
| | `aiModel` | `Input` | placeholder `deepseek-flash` |
| | `aiModelFast` | `Input` | placeholder `gpt-5-mini` |
| | `aiModelVision` | `Input` | placeholder `gpt-4o` |
| 3d Integraciones | `ycloudWebhookSecret` | password | write-only |
| | `cloudinaryCloudName` / `cloudinaryApiKey` / `cloudinaryApiSecret` | Input/password | secret write-only |
| | `metaAppId` / `metaAppSecret` / `metaWebhookVerifyToken` | Input/password | secret write-only |
| | `telegramNotifyChatId` | `Input` | placeholder `1991128737` |
| | `cronSecret` | password | write-only |
| | `escalationEmail` | email `Input` | `z.string().email()` (`actions.ts:99`) |
| 4 IDs permitidos | `allowedPhoneIds` | hidden JSON + add/remove list | `PhoneIdEntry[]{name,phone}` |
| 4b Vendedores | `sellerPhoneIds` | hidden JSON + add/remove list | `PhoneIdEntry[]` |
| 5 Horarios | `businessHours.<Día>.open` / `.openTime` / `.closeTime` | switch + `type="time"` | `HH:MM` regex (`actions.ts:29-30`) |
| 6 Ventana 24hs | `autoReply24h`, `autoReply24hMessage` | Switch + Textarea | message shown only when enabled |
| 6b Pedidos web | `webOrderRedirectEnabled`, `webOrderRedirectMessage` | Switch + Textarea | max 1000 (`actions.ts:57`) |
| 7 Entrenar Bot | `trainBotContext` | Textarea rows 4 | + collapsible preview `combinedSystemPrompt` (`:256-261`) |
| 8 Editor Prompt WA | `whatsappSystemPrompt` | Textarea rows 4 | if set, replaces V2 base entirely |
| | `whatsappInstrucciones` | Textarea rows 3 | maps to DB `whatsappInstructions` |
| | `whatsappZonasDelivery` | hidden JSON + repeatable rows | default centro/norte/sur (`:163-167`) |
| 9 Estado del local | `isCooking` | Switch | `true` |
| | `hamburguesasSinStock` | Switch | `false` |
| | `stockPanDocenas` | number | `0`, `int().min(0)` |
| | `aliasB2c` / `aliasB2b` | Input | payment aliases |
| | `tiempoEspera` | Input | e.g. `30-40 min` |
| | `productionHours` | Textarea rows 3 | production availability |
| 10 Imágenes de Menú | `menuImageUrlHamburguesas` / `menuImageUrlPan` | hidden + file upload + preview | uploaded to `/api/media/upload` (`:225`) |
| 10b Delivery | `deliveryEnabled` | Switch | `true` |
| | `deliveryStartHour` | Input | `14:00` |
| | `deliveryPhoneNumber` | Input | digits only |
| 11 Acciones rápidas | — | link `wa.me/<botNumber>` "Hablar con el Bot", button "Test configuración" | `handleTestConfig` → `testAgentConnection()` (`:237-251`) |
| Submit | — | sticky bottom bar | "Guardar configuración" / "Guardando…" (`:1647-1655`) |

### Server actions — `src/app/(admin)/admin/agent/actions.ts`
- `saveAgentConfig(_prev, formData)` (`:104`): `requireAdmin()` gate; rebuilds `businessHours`
  from seven fixed day keys; parses `allowedPhoneIds`, `sellerPhoneIds`, `whatsappZonasDelivery`
  from hidden JSON; Zod-validates; writes row `id=1` (update or insert); secret write pattern
  `CLEAR → null`, non-empty → `encrypt(...)`, empty → keep existing (`:256-339`); calls
  `invalidateAIConfigCache()`; `revalidatePath("/admin/agent")`.
- `testAgentConnection()` (`:365`): returns a joined checklist of ✅/❌/⚠️ for YCloud key, bot number,
  system prompt, enabled. (Pure config presence check — does not call the provider.)

### Known form-level quirks (evidence)
- The **Vendedores** add-row reuses the same `newName`/`newPhone` React state as the allowed-IDs
  row (`agent-config-form.tsx:853,868` vs `:750,765`), so the two inputs mirror each other.
- `whatsappPromociones` is parsed by the server action and persisted (`actions.ts:61,186,272`) but
  **has no form control** — it can only be set programmatically/DB.
- `agentConfigSchema` (Zod) keeps `phoneNumber: min(1)` while `whatsappBotNumber` is free-form.

---

## 3. `/admin/telegram` — internal management bot config

Page: `src/app/(admin)/admin/telegram/page.tsx` (`metadata.title = "Telegram Bot — Admin"`).
H1 `"Telegram Bot"`, subtitle `"Bot interno de gestión para consultar pedidos, ventas y entregas desde Telegram"` (`page.tsx:14-20`).

Client: `src/app/(admin)/admin/telegram/telegram-config.tsx`.
- Three `Card`s, all animated (`staggerContainer`/`fadeUpSmall`):
  1. **Estado del Bot** — `configured` badge (green/red), `botUsername`, "Probar conexión" button
     (`:149-181`).
  2. **Configuración** — read-only env-display inputs: `TELEGRAM_BOT_TOKEN` (masked via
     `maskToken`), `TELEGRAM_WEBHOOK_TOKEN` (with copy), `TELEGRAM_ALLOWED_CHAT_IDS`
     (comma-joined). Description hardcodes "Configuralas en Render" even though secrets are now
     DB-backed (see §9).
  3. **Webhook** — read-only URL + copy; buttons **Configurar Webhook**, **Verificar estado**,
     **Eliminar Webhook** (destructive); result panel with active URL + pending updates count.
- Actions: `src/app/(admin)/admin/telegram/actions.ts`.
  - `getTelegramStatus()` (`:49`): reads `getTelegramConfigFromDB()`; lazily generates and persists a
    `telegramWebhookToken` (`randomBytes(24)`); builds `${host}/api/telegram/webhook/${token}`
    (`:77`); calls `getMe` for username.
  - `setTelegramWebhookAction` (`:102`), `deleteTelegramWebhookAction` (`:152`),
    `getTelegramWebhookInfoAction` (`:176`), `saveTelegramConfigAction` (`:205`, verifies token via
    `getMe`, encrypts, stores `telegramBotToken/telegramChatId/telegramEnabled`).
  - Types: `TelegramStatus` (`:17`), `WebhookInfo` (`:27`), `TelegramActionState` (`:32`).
- Gating: every action calls `requireAdmin()`.

---

## 4. Conversations / messaging subsystem

### Inbox (active UI) — `src/app/(admin)/admin/conversations/`
- `page.tsx` (`:10`): server fetches `getConversations({page:1})`, maps rows to
  `ConversationSummary[]` (`src/types/chat.ts:27`), loads `agentConfig.sellerPhoneIds` to flag
  sellers, renders `ConversationsInbox`.
- `conversations-inbox.tsx` (client): `QueryClientProvider` (`:154`) + three-column layout driven by
  `currentView: "list" | "chat" | "context"`:
  1. `ConversationSidebar` (w-full mobile, `md:w-80`)
  2. `ChatPanel` (`:111`)
  3. `CustomerContextPanel` (`xl:w-[380px]` inline; fullscreen overlay on mobile at `:131-139`)
  Plus `CreateOrderModal` for "+ Nuevo Pedido" (`:142`). Human-override toggle wired at
  `:56-63` → `toggleHumanOverride`.
- `conversations-table.tsx` (legacy table): status filter (`Select`), columns Cliente/Teléfono/
  Estado/Mensajes/Creada, empty state `"No se encontraron conversaciones."`, pagination
  Anterior/Siguiente. Not referenced by the inbox page — appears superseded by the inbox.

### Message components — `src/components/messages/`
| File | Role |
|---|---|
| `conversation-sidebar.tsx` | Search + filter pills `Todos/WA/TG/VEN/Activos/Cerrados` (`:18-25`); count footer |
| `conversation-item.tsx` | Avatar, seller styling (`🛒`, purple), `ChannelBadge`, relative time, preview |
| `chat-panel.tsx` | Header (avatar, channel, `Manual` badge), day separators (`Hoy`/`Ayer`), auto-scroll container, `ReplyInput` |
| `message-bubble.tsx` | `roleStyles` + `roleLabels` (`user`→null, `assistant`→"Bot", `human`→"Operador", `system`→italic centered); URL strip + `LinkPreview`; media |
| `media-renderer.tsx` | Renders `contentAttributes` by type |
| `reply-input.tsx` | Enter=send/Shift+Enter=newline; **attach Paperclip is `disabled`** (`:74-81`); channel label "Enviando por {WhatsApp|Telegram}…" |
| `customer-context-panel.tsx` | Avatar/status/tags; stats; "IA Activa" card; CONTACTO; ACCIONES (+Nuevo Pedido / Agendar entrega / Ver ficha); HISTORIAL DE PEDIDOS; NOTAS; ATRIBUCIÓN |
| `channel-badge.tsx` | WA (emerald) / TG (sky) inline SVG badges |
| `lead-status-badge.tsx` | new/contacted/converted/lost → Nuevo/Contactado/Convertido/Perdido |
| `order-history.tsx` | Expanded order list with status badges (Pendiente/Preparando/Listo/Entregado/Cancelado) |
| `tag-list.tsx` | `Tag` + `getTagColor` |
| `link-preview.tsx` | OG fetch via `/api/link-preview` |
| `attachment-gallery.tsx` | `src/components/attachments/` |

### Conversation server actions — `src/app/(admin)/admin/conversations/actions.ts`
- Reads gated by `requireSession()` (viewer OK); mutations by `requireAdmin()` (`:14-17`).
- `getConversations({page=1,channel,status,search})` (`:40`): `PAGE_SIZE=50`; **default excludes
  `telegram`** (internal channel, `:54-55`); order by `COALESCE(lastMessageAt, updatedAt) DESC`;
  enriches names via `resolveClientNamesBatch` (no N+1).
- `getMessages(conversationId, limit=100, offset=0)` (`:113`): latest N DESC then `.reverse()`.
- `sendReply(conversationId, content)` (`:137`): admin; rejects empty and `>4000` chars; delegates
  to `sendOutboundMessage(..., "human")` from `@/lib/channels/router`.
- `updateConversationStatus(id, active|closed|archived)` (`:159`); `toggleHumanOverride(id, enabled)`
  sets `humanOverrideUntil = now + 24h` (`:181`); `getConversation`, `getLeadByConversation`,
  `getOrdersByLead`.
- Client data layer: `src/lib/conversations/queries.ts` — `useConversations` (poll 5s, pause when
  hidden), `useMessages` (3s), `useSendReply`, `useCustomerProfile` (lead by `conversationId`, then
  by phone fallback), `useCustomerOrders`.

### Legacy conversation detail
`src/app/(admin)/admin/conversations/[id]/page.tsx` — reads `conversations.messages` JSONB directly,
`parseMessages` (`:24`) accepts only `role ∈ {user,assistant}` with string `content`; renders
bubbles with labels `Cliente`/`Agente` + a "Metadata de la conversación" block. This page predates
`chat_messages` and is not what the inbox links to.

---

## 5. Dashboard action cards — automation triggers for the internal agent

`src/app/(admin)/admin/page.tsx`:
- `getActionCards()` (`:186`) computes five live cards from orders/conversations/leads:
  - `ready` "Listos para entregar" → `mark-delivered`
  - `stuck` "Preparando hace rato" (>45 min) → `mark-ready`
  - `stale-chats` "Chats sin respuesta" (last msg `user`, >15 min, channel whatsapp) → `open-chat`,
    **`trigger-agent`** (`:350-353`)
  - `unpaid` "Pagos pendientes" → `mark-paid`
  - `fresh-leads` "Leads nuevos" (>1h, status new) → `view-lead`
- Card labels/copy carry emoji in the server data (`✔️ Marcar Entregado`, `👉 Marcar Listo`,
  `💬 Abrir Chat`, `🤖 Activar IA`, `💵 Marcar Pagado`, `👤 Ver Lead`), but the renderer maps a
  semantic `icon` key to a lucide icon (`dashboard-actions.tsx:22-35`) and uses a single gold accent
  (`GOLD_STYLE`, `:14-19`).
- `dashboard-actions.tsx` `handleAction` (`:77`) routes to `updateOrderStatus`,
  `router.push('/admin/conversations/{id}')`, or `triggerAgentForConversation` (`:99-106`).
- `dashboard-actions-server.ts` `triggerAgentForConversation` (`:13`): loads last 20 messages
  (maps `human→assistant`), pulls YCloud key/number (DB→env), runs `runWhatsAppAgent`, persists the
  reply, sends via `sendWhatsAppBubbles`, stores the wamid, flushes `pendingMedia`
  (image/sticker). Auth = any session (not admin-gated). Success message `"✅ Agente activado — respuesta enviada"`.

---

## 6. Leads (capture / attribution / conversion)

- Page `.../leads/page.tsx`: `metadata.title = "Leads — Admin"`; header `Leads` + subtitle
  `"Contactos capturados desde campañas publicitarias"`; `PAGE_SIZE=20`; status filter; CTA
  `CreateOrderModalWrapperClient`.
- Table `.../leads/leads-table.tsx`: filter (`Todos/Nuevo/Contactado/Convertido/Perdido`), columns
  Nombre/Teléfono/Estado/Fuente UTM/Campaña/Creado, empty `"No hay leads para mostrar"`, pagination;
  right `Sheet` detail with Contacto / Atribución (refCode, platform, UTM×4) / IDs de campaña
  (adId, campaignId, adsetId, conversationId); actions **"Convertir a Cliente — Crear Pedido"** and
  **Eliminar lead** (two-step confirm) → `deleteLead`.
- API: `src/app/api/leads/route.ts` (POST public, rate-limited, size-capped `<8000`, Zod
  `CreateLeadSchema`, ref-code decode + HMAC verify; GET session-gated, filters
  campaign/status/from/to/search, limit 200); `leads/[id]/route.ts` (PATCH admin, status+notes);
  `leads/update/route.ts` (POST admin, updatable name/phone/email/address/notes/type/tags, revalidates
  clients/leads/orders/conversations/admin); `leads/stats/route.ts` (session-gated aggregates:
  total, byCampaign, bySource, byStatus, 30-day overTime).

---

## 7. API contracts related to agents / messaging / channels

| Route | Methods | Contract |
|---|---|---|
| `src/app/api/whatsapp/webhook/route.ts` | GET/POST | Canonical YCloud webhook. GET echoes `?token`. POST: signature verify (`ycloud-signature`), `isProtocolArtifact` gate, echo handler, inbound filter, dedup, rate-limit `wa-inbound:<phone>`, actor resolution (delivery/seller/customer), lead capture, auto-reply 24h, web-order redirect, session policy, buffer enqueue → `runWhatsAppAgent`; seller path uses `buildSellerPrompt`+`internalSellerTools` (`gpt-5.4-mini`). |
| `src/app/api/webhook/whatsapp/route.ts` | — | Legacy alias: `export { GET, POST }` from the canonical route (`:5`). |
| `src/app/api/telegram/webhook/[token]/route.ts` | POST | Token `timingSafeEqual`; `config.enabled`; rate-limit; auth `isChatAuthorized` (replies `"❌ No autorizado. No tengo instrucciones de responder en este chat."`); media→Whisper/Vision; idempotency + DB dedup; buffer → `buildTelegramPrompt` + `internalAgentTools` (`stepCountIs(15)`). |
| `src/app/api/agent/test/route.ts` | POST | Admin. Returns `{status:"ok"|"incomplete", issues[]}`. |
| `src/app/api/admin/test-agent/route.ts` | GET | Admin. `{success, message, checks{hasConfig,hasApiKey,hasPhoneNumber,enabled}, ycloudStatus, ycloudDetail}`; HEAD probe to `api.ycloud.com/v2/whatsapp/messages`. |
| `src/app/api/whatsapp-phone/route.ts` | GET | Public `{phone}` (DB `phoneNumber` → env). |
| `src/app/api/media/upload/route.ts` | POST | Admin. Cloudinary; allowed `jpeg/png/webp/gif`, ≤10 MB, magic-byte check; `{url}` or `{error}`. |
| `src/app/api/business/route.ts` | GET | Public business identity (client `useBusiness`). |
| `src/app/api/link-preview/route.ts` | GET | OG metadata for chat link previews. |
| `src/app/api/cron/followup/route.ts` | GET | `?key=<cronSecret>` (timing-safe). Sends `"Holaa, ¿todo bien con el pedido? No te olvides de etiquetarnos en ig porfa 🙌"` to delivered orders ≥30 min, 9–22h, atomic `followupSent` claim. |
| `src/app/api/cron/reconcile/route.ts` | GET | `?key=&mode=scan|sweep&limit=` → `runReconcile`; overlap guard. |
| `src/app/api/meta/webhook`, `meta/callback` | GET/POST | Meta Ads connection/attribution. |

`src/app/api/admin/{dlq,ref-code}` exist for queue DLQ and referral-code generation.

---

## 8. Persisted JSON / JSONB shapes

From `src/db/schema.ts` (all `jsonb`):
- `agentConfig.businessHours` (untyped jsonb, `:109`) — `{day,open,openTime,closeTime}[]`.
- `agentConfig.allowedPhoneIds` / `sellerPhoneIds` — `{name,phone}[]` (`:112-113`).
- `agentConfig.whatsappZonasDelivery` — `{zona,disponible,tiempo,costo}[]`, default centro/norte/sur (`:134-143`).
- `agentConfig.menuImageUrlsHamburguesas` / `menuImageUrlsPan` — `string[]` (`:154-155`).
- `conversations.messages` — `Record<string,unknown>[]` (`:201`, legacy copy of turns).
- `conversations.conversationMetadata` — `{repromptCount, lastUserMessageType, lastSuggestedProducts[], lastTools[]}` (`:209-214`).
- `chatMessages.contentAttributes` — `{type: image|audio|document|video, url, fileName?, fileSize?, mimeType?, caption?, transcription?, description?}[]` (`:275-284`).
- `leads.tags` `string[]`; `orders.items` jsonb; `orderContextItems`; `addresses`.
- Session machine: `conversationSessionStates`, `conversationSessionEvents`,
  `conversationSessionEffectClaims` (`:220-268`) with enums for mode/intent/question/asset/event/signal/effect.
- `agentMemories` — `{key,type:rule|fact|preference,source,content,active}` (`:407-418`).
- `reconcileCandidates.payload` `Record<string,unknown>` (`:434`); `reconcileRuns.report`.
- `cashSessions.report` (`:474`).
- Sensitive columns (`ycloudApiKey`, `aiApiKey`, `ycloudWebhookSecret`, `cloudinaryApiSecret`,
  `metaAppSecret`, `metaWebhookVerifyToken`, `cronSecret`, `telegramBotToken`) are AES-256-GCM
  encrypted at rest (`src/lib/encryption.ts`, used in `actions.ts` and `integrations.ts`).

---

## 9. Role gating & auth

- Admin layout `src/app/(admin)/layout.tsx:13-16`: `auth()` → `redirect("/login")` if no session.
  Toaster `richColors position="top-right"`.
- `src/lib/auth/require-admin.ts:9`: `requireAdmin()` = `session.user.role === "admin"`.
- Reads: conversations/leads GET use `requireSession()`/`auth()` (viewer allowed). Mutations and all
  config/secret actions require admin. `triggerAgentForConversation` only requires a session.
- Roles enum `user_role: ["admin","viewer"]` (`schema.ts:20`).
- Telegram webhook auth is token-in-URL + `isChatAuthorized(chatId, allowedChatIds)`.

---

## 10. Copy that carries behavior (single-source strings)

| String(s) | Source | Effect |
|---|---|---|
| `DEFAULT_SYSTEM_PROMPT` ("Karen" v6) | `src/lib/whatsapp/prompt-builder.ts:657` | base sales-agent persona / rules |
| `getCorePrompt` extra sections labels | `prompt-builder.ts:89-115` | admin/instruction/promo/context injection |
| `getStyleProfile` header | `prompt-builder.ts:124-134` | injects `whatsappStyleProfile` |
| `formatPermittedSessionFacts` `"SESIÓN: …"` | `prompt-builder.ts:14-48` | compact non-PII session facts |
| `buildSystemPrompt` context block | `prompt-builder.ts:510-653` | customer name/phone/line/address/cart/orders/hour/prev-context placeholder replacement |
| `FIXED_ACK_REPLY`, `FIXED_CLARIFICATION_REPLY`, `HANDOFF_REPLY` | `src/lib/whatsapp/agent.ts:62-65` | deterministic non-commercial replies |
| `resolveAgentRouting` | `agent.ts:67` | gate: which paths invoke LLM/tools |
| Web-order redirect `DEFAULT_MESSAGE` | `src/lib/whatsapp/web-order-redirect.ts:6-7` | first-contact redirect to `/carta-digital` |
| Order status notifications | `src/lib/whatsapp/status-utils.ts:27-58` | `ready`/`delivered` WhatsApp copy (`🍞/🍔`, IG mention) + agent semantics |
| Follow-up text | `src/app/api/cron/followup/route.ts:76` | review-request message |
| Escalation Telegram text | `src/lib/whatsapp/tools/escalation-email.ts:52-64` | `🔔 DERIVACIÓN` owner alert |
| Transfer-to-human reply | `src/lib/whatsapp/tools/transfer-to-human.ts:95` | `"Te paso con Leandro, el dueño, …"` |
| Seller prompt `BASE_SELLER_PROMPT` | `src/lib/whatsapp/seller-prompt.ts:133-304` | seller-via-WhatsApp executor + Muzzarella product dictionary |
| Internal agent `INTERNAL_AGENT_SYSTEM_PROMPT` | `src/lib/telegram/system-prompt.ts:1` | executive assistant persona + playbooks + radar |
| Telegram `buildTelegramPrompt` sections | `src/lib/telegram/prompt-builder.ts:11` | live business/menu/promos/memory/reconcile/cash/radar sections |
| Telegram unauthorized reply | `src/app/api/telegram/webhook/[token]/route.ts:92`, `handler.ts:41` | blocks unauthorized chats |
| Agent-config helper texts | `agent-config-form.tsx` (many) | explain write-only secrets, `CLEAR`, aliases, closed-mode behavior |

---

## 11. Sales automation

- **Reconcile** (`src/lib/reconcile/*`, cron route): SQL scan finds WhatsApp conversations with
  closed sales not loaded, deep-pass LLM classifies, writes `reconcileCandidates` + `reconcileRuns`;
  Telegram agent tools `getReconcileCandidates`/`resolveReconcileCandidate` close them.
- **Agent memory** (`agentMemories`; tools `rememberThis`/`forgetThis`/`recallMemories`): owner rules
  injected into `buildTelegramPrompt` (`telegram/prompt-builder.ts:61-78`).
- **Style learning** (`scripts/learn-style.ts`): merges `docs/chat-analysis/*.md` (or a marker block)
  into `agent_config.whatsapp_style_profile` (`:95`), which `getStyleProfile` injects.
- **Session boundary machine** (`src/lib/whatsapp/session-policy.ts` + `session-store.ts` +
  `human-handoff.ts`): classify `commercial|personal|ambiguous`; fixed/handoff/blocked paths never
  hit the LLM; idempotent effect claims (`human_override`, `owner_notification`, `customer_reply`).
- **Web-order redirect** (config-gated first contact) and **24h auto-reply**.
- **Dashboard `trigger-agent`** — manual "Activar IA" for stale chats.

---

## 12. Visual reuse constraints (design tokens / component patterns — no screenshots)

Source of truth: `DESIGN.MD` + `src/app/globals.css`.
- Dark-only: `<html class="dark">` forced (`src/app/layout.tsx:47`); backgrounds `#0a0a0a`/`#111`,
  foreground `#f5f5f5`. **Gold hairline** borders `rgba(212,160,23,0.2)` is the signature; primary
  gold `#D4A017`; single accent (no multi-hue).
- Fonts: Playfair Display (`font-heading`), Poppins (`font-sans`), Inter (`.digital-menu`),
  Geist Mono (`font-mono`, used for numerals/tokens like webhook/phone).
- Reusable classes: `text-gold-gradient` (page titles), `btn-gold`, `glass-card`/`glass-surface`,
  `card-gold-glow`, `gold-shimmer`/`Skeleton variant="shimmer"` (loading), bottom-sheet via
  `Sheet side="bottom"`/`.sheet-handle`.
- Motion: `framer-motion`; shared variants in `src/lib/animation-variants.ts` (`staggerContainer`,
  `fadeUp`, `fadeUpSmall`, `cardEntrance`); `useReducedMotion` parity. Toasts via `sonner`.
- UI kit: shadcn-base-nova components under `src/components/ui/` (`Card`, `Input`, `Textarea`,
  `Switch`, `Label`, `Select`+`SelectOption`, `Sheet`, `Table`, `Badge`, `Dialog`, `AlertDialog`,
  `SegmentedControl`, `Tag`/`TagInput`). Icons = `lucide-react` only.
- Chat-specific patterns to reuse: role-tinted bubbles (`message-bubble.tsx:21-33`), channel badges
  (`channel-badge.tsx`), filter pills (`conversation-sidebar.tsx:83-99`), 3-column inbox with
  mobile view-switch (`conversations-inbox.tsx:87-139`).
- Documented gaps to respect: emoji still present in `dashboard-actions` server strings and
  `agent-config-form` section headers (`DESIGN.MD` "Brechas" #8/#12); `.digital-menu` crema gold
  `#d7c198` must not be mixed with admin `#D4A017`.

---

## 13. Generic capability vs Muzzarella-domain content

**Generic / reusable across deployments (agnostic):**
- Agent-config form structure + Zod schema + secret write pattern (`CLEAR`/encrypt) — `agent actions.ts`.
- Telegram config UI + webhook lifecycle actions.
- Conversations inbox, message components, channel router, status badges, order history.
- Auth/gating (`requireAdmin`/`requireSession`), encryption, rate limiting, idempotency.
- Session boundary machine, handoff claims, reconcile/follow-up infrastructure.
- Prompt *layers* (`getCorePrompt`, `getStyleProfile`, `getBusinessInfo`) — parameterized by DB.

**Muzzarella-domain content embedded in code (must be re-authored per deployment):**
- Product synonym dictionary and example names (Genesis, Deli Deli, Bookbinder, Toro Asado,
  Papas Chesse, Prepizza, tragos) — `seller-prompt.ts:230-265`, `telegram/system-prompt.ts`.
- Business hours defaults `09:00–22:00`, delivery zones centro/norte/sur, `deliveryStartHour 14:00`.
- Aliases examples (`LEAN..LEMON`, `PANES.AL.POR.MAYOR`), menu images (hamburguesas/pan).
- Karen persona (`DEFAULT_SYSTEM_PROMPT`), status copy referencing "hamburguesas", `/carta-digital`
  redirect, IG handle `@…` in delivered notifications.
- Owner identity default `OWNER_NAME` and hardcoded `"Te paso con Leandro…"` (`transfer-to-human.ts:95`).

---

## 14. Empty / loading / error states observed

- Admin page loading skeleton: `src/app/(admin)/admin/loading.tsx` (+ `Skeleton variant="shimmer"`).
- Conversations: sidebar `"No se encontraron conversaciones"` (`conversation-sidebar.tsx:128`);
  chat placeholder `"Seleccioná una conversación"` (`conversations-inbox.tsx:108`);
  context `"Cargando..."` / `"Sin datos de cliente"` (`customer-context-panel.tsx:41,49`).
- Leads/table empty states; order history `"Cargando pedidos..."` / `"Sin pedidos"`.
- Agent test result panel: green/amber border + `CheckCircle2`/`AlertCircle` (`agent-config-form.tsx:1620-1638`).
- Telegram webhook result panel + disabled buttons until `configured`.
- Webhook/API errors: JSON `{error}`/`{message}` with 401/429/503; webhooks return `200` to avoid retry storms.

---

## 15. Evidence index (primary files)

- Config UI: `src/app/(admin)/admin/agent/{page.tsx,agent-config-form.tsx,actions.ts}` ·
  `src/app/(admin)/admin/telegram/{page.tsx,telegram-config.tsx,actions.ts}`
- Messaging UI: `src/app/(admin)/admin/conversations/**` · `src/components/messages/**` ·
  `src/components/orders/create-order-modal.tsx`
- Dashboard automations: `src/app/(admin)/admin/{page.tsx,dashboard-actions.tsx,dashboard-actions-server.ts}`
- Leads: `src/app/(admin)/admin/leads/**` · `src/app/api/leads/**`
- Agent runtime: `src/lib/whatsapp/{agent,prompt-builder,seller-prompt,session-policy,session-store,human-handoff,web-order-redirect,status-utils}.ts` ·
  `src/lib/whatsapp/tools/**` · `src/lib/telegram/{system-prompt,prompt-builder,handler,tools}.ts`
- Persistence: `src/db/schema.ts` · `src/lib/integrations.ts` · `src/lib/business.ts`
- APIs: `src/app/api/{whatsapp/webhook,webhook/whatsapp,telegram/webhook/[token],agent/test,admin/test-agent,whatsapp-phone,media/upload,cron/followup,cron/reconcile}/route.ts`
- Design: `DESIGN.MD` · `src/app/globals.css` · `src/lib/animation-variants.ts`
