# SocialCRM

**Open-source commerce + AI-agent platform for local businesses.**

Storefront, multichannel ordering with an AI sales agent (WhatsApp, Instagram, Facebook), admin dashboard, Telegram internal bot, Meta Ads attribution, and analytics — all configurable from the UI, all credentials stored in the database. Deploy it, add your business data, start selling.

Originally built for a real food business in Formosa, Argentina. Released by **[formosa.dev.ar](https://formosa.dev.ar)** (Fusa Labs) as a free resource — use it for personal projects or commercially.

```
Storefront (Next.js)        ─┐
WhatsApp (YCloud, Kapso)    ─┼─► Messaging layer ─►  Agent layer (OpenAI-compatible) ─► PostgreSQL
Instagram/Facebook (Zernio) ─┘   unified ingress        ▲ tools: orders, catalog, customers
Telegram internal bot            channel_accounts       └── business config lives in DB, editable from UI
Admin panel (/admin)
```

## Features

- **Storefront** — animated product pages, cart, checkout that hands off to WhatsApp, attribution-aware CTAs.
- **Multichannel AI agent** — answers customers, takes orders, sends catalog images, escalates to humans. WhatsApp via YCloud (Kapso adapter included), Instagram/Facebook via Zernio — all behind a canonical provider contract (`src/lib/messaging/`). OpenAI-compatible LLM providers only (OpenAI, OpenRouter, DeepSeek, Groq, Together, Ollama).
- **Admin panel** — products CRUD, order/kitchen board, conversations inbox with human override, leads with UTM attribution, analytics, and **full business/agent configuration**.
- **Channel accounts** — `/admin/channels` lists, creates and toggles `channel_accounts` for any registered provider, with `env:` credential refs and Zernio embedded connect (OAuth + WhatsApp Embedded Signup). Inbox filters by channel/account; phone-less social leads resolve through `lead_identities`; agent config scopes per channel or account.
- **Telegram internal bot** — manage orders, clients and metrics from Telegram (allowlist-gated).
- **Meta Ads integration** — pixel + Conversions API + signed attribution links (`ref:` codes).
- **Infra** — rate limiting, message buffer, Redis queue with DLQ (Upstash), circuit breaker, idempotent webhooks, HMAC signature checks.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · Framer Motion · Drizzle ORM · PostgreSQL · NextAuth v5 · Vercel AI SDK · Zod · Cloudinary (uploads) · Upstash Redis (optional) · Render-ready.

## Quick start (local)

```bash
git clone https://github.com/Formosa-Dev/CRM-inteligente.git
cd CRM-inteligente
npm install
cp .env.example .env.local   # fill in DATABASE_URL (Neon) + AUTH_SECRET at minimum

npm run db:push              # dev-only schema sync — installs/upgrades use db:migrate
npm run dev                  # http://localhost:3000
```

**Database requirement:** `DATABASE_URL` must be a **Neon Postgres** connection
string — the app uses the `neon-http` driver (`src/db/index.ts`), so Render
Postgres, RDS, Supabase or a plain local Postgres will not connect.

**First admin:** open `/setup` in the browser — it bootstraps the first admin with a single atomic insert. The CLI alternative is `ADMIN_EMAIL=you@example.com ADMIN_PASSWORD="strong-password" npm run db:seed`. The seed **never creates default credentials**. Add `SEED_DEMO=1` for the demo catalog.

Then `/admin/agent` covers everything else: business identity, WhatsApp number, YCloud key, AI provider key/models, integration secrets, hours, delivery zones, prompts.

## Deploy your own instance (Render + Neon)

The product is a **self-hosted, single-install** deployment: you fork the repo,
deploy it on Render via the included `render.yaml` blueprint, and back it with
an external **Neon Postgres** (required — see above). `npm run db:migrate` is
the canonical schema path for installs and upgrades; `db:push` is dev-only.

The full runbooks live under `docs/socialcrm/`:

| Doc | Covers |
|---|---|
| [Implementer onboarding](docs/socialcrm/implementer-onboarding.md) | Fork → Blueprint deploy → env/secrets → migrate + seed → `/admin/agent` → webhooks → verify. **Start here.** |
| [Install on Render + Neon](docs/socialcrm/install-render-neon.md) | Blueprint reference: env vars, migration details, first-deploy recovery, troubleshooting. |
| [AI-agent implementation guide](docs/socialcrm/ai-agent-implementation-guide.md) | Hand this to an AI agent to set up a new business instance. |
| [Transform the repo](docs/socialcrm/transform-repo.md) | Adapting branding, catalog and prompts to a different business vertical. |

Optional services (Upstash Redis, Cloudinary, YCloud/WhatsApp, Telegram, Meta)
are configured post-deploy from `/admin/agent` — credentials live encrypted in
the database and take precedence over env vars.

## Project layout

```
src/
├── app/(storefront)/          # public pages (animated, SEO metadata from DB)
├── app/(admin)/admin/         # dashboard, agent config, orders, leads, channels, analytics
├── app/api/webhooks/ingress/  # unified provider ingress (POST /api/webhooks/ingress/[provider])
├── app/api/                   # other webhooks + public endpoints (leads, products, business)
├── lib/messaging/             # provider abstraction: contract, registry, messenger, inbound pipeline
│   └── providers/             # ycloud, zernio (+ embedded connect), kapso adapters
├── lib/channels/              # conversation routing + channel-account binding
├── lib/whatsapp|telegram|agent/   # AI agents + tools
├── lib/business.ts            # business identity: DB row 1 → env → fallback
├── lib/ai/config.ts           # AI provider: DB → env (key, base URL, models)
├── lib/auth/require-admin.ts  # role-based guard for mutations
└── db/schema.ts               # agent_config, channel_accounts, lead_identities, …
```

## Security notes

- Admin mutations require `role = "admin"`; viewers are read-only.
- Stored secrets (YCloud key, AI key, Telegram token) are never sent to the client.
- Webhooks verify signatures/tokens; login is rate-limited; uploads validate magic bytes.
- Attribution links are HMAC-signed server-side.
- Don't commit `.env*` files — they're gitignored; keep it that way.

## License

MIT — free for personal and commercial use. See [LICENSE](LICENSE).

Built and maintained by [Fusa Labs](https://formosa.dev.ar) in Formosa, Argentina.
