export type Channel =
  | "whatsapp"
  | "telegram"
  | "instagram"
  | "facebook"
  | "sms"
  | "reddit"
  | "linkedin"
  | "tiktok"
  | "youtube"
  | "threads"
  | "pinterest"
  | "discord"
  | "slack";

export type MessageRole = "user" | "assistant" | "system" | "human";

export type MediaType = "image" | "audio" | "video" | "document";

export interface MediaAttachment {
  type: MediaType;
  url: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  caption?: string;
  transcription?: string;
  description?: string;
}

export interface ChatMessage {
  id: number;
  conversationId: number;
  role: MessageRole;
  content: string;
  contentAttributes?: MediaAttachment[];
  createdAt: string;
}

export interface ConversationSummary {
  id: number;
  channel: Channel;
  customerName: string | null;
  customerPhone: string;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  status: "active" | "closed" | "archived";
  messageCount?: number;
  humanOverrideUntil?: string | null;
}

export type ConversationFilter = "all" | "sellers" | "active" | "closed";

// ─── Customer Profile (para context panel) ───────────────────────────────

export interface CustomerProfile {
  id: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  status: "new" | "contacted" | "converted" | "lost";
  tags: string[];
  notes: string | null;
  platform: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  adId: string | null;
  campaignId: string | null;
  conversationId: number | null;
  createdAt: string;
}

export interface OrderSummary {
  id: number;
  orderType: string | null;
  status: string;
  total: string | null;
  createdAt: string;
}

