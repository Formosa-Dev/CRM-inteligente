# AGENTS.md — Muzapp

Open-source commerce + WhatsApp/Telegram AI-agent platform. Next.js 16 (App Router),
React 19, TypeScript, Tailwind 4, Drizzle ORM + PostgreSQL (Neon), NextAuth v5, Vercel
AI SDK. Target deployment: Render. Per-install business data and credentials live in the
DB (`agent_config`) and are edited from `/admin/agent`.

## Next.js version caveat

This repo uses Next 16.2.4 — APIs, conventions, and file structure differ from older
Next. Before editing routing, data fetching, or server/client boundaries, read the
relevant guide under `node_modules/next/dist/docs/` and follow its deprecation notes.

## Commands

- `npm run dev` — local dev server.
- `npm run build` — production build (`next build --webpack`). Must pass. On
  low-memory machines the default Node heap can OOM after page generation; if so
  re-run with `NODE_OPTIONS=--max-old-space-size=8192`.
- `npm start` — serve the production build.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` — ESLint.
- `npm run test:agents` — node:test suites (agents, checkout, whatsapp, telegram, cash).
- `npm run db:push` / `db:generate` / `db:migrate` — Drizzle schema changes.

## Verification gates (run before claiming work is done)

1. `npm run test:agents`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run build`

For browser/E2E validation use a production build (`npm run build && npm start`), never
`npm run dev`.

## Environment & data safety

- `DATABASE_URL` (production Postgres/Neon) lives in the local `.env` / `.env.local`,
  both gitignored. Never print, log, commit, or paste the URL or any secret.
- Audits and analyses of production data are READ-ONLY: SELECTs only. No sends, writes,
  migrations, or deletions without explicit instruction.
- Never commit customer messages, phones, names, or other PII. De-identify examples.
- `.env.example` is the only tracked env file; document new required vars there.

## Layout

- `src/app/(storefront)/` — public storefront; `src/app/(admin)/admin/` — dashboard,
  agent config, orders, conversations, leads, analytics.
- `src/app/api/` — webhooks (`whatsapp`, `telegram`, `meta`) + public endpoints.
- `src/lib/whatsapp|telegram|agent/` — AI agents + tools; `src/lib/checkout/` — web order flow.
- `src/db/schema.ts` — Drizzle schema; `agent_config` holds identity, credentials, prompts.
- `scripts/` — ops/audit scripts (load `.env` via `dotenv/config`).
- `sdd/` and `.specs/changes/` — change specs; `docs/` — reports and manuals.

## UI

Read `DESIGN.MD` at the repo root before touching any UI, and follow it: tokens, admin
dark-chrome vs storefront editorial, gold/glass utilities, do's/don'ts.

## Conventions

- Conventional commits only. Never add AI attribution or `Co-Authored-By`.
- Keep commits as reviewable work units; include tests with the behavior they verify.
- Don't mix unrelated lint/formatting cleanup into a feature diff.

## Coordination & skills

- `skills/clear-chat/SKILL.md` — clearing a WhatsApp chat (trigger: "vacia mi chat", ...).
- Multi-agent work coordinates through Engram memory (project `muzapp`): load the
  `inter-agent-engram` skill, keep specs in `sdd/` and `.specs/changes/`, and check/write
  `task-claim` / `task-done` / `signal` topics.
