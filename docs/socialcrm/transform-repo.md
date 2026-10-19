# Transform the Repo — Adapting SocialCRM to a Business Vertical

Pointer map for adapting this repo (originally a food-business app) to a
different vertical — retail, services, clinic, whatever. Read this before
customizing; it tells you **what is generic** (leave alone), **what is
restaurant-shaped** (configure or change), and **where each thing lives**.

Two kinds of adaptation, in order of effort:

1. **Configuration** — most of the business surface is already data-driven via
   `/admin/agent` → `agent_config`. Start here; many "customizations" need no
   code at all.
2. **Code** — the catalog taxonomy, storefront routes, prompts and demo data
   are food-shaped in source. The map below is the inventory.

Full de-branding context: `docs/socialcrm/self-hosted-product-roadmap.md`
§2.2 (core vs per-install rule of thumb) and
`docs/socialcrm/repo-hygiene-report.md` (leftover inventory). The hands-on
workflow is `docs/socialcrm/ai-agent-implementation-guide.md`.

## What stays generic (the platform core — do not rebrand)

- Conversation/lead/message pipeline: `conversations`, `chat_messages`,
  `leads`, `src/lib/channels/router.ts` ingestion, `/admin/conversations`,
  human override.
- Auth, `/admin` shell, `agent_config` write-only secrets model
  (`src/lib/integrations.ts`, `src/lib/encryption.ts`).
- AI provider abstraction (`src/lib/ai/config.ts`), webhook signature checks,
  buffer/DLQ/rate-limit/circuit-breaker infra, cron endpoints.
- Install/deploy surface: `render.yaml`, `docs/socialcrm/*`, `.env.example`
  (already generic; `DATABASE_URL` placeholder updated to Neon).

## Restaurant-isms inventory

### Data model (hardest to change — enum-driven)

| Where | What |
|---|---|
| `src/db/schema.ts` `productCategoryEnum` | `hamburguesa`, `acompanamiento`, `pan_mayorista`, `tragos_vip`, `bebidas`, `alcohol`, `empanadas`, `pizzas` |
| `src/db/schema.ts` `orderTypeEnum` | `hamburguesas`, `pan_mayorista` |
| `src/db/schema.ts` `agentConfig` fields | `isCooking`, `hamburguesasSinStock`, `stockPanDocenas`, `aliasB2c`, `aliasB2b`, `tiempoEspera`, `menuImageUrlHamburguesas/Pan(+s)`, `whatsappZonasDelivery` default centro/norte/sur, `productionHours`, `b2cStartHour` |

Enum changes require a **new additive migration** (`db:generate` after schema
edit) — never edit applied SQL files, and note the journal is being repaired
(G3/S6). For a non-food vertical the cheap path is mapping the catalog onto
existing enum values; the real fix is the data-driven taxonomy planned in
roadmap Phase 2.

### Storefront

| Where | What |
|---|---|
| `src/app/(storefront)/` | hardcoded routes: `hamburguesas/`, `pan-mayorista/`, `tragos-vip/`, `promo/` |
| `src/components/home/` | `bread-showcase`, `empanadas-showcase`, `landing-menu`, `landing-hero`, `promos-section`, `delivery-cta`, `client-gallery` |
| `src/components/hero/hero-section.tsx`, `cart/`, `products/upsell-modal.tsx` | food imagery/copy |
| `src/lib/constants.ts` | `LINEA_CARNE`, `BREAD_PRODUCTS`, `CAMPAIGNS`, `WHATSAPP_MESSAGES`, `PRODUCT_IMAGE_MAP`, `BG_IMAGES` — feeds storefront + `SEED_DEMO` |
| `src/db/seed.ts` | demo catalog is burgers/tragos — opt-in only (`SEED_DEMO=1`), never for real installs |

### Agent prompts & copy

| Where | What |
|---|---|
| `src/lib/whatsapp/prompt-builder.ts`, `seller-prompt.ts` | WhatsApp sales-agent prompt assembly — food terminology, few-shot examples |
| `src/lib/telegram/prompt-builder.ts`, `system-prompt.ts` | internal ops bot prompt |
| `agent_config` prompt fields | `systemPrompt`, `whatsappSystemPrompt`, `whatsappStyleProfile`, `whatsappInstructions`, `whatsappPromociones`, `trainBotContext` — all editable in `/admin/agent`, no code change needed |
| `src/app/api/cron/followup/route.ts` | hardcoded Spanish follow-up copy ("…etiquetarnos en ig…") |
| `src/lib/channels/router.ts` (~line 420) | delivery-arrival WhatsApp copy ("…tu pedido 🍔") |

### Ops modules (restaurant workflow)

| Where | What |
|---|---|
| `/admin/orders` kitchen board | pending→preparing→ready→delivered flow |
| `/admin/caja` (`src/app/(admin)/admin/caja/`) | cash sessions |
| Delivery | `deliveryPhoneNumber` field + arrival-notify flow in `router.ts`; `deliveryEnabled` flag exists to switch it off |
| Cron `/api/cron/reconcile` | LLM sweep assumes chat→sale semantics — review copy/prompts for non-sale verticals |

For non-food verticals: disable via `agent_config` flags where possible
(`deliveryEnabled`, zones `disponible: false`); removing modules entirely is
deferred to roadmap Phase 2 (feature flags with off-by-default).

### Brand strings & names

| Where | What |
|---|---|
| `package.json` | `"name": "muzapp"` |
| `src/app/api/media/upload/route.ts` | `CLOUDINARY_FOLDER = "muzapp"` |
| ~11 `src/` files | "Muzzarella"/"muzapp" strings (`git grep -in "muzzarella\|muzapp" src/`) |
| `src/app/api/link-preview/route.ts`, login form, checkout components | brand copy in metadata/UI |
| `docs/manual-operativo-mrs-muzzarella.md`, DESIGN.md | client-branded docs (hygiene slice handles removal) |

### Language

Spanish-first throughout: UI copy, agent prompts, seed, error strings. The
i18n decision is open (roadmap G9) — for another locale you are translating
strings in place, not flipping a locale file.

## Recommended order for a new vertical

1. Configure `agent_config` (identity, hours, zones, prompts, flags) — most
   rebranding happens here with zero code.
2. Replace catalog via `/admin/products` (or a custom seed mapped onto the
   existing `product_category` enum).
3. Swap branding constants (`constants.ts`, `CLOUDINARY_FOLDER`,
   `package.json` name, greppable brand strings).
4. Adapt storefront routes/components for the vertical.
5. Rewrite prompts (`prompt-builder`/`seller-prompt` + `agent_config` prompt
   fields) — keep the tool-call and guard rails intact.
6. Only if needed: additive migration for new categories/order types.

## What NOT to do

- Don't edit `drizzle/*.sql` or the journal — additive migrations only via
  `db:generate`, and wait for the S6 journal repair before generating.
- Don't remove `whatsapp`/`telegram` from `channelEnum` or touch auth,
  secrets encryption, webhook signature checks.
- Don't run `SEED_DEMO=1` on a real install — it loads the food demo catalog.
- Don't commit client PII, secrets, or real env values.
