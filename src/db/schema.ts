import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  serial,
  text,
  varchar,
  numeric,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";


// ─── Enums ────────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", ["admin", "viewer"]);

export const productCategoryEnum = pgEnum("product_category", [
  "hamburguesa",
  "acompanamiento",
  "pan_mayorista",
  "tragos_vip",
  "bebidas",
  "alcohol",
  "empanadas",
  "pizzas",
]);

export const conversationStatusEnum = pgEnum("conversation_status", [
  "active",
  "closed",
  "archived",
]);

export const leadStatusEnum = pgEnum("lead_status", [
  "new",
  "contacted",
  "converted",
  "lost",
]);

export const clientTypeEnum = pgEnum("client_type", ["b2c", "b2b"]);

export const channelEnum = pgEnum("channel", [
  "whatsapp",
  "telegram",
  "instagram",
  "facebook",
  "sms",
  "reddit",
]);
export const messageRoleEnum = pgEnum("message_role", ["user", "assistant", "system", "human"]);
export const sessionModeEnum = pgEnum("conversation_session_mode", ["commercial", "personal_acknowledged", "handed_off"]);
export const sessionIntentEnum = pgEnum("conversation_session_intent", ["catalog", "order", "delivery", "support", "other"]);
export const sessionQuestionEnum = pgEnum("conversation_session_question", ["unit_or_dozen", "delivery_time", "address", "payment", "other"]);
export const sessionAssetKindEnum = pgEnum("conversation_session_asset_kind", ["image", "audio", "document", "video"]);
export const sessionEventTypeEnum = pgEnum("conversation_session_event_type", ["commercial_detected", "personal_acknowledged", "ambiguous_clarified", "handoff_requested"]);
export const sessionSignalEnum = pgEnum("conversation_session_signal", ["commercial", "personal", "ambiguous"]);
export const sessionEffectKindEnum = pgEnum("conversation_session_effect_kind", ["human_override", "owner_notification", "customer_reply"]);

// ─── Tables ───────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  hashedPassword: text("hashed_password").notNull(),
  name: varchar("name", { length: 255 }),
  role: userRoleEnum("role").notNull().default("viewer"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  price: numeric("price", { precision: 10, scale: 2 }),
  imageUrl: text("image_url"),
  category: productCategoryEnum("category").notNull(),
  available: boolean("available").notNull().default(true),
  comingSoon: boolean("coming_soon").notNull().default(false),
  stock: integer("stock"),
  sortOrder: integer("sort_order").notNull().default(0),
  isPromo: boolean("is_promo").notNull().default(false),
  promoPrice: numeric("promo_price", { precision: 10, scale: 2 }),
  variants: jsonb("variants").$type<{
    name: string;
    priceDelta: number;
    default?: boolean;
  }[]>().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const agentConfig = pgTable("agent_config", {
  id: serial("id").primaryKey(),
  systemPrompt: text("system_prompt"),
  phoneNumber: varchar("phone_number", { length: 50 }),
  ycloudApiKey: text("ycloud_api_key"),
  enabled: boolean("enabled").notNull().default(false),
  businessHours: jsonb("business_hours"),
  // ─── Nuevos campos Agente Interno ──────────────────────────────────────────
  whatsappBotNumber: varchar("whatsapp_bot_number", { length: 50 }),
  allowedPhoneIds: jsonb("allowed_phone_ids").$type<{ name: string; phone: string }[]>().default([]),
  sellerPhoneIds: jsonb("seller_phone_ids").$type<{ name: string; phone: string }[]>().default([]),
  autoReply24h: boolean("auto_reply_24h").notNull().default(false),
  autoReply24hMessage: text("auto_reply_24h_message"),
  // Optional first-contact message that routes customers to the public ordering flow.
  webOrderRedirectEnabled: boolean("web_order_redirect_enabled").notNull().default(false),
  webOrderRedirectMessage: text("web_order_redirect_message"),
  trainBotContext: text("train_bot_context"),
  // ─── Telegram Bot (CRUD) ────────────────────────────────────────────────
  telegramBotToken: text("telegram_bot_token"), // encrypted
  telegramChatId: varchar("telegram_chat_id", { length: 50 }),
  telegramWebhookToken: varchar("telegram_webhook_token", { length: 100 }),
  telegramEnabled: boolean("telegram_enabled").notNull().default(false),
  // ─── WhatsApp Agent (Editable desde UI) ────────────────────────
  whatsappSystemPrompt: text("whatsapp_system_prompt"),
  whatsappStyleProfile: text("whatsapp_style_profile"),
  whatsappInstructions: text("whatsapp_instructions"),
  whatsappPromociones: text("whatsapp_promociones"),
  productionHours: text("production_hours"),
  deliveryEnabled: boolean("delivery_enabled").notNull().default(true),
  deliveryStartHour: varchar("delivery_start_hour", { length: 5 }),
  b2cStartHour: varchar("b2c_start_hour", { length: 5 }).default("20:00"),
  whatsappZonasDelivery: jsonb("whatsapp_zonas_delivery").$type<{
    zona: string;
    disponible: boolean;
    tiempo: string;
    costo: number;
  }[]>().default([
    { zona: "centro", disponible: true, tiempo: "20-30 min", costo: 0 },
    { zona: "norte", disponible: true, tiempo: "25-35 min", costo: 0 },
    { zona: "sur", disponible: true, tiempo: "30-40 min", costo: 0 },
  ]),
  // ───────────────────────────────────────────────────────────────────────────
  // ─── Identidad anti-bot / System Status ───────────────────────────────────
  isCooking: boolean("is_cooking").notNull().default(true),
  hamburguesasSinStock: boolean("hamburguesas_sin_stock").notNull().default(false),
  stockPanDocenas: integer("stock_pan_docenas").default(0),
  aliasB2c: varchar("alias_b2c", { length: 100 }),
  aliasB2b: varchar("alias_b2b", { length: 100 }),
  tiempoEspera: varchar("tiempo_espera", { length: 50 }),
  menuImageUrlHamburguesas: text("menu_image_url_hamburguesas"),
  menuImageUrlPan: text("menu_image_url_pan"),
  menuImageUrlsHamburguesas: jsonb("menu_image_urls_hamburguesas").$type<string[]>().default([]),
  menuImageUrlsPan: jsonb("menu_image_urls_pan").$type<string[]>().default([]),
  // ───────────────────────────────────────────────────────────────────────────
  // ─── Delivery ────────────────────────────────────────────────────────────
  deliveryPhoneNumber: varchar("delivery_phone_number", { length: 50 }),
  // ───────────────────────────────────────────────────────────────────────────
  // ─── Meta Business OAuth ───────────────────────────────────────────────────
  metaAccessToken: text("meta_access_token"),
  metaTokenExpiresAt: timestamp("meta_token_expires_at", { withTimezone: true }),
  metaBusinessName: varchar("meta_business_name", { length: 255 }),
  metaPhoneNumberId: varchar("meta_phone_number_id", { length: 50 }),
  metaConnected: boolean("meta_connected").notNull().default(false),
  // ───────────────────────────────────────────────────────────────────────────
  // ─── Business Identity (agnostic storefront — editable desde admin) ────────
  businessName: varchar("business_name", { length: 160 }),
  businessTagline: varchar("business_tagline", { length: 255 }),
  businessAddress: varchar("business_address", { length: 255 }),
  businessPhoneDisplay: varchar("business_phone_display", { length: 50 }),
  instagramHandle: varchar("instagram_handle", { length: 100 }),
  businessWebsite: text("business_website"),
  businessDescription: text("business_description"),
  // ─── AI Provider (OpenAI-compatible — editable desde admin) ────────────────
  aiApiKey: text("ai_api_key"),
  aiBaseUrl: text("ai_base_url"),
  aiModel: varchar("ai_model", { length: 120 }),
  aiModelFast: varchar("ai_model_fast", { length: 120 }),
  aiModelVision: varchar("ai_model_vision", { length: 120 }),
  // ─── Integration secrets (editable desde admin, write-only en UI) ──────────
  ycloudWebhookSecret: text("ycloud_webhook_secret"),
  cloudinaryCloudName: varchar("cloudinary_cloud_name", { length: 120 }),
  cloudinaryApiKey: varchar("cloudinary_api_key", { length: 120 }),
  cloudinaryApiSecret: text("cloudinary_api_secret"),
  metaAppId: varchar("meta_app_id", { length: 80 }),
  metaAppSecret: text("meta_app_secret"),
  metaWebhookVerifyToken: varchar("meta_webhook_verify_token", { length: 200 }),
  telegramNotifyChatId: varchar("telegram_notify_chat_id", { length: 50 }),
  cronSecret: varchar("cron_secret", { length: 200 }),
  escalationEmail: varchar("escalation_email", { length: 200 }),
  // ─── Scope (S13) ───────────────────────────────────────────────────────────
  // Both null = the global default row — identical semantics to the pre-S13
  // single row. channel set + channelAccountId null = channel-scoped row.
  // channelAccountId set = per-account row (channel kept informative).
  channel: channelEnum("channel"),
  // AnyPgColumn breaks the agentConfig ↔ channelAccounts circular FK.
  // Account deletion cascades its scoped config row. `SET NULL` was unsafe:
  // clearing the account while keeping `channel` could collide with the
  // channel-scope partial unique index.
  channelAccountId: integer("channel_account_id").references(
    (): AnyPgColumn => channelAccounts.id,
    { onDelete: "cascade" }
  ),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  channelAccountUq: uniqueIndex("agent_config_channel_account_uq")
    .on(table.channelAccountId)
    .where(sql`channel_account_id is not null`),
  channelScopeUq: uniqueIndex("agent_config_channel_scope_uq")
    .on(table.channel)
    .where(sql`channel is not null and channel_account_id is null`),
}));

// ─── Channel Accounts (one row per connected provider account/number) ────────
// Multi-provider support: each row is a concrete sender (WhatsApp number via
// YCloud/Kapso, social account via Zernio). `credentialsRef` stores WHERE the
// secrets live (`env:YCLOUD_*`, `agent_config`, future vault ref) — never the
// secret itself. `tenantId` stays the constant "default" (single install).

export const channelAccounts = pgTable("channel_accounts", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull().default("default"),
  provider: text("provider").notNull(), // ycloud | zernio | kapso
  channel: channelEnum("channel").notNull(),
  // Provider's own id for the account: ycloud E.164 sender · zernio accountId · kapso phoneNumberId
  providerAccountId: text("provider_account_id").notNull(),
  // E.164 number, @handle, or page id — the surface customers see
  senderAddress: text("sender_address").notNull(),
  displayName: text("display_name"),
  credentialsRef: text("credentials_ref"),
  agentConfigId: integer("agent_config_id").references(() => agentConfig.id),
  status: text("status").notNull().default("active"), // active | disconnected | error
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  providerAccountUq: uniqueIndex("channel_accounts_provider_account_uq").on(table.provider, table.providerAccountId),
}));

// Durable, idempotent provider events that have no conversation/message row
// (status transitions, account lifecycle, other normalized envelopes). Kept
// minimal: the raw envelope stays in `payload` for audit/replay.
export const channelEvents = pgTable("channel_events", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull().default("default"),
  provider: text("provider").notNull(),
  channel: channelEnum("channel"),
  channelAccountId: integer("channel_account_id").references(
    () => channelAccounts.id,
    { onDelete: "set null" }
  ),
  providerAccountId: text("provider_account_id"),
  deliveryId: text("delivery_id").notNull(),
  platformMessageId: text("platform_message_id"),
  kind: text("kind").notNull(),
  direction: text("direction").notNull(),
  status: text("status"),
  eventTimestamp: timestamp("event_timestamp", { withTimezone: true }),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  providerDeliveryUq: uniqueIndex("channel_events_provider_delivery_uq").on(
    table.provider,
    table.deliveryId
  ),
  providerPlatformUq: uniqueIndex("channel_events_provider_platform_uq")
    .on(table.provider, table.platformMessageId, table.kind, table.status)
    .where(
      sql`platform_message_id is not null and status is not null`
    ),
  accountLookupIdx: index("channel_events_account_created_idx").on(
    table.channelAccountId,
    table.createdAt
  ),
  platformLookupIdx: index("channel_events_provider_platform_idx").on(
    table.provider,
    table.platformMessageId
  ),
}));

export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  // Nullable since multi-channel (S11): social identities have no whatsappId.
  // The legacy UNIQUE constraint stays — Postgres allows multiple NULLs, so
  // non-null dedup is preserved; identity-level uniqueness now also lives on
  // account-aware partial unique indexes below.
  // Account-scoped rows leave whatsapp_id NULL; the legacy UNIQUE constraint
  // only guards null-account (legacy) rows.
  whatsappId: varchar("whatsapp_id", { length: 255 }).unique(),
  channelAccountId: integer("channel_account_id").references(() => channelAccounts.id),
  externalThreadId: text("external_thread_id"), // provider thread/conversation id
  customerName: varchar("customer_name", { length: 255 }),
  customerPhone: varchar("customer_phone", { length: 50 }),
  messages: jsonb("messages").$type<Record<string, unknown>[]>().default([]),
  status: conversationStatusEnum("status").notNull().default("active"),
  channel: channelEnum("channel").notNull().default("whatsapp"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  lastMessagePreview: varchar("last_message_preview", { length: 255 }),
  humanOverrideUntil: timestamp("human_override_until", { withTimezone: true }),
  lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
  externalUserId: varchar("external_user_id", { length: 255 }),
  // Canonical, channel-aware identity key. Phone-shaped channels store digits
  // only; social channels store the provider identifier verbatim. Uniqueness
  // is account-scoped below: (channel, account, key) for bound rows and
  // (channel, key) for legacy null-account rows.
  externalUserIdNormalized: varchar("external_user_id_normalized", { length: 255 }),
  conversationMetadata: jsonb("conversation_metadata").$type<{
    repromptCount: number;
    lastUserMessageType: "order" | "greeting" | "menu" | "info" | "complaint" | "other";
    lastSuggestedProducts: string[];
    lastTools: string[];
    // Same/new order clarification asked during the 4h active-order window.
    keepActiveConfirmation?: { activeOrderId: number; askedAt: string };
  }>().default({ repromptCount: 0, lastUserMessageType: "other", lastSuggestedProducts: [], lastTools: [] }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  // Account-scoped identity: the same customer on two provisioned numbers is
  // two conversations, never one shared or rebound row.
  channelAccountExternalUq: uniqueIndex("conversations_channel_account_external_uq")
    .on(table.channel, table.channelAccountId, table.externalUserIdNormalized)
    .where(sql`external_user_id_normalized is not null and channel_account_id is not null`),
  // Legacy null-account identity keeps the pre-S11 dedup semantics.
  channelLegacyExternalUq: uniqueIndex("conversations_channel_legacy_external_uq")
    .on(table.channel, table.externalUserIdNormalized)
    .where(sql`external_user_id_normalized is not null and channel_account_id is null`),
  channelIdentityLookupIdx: index("conversations_channel_identity_idx")
    .on(table.channel, table.externalUserIdNormalized),
}));

// Durable boundary state only: business entities remain authoritative in their own tables.
export const conversationSessionStates = pgTable("conversation_session_states", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  version: integer("version").notNull().default(0),
  policyVersion: integer("policy_version").notNull().default(1),
  episode: integer("episode").notNull().default(0),
  mode: sessionModeEnum("mode").notNull().default("commercial"),
  ackSent: boolean("ack_sent").notNull().default(false),
  clarificationSent: boolean("clarification_sent").notNull().default(false),
  commercialIntent: sessionIntentEnum("commercial_intent"),
  pendingQuestion: sessionQuestionEnum("pending_question"),
  recentAssetKinds: sessionAssetKindEnum("recent_asset_kinds").array().notNull().default([]),
  activeOrderId: integer("active_order_id").references(() => orders.id),
  hasActiveCart: boolean("has_active_cart").notNull().default(false),
  hasAddressReference: boolean("has_address_reference").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  conversationUnique: unique("conversation_session_states_conversation_unique").on(table.conversationId),
  versionIndex: index("conversation_session_states_conversation_version_idx").on(table.conversationId, table.version),
}));

export const conversationSessionEvents = pgTable("conversation_session_events", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  episode: integer("episode").notNull(),
  stateVersion: integer("state_version").notNull(),
  policyVersion: integer("policy_version").notNull(),
  eventType: sessionEventTypeEnum("event_type").notNull(),
  signal: sessionSignalEnum("signal").notNull(),
  inboundMessageId: varchar("inbound_message_id", { length: 255 }).notNull(),
  inboundHash: varchar("inbound_hash", { length: 128 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  inboundTransitionUnique: unique("conversation_session_events_inbound_unique").on(table.conversationId, table.inboundMessageId),
  auditIndex: index("conversation_session_events_conversation_created_idx").on(table.conversationId, table.createdAt),
}));

export const conversationSessionEffectClaims = pgTable("conversation_session_effect_claims", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  episode: integer("episode").notNull(),
  effectKind: sessionEffectKindEnum("effect_kind").notNull(),
  inboundMessageId: varchar("inbound_message_id", { length: 255 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  effectUnique: unique("conversation_session_effect_claims_episode_effect_unique").on(table.conversationId, table.episode, table.effectKind),
  inboundEffectUnique: unique("conversation_session_effect_claims_inbound_effect_unique").on(table.conversationId, table.inboundMessageId, table.effectKind),
}));

export const chatMessages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  role: messageRoleEnum("role").notNull(),
  content: text("content").notNull(),
  contentAttributes: jsonb("content_attributes").$type<{
    type: "image" | "audio" | "document" | "video";
    url: string;
    fileName?: string;
    fileSize?: number;
    mimeType?: string;
    caption?: string;
    transcription?: string;
    description?: string;
  }[]>().default([]),
  platformMessageId: varchar("platform_message_id", { length: 255 }),
  channelAccountId: integer("channel_account_id").references(() => channelAccounts.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  platformMsgUq: uniqueIndex("idx_chat_messages_platform_id").on(table.platformMessageId),
}));

export const leads = pgTable("leads", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }),
  // Nullable since S11: social identities may have no phone. UNIQUE stays —
  // Postgres allows multiple NULLs, so legacy phone dedup is preserved.
  phone: varchar("phone", { length: 50 }).unique(),
  channel: channelEnum("channel"), // set when the lead is channel-identified
  externalUserId: text("external_user_id"), // provider-native user id (BSUID, social id)
  channelAccountId: integer("channel_account_id").references(() => channelAccounts.id),
  email: varchar("email", { length: 255 }),
  address: text("address"),
  firstMessage: text("first_message"),
  refCode: varchar("ref_code", { length: 255 }),
  utmSource: varchar("utm_source", { length: 255 }),
  utmMedium: varchar("utm_medium", { length: 255 }),
  utmCampaign: varchar("utm_campaign", { length: 255 }),
  utmContent: varchar("utm_content", { length: 255 }),
  adId: varchar("ad_id", { length: 255 }),
  campaignId: varchar("campaign_id", { length: 255 }),
  adsetId: varchar("adset_id", { length: 255 }),
  platform: varchar("platform", { length: 100 }),
  notes: text("notes"),
  alias: varchar("alias", { length: 255 }),
  status: leadStatusEnum("status").notNull().default("new"),
  type: varchar("type", { length: 10 }),
  conversationId: integer("conversation_id").references(() => conversations.id),
  tags: jsonb("tags").$type<string[]>().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  channelExternalUserUq: uniqueIndex("leads_channel_external_user_uq")
    .on(table.channel, table.externalUserId)
    .where(sql`external_user_id is not null`),
}));

export const attachments = pgTable("attachments", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").references(() => leads.id),
  conversationId: integer("conversation_id").references(() => conversations.id),
  messageId: integer("message_id").references(() => chatMessages.id),
  type: varchar("type", { length: 20 }).notNull(),
  url: varchar("url", { length: 500 }).notNull(),
  fileName: varchar("file_name", { length: 255 }),
  mimeType: varchar("mime_type", { length: 100 }),
  fileSize: integer("file_size"),
  caption: varchar("caption", { length: 500 }),
  description: text("description"),
  documentType: varchar("document_type", { length: 50 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Orders / Kitchen ──────────────────────────────────────────────────────────

export const orderTypeEnum = pgEnum("order_type", [
  "hamburguesas",
  "pan_mayorista",
]);

export const orderStatusEnum = pgEnum("order_status", [
  "pending",
  "preparing",
  "ready",
  "delivered",
  "cancelled",
]);

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").references(() => leads.id),
  phoneNumber: text("phone_number").notNull(),
  customerName: text("customer_name"),
  address: text("address"),
  orderType: orderTypeEnum("order_type"),
  items: jsonb("items").notNull(),
  notes: text("notes"),
  tags: jsonb("tags").$type<string[]>().default([]),
  status: orderStatusEnum("status").notNull().default("pending"),
  deliveryFee: numeric("delivery_fee", { precision: 10, scale: 2 }).default("0"),
  paymentStatus: text("payment_status").default("pending"),
  paymentMethod: text("payment_method"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  followupSent: boolean("followup_sent").notNull().default(false),
});

// ─── Order Context (items temporales del pedido actual) ─────────────────────────

export const orderContextEnum = pgEnum("order_context_status", ["active", "ordered"]);

export const orderContextItems = pgTable("order_context_items", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  phone: text("phone").notNull(),
  productName: text("product_name").notNull(),
  productPrice: numeric("product_price", { precision: 10, scale: 2 }),
  quantity: integer("quantity").notNull().default(1),
  variant: text("variant"),
  notes: text("notes"),
  status: orderContextEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// ─── Addresses (ubicaciones guardadas de clientes) ──────────────────────────────

export const addresses = pgTable("addresses", {
  id: serial("id").primaryKey(),
  phone: text("phone").notNull(),
  address: text("address").notNull(),
  latitude: text("latitude"),
  longitude: text("longitude"),
  mapsLink: text("maps_link"),
  label: text("label"), // "Casa", "Trabajo", etc — lo puede poner el agente
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Agent Memory (reglas/hechos persistentes del agente interno) ─────────────
// Memoria durable estilo Hermes: cuando el dueño dice "dejalo como regla" o el
// reconciler aprende un mapeo, queda acá y se inyecta al system prompt.

export const agentMemories = pgTable("agent_memories", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 120 }).notNull(),
  type: varchar("type", { length: 30 }).notNull().default("rule"), // rule | fact | preference
  content: text("content").notNull(),
  source: varchar("source", { length: 30 }).notNull().default("admin"), // admin | reconcile | system
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  keyUq: uniqueIndex("idx_agent_memories_key").on(table.key),
}));

// ─── Reconcile (ventas detectadas en chats que no quedaron cargadas) ──────────

export const reconcileStatusEnum = pgEnum("reconcile_status", [
  "detected",
  "needs_info",
  "loaded",
  "dismissed",
]);

export const reconcileCandidates = pgTable("reconcile_candidates", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").references(() => conversations.id),
  kind: varchar("kind", { length: 30 }).notNull().default("order"), // order | product | info
  summary: text("summary").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
  status: reconcileStatusEnum("status").notNull().default("detected"),
  orderId: integer("order_id").references(() => orders.id),
  adminNote: text("admin_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (table) => ({
  convCreatedIdx: index("idx_reconcile_candidates_conv").on(table.conversationId, table.createdAt),
  statusIdx: index("idx_reconcile_candidates_status").on(table.status),
}));

export const reconcileRuns = pgTable("reconcile_runs", {
  id: serial("id").primaryKey(),
  mode: varchar("mode", { length: 20 }).notNull().default("scan"), // scan | sweep
  conversationsScanned: integer("conversations_scanned").notNull().default(0),
  ordersCreated: integer("orders_created").notNull().default(0),
  candidatesCreated: integer("candidates_created").notNull().default(0),
  report: text("report"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

// ─── Cash Sessions (cierre de caja — efectivo físico) ────────────────────────
// Invariante contable: las sesiones forman una cadena continua — cada sesión
// abre donde cerró la anterior (auto-apertura backdateada), así ningún pedido
// queda fuera de ninguna ventana ni en dos a la vez. Una sesión cerrada es
// inmutable: queda como asiento de auditoría.

export const cashSessionStatusEnum = pgEnum("cash_session_status", ["open", "closed"]);

export const cashSessions = pgTable("cash_sessions", {
  id: serial("id").primaryKey(),
  status: cashSessionStatusEnum("status").notNull().default("open"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  openingCash: numeric("opening_cash", { precision: 12, scale: 2 }).notNull().default("0"),
  expectedCash: numeric("expected_cash", { precision: 12, scale: 2 }),
  actualCash: numeric("actual_cash", { precision: 12, scale: 2 }),
  difference: numeric("difference", { precision: 12, scale: 2 }),
  closedBy: varchar("closed_by", { length: 100 }),
  report: jsonb("report"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cashMovements = pgTable("cash_movements", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => cashSessions.id),
  direction: varchar("direction", { length: 10 }).notNull(), // 'in' | 'out'
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  reason: text("reason").notNull(),
  createdBy: varchar("created_by", { length: 100 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sessionIdx: index("idx_cash_movements_session").on(table.sessionId, table.createdAt),
}));

// ─── Promotions (promociones con productos reales) ──────────────────────────

export const promotions = pgTable("promotions", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  items: jsonb("items").$type<{ productId: number; productName: string; quantity: number }[]>().default([]),
  customPrice: numeric("custom_price", { precision: 10, scale: 2 }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
