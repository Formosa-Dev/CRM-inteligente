# SocialCRM Plans Re-Review — Closure of `5dbc72f`

**Decision up front:** the provider-evidence repair is approvable. The architecture
repair is not: it still publishes a competing contract. The self-hosted repair is not:
it routes the v1 installer to a webhook that does not exist yet and repeats one false
migration premise. No CRITICAL is left in the evidence document, but CR-1 and W-14 are
not fully closed across the document set, and the already-running messaging-core slice
does not match the canonical contract.

| Field | Value |
|---|---|
| Control baseline | `400daa15b2528a76695c20e8fc0a59f11c3228df` |
| Prior review | `5dbc72f39aa7299d95debad9c2eb7706a4a6e7e8` |
| Architecture repair | `ae708c1940b8d427537637ff9b28e761af77e9da` (parent `4e983a6`) |
| Evidence repair | `37821fd66e0080214199addf5773720afdc24faf` (parent `ab7ae2f`) |
| Self-hosted repair | `9a5c20fbd63d82587ea0f052a3cfb3c47cd8ebf1` (parent `1425a9f`) |
| Method | Immutable-commit review of the three resulting documents, static code/schema/deployment inspection, primary provider-doc spot check. No plan or source edits. No DB writes. No secrets read. |
| Content checked | `git rev-parse <commit>:<path>`: architecture `5b1cbbd5…`, evidence `24036ea7…`, self-hosted `20ced01a…` |

## 1. Verdicts

| Commit | Document | Verdict | Reason |
|---|---|---|---|
| `ae708c1` | `architecture-roadmap.md` | **CHANGES REQUIRED** | CR-1/W-14 remain open: §2.2 still defines a competing `ChannelId` with `messenger`, claims “this contract wins”, and repeats stale deltas. All other prior findings are closed. |
| `37821fd` | `provider-integration-evidence.md` | **APPROVE** | Canonical contract, `tenantId`, `sendTemplate?`, channel/event split, and v1 scope are correct and authoritative. One non-blocking platform-count error remains (17 vs 16). |
| `9a5c20f` | `self-hosted-product-roadmap.md` | **CHANGES REQUIRED** | CR-2/CR-3/W-8–W-11 and the Kapso scope are properly closed, but §1.6 installs a nonexistent v1 ingress URL and G3 repeats a false “fresh DB lacks unique” premise. |

The three commits are individually revertable documentation changes. The verdicts are
about the documents, not about the unchanged runtime defects (journal, `/setup`) that
the self-hosted document correctly labels as P0 work.

## 2. Per-finding closure matrix

Status legend: **CLOSED** = the defect is resolved in the repaired document;
**CLOSED WITH CAVEAT** = the plan is correct but one supporting claim is wrong;
**PARTIAL** = the main point is fixed but a cross-document contradiction remains;
**NOT CLOSED** = the defect still exists in a repaired document.

### CRITICAL

| ID | Finding | Repair evidence | Status |
|---|---|---|---|
| CR-1 | Three incompatible adapter contracts | Evidence §4 is now explicitly canonical (`37821fd`); self-hosted §0 references it; architecture §2.2 adopts it. But architecture still redefines it with `messenger` and claims authority over any other document. Execution-control and S1 add further variants. | **NOT CLOSED** |
| CR-2 | Migration journal cannot produce a fresh install; self-hosted misdiagnosed it | Self-hosted G3 now states the missing `0001` SQL, the two `0002` files, the orphan destructive migration, missing snapshots, and P0 acceptance (`migrate` on an empty branch + clean `generate`). It also promotes installability to a P0 blocker. Caveat: the sub-claim that a journal-migrated fresh DB lacks `leads_phone_unique` is false (`0002_woozy_valkyrie.sql:121` adds it). | **CLOSED WITH CAVEAT** |
| CR-3 | `/setup` uses `db.transaction` on `neon-http` | Self-hosted G4 is now a BLOCKER; Phase 0 rewrites first-admin creation without `db.transaction`, fixes `clients/actions.ts:206`, and adds a concurrent-submit test. Caveat: the suggested session-level `pg_advisory_lock` is not a reliable primitive over stateless HTTP; the single-statement conditional insert is. | **CLOSED WITH CAVEAT** |
| CR-4 | Schema cannot represent phone-less social identities | Architecture §2.4 chooses `lead_identities`, nullable `leads.phone` + partial unique index, synthetic conversation keys, enum/union/`BUFFER_CONFIG` extension, and a phone-less Instagram fixture. Self-hosted Phase 5 references it as a prerequisite. | **CLOSED** |
| CR-5 | Credential cutover silently ignores post-backfill admin edits | Architecture C2/C13 make `agent_config` authoritative for legacy YCloud credentials until the admin UI writes `channel_accounts`, with a required shadowing test. Self-hosted Phase 4 repeats the rule. | **CLOSED** |
| CR-6 | Unresolved “contract only” vs “build ChannelAccount + Kapso” scope | All three documents now agree: v1 = contract + YCloud adapter + facade + inbound extraction; `channel_accounts`/ingress only after a second provider is approved; Zernio next; Kapso spike only; embedded signup out. Evidence explicitly supersedes the source brief’s v1 scope. | **CLOSED** |

### WARNING

| ID | Finding | Repair evidence | Status |
|---|---|---|---|
| W-1 | Ingress path inconsistent | All documents use `/api/webhooks/ingress/[provider]`; no `/api/v1` surface. But self-hosted §1.6 tells the v1 installer to wire that route before it exists. | **PARTIAL** |
| W-2 | Contract cannot send templates | `sendTemplate?` is in evidence §4 and architecture §2.2. | **CLOSED** |
| W-3 | `tenantId` contradiction | Evidence §4 now includes `tenantId`; architecture includes it; self-hosted references it as constant `"default"`. | **CLOSED** |
| W-4 | `platformMessageId` namespacing unresolved | C6 and evidence rule 5 agree: bare WhatsApp wamid, `${provider}:${nativeId}` for social ids, `deliveryId` for non-message events. | **CLOSED** |
| W-5 | Direct-send inventory incomplete | Architecture §1 lists broadcast, queue worker, follow-up cron, Telegram tools, order creation, channel router, webhook replies, dashboard reply/media, and both order-status sends; it explicitly marks `api/agent/test` as non-sending. Phase 1 repeats the complete list. Verified against `grep` call sites. | **CLOSED** |
| W-6 | YCloud SMS marked verified | Matrix now says `sms (S — no SMS code in repo)` and non-goals exclude SMS implementation. | **CLOSED** |
| W-7 | New tests do not run | Architecture §6 gives the explicit `node --import tsx --test "src/lib/messaging/**/*.test.ts"` command and says unit 2 wires the tests plus `web-order-redirect.test.ts` into `test:agents`. | **CLOSED** |
| W-8 | “Up and down in CI” unsupported | Self-hosted §5/§8 state there is no CI and no down migrations; rollback is branch/backup restore plus re-migrate. | **CLOSED** |
| W-9 | Install acceptance overclaims | Self-hosted §1.7 splits “deployable” from “messaging end-to-end”; the 30-minute target is explicitly “to be measured, not asserted”. | **CLOSED** |
| W-10 | Queue/DLQ are not in-memory fallbacks | G14 and §1/§2.1 now say only buffer and rate-limit fall back; queue/worker/DLQ are no-ops without Upstash. | **CLOSED** |
| W-11 | Neon-only reality contradicts docs | G5 is a user-facing blocker and Phase 0 fixes README and `.env.example`. | **CLOSED (plan)** |
| W-12 | Repairs reference a file absent from their base | Source spec is tracked on the integration baseline (`400daa1`, promoted in `fe04b2b`); architecture and self-hosted add tracking notes. Evidence has no note, but the reference resolves at the integration baseline. Cherry-pick, not branch-tip merge, is required. | **CLOSED AT BASELINE** |
| W-13 | Conversation-to-account association undefined | Architecture C14 adds nullable `conversations.channelAccountId` in the same migration as `channel_accounts`; self-hosted Phase 4 repeats the FK backfill. | **CLOSED** |
| W-14 | Channel taxonomy conflates channel and event kind | Evidence §4 separates `ChannelId` and `EventKind` and removes `comment`/`messenger`. Architecture removes `comment` but keeps `messenger`; S1 keeps both `comment` and `messenger`. | **PARTIAL** |

### SUGGESTION

| ID | Finding | Status |
|---|---|---|
| S-1 | `src/lib/db/index.ts` path typo | CLOSED (`src/db/index.ts`). |
| S-2 | “admin test” is not a sender | CLOSED (explicitly marked non-sending). |
| S-3 | G3 wording about duplicate `0002` | CLOSED (two `0002` files, one journaled). |
| S-4 | Muzzarella file count | CLOSED (10, verified). |
| S-5 | Cross-link provider evidence | CLOSED (architecture §4 links evidence and downgrades claimed statuses). |
| S-6 | Declare Node engine | CLOSED at plan level (P0 adds `engines`). |
| S-7 | Zernio platform count | **NOT CLOSED** — doc says 17; primary docs say 16 posting platforms, with Shopify/WordPress connect-only blogs. |
| S-8 | Make the first slice runnable | CLOSED (explicit test command). |

## 3. New findings

### CRITICAL

#### N-1 — The architecture document still defines a competing contract

`architecture-roadmap.md` §2.2 says it is “the one canonical contract” and “this
contract wins”, while `provider-integration-evidence.md` §4 says it is canonical and
architecture “must reference this section, not redefine it.” The copies are not equal:

| Element | Evidence §4 (canonical) | Architecture §2.2 |
|---|---|---|
| `ChannelId` | `whatsapp \| instagram \| facebook \| telegram \| sms` | adds `messenger` |
| Messenger | rides `facebook`; not a channel | separate channel |
| §2.4 schema | n/a | adds `messenger` to enum and `msg:` synthetic keys |
| Delta statement | n/a | says “two deltas: tenantId, comment removed” — both are already true in evidence; the only actual delta is the added `messenger` |

Impact: the contract freeze (the first implementation slice) has two authority claims
and two channel unions. An implementer following architecture will add a dead
`messenger` channel and `msg:` keys; one following evidence will not. This is the
remaining substance of CR-1/W-14, not a wording issue.

Required fix: make architecture §2.2 a verbatim reference to evidence §4 plus the
`ChannelAccount` fields the product needs. Remove `messenger` from `ChannelId`, §2.4,
and the enum plan unless the canonical contract is deliberately changed everywhere.

#### N-2 — The running messaging-core slice does not match the canonical contract

`socialcrm-messaging-core` (`6ca09f4`, based on `400daa1`) is the first implementation
slice and already freezes a different contract in code:

- `src/lib/messaging/types.ts:13-20` defines `ChannelKind` with **both** `messenger`
  and `comment`.
- It has no `ChannelId`/`EventKind` split; it inlines the event union.
- It includes `isDefault` and `displayAddress` (`types.ts:37-40`), citing an
  architecture §2.2 that no longer contains those fields.

Impact: merging S1 as-is makes the code the de facto contract and leaves the repaired
documents contradicting it. This is an integration blocker, not a future concern.

Required fix before integrating S1: align `types.ts` and its contract test with the
chosen canonical contract (drop `comment`; resolve `messenger`; use `ChannelId` /
`EventKind` names), or explicitly amend the canonical contract and execution-control
in the same integration work unit.

### WARNING

#### N-3 — Self-hosted v1 install guide points at a route that does not exist

`self-hosted-product-roadmap.md:82` says each configured channel account surfaces
`/api/webhooks/ingress/[provider]`. In v1 there is no ingress route
(`src/app/api/webhooks/` is absent) and architecture C1/evidence checklist #6 keep
`/api/whatsapp/webhook` as the YCloud binding until B4. The render-blueprint guide
correctly uses `/api/whatsapp/webhook` (`install-render-neon.md:38,135`).

Impact: an installer following the product roadmap would paste a 404 URL into YCloud
and see no inbound messages. Fix §1.6 to name the v1 YCloud route and reserve ingress
for the provider-#2 phase.

#### N-4 — Execution control defers the install blocker that self-hosted makes P0

`execution-control.md` §3 puts `A0 → A1` before `A2 journal repair`, calls A2 “deferred,
large”, and queues S3 (`render.yaml`) independently. Repaired self-hosted §0/Phase 0
says the journal repair is a BLOCKER and “prerequisite for everything.” S3’s current
install guide works around the journal with:

```bash
for f in drizzle/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
```

That fallback is unsafe and self-defeating: it runs the destructive
`0002_unique_phone.sql` (dedupe + constraint), then `0002_woozy_valkyrie.sql:121`
tries to add `leads_phone_unique` again and aborts on a duplicate constraint. It also
ignores the missing `0001` entry rather than repairing it.

Impact: the first published install path remains broken and inconsistent with the
repaired P0 order. Fix: either sequence A2 before A1/S3, or hold S3 and rewrite its
guide. Remove the `psql` fallback in any case.

#### N-5 — Self-hosted G3 repeats a false migration premise

`self-hosted-product-roadmap.md:143` says a journal-migrated fresh DB “lacks”
`leads_phone_unique` because `schema.ts:285` has it. But the journaled migration
`0002_woozy_valkyrie.sql:121` already contains:

```sql
ALTER TABLE "leads" ADD CONSTRAINT "leads_phone_unique" UNIQUE("phone");
```

Once the missing `0001` SQL is restored, a fresh journal run reaches `0002_woozy` and
gets the constraint. The real defects are the missing `0001` file and the orphan
destructive `0002_unique_phone.sql`; there is no missing-constraint path for normal
journal installs. The proposed “new guarded/idempotent unique migration” may therefore
be unnecessary. Fix the claim and base the P0 acceptance on the real defects.

### SUGGESTION

- **N-6 — `/setup` fix mechanism.** Prefer a single atomic
  `INSERT … SELECT … WHERE NOT EXISTS` (or a proven `db.batch`) over a session-level
  `pg_advisory_lock`; HTTP-driver sessions are not a durable lock context. The doc
  already offers alternatives; make the single-statement path primary.
- **N-7 — Zernio platform count.** Primary docs currently say “publish to 16
  platforms”; Shopify and WordPress are connect-only blogs and are not counted. Change
  “17” to “16” or avoid the count.
- **N-8 — Self-hosted Phase 3 wording.** It says “new files only, no behavior change”
  while including the outbound facade, which necessarily edits existing call sites.
  Mirror execution-control’s B0 (new files) / B1 (facade edits) split.
- **N-9 — Source brief still contains the old contract.** The source brief is
  requirements-only and execution-control declares it non-authoritative, but it still
  shows `ChannelType`/`IMessagingProvider`. Add a superseded pointer if it remains
  tracked as product input.
- **N-10 — Schema prerequisite wording.** Self-hosted Phase 5 says “nullable
  `leads.phone` **or** a `lead_identities` table”; architecture §2.4 chose both.
  Reference §2.4 rather than restating a weaker alternative.

## 4. Cross-document compatibility

| Topic | Evidence | Architecture | Self-hosted | Execution control | Result |
|---|---|---|---|---|---|
| Contract authority | Canonical §4 | Redefines + “wins” | References | Says evidence verbatim + merge roadmap fields | **Conflict** (N-1) |
| `ChannelId` / `EventKind` | Split, no `messenger` | Split, adds `messenger` | Comment as event kind | Evidence names | **Conflict** (N-1) |
| `ChannelAccount` fields | `tenantId`, no `isDefault`/`displayAddress` | Same as evidence | References | Says merge `isDefault`/`displayAddress` from architecture | **Stale** (N-2) |
| Credential cutover | n/a | C2/C13 prefer `agent_config` for legacy YCloud | Phase 4 repeats | agent_config → env until B3 | Compatible |
| Phone-less identity | Rule 8 | §2.4 full model | Phase 5 prerequisite | Not covered | Compatible |
| Ingress path | `[provider]`, provider #2 only | `[provider]`, provider #2 only | Uses it in v1 §1.6 | Lands in B4 | **Partial** (N-3) |
| Kapso | Spike only | Spike only | Spike only, no embedded signup | B6 spike | Compatible |
| Journal / setup | n/a | Parallel repo-trust lane | P0 BLOCKER prerequisite | A2 deferred, S3 queued | **Conflict** (N-4) |
| Source spec | Superseded | Tracked note | Tracked note | Requirements only | Compatible with pointer cleanup |

## 5. Compatibility with implementation slices from `400daa1`

| Slice | Commit | Finding | Action |
|---|---|---|---|
| `socialcrm-messaging-core` (S1) | `6ca09f4` | Contract drift: `ChannelKind` includes `comment` and `messenger`; extra fields absent from repaired architecture | Hold until N-1/N-2 resolved; edit is confined to new files. |
| `socialcrm-render-blueprint` (S3) | `28e054c` | `/setup` still advertised as “race-safe advisory lock”; journal fallback is broken; stale G4/G5/G6 numbering; correct YCloud route | Hold until A2 and the `/setup` fix land; rewrite guide §3–§4. |
| `socialcrm-repo-hygiene` (S2) | `400daa1` tip | No unique commits; queued | No conflict. |
| S4–S6 | not launched | Depend on S1/contract | Do not start before N-1/N-2. |

## 6. Integration sequencing advice for the main orchestrator

1. **Do not merge the branch tips.** All three repaired branches have merge-base
   `c14951d`; they predate `400daa1` and do not contain `execution-control.md` or the
   promoted source spec. A direct `git merge` would conflict on the same files. The
   original document blobs at `4e983a6`/`ab7ae2f`/`1425a9f` are byte-identical to
   `400daa1`, so cherry-pick onto `400daa1`:
   `git cherry-pick ae708c1 37821fd 9a5c20f`.
2. **Land the document fixes as a follow-up commit, not by rewriting the reviewed
   branches:** architecture §2.2 → pointer to evidence §4, remove `messenger`;
   self-hosted §1.6 → v1 YCloud route; self-hosted G3 → real journal defects;
   self-hosted Phase 3 → B0/B1 split; evidence 17 → 16.
3. **Freeze one contract before S1.** Choose whether `isDefault`/`displayAddress` are
   canonical. If yes, add them to evidence §4 and architecture §2.2; if no, remove them
   from S1. Drop `comment` everywhere as a channel. Resolve `messenger` as
   `facebook` (recommended, matches evidence and Zernio’s platform model). Then update
   S1 `types.ts` and its contract test.
4. **Update execution-control after the cherry-picks** (orchestrator-owned; not edited
   here): record the new document blobs in the integration log, change S1 acceptance
   from “§2.2” to the canonical contract pointer, remove the stale `isDefault`/
   `displayAddress` instruction if the fields are rejected, and reconcile
   `A2 deferred` with self-hosted’s `P0 prerequisite`.
5. **Sequence A2 before A1/S3 publication.** Repair/stabilize the journal, prove
   `migrate` + clean `generate` on an empty Neon branch, and fix `/setup` without
   `db.transaction`. Only then publish the install guide. Remove the `psql` fallback;
   it cannot succeed against the current migrations.
6. **Integrate S1 after step 3**, then S4/S5. Keep B3/B4 and Zernio behind the
   provider-#2 decision; keep Kapso spike-only.
7. **Gates:** docs-only cherry-picks need `git diff --check` and a link/reference
   check; S1/S3 retain the full `test:agents`/`typecheck`/`lint`/`build` gate. Do not
   merge S3 until its guide matches the repaired self-hosted order.

## 7. Verification evidence

### Repository and commit checks

- `git rev-parse HEAD` → `400daa15b2528a76695c20e8fc0a59f11c3228df`.
- `git merge-base 400daa1 ae708c1|37821fd|9a5c20f` → `c14951d…` for all three.
- `git diff 4e983a6 400daa1 -- docs/socialcrm/architecture-roadmap.md` → empty;
  same for `ab7ae2f`/evidence and `1425a9f`/self-hosted. The repaired parents’ content
  equals the integration baseline.
- `git diff --check <parent> <repair>` → exit 0 for all three. `git diff --check` on
  the review worktree → exit 0.
- Document blobs: architecture `5b1cbbd5c2b4f8a5182a28e4c321e2e2ad6b7857`, evidence
  `24036ea75aa29f4b0d1f846372eb334957820801`, self-hosted
  `20ced01a25736740a81faaf8f841820b20337bda`.

### Static code/schema checks

- `src/app/setup/actions.ts:40` — `db.transaction(...)`; `clients/actions.ts:206` —
  same pattern.
- `src/lib/checkout/service.ts:31-34` — repo comment: `neon-http` does not support
  `db.transaction()`.
- `src/db/index.ts` — `drizzle-orm/neon-http`.
- `drizzle/meta/_journal.json` — `idx: 1` tag `0001_handy_tombstone`; no matching SQL.
- `drizzle/` — `0002_unique_phone.sql` + `0002_woozy_valkyrie.sql`;
  `0002_woozy_valkyrie.sql:121` adds `leads_phone_unique`.
- `drizzle/meta/` — snapshots missing for `0003`, `0006`, `0007`, `0011`, `0012`.
- `src/db/schema.ts:48,187,285` — channel enum, `whatsappId notNull unique`,
  `leads.phone notNull unique`.
- `src/lib/channels/router.ts:7` and `src/lib/buffer/config.ts` — only
  `whatsapp|telegram`.
- `src/app/(admin)/admin/agent/actions.ts:256-261,306-311` — admin writes only
  `agent_config`.
- Direct-send grep: broadcast, queue worker, follow-up cron, Telegram
  `toolsWhatsApp`/`toolsManagement`, `create-order`, channel router, webhook route,
  `response-sender`, dashboard reply/media, both order-status sends. `api/agent/test`
  only checks `ycloudApiKey`.
- `package.json` `test:agents` — 13 files; `web-order-redirect.test.ts` unwired.
- No `src/app/api/webhooks/` route; `/api/whatsapp/webhook` present.
- `socialcrm-messaging-core:src/lib/messaging/types.ts:13-20,37-40` —
  `ChannelKind` includes `comment`/`messenger`; `isDefault`/`displayAddress` present.
- `socialcrm-render-blueprint:docs/socialcrm/install-render-neon.md:94-105,135` —
  `psql` fallback, “race-safe advisory lock”, correct YCloud URL.

### Primary provider-doc check

- `https://docs.zernio.com/platforms` (fetched for this review): “Publish to 16
  platforms”; Shopify/WordPress are connect-only Blogs & Commerce, not social-post
  targets. This confirms the repaired “17 platforms” sentence is inaccurate.

### Not run

- `npm run test:agents`, `typecheck`, `lint`, `build`: the reviewed commits are
  documentation-only and this review changed no source. S1/S3 findings are static
  inspections of their committed files.
- No migration, `/setup`, webhook, or database operation was executed. No secrets were
  read.

## 8. Remaining blockers and bottom line

Remaining blockers, in order:

1. Contract authority and taxonomy (N-1) plus S1 drift (N-2) — must be fixed before
   the first implementation slice is accepted.
2. Self-hosted v1 ingress wording (N-3) and G3’s false unique premise (N-5).
3. Execution-control’s A2/A1 ordering and S3’s broken migration fallback (N-4).

Once those are corrected, all six CRITICALs and every real prior WARNING are closed at
the planning level. Evidence is ready to approve now; architecture and self-hosted need
one small documentation follow-up each. Do not merge S1 or S3 before that follow-up.

**Skill Resolution: injected**

**Engram:** no `mem_*` runtime tools are exposed in this session, so no memory writes
were attempted.
