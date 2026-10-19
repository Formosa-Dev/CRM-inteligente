# SocialCRM Plans Final Review — Round-2 Repairs

**Decision up front:** both round-2 commits are **APPROVE** at the document level.
`d497619` genuinely closes N-1 and W-14: the architecture document no longer
defines a competing contract, and `messenger`/`comment` are no longer channels.
`8fa6788` genuinely closes N-3 and the G3 caveat: v1 points at the existing
`/api/whatsapp/webhook` route, and the journal diagnosis now matches the SQL on
disk.

The document set is not yet safe to integrate S1 or S3. Three control-plane
items remain: `execution-control.md` still tells S1 to merge fields the canonical
contract rejects; `execution-control.md` and S3 still publish the old
A1-before-A2 ordering and the broken bulk-`psql` fallback; and the completed S1
branch still freezes the old contract in code. Those are integration blockers,
not reasons to reword either reviewed document.

| Field | Value |
|---|---|
| Control baseline | `400daa15b2528a76695c20e8fc0a59f11c3228df` |
| Prior re-review | `036d10634f2263fe0169ac12589e81acb91b73ef` |
| Canonical evidence | `37821fd66e0080214199addf5773720afdc24faf` (approved in `036d106`) |
| Architecture round-1 parent | `ae708c1940b8d427537637ff9b28e761af77e9da` |
| Architecture round-2 | `d49761996b59b7cc386147e19a9d3ab5b44b10da` |
| Self-hosted round-1 parent | `9a5c20fbd63d82587ea0f052a3cfb3c47cd8ebf1` |
| Self-hosted round-2 | `8fa6788531dc1241a433e120d3c537a97b9b1a30` |
| S1 branch tip | `socialcrm-messaging-core` `6ca09f4` |
| S3 branch tip | `socialcrm-render-blueprint` `28e054c` |
| Method | Immutable-commit review; full resulting documents; static code/schema/deployment inspection; detached cherry-pick dry run. No source edits, DB writes, webhook calls, or secret reads. |
| Resulting document blobs | architecture `e0e93276ac31cce6494393176ce4c98d6b319dc8`, evidence `24036ea75aa29f4b0d1f846372eb334957820801`, self-hosted `4e612d11b2aecaf0260ee9608ef9dd8ec8237a3f` |
| `git diff --check` | exit 0 for both commits and for the full cherry-pick dry run |

## 1. Verdicts

| Commit | Document | Verdict | Basis |
|---|---|---|---|
| `d497619` | `architecture-roadmap.md` | **APPROVE** | N-1/W-14 are actually gone, not reworded: §2.2 is now a pointer to evidence §4, the competing type block is deleted, `messenger` is removed from `ChannelId` and §2.4, and the stale "two deltas" claim is gone. The document also records the S1 hold/acceptance criterion. Integration is conditional on R-1/R-3 below. |
| `8fa6788` | `self-hosted-product-roadmap.md` | **APPROVE** | N-3 and N-5/G3 are actually gone: v1 uses the existing `/api/whatsapp/webhook`; ingress is Phase 4 only; G3 correctly says `0002_woozy` is journaled and already adds `leads_phone_unique`; the false "missing constraint" premise and the unnecessary new unique migration are removed. Integration is conditional on R-2 below. |

The parent repairs (`ae708c1`, `9a5c20f`) are required inputs to the final
documents because the round-2 commits are stacked on them. They are not
re-reviewed as standalone commits here; the verdicts above are for the resulting
full documents at the round-2 tips.

## 2. Blocker closure matrix

Status legend: **CLOSED** = the prior defect is resolved in the resulting
document; **PARTIAL** = the document is correct but a control-plane or code
artifact still contradicts it; **OPEN** = the prior defect still exists in the
artifact that will be integrated.

| ID | Prior finding | Round-2 evidence | Status |
|---|---|---|---|
| N-1 (CRITICAL) | Architecture defined a competing contract and claimed it won | `d497619` deletes the full type block; `architecture-roadmap.md:96-130` is a pointer to `provider-integration-evidence.md` §4 plus an orientation table. No second authority claim remains. | **CLOSED (document)** |
| W-14 (WARNING) | Channel taxonomy conflated channels and event kinds | `architecture-roadmap.md:110` lists `ChannelId` without `comment`/`messenger`; `:111` keeps `comment.received` as `EventKind`; `:157-165` removes `msg:` synthetic keys and `messenger` from the enum plan. | **CLOSED** |
| N-3 (WARNING) | Self-hosted v1 install guide pointed at a route that does not exist | `self-hosted-product-roadmap.md:39-42` and `:90-95` keep v1 on `/api/whatsapp/webhook` (legacy alias `/api/webhook/whatsapp`); ingress is explicitly Phase 4 only. | **CLOSED** |
| N-5 / G3 caveat (WARNING) | Self-hosted repeated a false "fresh journal DB lacks `leads_phone_unique`" premise | `self-hosted-product-roadmap.md:146-161` states `0002_woozy_valkyrie.sql` is journaled and adds `leads_phone_unique` at line 121; the real defects are the missing `0001` file and the orphan `0002_unique_phone.sql`; no new constraint migration is asserted. `:272-274` repeats the corrected acceptance. | **CLOSED** |
| CR-2 / G3 caveat (CRITICAL) | Journal diagnosis and P0 acceptance wrong | Same as N-5; `:241-278` now makes journal repair and `/setup` hard P0 prerequisites before the install guide/blueprint is published. | **CLOSED (document)** |
| N-4 (WARNING) | Execution control and S3 deferred the install blocker that self-hosted makes P0 | `self-hosted-product-roadmap.md:53-59` and `:277-278` now sequence P0 before guide publication. But `execution-control.md:66-71` still places A1 before A2 and calls A2 "deferred, large"; `execution-control.md:94` still queues S3 without a P0 dependency; S3's guide still publishes the bulk-`psql` fallback. | **PARTIAL** |
| N-2 (CRITICAL) | Running S1 slice froze a different contract | `architecture-roadmap.md:125-130` now records the S1 acceptance criterion and says "Hold S1 until it matches evidence §4 exactly." S1 (`6ca09f4`) is unchanged and still violates it. | **OPEN (S1)** |
| N-6 (SUGGESTION) | `/setup` fix used an unreliable advisory lock | `self-hosted-product-roadmap.md:253-258` makes one atomic `INSERT ... SELECT ... WHERE NOT EXISTS` the primary mechanism and explicitly rejects session-level `pg_advisory_lock`. | **CLOSED** |
| N-8 (SUGGESTION) | Phase 3 claimed "new files only" while editing call sites | `self-hosted-product-roadmap.md:315-326` splits seam (new files) from facade (existing call sites) and inbound extraction. | **CLOSED** |
| N-10 (SUGGESTION) | Phase 5 schema prerequisite was written as an either/or | `self-hosted-product-roadmap.md:362-367` references architecture §2.4 and requires both `lead_identities` and nullable `leads.phone` with a partial unique index. | **CLOSED** |
| N-9 (SUGGESTION) | Source brief still showed the old contract | `architecture-roadmap.md:102-103` explicitly marks the source brief's `IMessagingProvider`/`ChannelType` block as superseded requirements input. | **CLOSED** |
| N-7 / S-7 (SUGGESTION) | Evidence says "17 platforms"; primary docs say 16 | Not touched by these commits. `37821fd` is already approved as canonical and is not re-opened here. | **NON-BLOCKING, OUT OF SCOPE** |

## 3. Remaining findings

### R-1 — `execution-control.md` still merges contract fields that no longer exist (WARNING, integration blocker)

`execution-control.md:41-42` says:

> use evidence §4 verbatim ... merge in roadmap §2.2 `ChannelAccount` fields
> (`tenantId`, `isDefault`, `displayAddress`, `status`)

The canonical contract has no `isDefault` or `displayAddress`:
`provider-integration-evidence.md` §4 defines `ChannelAccount` with `id`,
`tenantId`, `provider`, `channel`, `providerAccountId`, `senderAddress`,
`credentials`, and `status` only. `architecture-roadmap.md:112` now mirrors
exactly that list, and `:125-130` says:

> **no** `isDefault`/`displayAddress` fields (not canonical; account
> defaulting is a schema/resolver concern — C14, and `senderAddress` already
> covers the display role). Hold S1 until it matches evidence §4 exactly.

S1 follows the stale instruction: `src/lib/messaging/types.ts:37-40` adds both
fields, and `providers/ycloud.test.ts:25-27` uses them.

Required before S1 integration: remove `isDefault`/`displayAddress` from
`execution-control.md` §2.2, keep `tenantId`/`status`, and change the S1
acceptance at `execution-control.md:92` from "Contract per §2.2" to
"evidence §4 verbatim / architecture §2.2 pointer".
If the product wants defaulting or a display address, it belongs in the
schema/resolver (C14) or `senderAddress`, not in the frozen contract.

### R-2 — `execution-control.md` and S3 still contradict the new P0 order (WARNING, integration blocker)

`self-hosted-product-roadmap.md:53-59` says journal repair (G3) and the
`/setup` fix (G4) are hard P0 prerequisites that land **before** the install
guide or blueprint is published, and that no published install path may use a
bulk `psql` workaround. `:277-278` makes the same rule an acceptance criterion.

`execution-control.md` still says the opposite:

- `:66` sequences `A0 -> A1 render.yaml+install -> ...`;
- `:70-71` puts `A2 journal repair + de-brand vertical` after A1 and labels it
  `(deferred, large)`;
- `:94` queues S3 with `Depends on: none`;
- S6 is journal repair only; the G4 `/setup` fix has no explicit P0 slice.

S3's completed branch (`28e054c`) still contains the exact workaround the
self-hosted document now forbids:

- `docs/socialcrm/install-render-neon.md:94-100` says "Until the journal is
  repaired, apply the SQL files directly in filename order" and gives
  `for f in drizzle/*.sql; do psql ...; done`;
- `:155` tells the operator to use that fallback on a journal error;
- `:104-105` advertises `/setup` as a "race-safe advisory lock", which the
  self-hosted document now says is not a durable primitive on `neon-http`.

Required before S3 integration: either sequence S6/A2 (journal) and the G4
`/setup` fix before A1/S3, or mark S3 blocked and rewrite its guide after P0.
Remove the `psql` fallback and the advisory-lock claim. This is a real
contradiction, not a wording difference: the fallback replays the destructive
orphan migration and then aborts when `0002_woozy` re-adds
`leads_phone_unique`.

### R-3 — S1 still freezes the old contract (CRITICAL, integration blocker)

The completed S1 branch (`6ca09f4`, based on `400daa1`) still contains:

- `src/lib/messaging/types.ts:5-7` cites architecture §2.2 for
  `isDefault`/`displayAddress`, but §2.2 no longer contains them;
- `types.ts:13-20` defines `ChannelKind` with both `messenger` and `comment`;
- `types.ts:25` uses `ChannelKind` for `ChannelAccount.channel`;
- `types.ts:37-40` adds `isDefault`/`displayAddress`;
- `types.ts:62-66` inlines the event union instead of a separate `EventKind`;
- `registry.ts:10,16,38` imports and uses `ChannelKind`;
- `providers/ycloud.test.ts:25-27` constructs the fixture with the non-canonical
  fields;
- `provider-contract.test.ts` has no assertions for the canonical channel/event
  sets.

Required before S1 integration: rename to `ChannelId`, remove `messenger` and
`comment` from channels, add/export `EventKind` and use it for `kind`, remove
`isDefault`/`displayAddress`, update `registry.ts` and the adapter fixture, and
add contract-test assertions for the canonical `ChannelId`/`EventKind` sets.
The architecture document already says to hold S1 until this is done; merging
S1 as-is would make the code the de facto contract and reintroduce N-1/W-14.

### R-4 — Non-blocking evidence leftover (not re-opened)

The prior review's S-7 (Zernio "17 platforms" vs primary docs "16") remains in
`provider-integration-evidence.md`. `37821fd` is already approved as the
canonical contract; this review does not re-open it. Correct it in a later
evidence-only commit if desired.

## 4. Cross-document compatibility

| Topic | Evidence `37821fd` | Architecture `d497619` | Self-hosted `8fa6788` | Execution control `400daa1` | S1/S3 | Result |
|---|---|---|---|---|---|---|
| Contract authority | Canonical §4 | Pointer to §4; no copy | References §4 | Evidence §4 + stale roadmap fields | S1 old contract | **Conflict R-1/R-3** |
| `ChannelId` / `EventKind` | Split; no `messenger`/`comment` channels | Split; no `messenger`/`comment` channels | Comment as event kind | Evidence names | S1 `ChannelKind` with both | **Conflict R-3** |
| `ChannelAccount` fields | `tenantId`; no `isDefault`/`displayAddress` | Same as evidence | References contract | Says merge `isDefault`/`displayAddress` | S1 has both | **Conflict R-1/R-3** |
| v1 ingress | Existing YCloud route; ingress provider #2 | Existing route; ingress provider #2 | Existing route; ingress Phase 4 only | B4 | S3 uses correct route | **Compatible** |
| Journal / P0 order | n/a | Parallel repo-trust lane | P0 before guide/blueprint; no bulk `psql` | A1 before A2; A2 deferred; S3 queued | S3 publishes `psql` fallback | **Conflict R-2** |
| Credential cutover | n/a | `agent_config` wins for legacy YCloud | Phase 4 repeats | `agent_config` -> env until B3 | n/a | **Compatible** |
| Phone-less identity | Rule 8 | §2.4 both `lead_identities` + nullable phone | Phase 5 references §2.4 | Not covered | n/a | **Compatible** |
| Kapso | Spike only | Spike only | Spike only, no embedded signup | B6 spike | n/a | **Compatible** |
| Source brief | Superseded | Explicit superseded pointer | References contract | Requirements only | n/a | **Compatible** |

## 5. Exact safe integration order

Do not merge branch tips. All three branches have merge-base `c14951d` and
predate `400daa1`; a direct merge would conflict and can drop
`execution-control.md` and the promoted source spec. The baseline content equals
the original branch roots, so cherry-pick the stacked series onto `400daa1`.

### 5.1 Documentation commits (safe now)

From a clean `main` at `400daa1`:

```bash
git cherry-pick 37821fd ae708c1 d497619 9a5c20f 8fa6788
```

Order rationale:

1. `37821fd` — evidence §4 is the canonical contract the other two documents
   point to; it applies directly to `400daa1`.
2. `ae708c1` then `d497619` — architecture round-1 reconciliation plus the
   round-2 pointer. `d497619` cannot be cherry-picked alone: its parent content
   (`ae708c1`) is not in `400daa1`.
3. `9a5c20f` then `8fa6788` — self-hosted round-1 reconciliation plus the
   round-2 route/journal correction. `8fa6788` cannot be cherry-picked alone for
   the same reason.

This exact sequence was dry-run in a detached worktree at `400daa1`; all five
commits applied cleanly, and the resulting document blobs match the reviewed
tips exactly:

- architecture `e0e93276ac31cce6494393176ce4c98d6b319dc8`
- evidence `24036ea75aa29f4b0d1f846372eb334957820801`
- self-hosted `4e612d11b2aecaf0260ee9608ef9dd8ec8237a3f`

Run `git diff --check` after the cherry-picks. Do not include the auto-generated
`.atl/` changes in the integration commit.

### 5.2 Control-plane update (orchestrator-owned, before S1/S3)

Update `docs/socialcrm/execution-control.md`:

1. §2.2 — remove `isDefault`/`displayAddress`; keep `tenantId`/`status`; point
   S1 acceptance at evidence §4 / architecture §2.2.
2. §3/§4 — sequence S6/A2 and the G4 `/setup` fix before A1/S3, or mark S3
   `blocked` until P0; remove "A2 deferred, large" as the operative ordering.
3. §4 — set S3 to `blocked` until S6 and G4 pass; set S1 to `blocked` until R-3
   is fixed.
4. §8 — record the five cherry-picked SHAs and the new document blobs.

### 5.3 Implementation integration (after 5.1 and 5.2)

1. S1: apply R-3, run `npm run test:agents`, `npm run typecheck`,
   `npm run lint`, `npm run build`, then integrate.
2. S6/A2 + G4: repair the journal, prove `drizzle-kit migrate` on an empty Neon
   branch plus a clean `drizzle-kit generate`, fix `/setup` without
   `db.transaction`, and run the concurrent-submit test.
3. S3: rewrite the guide (§3, §4, §7) to remove the `psql` fallback, the
   advisory-lock claim, and the pre-P0 publication order; then integrate after
   S6/G4.
4. S4/S5 and later: follow S1; do not start before the contract is frozen.
   B3/B4 and Zernio remain behind the provider-#2 decision; Kapso remains a
   spike.

## 6. Verification evidence

### Commit and diff checks

- `git diff --check ae708c1 d497619` -> exit 0.
- `git diff --check 9a5c20f 8fa6788` -> exit 0.
- `git diff --check 400daa1 d497619` -> exit 0.
- `git diff --check 400daa1 8fa6788` -> exit 0.
- Detached worktree at `400daa1`:
  `git cherry-pick 37821fd ae708c1 d497619 9a5c20f 8fa6788` -> all five
  applied cleanly; `git diff --check HEAD~5..HEAD` -> exit 0.
- Resulting blobs equal the reviewed tips (architecture, evidence,
  self-hosted), as listed in §5.1.

### Code/schema/deployment checks

- `src/app/api/whatsapp/webhook/route.ts` and legacy
  `src/app/api/webhook/whatsapp/route.ts` exist; no `src/app/api/webhooks/`
  route exists. This confirms N-3's v1 route choice and the "ingress Phase 4
  only" statement.
- `drizzle/meta/_journal.json`: `idx: 1` tag is `0001_handy_tombstone`;
  `drizzle/0001_handy_tombstone.sql` is absent; `idx: 2` is
  `0002_woozy_valkyrie`; `drizzle/0002_unique_phone.sql` is present but absent
  from the journal. This confirms G3's missing-`0001` + orphan diagnosis.
- `drizzle/0002_woozy_valkyrie.sql:121` adds
  `ALTER TABLE "leads" ADD CONSTRAINT "leads_phone_unique" UNIQUE("phone")`.
  This confirms the G3 caveat correction: a normal journal install does get the
  constraint.
- `drizzle/0002_unique_phone.sql:8,18,29` performs the destructive `leads`
  dedupe, reassigns `orders`, and adds `leads_phone_unique`; this confirms the
  bulk-`psql` fallback would replay the destructive orphan and then collide.
- Snapshots are missing for journal entries `0003`, `0006`, `0007`, `0011`,
  `0012`; present snapshots are `0001`, `0002`, `0004`, `0005`, `0008`, `0009`,
  `0010`. This matches G3.
- `src/app/setup/actions.ts:40` and
  `src/app/(admin)/admin/clients/actions.ts:206` call `db.transaction(...)`;
  `src/db/index.ts` imports `drizzle-orm/neon-http`. This confirms G4 and the
  reason the advisory-lock claim is wrong.
- S1 `6ca09f4`: `types.ts:13-20,37-40`, `registry.ts:10,16,38`,
  `providers/ycloud.test.ts:25-27` show the old `ChannelKind`/fields. This
  confirms N-2 is still open at the branch tip.
- S3 `28e054c`: `docs/socialcrm/install-render-neon.md:94-100,104-105,155`
  show the `psql` fallback and "race-safe advisory lock". This confirms R-2.

### Not run

- `npm run test:agents`, `typecheck`, `lint`, `build`: the reviewed commits are
  documentation-only; S1/S3 findings are static inspections of their committed
  files.
- No migration, `/setup`, webhook, or database operation was executed. No
  secrets were read. No source branch was modified.

## 7. Bottom line

- `d497619`: **APPROVE**. N-1 and W-14 are closed in the resulting
  architecture document; no competing contract or `messenger` channel remains.
- `8fa6788`: **APPROVE**. N-3 and the G3 caveat are closed in the resulting
  self-hosted document; v1 uses the existing route and the journal diagnosis is
  accurate.
- The documents are ready to cherry-pick now in the order in §5.1.
- Do not integrate S1 or S3 until R-1, R-2, and R-3 are resolved. Those are
  control-plane/code repairs, not reasons to reword the two approved documents.

**Skill Resolution: injected**

**Engram:** runtime identity resolved to `crm-inteligente` from the git remote,
not `socialcrm`; no memory write was attempted under the wrong project.
