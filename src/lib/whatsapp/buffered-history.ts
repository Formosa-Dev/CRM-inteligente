type HistoryTurn = { role: string; content: string; platformMessageId?: string | null; createdAt?: Date | string | null };
type BufferedTurn = { content: string; messageId?: string };

/**
 * Removes the persisted inbound turns that the buffer is about to re-add, so a
 * message is never duplicated in the model context. When no provider IDs were
 * saved (older records) only the exact trailing run is removed; an unrelated
 * earlier identical message is never dropped.
 */
export function dedupeHistoryWithBuffered<T extends HistoryTurn>(history: T[], buffered: BufferedTurn[]): T[] {
  if (!buffered.length) return history;
  const ids = new Set(buffered.map((m) => m.messageId).filter((id): id is string => !!id));
  const result = history.filter((turn) => !(turn.role === "user" && turn.platformMessageId && ids.has(turn.platformMessageId)));
  const missingIds = buffered.filter((m) => !m.messageId || !history.some((turn) => turn.platformMessageId === m.messageId));
  let matched = 0;
  for (let i = result.length - 1; i >= 0 && matched < missingIds.length; i--) {
    const incoming = missingIds[missingIds.length - 1 - matched];
    if (result[i].role !== "user" || result[i].content !== incoming.content) break;
    matched++;
  }
  if (matched) result.splice(result.length - matched, matched);
  return result;
}

/** Persisted inbound turns are identified by provider ID, including media whose
 * stored placeholder differs from the analyzed text queued in the buffer. */
export function mergeBufferedTurn<T extends HistoryTurn>(history: T[], buffered: BufferedTurn[]): { role: T["role"] | "user"; content: string }[] {
  const result = dedupeHistoryWithBuffered(history, buffered).map(({ role, content }) => ({ role, content }));
  if (!buffered.length) return result;
  return [...result, { role: "user" as const, content: buffered.map((m) => m.content).join("\n") }];
}
