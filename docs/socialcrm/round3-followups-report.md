# Round 3 follow-ups — execution report

Orchestrated execution of the R2 follow-ups (FU-1…FU-7) in SocialCRM/Muzapp.
Baseline `9ebfca3`; final merged `main` = `23b1fd0`, pushed to `origin/main`.
All four gates green on merged main.

## Gate results (merged main)

| Gate | Result |
|---|---|
| `npm run test:agents` | **pass** — 837 tests, 831 pass, 0 fail, 6 skipped |
| `npm run typecheck` | **pass** |
| `npm run lint` | **pass** |
| `NODE_OPTIONS=--max-old-space-size=8192 npm run build` | **pass** — 41 routes |

## Findings

### FU-1 — Telegram webhook token at-rest encryption — FIXED
- **Delegate**: `socialcrm-r3-tg-token` (opencode, deepseek-v4-pro). Commit `317303d`, merge `a7f2f4d`.
- `agent_config.telegram_webhook_token` widened `varchar(100)` → `varchar(255)` (`src/db/schema.ts:121`).
- Write path encrypts in both lazy-generation spots (`getTelegramStatus`, `setTelegramWebhookAction`) via `encrypt()` from `@/lib/encryption`; the local token stays plaintext for the URL.
- Read path left untouched (already `decryptIfEncrypted`-tolerant in `src/lib/telegram/bot.ts`).
- Migration `drizzle/0023_curvy_makkari.sql` generated; journal gains coherent `idx 23` entry (`tag=0023_curvy_makkari`, `breakpoints: true`).
- Test `src/lib/encryption.test.ts` proves round-trip + legacy-plaintext tolerance; registered in `test:agents`.
- **Notable**: the delegate had to repair a pre-existing **forked migration chain** — `0021_thin_plazm` and `0022_hot_path_indexes` were generated in parallel with both `prevId`→`0020` (their `_journal.json` `when` timestamps are out of order, confirming it). `drizzle-kit generate` aborted with a snapshot collision. The delegate repointed `0022.prevId`→`0021` and merged the `idx_chat_messages_platform_id` `coalesce(channel_account_id,-1)` column into the `0022` snapshot, making the chain linear `0020→0021→0022→0023`. Verified sound (snapshot `id`/`prevId` chain is now linear; `0023` snapshot carries `varchar(255)` + the coalesce index). This was necessary for `db:generate`/`db:migrate` to work at all.
- **Ops note**: existing plaintext `telegram_webhook_token` rows read transparently, but need ONE re-save via `/admin/telegram` after deploy to migrate to encrypted at-rest form.

### FU-2 — Media migration runbook + helper script — FIXED
- **Delegate**: `socialcrm-r3-docs-env`. Commit `c583e9a`, merge `af5cc9e`.
- `scripts/migrate-uploads.mjs`: moves `public/uploads/<conversationId>/<file>` → `MEDIA_UPLOADS_DIR` (default `data/uploads`), no hardcoded paths, `--dry-run` default / `--apply` to execute, cross-device fallback (EXDEV), never touches the DB, prints summary.
- Runbook section (§9) + updated G5 note added to `docs/socialcrm/install-render-neon.md`, with Render persistent-disk guidance.

### FU-3 — Document new env vars — FIXED
- **Delegate**: `socialcrm-r3-docs-env`. Commit `7e674c5`.
- `CRON_ALLOW_QUERY_KEY` and `MEDIA_UPLOADS_DIR` added to `.env.example` matching existing style; `BUSINESS_HOURS` confirmed already present.

### FU-4 — Fix stale install doc (cron contract) — FIXED
- **Delegate**: `socialcrm-r3-docs-env`. Commit `6a5bae9`.
- Cron doc updated from `GET ?key=` URL-encoding to `POST` + `Authorization: Bearer ${CRON_SECRET}`; `CRON_ALLOW_QUERY_KEY` mentioned as the legacy escape hatch.

### FU-5 — Sanitize provider-error passthroughs — FIXED
- **Delegate**: `socialcrm-r3-errors-cleanup`. Commit `be8d064`, merge `daa0bb7`.
- Three leaks closed with the F13 pattern (`reportInternalError` + generic message + `ref:`):
  - `admin/meta/actions.ts` — Meta `body?.error?.message` no longer reaches the client.
  - `admin/orders/actions.ts` (×2) — `notified.error` no longer reaches the client in `updateOrderStatus` and `notifyCustomer`.
- Re-grep confirms no provider detail reaches any client return.

### FU-6 — Micro-cleanup — FIXED
- **Delegate**: `socialcrm-r3-errors-cleanup`. Commit `01b83ef`.
- Dead `.product-card` CSS media-query block removed from `src/app/globals.css` (`.public-product-card` left intact).
- `createInitialSessionState` duplicate export **verified absent**: the live export is `src/lib/whatsapp/session-policy.ts:68` only; `session-store.ts` exports no second copy. Nothing to remove.

### FU-7 — De-branding (Muzzarella → generic commerce) — FIXED
- **Delegate**: `socialcrm-r3-debrand`. Five commits (`8819d11`, `6455236`, `ba188be`, `eb78904`, `249bdf2`), merge `23b1fd0`.
- Landing hero/marquee/stats, nav/footer labels, `carta-digital` categories, `landing-menu` sections, `CATEGORY_EMOJI`, `CAMPAIGNS`/`LINEA_CARNE` copy, wholesale/promo copy, product-page cart emojis, `seller-badge` avatar, and the home hero `marker-gold` heading all neutralized.
- The hero-heading test coupling (`agent-consistency.test.ts:1584`) was updated in-step (authorized as a debrand regression test).
- Contract preserved: `order_type` enum values, `burgersUnavailable`/`hamburguesasSinStock` keys, and `/hamburguesas` + `/tragos-vip` redirect aliases untouched.

## Deferred / known leftovers (for a future round)

1. **`src/app/login/login-form.tsx`** still has an `admin@mrsmuzzarella.com` placeholder — `src/app/login/**` was not owned by any worker this round. Discovered by the debrand delegate.
2. **Demo-data image fallbacks** `PRODUCT_IMAGE_MAP`/`PRODUCT_IMAGE_BY_NAME` and `BREAD_IMAGES` remain keyed by food names (imported by `catalog-image.tsx` / `product-tools.ts`, outside the debrand ownership). They are demo data, not user-facing copy.
3. **`promo-muzza` campaign slug** kept (URL contract: `generateStaticParams`, sitemap, `/promo/<slug>`).
4. **Minor copy grammar**: the home hero now reads "Más que una **producto**" — the neutralization introduced a gender mismatch (should be "un producto"). Cosmetic; left for a copy polish pass.

## Process notes

- Four Orca worktrees (`socialcrm-r3-{tg-token,docs-env,errors-cleanup,debrand}`) from baseline `9ebfca3`; four opencode delegates (deepseek/deepseek-v4-pro); merged in order errors-cleanup → tg-token → docs-env → debrand. No merge conflicts (file ownership was disjoint by design).
- `package.json` `test:agents` union verified: parses, no stale refs (`queue/worker.test` / `leads/update/route.test`), every `.test.ts` token exists on disk.
- **test:agents is flaky on this Windows host under full parallelism** — intermittent `STATUS_DLL_INIT_FAILED` / exit `0xC0000142` crashes across unrelated test files. Each delegate and the final gate confirmed a clean pass on re-run (final: 831/0). Not a regression.
- `.atl/.skill-registry.*` files are machine-local churn present before this round; they were left uncommitted in every worktree and in main.
- Cleanup: 4 delegate terminals closed, worktrees unregistered from Orca, `git worktree list` shows only `main`, and all 4 branches deleted. Four empty worktree directory shells remain under `C:/Users/Asus/orca/workspaces/SocialCRM/` held by a lingering Orca host file handle ("Device or resource busy") — they contain no files and will clear when the handle releases.
