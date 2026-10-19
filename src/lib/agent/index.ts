import { generateText, stepCountIs } from "ai";
import { getFastModel } from "@/lib/ai/config";
import { getBusinessInfo } from "@/lib/business";
import type { ModelMessage } from "ai";
import { db } from "@/db";
import { products } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { buildSystemPrompt } from "./system-prompt";
import { makeCaptureOrder, checkHours, getMenu, checkDelivery } from "./tools";
import { resolveAgentConfig } from "@/lib/agent-config-scope";

const FALLBACK_MESSAGE =
  "Disculpá, hubo un problema de mi lado. Escribinos directamente y te atendemos a la brevedad 🙏";

export interface ProcessMessageOptions {
  phoneNumber: string;
  text: string;
  conversationHistory: ModelMessage[];
}

// Legacy agent path: its signature (phone + text) carries no channel/account
// context, so it resolves the global scope — the both-null row, identical to
// the pre-S13 `limit(1)` first row.
async function loadConfig() {
  try {
    return (await resolveAgentConfig({})) ?? null;
  } catch {
    return null;
  }
}

async function loadMenuItems() {
  try {
    return await db
      .select({
        name: products.name,
        description: products.description,
        price: products.price,
        category: products.category,
        available: products.available,
      })
      .from(products)
      .where(and(eq(products.available, true)))
      .orderBy(products.sortOrder);
  } catch {
    return [];
  }
}

export async function processMessage({
  phoneNumber,
  text,
  conversationHistory,
}: ProcessMessageOptions): Promise<string> {
  try {
    const [config, menuItems] = await Promise.all([
      loadConfig(),
      loadMenuItems(),
    ]);

    const biz = await getBusinessInfo();
    const systemPrompt = buildSystemPrompt(
      biz.name,
      menuItems,
      config?.systemPrompt
    );

    const messages: ModelMessage[] = [
      ...conversationHistory,
      { role: "user", content: text },
    ];

    const result = await generateText({
      model: await getFastModel(),
      system: systemPrompt,
      messages,
      tools: {
        captureOrder: makeCaptureOrder(phoneNumber),
        checkHours,
        getMenu,
        checkDelivery,
      },
      stopWhen: stepCountIs(3),
    });

    return result.text || FALLBACK_MESSAGE;
  } catch (error) {
    console.error("[agent] Error processing message:", error);
    return FALLBACK_MESSAGE;
  }
}
