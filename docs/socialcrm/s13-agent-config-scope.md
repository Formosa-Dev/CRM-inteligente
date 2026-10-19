# S13 — Scoped `agent_config` (per-channel / per-account)

`agent_config` gained two nullable scope columns: `channel` (`channel` enum)
and `channel_account_id` (FK → `channel_accounts.id`, `ON DELETE SET NULL`).

| `channel` | `channel_account_id` | Meaning |
| --- | --- | --- |
| NULL | NULL | **Global default** — the pre-S13 single row (conventionally `id = 1`). |
| set | NULL | Channel-scoped row (one per channel, partial unique). |
| set | set | Per-account row (one per `channel_accounts` row, partial unique). |

## Resolution order

`resolveAgentConfig({ channel, channelAccountId })` → account row →
`channel_accounts.agent_config_id` binding (S11 seam) → channel row → global
row (lowest `id`, both columns NULL). Every lookup is wrapped in try/catch: on
an un-migrated deploy the scoped queries fail and the legacy `id = 1` row is
returned — identical to previous behavior.

`resolveAgentConfigId()` returns just the id (30s cache per scope key).
`findAgentConfigForScope()` is the **exact-scope** read used by the admin
editor — it never chains to broader scopes.

## Ambient scope

`runWithAgentConfigScope(scope, fn)` binds a scope to the async context
(`AsyncLocalStorage`). Callers that omit the `scope` argument read the ambient
scope; outside a `run` the ambient scope is empty → global row.

## Rewired call sites (context already available)

| Call site | How scope is derived |
| --- | --- |
| `whatsapp/agent.ts` `runWhatsAppAgent` | Wrapper resolves `{ channel, channelAccountId }` from `conversations` by `conversationId`, then wraps the whole run in `runWithAgentConfigScope`. All ambient reads inside inherit it, including tool `execute`s and `notifyDeliveryOrder`. `dashboard-actions-server.ts` re-runs get it automatically. |
| `whatsapp/prompt-builder.ts` ×6 (`getCorePrompt`, `getStyleProfile`, `getBusinessHours`, `getProductionHours`, `getOperationalData`, tiempoEspera in `buildSystemPrompt`) | Ambient (agent run) → else global. `resolveAgentConfig()` drop-in for the `findFirst(id=1)` calls. |
| `ai/config.ts` `getAIConfig` | Ambient scope; 30s cache now keyed per scope. `invalidateAIConfigCache()` clears all scopes. |
| `whatsapp/tools/kitchen-tools.ts` ×4, `get-menu.ts` ×2, `get-business-hours.ts`, `client-tools.ts`, `order-context-tools.ts`, `sticker-tools.ts` ×2, `extended-tools.ts`, `create-order.ts` ×2 | `eq(agentConfig.id, await resolveAgentConfigId())` (ambient) / `resolveAgentConfig()`. |
| `whatsapp/seller-prompt.ts` `getBusinessStatus` | `resolveAgentConfig()` ambient. |
| `channels/router.ts` `sendOutboundMessage` (whatsapp branch) | Explicit scope from the already-loaded conversation row; scoped apiKey/sender passed to `messenger.send` for **all** branches (text + image + document — previously media sends silently used provider-internal global creds). |
| `admin/agent` page + actions | `?scope=<key>` selects global / `channel:<c>` / `account:<id>`; `saveAgentConfig` updates or creates the exact-scope row (create-on-save); `copyAgentConfig` clones a source scope into the current one; `testAgentConnection` reports the effective (resolved) row for the viewed scope. |
| `agent/index.ts` `processMessage` (legacy v1 path) | `loadConfig` now uses `resolveAgentConfig({})` — explicit global (same row the old `limit(1)` picked). |

## Deliberately-global call sites (no usable context / install-level)

| Call site | Why global |
| --- | --- |
| `lib/integrations.ts` (`getIntegrationSecrets`, `getYCloudApiKey`) | Infrastructure/bootstrap secrets read by webhook verify, provider adapters, and `messaging/accounts.ts` legacy `credentialsRef: "agent_config"` placeholder. No conversation context at those boundaries — and the placeholder slot *is* the global row by design. |
| `lib/business.ts` `getBusinessInfo` | Storefront/business identity — channel-agnostic surface (web cart, prompts). |
| `whatsapp/get-number.ts` | Admin-side display helper. |
| `checkout/store.ts` (`getDestinationPhone`, `getBurgersUnavailable`) | Web checkout is channel-agnostic; there is no conversation yet. |
| `telegram/*` (bot, toolsManagement, toolsWhatsApp, prompt-builder) | The internal Telegram ops bot is install-level, not a customer channel account. |
| `channels/router.ts` `notifyCustomerDeliveryArrived` / `forwardLocationToDelivery` | Keyed by delivery phone / latest pending order; `orders` has no `conversationId`, so no reliable account context. |
| `app/api/whatsapp/webhook/route.ts` `enabled` gate + pendingMedia sends | Install-level kill switch; file owned by another worker (S12) — the agent's `pendingMedia` is sent by this route after the scoped run ends, via its own credential resolution. |
| `app/api/webhooks/ingress/**`, `whatsapp/human-handoff.ts` | Owned by other workers — untouched per task partition. |
| `admin/*` pages (conversations, dashboard-actions-server send path aside) | Operator context. `dashboard-actions-server`'s `runWhatsAppAgent` call IS scope-aware via the wrapper (it passes `conversationId`); its standalone WA creds read stays global. |
| `app/api/admin/test-agent`, `app/api/agent/test` | Operator test routes — global. |
| `db/seed.ts` | Seeds the global row (`id: 1`, both scope cols NULL). |

## Copy semantics

`copyAgentConfig(from, to)` clones the source scope's **entire** row —
including secret columns — into the target scope (update if it exists, else
insert with the target's scope columns). Secrets are stored AES-256-GCM under
the install's `ENCRYPTION_KEY`, so ciphertext copies verbatim and decrypts
identically: same-install copy keeps credentials. Selecting a scope never
creates a row; only save/copy does.

## Residuals

- `channel_accounts.agent_config_id` is honored at resolve time as a secondary
  account binding, but no UI sets it yet (account onboarding, S16).
- `sendOutboundMessage` telegram branch keeps install-global bot creds (single
  internal bot by design).
- Deleting a `channel_accounts` row now cascades its scoped config row
  (`ON DELETE CASCADE`, migration `0016`); the old `SET NULL` could collide
  with the channel-scope partial unique index. Runtime scope consumption and
  fail-closed resolution are documented in `security-remediation.md`.
