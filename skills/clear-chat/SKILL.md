---
name: clear-chat
description: "Trigger: \"vacia mi chat\", \"clear my chat\", \"empty my chat\", \"borra mis mensajes\", \"limpia mi chat\". Delete all messages from the user's WhatsApp conversation in muzapp while keeping the conversation record intact."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

# Skill: clear-chat

## Activation Contract

Use this skill when the user asks to clear/empty/delete their WhatsApp chat messages but keep the conversation itself. The user's phone number is the key to finding the right conversation.

## Hard Rules

- NEVER delete the conversation row — only messages, attachments, and nullify `leads.conversationId`
- NEVER expose the DATABASE_URL in output
- The phone number format is Argentine: `5493704123456` (without `+` prefix)
- The user's phone is stored in memory. If you don't have it, ask: "¿cuál es tu número de WhatsApp?"
- Always use the project's DB via `@/db` and Drizzle ORM — never raw SQL
- Clean up any temp scripts after execution

## Execution Steps

1. **Confirm intent**: If the user says "vacia mi chat", confirm: "¿vacío todos los mensajes pero dejo la conversación?" before executing.

2. **Get phone number**: Check if you already know it from the session/memory. If not, ask the user.

3. **Find conversation**:
   ```
   const convs = await db
     .select({ id, customerName, customerPhone, whatsappId })
     .from(conversations)
     .where(or(
       like(conversations.customerPhone, "%{lastDigits}"),
       like(conversations.whatsappId, "%{lastDigits}")
     ));
   ```

4. **Execute deletion in order** (FK constraint chain):
   a. Delete attachments for the conversation
   b. Nullify `leads.conversationId` for leads pointing to this conversation
   c. Delete all `chatMessages` for this conversation

5. **Report**: Show count of deleted messages, attachments, and confirm the conversation is intact.

## Script Template

Write a temp script at `scripts/clear-chat.ts` with this structure:

```typescript
import { db } from "@/db";
import { chatMessages, attachments, leads } from "@/db/schema";
import { eq } from "drizzle-orm";

const CONVERSATION_ID = <id>;

async function main() {
  const deletedAtts = await db.delete(attachments)
    .where(eq(attachments.conversationId, CONVERSATION_ID))
    .returning({ id: attachments.id });

  const updatedLeads = await db.update(leads)
    .set({ conversationId: null })
    .where(eq(leads.conversationId, CONVERSATION_ID))
    .returning({ id: leads.id });

  const deletedMsgs = await db.delete(chatMessages)
    .where(eq(chatMessages.conversationId, CONVERSATION_ID))
    .returning({ id: chatMessages.id });

  console.log(`Attachments: ${deletedAtts.length}, Leads: ${updatedLeads.length}, Messages: ${deletedMsgs.length}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
```

Run with: `$env:DATABASE_URL="<url from .env>"; npx tsx scripts/clear-chat.ts`

## Known Phone Numbers

- None hardcoded — always ask the operator for their number or pull it from session memory. Never commit personal numbers to this file.

## References

- `src/db/schema.ts` — `chatMessages`, `attachments`, `leads`, `conversations` table schemas
- `.env` — `DATABASE_URL` for the Neon PostgreSQL connection
