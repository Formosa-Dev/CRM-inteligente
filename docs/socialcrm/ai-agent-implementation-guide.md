# AI-Agent Implementation Guide — SocialCRM

**Audience: an AI coding/ops agent** (Devin, Claude, Codex, etc.) that an
implementer hands this document to, along with access to their fork of
`Formosa-Dev/CRM-inteligente`. Your job: turn a generic fork into a configured
instance for one specific business — and stop before touching anything that
can break production.

This doc is a runbook, not a reference. Follow it in order. Where it points at
deeper docs, read them:

- `docs/socialcrm/implementer-onboarding.md` — the human operator runbook
- `docs/socialcrm/install-render-neon.md` — env vars, migrations, recovery
- `docs/socialcrm/transform-repo.md` — vertical adaptation map
- `docs/socialcrm/repo-hygiene-report.md` — inventory of client-specific
  leftovers (lands with the repo-hygiene slice)
- `docs/socialcrm/self-hosted-product-roadmap.md` §2.2 — the de-branding list

## Hard boundaries — read first

Do NOT:

- **Read, print, copy, or commit any real secret** — `DATABASE_URL`, `.env*`
  contents, `AUTH_SECRET`, API keys, webhook secrets. Work with placeholders;
  the owner pastes real values into consoles/env vars themselves.
- **Run migrations, seeds, or queries against a production database** — only
  against a dev DB/Neon branch the owner explicitly designates. Never run
  `db:push` against a real database; `db:migrate` is the only schema path.
- **Modify `drizzle/` or `src/db/schema.ts`** unless explicitly scoped — the
  migration journal is already damaged (G3; repair in flight).
- **Flip provider webhooks or the agent "enabled" switch in production** —
  prepare configuration, but the owner turns on live traffic.
- **Create commits with AI attribution** — conventional commits only.
- **Touch `.env*`, `agent_config` secrets, or auth/session code.**

## Phase 0 — Intake: ask the owner first

Do not start until you have these answers. Ask once, as a single list:

| # | Question | Drives |
|---|---|---|
| 1 | Business name, tagline, address, display phone, Instagram, website | `agent_config` business-identity fields; storefront |
| 2 | WhatsApp bot number (digits only, no `+`) | `agent_config.whatsappBotNumber` / `WHATSAPP_PHONE_NUMBER` |
| 3 | YCloud API key + chosen webhook secret | `/admin/agent` + provider console (owner enters) |
| 4 | AI provider: which one (OpenAI/OpenRouter/DeepSeek/Groq/Together/Ollama), API key, base URL, model names | `/admin/agent → Proveedor de IA` |
| 5 | Catalog: product list (name, description, price, category, image?) | `products` rows via `/admin/products` or seed |
| 6 | Business hours + delivery zones/costs + payment aliases | `agent_config` hours/delivery/zones fields |
| 7 | Language/tone for the agent (Spanish default — voseo Rioplatense) | prompt fields |
| 8 | Which modules to disable (kitchen board, cash `/admin/caja`, delivery, B2B wholesale) | feature fields in `agent_config`; `transform-repo.md` |
| 9 | Optional: Cloudinary creds, Telegram bot token + chat IDs, Meta app creds, Upstash | `/admin/agent → Integraciones` or env |
| 10 | Admin email + password for first login | `db:seed` (owner runs it, not you) |

If any answer is missing, mark it **BLOCKED** in your final checklist rather
than guessing.

## Phase 1 — Environment checklist

The owner deploys from their fork via `render.yaml` (Blueprint). Verify these
env prompts are planned/filled — you fill **files and UI fields**, never
secret values:

| Var | Required | Owner provides | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | Neon **pooled** URL | Neon only — `neon-http` driver, nothing else connects |
| `AUTH_SECRET` | yes | owner generates | Permanent — encrypts all stored credentials |
| `AUTH_URL` / `NEXT_PUBLIC_APP_URL` | yes | `https://<app>.onrender.com` | Same value; must match the real public URL |
| `UPSTASH_REDIS_REST_*` | no | Upstash console | Env-only (not UI-settable) — durable queue/DLQ/rate-limit |
| `YCLOUD_API_KEY`, `YCLOUD_WEBHOOK_SECRET`, `WHATSAPP_PHONE_NUMBER` | no | YCloud console | Also settable in `/admin/agent` (DB wins) |
| `CLOUDINARY_*` (3) | no | Cloudinary | Durable uploads; without it image uploads fail |
| `CRON_SECRET` | auto | blueprint generates | Leave the `/admin/agent` cron field empty OR equal — DB value wins over env |

Where each config class lives (precedence, top wins):

1. **`agent_config` row (id=1)** — encrypted, edited in `/admin/agent`:
   business identity, YCloud/AI/Cloudinary/Meta/Telegram credentials,
   cron secret, escalation email, prompts, hours, zones, delivery, flags.
2. **Env vars** — bootstrap fallback for the same fields + infra-only vars
   (`DATABASE_URL`, `AUTH_SECRET`, `AUTH_URL`, `NEXT_PUBLIC_*`, `UPSTASH_*`).
3. **Files** — branding/vertical constants (`src/lib/constants.ts`,
   storefront routes, `package.json` name, `CLOUDINARY_FOLDER` in
   `src/app/api/media/upload/route.ts`).

## Phase 2 — Schema + first admin

The owner runs these (they hold the DB URL). Your job is to hand them exact
commands and verify output — never run them against production yourself:

```bash
DATABASE_URL="<direct Neon URL>" npm run db:migrate
DATABASE_URL="<Neon URL>" ADMIN_EMAIL="<email>" ADMIN_PASSWORD="<pw>" npm run db:seed
```

- Migrate uses the **direct** (non-`-pooler`) Neon URL; runtime uses pooled.
- If `db:migrate` fails on the journal, use the fresh-DB-only sequence in
  `install-render-neon.md` §3 — never a `drizzle/*.sql` glob.
- `/setup` is currently broken (neon-http has no transactions; fix in flight
  as S7/G4) — `db:seed` is the working first-admin path. Do not present
  `/setup` as done until that fix lands and you re-verified it.

## Phase 3 — Configure `agent_config` (via `/admin/agent`)

After the owner logs in, fill (or instruct them to fill) `/admin/agent`:

- **Negocio**: name, tagline, address, phone display, Instagram, website,
  description → `businessName`, `businessTagline`, `businessAddress`,
  `businessPhoneDisplay`, `instagramHandle`, `businessWebsite`,
  `businessDescription`.
- **Credenciales YCloud**: `ycloudApiKey`, `whatsappBotNumber`.
- **Proveedor de IA**: `aiApiKey`, `aiBaseUrl`, `aiModel`, `aiModelFast`,
  `aiModelVision`.
- **Integraciones**: `ycloudWebhookSecret`, `cloudinary*`, `metaApp*`,
  `telegramNotifyChatId`, `escalationEmail`, `cronSecret` (leave empty).
- **Prompts**: `systemPrompt` (base), `whatsappSystemPrompt`,
  `whatsappStyleProfile`, `whatsappInstructions`, `whatsappPromociones`,
  `trainBotContext` (appended to the base prompt as extra context).
- **Modules**: `enabled` (agent master switch — leave OFF until webhooks are
  wired), `deliveryEnabled`, hours (`businessHours`, `productionHours`,
  `b2cStartHour`, `deliveryStartHour`), `whatsappZonasDelivery`, `aliasB2c`,
  `aliasB2b`, `tiempoEspera`, menu images (`menuImageUrl*`), auto-reply and
  web-order-redirect toggles.

Restaurant-shaped fields to neutralize for non-food businesses:
`isCooking`, `hamburguesasSinStock`, `stockPanDocenas`, `aliasB2c`/`aliasB2b`,
`menuImageUrlHamburguesas`/`menuImageUrlPan`, `whatsappZonasDelivery` defaults
(centro/norte/sur). See the de-branding map in `transform-repo.md`.

## Phase 4 — Catalog + branding adaptation

- **Catalog**: products are rows in `products` (`/admin/products` CRUD or a
  seed). Categories are a Postgres enum (`product_category`: hamburguesa,
  acompanamiento, pan_mayorista, tragos_vip, bebidas, alcohol, empanadas,
  pizzas) — for a non-food vertical you must map the business's catalog onto
  these enum values or follow `transform-repo.md` for the deeper adaptation.
  `SEED_DEMO=1` loads the demo food catalog — do NOT use it for a real
  business.
- **Demo/branding constants**: `src/lib/constants.ts` (`LINEA_CARNE`,
  `BREAD_PRODUCTS`, `CAMPAIGNS`, `WHATSAPP_MESSAGES`, `PRODUCT_IMAGE_MAP`,
  `BG_IMAGES`) feeds the seed and storefront.
- **Storefront**: `src/app/(storefront)/` — the landing `page.tsx` +
  hardcoded routes `hamburguesas/`, `pan-mayorista/`, `tragos-vip/`, `promo/`.
- **Prompt code paths**: `src/lib/whatsapp/prompt-builder.ts`,
  `src/lib/whatsapp/seller-prompt.ts`, `src/lib/telegram/prompt-builder.ts`,
  `src/lib/telegram/system-prompt.ts` — read before rewriting prompts.
- **Brand strings**: ~11 `src/` files mention the original business;
  `package.json` `name`, `CLOUDINARY_FOLDER = "muzapp"`. Full inventory:
  roadmap §2.2 + `repo-hygiene-report.md`.

## Phase 5 — Verification (report, don't flip)

Produce a status report; the owner performs live-affecting steps:

- [ ] `db:migrate` completed on the direct URL; `db:seed` created the admin
- [ ] `/api/health` → `db: connected` after deploy
- [ ] `/login` works; `/admin/agent` shows every expected value set
- [ ] `git diff --check`, `npm run lint`, `npm run typecheck` clean on your branch
- [ ] Owner: YCloud webhook URL + secret wired; test message lands in
  `/admin/conversations`; reply sends; agent enabled last
- [ ] Cron jobs green (they 401 if a mismatched `cronSecret` was set in the UI)

## Implementation checklist (fill and return)

```text
Business: ______________   Vertical: ______________
[ ] Intake answers 1–10 collected (BLOCKED items: ___)
[ ] Fork created; render.yaml deploys; env prompts planned
[ ] db:migrate run (direct URL) / emergency sequence used? ___
[ ] db:seed run; admin email: ___
[ ] agent_config: business identity filled
[ ] agent_config: YCloud + AI provider filled (keys entered by owner)
[ ] Prompts adapted to business + tone (fields listed: ___)
[ ] Catalog seeded/mapped; categories used: ___
[ ] Restaurant-specific fields neutralized/disabled: ___
[ ] Optional integrations configured: Upstash/Cloudinary/Telegram/Meta: ___
[ ] Webhook URLs handed to owner (YCloud/Telegram/Meta)
[ ] Verification section results: ___
[ ] NOT DONE (by rule): secrets read? prod webhook flipped? db:push? ___
```
