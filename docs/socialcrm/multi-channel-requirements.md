# Multi-Channel Product Requirements

Status: canonical requirements (owner-directed). Source of truth for what the
messaging engine must become. Execution sequencing lives in
`execution-control.md`; provider contract details in
`provider-integration-evidence.md` §4.

## Product intent (owner, 2026-10-19)

Everything that today hard-wires YCloud must become provider-agnostic:

1. **Provider parity**: whichever provider is connected is used EVERYWHERE —
   sends, ingestion, handoff, operator replies, broadcasts, follow-ups. If the
   business connects YCloud, all WhatsApp traffic runs on YCloud; if Zernio, on
   Zernio. No provider-specific code outside `src/lib/messaging/providers/*`.
2. **Multiple accounts, one per provider**: the business can connect several
   numbers/accounts — e.g. one WhatsApp number via Meta Embedded Signup, one via
   YCloud, one via Kapso, plus Zernio social accounts. Every send/receive must
   know WHICH account it belongs to.
3. **Channel/number-aware UI**: the conversations/chats admin page filters by
   channel AND by connected number/account.
4. **Passive universal ingestion**: every inbound event on every connected
   channel is persisted — messages, statuses, echoes, comments. Nothing is
   dropped silently.
5. **Human handoff works on all channels**: operator takeover, manual replies
   sent as the operator, response formatting — identical semantics regardless
   of provider.
6. **Per-channel/per-account agent configuration**: a selector binds an agent
   configuration to a channel or a specific number. Configurations can be
   copied across channels/numbers (template + replicate).
7. **Channel universe**: whatsapp, instagram, facebook, telegram, sms, reddit,
   and whatever else the connected providers expose (Zernio alone covers 16
   platforms). `comment`/`messenger` remain event kinds, not channels.

## Mapping to architecture

| Requirement | Mechanism | Gap today |
|---|---|---|
| Provider parity | `messenger.send()` + `provider.parseWebhook()` + shared pipeline | S5 finishes inbound extraction; DONE outbound |
| Multiple accounts | **`channel_accounts` table** (deferred B3 — now promoted to required): id, provider, channel, providerAccountId, senderAddress, credentials ref, agentBinding, status | table doesn't exist; `messenger.send` already accepts `account`/`credentials` overrides |
| Distinguish numbers in send/receive | `ChannelAccount.id` stamped on `conversations.channelAccountId` + `messages.channelAccountId` | conversations has `channel` but no account FK |
| UI filter by number/channel | `/admin/conversations` filter chips: channel + account | UI filters by channel only (enum `whatsapp\|telegram`) |
| Passive universal ingestion | unified ingress `/api/webhooks/ingress/[provider]` → verify→parse→persist ALL events incl. statuses/echoes/comments | today only `/api/whatsapp/webhook`; statuses partially handled; other channels have no ingress |
| Handoff cross-channel | `resolveHandoffTransport` → account-aware transport via `messenger.send` | handoff is WhatsApp/YCloud-specific |
| Per-channel agent config | `agent_config` gains scope: `channelAccountId` or `channel` column; resolution order account→channel→global default | `agent_config` is one global row |
| Config replication | admin action "copy config to channel/account" | n/a |
| Identities without phone | `leads`/`conversations` gain `externalUserId`-style keys; `conversations.whatsappId` relaxed (notNull→nullable, uniqueness on (channel, externalId)) | `whatsappId notNull unique`, `leads.phone notNull unique` |
| Channel enum | `channelEnum` extends to instagram/facebook/sms/reddit (+Zernio list) + `ChannelKind` type synced | enum is `whatsapp\|telegram` |
| Meta Embedded Signup | onboarding flow: connect Meta account via embedded signup (Kapso provides this; direct Meta embedded signup is the alternative) | no onboarding flow exists |

## New slices (added to execution-control §4)

| ID | Slice | Depends on |
|---|---|---|
| S11 | Schema: `channel_accounts` table, `conversations.channelAccountId`, relaxed `whatsappId`/phone nullability, `channelEnum` extension | S5 |
| S12 | Unified ingress `/api/webhooks/ingress/[provider]` + passive persistence for all event kinds | S5, S11 |
| S13 | Per-channel/per-account agent config binding + admin selector + copy-config action | S11 |
| S14 | Conversations admin: channel + number/account filters | S11 |
| S15 | Handoff/operator transport generalized through `messenger.send` | S4 done; S11 |
| S16 | Provider connection onboarding (embedded signup Meta/Kapso; manual YCloud/Zernio key entry) | S11, provider creds |
| B5 | ZernioAdapter (instagram/facebook/reddit/…) | **Zernio account + API key (external)** |
| B6 | Kapso spike (WhatsApp alt + embedded signup) | **Kapso test project (external)** |

## Non-negotiables (unchanged)

- Backward compat: existing `/api/whatsapp/webhook` URL keeps working; YCloud
  stays the WhatsApp provider until a second provider is actually connected.
- Additive migrations only; no destructive schema edits on existing data.
- Telegram internal bot stays outside the provider model.
- No multitenancy/SaaS billing — `tenantId` stays `"default"`.
- Fail-closed: unregistered channel/provider → error, never silent drop.
