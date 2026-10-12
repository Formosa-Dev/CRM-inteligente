// ─── Reconcile Runner ─────────────────────────────────────────────────────────
// Deep pass con LLM sobre las conversaciones que marcó el scan barato.
// Corre desatendido por cron: detecta ventas cerradas en chats, las carga como
// pedidos entregados, deja candidatas cuando falta un dato, y reporta todo por
// Telegram. Nunca pide permiso ni habla con clientes.

import { generateText, stepCountIs } from "ai";
import { eq, and, gt, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { reconcileRuns } from "@/db/schema";
import { getMainChatModel } from "@/lib/ai/config";
import { getBusinessInfo } from "@/lib/business";
import {
  findConversationsNeedingReconcile,
  fetchTranscript,
  markConversationReconciled,
  type ReconcileTarget,
  type TranscriptEntry,
} from "./scan";
import { RECONCILE_SYSTEM_PROMPT } from "./prompt";
import { reconcileTools } from "./tools";

export type ReconcileMode = "scan" | "sweep";

type ConvOutcome = {
  conversationId: number;
  label: string;
  resultado: string;
  orderIds: number[];
  candidateIds: number[];
  note: string;
};

const ROLE_LABEL: Record<string, string> = {
  user: "CLIENTE",
  human: "DUEÑO",
  assistant: "BOT",
  system: "SISTEMA",
};

function formatTranscript(entries: TranscriptEntry[]): string {
  return entries
    .map((e) => {
      const d = e.at;
      const stamp = `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
      return `[${stamp}] ${ROLE_LABEL[e.role] ?? e.role.toUpperCase()}: ${e.content.slice(0, 400)}`;
    })
    .join("\n");
}

function parseResultadoTail(text: string): { resultado: string; note: string } {
  const match = text.match(/RESULTADO:\s*(\w+)[\s\S]*?NOTA:\s*(.+)$/i);
  if (!match) return { resultado: "desconocido", note: text.slice(-160) };
  return { resultado: match[1].toLowerCase(), note: match[2].trim().slice(0, 160) };
}

/** IDs de pedidos/candidatas realmente creados — desde los resultados de las tools, no del texto del LLM. */
function collectToolOutputs(result: {
  steps?: { toolResults?: { toolName: string; output?: unknown }[] }[];
}): { orderIds: number[]; candidateIds: number[] } {
  const orderIds: number[] = [];
  const candidateIds: number[] = [];
  for (const step of result.steps ?? []) {
    for (const tr of step.toolResults ?? []) {
      const out = tr.output as Record<string, unknown> | undefined;
      if (!out) continue;
      if (tr.toolName === "createDeliveredOrder" && out.success === true && typeof out.id === "number") {
        orderIds.push(out.id);
      }
      if (tr.toolName === "reportReconcileCandidate" && out.success === true && typeof out.candidateId === "number") {
        candidateIds.push(out.candidateId);
      }
    }
  }
  return { orderIds, candidateIds };
}

async function reconcileConversation(
  target: ReconcileTarget,
  systemPrompt: string,
  lookbackHours: number
): Promise<ConvOutcome> {
  const label = `${target.customerName ?? "?" } (${target.customerPhone ?? "sin tel"})`;
  const since = target.lastReconciledAt ?? new Date(Date.now() - lookbackHours * 3600 * 1000);

  const transcript = await fetchTranscript(target.conversationId, since);
  if (!transcript.length) {
    await markConversationReconciled(target.conversationId, target.lastMessageAt);
    return { conversationId: target.conversationId, label, resultado: "sin_venta", orderIds: [], candidateIds: [], note: "sin mensajes nuevos" };
  }

  const userPrompt =
    `CONVERSACIÓN #${target.conversationId} — ${label}\n` +
    `Revisá este transcript y actuá según tus instrucciones:\n\n` +
    formatTranscript(transcript);

  try {
    const result = await generateText({
      model: await getMainChatModel(),
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      tools: reconcileTools,
      stopWhen: stepCountIs(15),
    });

    const { orderIds, candidateIds } = collectToolOutputs(result);
    const { resultado, note } = parseResultadoTail(result.text ?? "");

    // Marcar hasta el último mensaje que el agente efectivamente vio.
    await markConversationReconciled(target.conversationId, transcript[transcript.length - 1].at);

    return {
      conversationId: target.conversationId,
      label,
      resultado,
      orderIds,
      candidateIds,
      note,
    };
  } catch (err) {
    // No marcamos en error: la próxima corrida lo reintenta.
    return {
      conversationId: target.conversationId,
      label,
      resultado: "error",
      orderIds: [],
      candidateIds: [],
      note: err instanceof Error ? err.message.slice(0, 160) : "error desconocido",
    };
  }
}

export async function runReconcile(opts: {
  mode?: ReconcileMode;
  maxConversations?: number;
  minMessages?: number;
}): Promise<{ reportText: string; scanned: number; ordersCreated: number; candidatesCreated: number }> {
  const mode: ReconcileMode = opts.mode ?? "scan";
  const maxConversations = opts.maxConversations ?? 8;
  const minMessages = opts.minMessages ?? (mode === "sweep" ? 1 : 4);
  const lookbackHours = mode === "sweep" ? 72 : 36;

  const [run] = await db
    .insert(reconcileRuns)
    .values({ mode })
    .returning({ id: reconcileRuns.id });

  // Claim: si otra corrida sigue sin terminar (iniciada hace <20 min), esta se
  // retira. Dos invocaciones concurrentes se ven mutuamente y ambas abortan —
  // fail-safe antes que doble carga.
  const staleCutoff = new Date(Date.now() - 20 * 60 * 1000);
  const others = await db
    .select({ id: reconcileRuns.id })
    .from(reconcileRuns)
    .where(
      and(
        isNull(reconcileRuns.finishedAt),
        gt(reconcileRuns.startedAt, staleCutoff),
        ne(reconcileRuns.id, run.id)
      )
    )
    .limit(1);
  if (others.length) {
    await db
      .update(reconcileRuns)
      .set({ report: "skipped: concurrent run", finishedAt: new Date() })
      .where(eq(reconcileRuns.id, run.id));
    return { reportText: "skipped: concurrent run", scanned: 0, ordersCreated: 0, candidatesCreated: 0 };
  }

  const targets = await findConversationsNeedingReconcile({
    minMessages,
    limit: maxConversations,
    lookbackHours,
  });

  const biz = await getBusinessInfo().catch(() => ({ name: "Mrs Muzzarella" }));
  const systemPrompt = RECONCILE_SYSTEM_PROMPT.replace(/\{\{BUSINESS_NAME\}\}/g, biz.name);

  const outcomes: ConvOutcome[] = [];
  for (const target of targets) {
    outcomes.push(await reconcileConversation(target, systemPrompt, lookbackHours));
  }

  const ordersCreated = outcomes.reduce((acc, o) => acc + o.orderIds.length, 0);
  const candidatesCreated = outcomes.reduce((acc, o) => acc + o.candidateIds.length, 0);
  const allOrderIds = outcomes.flatMap((o) => o.orderIds);

  const lines: string[] = [
    `🧹 Reconcile (${mode}) — ${outcomes.length} chat(s) revisado(s)`,
    `✅ ${ordersCreated} pedido(s) cargado(s)${allOrderIds.length ? `: ${allOrderIds.map((i) => `#${i}`).join(", ")}` : ""}`,
    `❓ ${candidatesCreated} candidata(s) pendiente(s)`,
  ];
  for (const o of outcomes) {
    const icon =
      o.orderIds.length > 0 ? "✅" :
      o.candidateIds.length > 0 ? "❓" :
      o.resultado === "error" ? "⚠️" : "➖";
    lines.push(`${icon} #${o.conversationId} ${o.label} — ${o.resultado}${o.orderIds.length ? ` → pedido(s) ${o.orderIds.map((i) => `#${i}`).join(",")}` : ""} · ${o.note}`);
  }
  const reportText = lines.join("\n");

  await db
    .update(reconcileRuns)
    .set({
      conversationsScanned: outcomes.length,
      ordersCreated,
      candidatesCreated,
      report: reportText,
      finishedAt: new Date(),
    })
    .where(eq(reconcileRuns.id, run.id));

  // Notificar a TODOS los admins cuando el deep pass efectivamente procesó
  // conversaciones. Si el scan no encontró trabajo, silencio (no spam cada 30 min).
  if (outcomes.length > 0) {
    try {
      const { notifyAdmins } = await import("@/lib/telegram/notifier");
      await notifyAdmins(reportText);
    } catch (err) {
      console.warn("[reconcile] Telegram notify failed:", err);
    }
  }

  return { reportText, scanned: outcomes.length, ordersCreated, candidatesCreated };
}
