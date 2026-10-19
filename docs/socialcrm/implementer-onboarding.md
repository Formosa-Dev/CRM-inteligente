# SocialCRM Implementer Onboarding

The complete runbook to take a business from zero to a working SocialCRM
instance: **fork → deploy → configure → webhooks → verify**. Written for a
non-technical business owner or an implementer/agency doing this for a client.
Each instance is one dedicated deployment on **Render + Neon PostgreSQL** —
there is no shared SaaS; the business owns its data end to end.

Budget about 45–60 minutes. Most of it is copy-pasting values between consoles.

> Deep technical reference (env vars, migration details, recovery):
> `docs/socialcrm/install-render-neon.md`. This guide is the operator path —
> when in doubt, follow the order here.

## What you will need before starting

| Thing | Why | Where it comes from |
|---|---|---|
| GitHub account | To fork the product repo | github.com |
| Render account | Hosts the app + cron jobs | render.com — paid **starter** plan recommended for the web service (the free plan sleeps and drops webhook latency) |
| Neon account | PostgreSQL database (**required** — the app only works with Neon) | neon.tech — free tier works |
| YCloud account | WhatsApp provider (sends/receives messages) | ycloud.com — plus a WhatsApp number for the business |
| OpenAI-compatible API key | Powers the AI sales agent | OpenAI, OpenRouter, DeepSeek, Groq, Together, Ollama — any OpenAI-compatible provider |
| A computer with Node 20 + git | Runs two one-time commands (migrate + seed) | nodejs.org LTS |
| Optional: Upstash, Cloudinary, Telegram bot, Meta app | Durable queues, image uploads, internal ops bot, ads attribution | Set up later — the app works without them |

Never share or commit real secret values. Everything below that is a secret is
entered directly into consoles/env vars — docs never contain real values.

## Step 1 — Fork the repo

1. Log in to GitHub → open `https://github.com/Formosa-Dev/CRM-inteligente`.
2. Click **Fork** → create it under your own account/organization.
3. Keep the fork **private** if you plan to commit client-specific changes —
   the upstream repo is open source; your fork is yours.

You now own `github.com/<you>/CRM-inteligente` — this is what Render deploys.

## Step 2 — Create the Neon database

1. Neon console → **New project** → region near `us-east-1` (Virginia) →
   create.
2. On the project dashboard, copy the connection string. Neon shows the
   **pooled** endpoint by default (`-pooler.` in the hostname).
3. Write down **two** URLs — they differ only in the host:

   | URL | Looks like | Used for |
   |---|---|---|
   | **Pooled** | `postgresql://user:pass@xxx-pooler.region.neon.tech/db?sslmode=require` | `DATABASE_URL` env var on Render |
   | **Direct** | same, without `-pooler` in the host | Running `npm run db:migrate` locally |

   Pooled is for the running app; direct is for schema migrations (pooled
   connections can't hold the session state migrations need).

## Step 3 — Deploy to Render (Blueprint)

1. Render Dashboard → **New → Blueprint** → connect GitHub → pick **your
   fork**.
2. Render reads `render.yaml` and creates 4 services: `socialcrm` (web),
   `socialcrm-cron-followup`, `socialcrm-cron-reconcile-scan`,
   `socialcrm-cron-reconcile-sweep`.
3. Fill the prompted values:

   | Prompt | What to enter |
   |---|---|
   | `DATABASE_URL` | The **pooled** Neon URL from Step 2 |
   | `AUTH_SECRET` | A random 32-byte secret — generate with `openssl rand -base64 32` (or any password manager's generator, 32+ chars). **Save it somewhere safe — it is effectively permanent** (rotating it makes all stored credentials undecryptable). |
   | `AUTH_URL` | `https://<service-name>.onrender.com` — the URL Render will give the service (or your custom domain) |
   | `NEXT_PUBLIC_APP_URL` | Same URL as `AUTH_URL` |
   | `YCLOUD_*`, `WHATSAPP_PHONE_NUMBER`, `CLOUDINARY_*`, `UPSTASH_*` | Optional — leave blank, set later from `/admin/agent` (except Upstash, which is env-only) |

4. **Apply**. The first build takes ~5–10 min.

`CRON_SECRET` is generated automatically — the cron jobs inherit and
URL-encode it; nothing to do.

## Step 4 — Apply the schema + first admin

These two commands run **from your own computer**, once, while the first
deploy builds.

```bash
git clone https://github.com/<you>/CRM-inteligente.git
cd CRM-inteligente
npm install

# 1. Schema — use the DIRECT Neon URL (no "-pooler" in the host)
DATABASE_URL="postgresql://…direct…" npm run db:migrate

# 2. First admin — never creates default credentials
DATABASE_URL="postgresql://…pooled-or-direct…" \
ADMIN_EMAIL="you@yourbusiness.com" \
ADMIN_PASSWORD="pick-a-strong-password" \
npm run db:seed
```

- `db:migrate` is the only supported schema path. `db:push` is dev-only.
- If `db:migrate` fails on a journal error, see the emergency fresh-database
  sequence in `docs/socialcrm/install-render-neon.md` §3 (a journal repair is
  in flight).
- Windows PowerShell: set vars per-command instead, e.g.
  `$env:DATABASE_URL="…"; npm run db:migrate`.

**If the deploy was cancelled before you ran the migration:** Render cancels
deploys whose health check fails ~15 min (the app reports unhealthy until the
tables exist). Run the two commands, then Render dashboard → the service →
**Manual Deploy → Deploy latest commit**. Details: install guide §4.

## Step 5 — Configure the business (/admin/agent)

Log in at `https://<app>.onrender.com/login` with the seeded email/password,
then open `/admin/agent`. Everything below is configured here — no redeploys:

| Section | What to fill in |
|---|---|
| **Negocio** | Business name, tagline, address, display phone, Instagram, website, description — drives the storefront and agent messages |
| **Credenciales YCloud** | `YCLOUD_API_KEY`, WhatsApp bot number (digits only, no `+`) |
| **Proveedor de IA** | API key, base URL, main/fast/vision models for your chosen provider |
| **Estado del agente** | Master on/off for the WhatsApp agent |
| **Horarios / Delivery / Zonas** | Business hours, delivery config, zones, payment aliases |
| **Integraciones** | `YCLOUD_WEBHOOK_SECRET`, Cloudinary, Meta, Telegram notify chat, escalation email, cron secret |
| **Prompts** (`whatsappSystemPrompt`, style profile, instructions, promotions) | The agent's personality and sales rules — see `transform-repo.md` |

**Where secrets live:** fields in `/admin/agent` are stored **AES-256-GCM
encrypted** in the `agent_config` DB row and take precedence over env vars.
The UI is write-only (empty submit = keep, `CLEAR` = delete). Env vars on
Render are bootstrap values; `/admin/agent` is the day-to-day control surface.
`NEXT_PUBLIC_*` vars are the exception — build-time only, must stay env vars.

## Step 6 — Wire the webhooks

| Provider | Paste this URL in the provider console | Notes |
|---|---|---|
| **YCloud (WhatsApp)** | `https://<app>.onrender.com/api/whatsapp/webhook` | In the YCloud console set the **same webhook secret** you put in `/admin/agent → Integraciones → YCloud — Webhook Secret`. Legacy alias `/api/webhook/whatsapp` also answers. |
| **Telegram (internal ops bot)** | `https://<app>.onrender.com/api/telegram/webhook/<token>` | Token + full URL shown in `/admin/telegram` — the page generates it and can push it to Telegram via `setWebhook`. Set `TELEGRAM_BOT_TOKEN` + allowed chat IDs there too. |
| **Meta (ads attribution)** | `https://<app>.onrender.com/api/meta/webhook` | Verify token = `META_WEBHOOK_VERIFY_TOKEN` (set it in `/admin/agent` first). |

Only wire YCloud when you're ready to receive real customer messages —
webhook delivery starts immediately.

## Step 7 — Verify

- [ ] `https://<app>.onrender.com/api/health` → `200` with `"db": "connected"`
- [ ] `/login` works with the seeded admin
- [ ] Send a WhatsApp message to the YCloud number → lands in `/admin/conversations`
- [ ] Reply from the conversation view → the reply actually arrives
- [ ] Upload an image in `/admin/products` → works (needs `CLOUDINARY_*` set)
- [ ] All three cron jobs show green runs in Render

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| First deploy "failed" | Health check timed out before migrations ran — migrate, then Manual Deploy (Step 4) |
| Health check stays 500 | `DATABASE_URL` is wrong, not a Neon URL, or Neon suspended (open the Neon console to wake it) |
| `db:migrate` errors on `0001` / journal | Known journal defect — use the fresh-DB-only sequence in `install-render-neon.md` §3 |
| Migration errors via the pooled URL | Use the **direct** (non-`-pooler`) Neon URL for `db:migrate`/`psql` |
| `/setup` errors | Expected — it is blocked on a bootstrap fix; use `db:seed` (Step 4) |
| Webhook 401 / no messages | `YCLOUD_WEBHOOK_SECRET` must match in YCloud console AND `/admin/agent`; API key must be set |
| Cron runs 401 | If you set a cron secret in `/admin/agent`, it must equal the `CRON_SECRET` env var on the web service (DB value wins) |
| Agent silent | "Estado del agente" switch off, AI provider key missing, or outside configured business hours |
| Image upload fails | `CLOUDINARY_*` not configured |
| First webhook slow | Free plan sleeps — upgrade the web service to `starter` |

## Ongoing operations

- **Rotating `AUTH_SECRET`**: don't — it encrypts every stored credential.
  Treat it as permanent; keep it in a password manager.
- **Media durability**: inbound WhatsApp media on the Render disk is ephemeral
  (lost on redeploy); admin uploads via Cloudinary are durable. Configure
  Cloudinary early.
- **Upgrades**: pull upstream changes into your fork → `db:migrate` (direct
  URL) → deploy. A formal upgrade runbook ships with Phase 5 of
  `self-hosted-product-roadmap.md`.
- **Handing setup to an AI agent**: see
  `docs/socialcrm/ai-agent-implementation-guide.md`.
