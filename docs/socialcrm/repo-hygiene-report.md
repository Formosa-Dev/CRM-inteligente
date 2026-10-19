# SocialCRM — Repo Hygiene Audit Report

Status: audit output for slice S2 (`socialcrm-repo-hygiene`). Date: 2026-10-18.
Scope: Phase A0 removal of client-PII scripts and scratch artifacts per
`execution-control.md` §4/S2 and `self-hosted-product-roadmap.md` §2.2/G8.

Method: every deletion candidate was confirmed tracked, then `git grep`ed by
exact filename across all tracked files. Items referenced only by the
planning docs that define the deletion set (`execution-control.md`,
`self-hosted-product-roadmap.md`) and by the stale repomix snapshot
(`docs/repomix-output-adriangmrraa-muzapp.md`) were treated as unreferenced —
neither is a live dependency. `package.json` wires none of the removed files.

## 1. Deleted files (49)

### 1.1 Customer-PII / one-off ops scripts (26)

| File | Pattern in deletion set |
|---|---|
| `scripts/find-hector.mjs` | `find-hector*` |
| `scripts/find-hector-full.mjs` | `find-hector*` |
| `scripts/wipe-conv15.mjs` | `wipe-conv15*` |
| `scripts/wipe-conv15-final.mjs` | `wipe-conv15*` |
| `scripts/wipe-all-hector.mjs` | extension — see note below |
| `scripts/del-order48.mjs` | `del-order*` |
| `scripts/del-orders-49-51.mjs` | `del-order*` |
| `scripts/clean-conv15.mjs` | `clean-conv15*` |
| `scripts/clean-conv15v2.mjs` | `clean-conv15*` |
| `scripts/clean-conv15v3.mjs` | `clean-conv15*` |
| `scripts/clean-conv15v4.mjs` | `clean-conv15*` |
| `scripts/clean-conv15v5.mjs` | `clean-conv15*` |
| `scripts/check-agent.ts` | `check-*` one-off |
| `scripts/check-all-today.mjs` | `check-*` one-off |
| `scripts/check-conv15.mjs` | `check-*` one-off |
| `scripts/check-conv15-full.mjs` | `check-*` one-off |
| `scripts/check-db.ts` | `check-*` one-off |
| `scripts/check-hector-now.mjs` | `check-*` one-off (also PII filename) |
| `scripts/check-latest.mjs` | `check-*` one-off |
| `scripts/check-migration-state.ts` | `check-*` one-off |
| `scripts/check-octx.mjs` | `check-*` one-off |
| `scripts/check-products.mjs` | `check-*` one-off |
| `scripts/check-promos-chat.mjs` | `check-*` one-off |
| `scripts/check-promo-tools.mjs` | `check-*` one-off |
| `scripts/check-tg-msgs.mjs` | `check-*` one-off |
| `scripts/check-users-role.ts` | `check-*` one-off |

Note: `scripts/wipe-all-hector.mjs` is not matched by the literal patterns but
was deleted because its filename itself contains a customer name and it is a
same-class customer-data wipe script (G8: "ops scripts reference real customer
names/phones"). Verified unreferenced before removal.

### 1.2 Root scratch artifacts (8)

| File |
|---|
| `chatprueba.txt` |
| `nota.txt` |
| `prompt.txt` |
| `promptagente2.txt` |
| `PROMPT-AGENT2.md` |
| `PROMPT-CLAUDE-CONTINUAR.md` |
| `clean.js` |
| `migrate-fix.js` |

### 1.3 Scratch directories (4 files)

| Path |
|---|
| `fusa stack/Documentación Técnica FacilPay.md` |
| `fusa stack/VERCEL_ECOSYSTEM_DEPLOYMENT_TOOLS_HTML.html` |
| `fusa stack/VERCEL_ECOSYSTEM_DEPLOYMENT_TOOLS_MD.md` |
| `fusa-stack/README.md` |

### 1.4 Product JPEGs in repo root (11, ~2.5 MB)

| File |
|---|
| `combo 13.jpg` |
| `combo 14.jpeg` |
| `combo 17.jpg` |
| `combo 19.jpg` |
| `genesis y vino.jpeg` |
| `Image.jpeg` |
| `MENU B2B.jpeg` |
| `Menu hamburguesa mayo.jpeg` |
| `papas.jpeg` |
| `promo 1.jpeg` |
| `vinosssss.jpeg` |

### 1.5 `.env.example` fix

The stray uncommented `BUSINESS_OWNER_NAME=` at EOF was commented out with a
descriptive comment matching the file's style. The variable is real and in use
(`src/lib/whatsapp/agent.ts` reads it for human hand-off naming), so it was
kept as an optional commented var rather than removed.

## 2. Kept candidates / flagged leftovers

Everything inside the literal deletion set was unreferenced and deleted. The
following are **outside** the deletion set and were kept per "when in doubt,
keep and report" — all recommended for a follow-up hygiene slice:

| File / pattern | Why flagged |
|---|---|
| `docs/repomix-output-adriangmrraa-muzapp.md` | Stale full-repo snapshot; embeds content/names of the deleted files (and pre-deletion `src/`). Non-blocking reference only — itself a cleanup candidate. |
| `leer.txt` (root, ~104 KB) | Claude Code session transcript, not in deletion set. Scratch artifact. |
| `error.txt`, `temp-check.txt`, `notas.txt` (root) | Scratch text dumps; `notas.txt` is empty (0 B). Not in deletion set. |
| `system-prompt-analysis.md`, `SYSTEM-PROMPT-V2.md` (root) | Agent-prompt working docs at root; match `prompt*` in spirit but not the listed `.txt`/`.md` patterns. |
| `scripts/restore-lead{,2,3}.mjs`, `scripts/find-leads.mjs`, `scripts/find-tg-convs.mjs`, `scripts/get-chat-by-phone.ts`, `scripts/_check-chat.mjs` | Same-class one-off DB-ops scripts; several contain hardcoded customer phone numbers (§4). Not in the named patterns. |
| `scripts/wipe-customers.mjs`, `scripts/wipe-orders-chats.mjs`, `scripts/wipe-tg-conv{92,112}.mjs`, `scripts/del-{last2,dup-product}.mjs` | Same-class destructive one-off ops scripts; contain hardcoded numbers (§4). Not in the named patterns. |
| `scripts/{analyze-today,audit-sales-today,migrate-promos,diagnose-checkout-readonly,telegram-diagnose}.mjs` | One-off ops/diagnostic scripts of the same vintage. Not in the named patterns. |
| `docs/{chats,mirar,prueba,xxx}.txt` | Raw chat/analysis exports containing customer names/numbers (§4). Not in S2 scope (lives under `docs/`). |

## 3. Drizzle journal integrity (audit only — no fix applied)

Verified against `drizzle/meta/_journal.json`, `drizzle/*.sql`, and
`drizzle/meta/*_snapshot.json` on this branch. All claims confirmed; details
below are precise, not paraphrased.

### 3.1 Journal vs SQL files

- Journal holds **13 entries** (idx 0–12). SQL files on disk: **13**.
- **Journaled but SQL missing**: idx 1 `0001_handy_tombstone` —
  `drizzle/0001_handy_tombstone.sql` does not exist. `drizzle-kit migrate`
  against a fresh database will fail or skip state at this point; the
  migration's content is lost from the repo.
- **On disk but NOT journaled**: `0002_unique_phone.sql` — orphaned migration;
  `drizzle-kit migrate` will never apply it because it is absent from the
  journal.
- **Duplicate sequence prefix**: two files share `0002_`
  (`0002_unique_phone.sql` unjournaled, `0002_woozy_valkyrie.sql` journaled
  at idx 2).

### 3.2 Journal vs meta snapshots

Snapshots exist for only **7 of 13** journaled entries
(`0001`, `0002`, `0004`, `0005`, `0008`, `0009`, `0010`).

| Journal idx | Tag | SQL present? | Snapshot present? |
|---|---|---|---|
| 0 | `0000_peaceful_chamber` | yes | **missing** |
| 1 | `0001_handy_tombstone` | **missing** | yes (orphaned) |
| 2 | `0002_woozy_valkyrie` | yes | yes |
| 3 | `0003_session_memory` | yes | **missing** |
| 4 | `0004_business_ai_config` | yes | yes |
| 5 | `0005_integration_secrets` | yes | yes |
| 6 | `0006_catalog_alcohol_empanadas` | yes | **missing** |
| 7 | `0007_web_order_redirect` | yes | **missing** |
| 8 | `0008_lame_lord_tyger` | yes | yes |
| 9 | `0009_needy_pestilence` | yes | yes |
| 10 | `0010_peaceful_rocket_racer` | yes | yes |
| 11 | `0011_add_pizzas_category` | yes | **missing** |
| 12 | `0012_drop_product_line` | yes | **missing** |

### 3.3 Anomaly summary

1. `0001_handy_tombstone`: journaled, SQL gone, snapshot orphaned.
2. `0002_unique_phone.sql`: on disk, never journaled (plus the `0002` prefix
   collision with the journaled `0002_woozy_valkyrie`).
3. Six journaled entries lack meta snapshots (idx 0, 3, 6, 7, 11, 12), so
   `drizzle-kit generate` diffing and journal replay cannot be trusted.

Conclusion: the journal is internally inconsistent — one missing SQL file, one
unjournaled SQL file, a duplicate sequence prefix, and six missing snapshots.
Per `execution-control.md` §2.7, migrations are untrusted until the A2/S6
repair slice; no new migration should be generated before that. This slice
changed nothing under `drizzle/`.

## 4. PII scan of remaining tracked files (paths only)

`git grep` for the known customer name (`hector`, case-insensitive) and
Argentine phone patterns (`549` + 9–11 digits; generic 10–15 digit runs).

Note: name occurrences elsewhere in this report are verbatim citations of
deleted file names, kept for audit provenance — not gratuitous PII.

### 4.1 Likely real customer PII still in the tree

| Path | Signal |
|---|---|
| `docs/chats.txt` | phone patterns; raw chat export |
| `docs/mirar.txt` | customer name + phone patterns |
| `docs/prueba.txt` | customer name + phone patterns |
| `docs/xxx.txt` | phone patterns |
| `docs/chat-analysis/segmentos.md` | customer name |
| `docs/manual-operativo-mrs-muzzarella.md` | customer name |
| `docs/presentacion-manual-operativo.html` | customer name |
| `docs/agent-ux-inventory.md` | long digit runs |
| `docs/repomix-output-adriangmrraa-muzapp.md` | customer name + embedded deleted-file content |
| `scripts/restore-lead.mjs` / `restore-lead2.mjs` / `restore-lead3.mjs` | customer name + hardcoded phone numbers |
| `scripts/get-chat-by-phone.ts` | hardcoded phone number |
| `scripts/find-tg-convs.mjs` | customer name |
| `scripts/wipe-customers.mjs` | hardcoded phone numbers |
| `scripts/wipe-orders-chats.mjs` | hardcoded phone numbers |
| `system-prompt-analysis.md` (root) | customer name + phone patterns |

### 4.2 Example/fixture matches (product decision, not mechanical cleanup)

- `src/lib/whatsapp/seller-prompt.ts`, `src/lib/telegram/toolsManagement.ts`,
  `src/lib/telegram/toolsWhatsApp.ts` — few-shot prompt examples embedding a
  customer first name and phone-shaped strings.
- `src/lib/phone-utils.ts`, `src/app/(admin)/admin/agent/agent-config-form.tsx`,
  `src/app/(admin)/admin/meta/actions.ts` — `+549…` placeholders/docstrings.
- `src/**/*.test.ts` (checkout, notify, telegram, broadcast suites) — synthetic
  549-numbers used as fixtures.
- `sdd/*/proposal.md`, `sdd/*/specs.md`, `sdd/*/design.md` (6 files),
  `skills/clear-chat/SKILL.md`, `.atl/skill-registry.md` — example numbers in
  docs/specs.

The execution-control docs themselves match the name pattern only because they
enumerate the deletion set — not PII.

### 4.3 Post-deletion state

`git grep` no longer finds the customer name in `scripts/find-*`,
`wipe-*`, `clean-*`, or `check-*` filenames — all files named after or
targeting the specific customer are gone. Residual PII is concentrated in
`docs/*.txt` exports, `docs/manual-operativo-*`, the repomix snapshot, the
kept `restore-lead*`/`wipe-*`/`get-chat-by-phone` ops scripts, and one
few-shot prompt example set in `src/`. Recommend a follow-up slice covering
§2 above plus de-identification of the prompt examples.

---

## 5. S9 addendum — residual PII scrub (2026-10-18)

Scope: `execution-control.md` §4/S9 (`socialcrm-pii-scrub` branch) — clears
the residual set flagged in §2/§4. Product decision: **anonymize** documents
with analytical value, **delete** pure scratch and customer-targeting
one-offs. Every deletion candidate was re-verified with
`git grep -n "<basename>" -- . ':!docs/socialcrm'`; the only hits were inside
the repomix snapshot, itself deleted. `package.json` (including
`test:agents`) wires none of the removed files.

### 5.1 Deleted files (33)

**Root scratch (4):** `leer.txt` (session transcript), `notas.txt` (empty),
`error.txt` (build log), `temp-check.txt` (code fragment).

**docs/ scratch + raw exports (10):** `chats.txt`, `mirar.txt`, `prueba.txt`,
`xxx.txt`, `devolucion.txt`, `ahora.txt`, `notas.txt`, `prompt.txt`,
`prompt2.txt`, `error.txt` — raw chat exports / prompt scratch containing
real customer names, phones, street addresses, location coordinates, and the
personal payment alias.

**Stale repo snapshot (1):** `docs/repomix-output-adriangmrraa-muzapp.md` —
embeds the PII-bearing content of the files above plus pre-scrub `src/`.
Deleted rather than regenerated.

**Customer-targeting / PII ops scripts (18):** `restore-lead{,2,3}.mjs`,
`get-chat-by-phone.ts`, `find-tg-convs.mjs`, `find-leads.mjs`,
`wipe-customers.mjs`, `wipe-orders-chats.mjs`, `wipe-tg-conv{92,112}.mjs`,
`del-{last2,dup-product}.mjs`, `_check-chat.mjs`, `analyze-today.mjs`,
`analyze-db.mjs`, `stats.mjs`, `test-trgm.mjs`,
`diagnose-checkout-readonly.mjs` — hardcoded customer names, real phone
numbers, phone-suffix ILIKE filters, or sole purpose of inspecting/mutating
one specific customer's data.

### 5.2 Anonymized files (33) — analytical value preserved

**docs/ analysis set:**
- `chat-analysis/estilo.md` — owner name → "el operador"/"el dueño", personal
  alias → `[alias]`, titular → `[titular]`, customer first names →
  `Cliente A/B…` (consistent per doc).
- `chat-analysis/flujo.md` — same + shared-location coordinates →
  `(-26.••, -58.••)`.
- `chat-analysis/pagos.md` — aliases/titulars → `[alias]`/`[titular]`/
  `[nombre]`; delivery-person tag → `[repartidor]`.
- `chat-analysis/segmentos.md` — ~30 customer names → `Cliente A…` labels;
  friend/partner names → `[amigo]`/`[nombre]`.
- `chat-analysis/{objeciones,style-profile}.md` — verified already clean;
  unchanged.
- `aprendizaje-chats-dueno.md` — owner name/alias, customer names →
  placeholders.
- `manual-operativo-mrs-muzzarella.md`, `presentacion-manual-operativo.html`
  — customer-name example → "Juan".
- `agent-ux-inventory.md` — quoted source strings updated (`"Te paso con el
  dueño…"`), Telegram chat-id example → `123456789`, personal-alias
  example → `TU..ALIAS`. `agent-runtime-inventory.md` verified clean;
  unchanged.
- `system-prompt-analysis.md` (root) — owner name → `[Nombre]`, real phone →
  masked, street address → `[dirección]`, customer → `Cliente A`, aliases →
  `[alias]`.

**src/ literals (shipped prompts, descriptions, fixtures):**
- `whatsapp/tools/transfer-to-human.ts` — `"Te paso con <owner>, el dueño…"`
  → `"Te paso con el dueño…"`.
- `whatsapp/seller-prompt.ts` — few-shot `"<customer> <real-phone>"` →
  synthetic `"pedro 5493704111111"`.
- `telegram/toolsWhatsApp.ts`, `telegram/toolsManagement.ts`,
  `phone-utils.ts` — docstring/example name+phone → synthetic.
- `admin/agent/agent-config-form.tsx` — chat-id placeholder → `123456789`,
  personal-alias example → `TU..ALIAS`.
- `*.test.ts` (agent-consistency, conversation-identity, sales-coach,
  web-order-guard, clients/actions) — real-name/real-phone fixtures →
  synthetic. The PII-absence assertions are kept — they now enforce this
  scrub (note: those regexes intentionally contain the identity patterns they
  forbid, and are the only allowed hits for them).

**skills/ + sdd/ specs:**
- `skills/clear-chat/SKILL.md` — dropped hardcoded personal name+phone pair;
  the skill now always asks. Format example → synthetic.
- `sdd/contexto-persistente-estados/proposal.md` — customer name + phone →
  `Cliente A (+54 3704 ••••••)`.
- `sdd/deteccion-no-comercial/{explore,specs,tasks}.md` — `"…paso con
  <owner>…"` → `"…con el dueño…"`.
- `sdd/diferenciacion-b2b-b2c/{specs,tasks}.md`,
  `sdd/rediseno-bot-ventas/{design,specs}.md` — personal alias → `[alias]`;
  owner persona → `[nombre del dueño]`.
- `sdd/resolucion-consistencia/{specs, fase-a-normalizacion/{design,specs},
  fase-e-frontend-sync/design}.md` — real phone in code examples →
  `5493704111111` family.

### 5.3 Kept — legit ops tools / no identity

`scripts/audit-sales-today.mjs` (PII-redacting audit tool),
`telegram-diagnose.mjs`, `migrate-promos.mjs`, `debug-hours.ts`,
`add-prepizza-docena.mjs`, `inspect-config.mjs`, `learn-style.ts`.
Kept-because-referenced deletions: **0** — every candidate was unreferenced.

### 5.4 Kept by rule — not customer PII

- Business-owned numbers: store WhatsApp (`SYSTEM-PROMPT-V2.md`), `wa.me/…`
  CTA in `sdd/mrs-muzzarella-marketplace/specs.md`, store street address.
- Synthetic fixtures `5493704111111`, `5493704123456`, `5491100000000`,
  `+5491100000000` — the only `549…` literals left in tracked files.
- `docs/socialcrm/*` citations of deleted filenames — audit provenance.
- Drizzle journal `when` timestamps and npm integrity hashes — not phones.

### 5.5 Verification

`git grep` over tracked files finds no real customer name, personal payment
alias, real phone number, customer address, or location coordinate. Gates
run: `npm run lint`, `npm run typecheck`, `npm run test:agents` (executable
files were touched), `npm run build`.
