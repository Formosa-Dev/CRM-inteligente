import "server-only";

import { and, desc, eq, gt, inArray, lt, notLike, or, sql } from "drizzle-orm";

import { db } from "@/db";
import { agentInboundJobs, channelAccounts, chatMessages } from "@/db/schema";

import {
  ChannelAccountResolutionError,
  resolveChannelAccountByIdStrict,
} from "./accounts";
import { BUFFER_CONFIG, BufferManager, type BufferedMessage } from "./buffer";
import { isSchemaNotReady } from "./errors";
import type { ChannelAccount, ChannelKind } from "./types";
import type { InboundTurn } from "./inbound-pipeline";

/**
 * Durable inbound-turn queue — Postgres-backed mirror of the in-memory
 * debounce buffer. One row per debounced conversation turn, deduped by
 * `turn:<conversation_id>` with a partial unique index over LIVE statuses —
 * so debounce coalescing holds at the durable layer too.
 *
 * Lifecycle: queued → running → done | dead (the DLQ).
 *
 * Drain mechanism (chosen for this App Router deploy):
 *  1. PRIMARY — self-healing trigger at the top of `handleNormalizedEvent`
 *     (the single entry every inbound webhook funnels through): each new
 *     webhook drains pending work, throttled to one pass per process per
 *     `DRAIN_TRIGGER_MIN_INTERVAL_MS`. Works on serverless and long-lived
 *     Node alike — no cron or worker process needed.
 *  2. SECONDARY — `src/instrumentation.ts` `register()` runs a startup drain
 *     plus a slow periodic sweep on the Node runtime (`next start`, Render),
 *     covering orphan recovery when webhooks go quiet.
 *
 * Crash semantics: the in-process flush claims the job (`running`) before
 * dispatch and settles it only when the buffer is empty AND no flush holds
 * the per-key lock. A crash at any point leaves the row `queued` (not yet
 * started) or `running` (stale after `INBOUND_JOB_LEASE_MS`) — both
 * claimable by the next drain, which rebuilds the batch from `chat_messages`
 * (inbound customer rows newer than the last outbound) instead of trusting
 * the payload. At-least-once dispatch.
 *
 * Migration tolerance: on installs where `agent_inbound_jobs` is not yet
 * migrated (SQLSTATE 42P01) every entry point degrades to the in-memory
 * buffer path and warns once — the webhook contract never changes.
 */

export type AgentInboundJobStatus = "queued" | "running" | "done" | "dead";

export type InboundTurnJobPayload = {
  /** Canonical customer identity (conversations.external_user_id_normalized). */
  externalUserId: string;
  /** Provider-addressable send target (customer phone / BSUID / social id). */
  to: string;
  providerConversationId?: string | null;
};

export type AgentInboundJob = typeof agentInboundJobs.$inferSelect;

/** A dead job joined with its account display data, for the DLQ surfaces. */
export interface DeadInboundJob {
  id: number;
  dedupKey: string;
  channel: ChannelKind;
  channelAccountId: number | null;
  accountProvider: string | null;
  accountSender: string | null;
  accountDisplayName: string | null;
  conversationId: number;
  conversationKey: string;
  status: AgentInboundJobStatus;
  attempts: number;
  runAfter: Date;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Max drain executions before a job is dead-lettered (the DLQ). */
export const INBOUND_JOB_MAX_ATTEMPTS = 5;

/** 'running' rows untouched this long are treated as crashed and re-claimed. */
const INBOUND_JOB_LEASE_MS = 10 * 60 * 1000;

/** Delay after enqueue during which only the in-process flush may run. */
const RUN_AFTER_GRACE_MS = 30_000;

/** Exponential backoff: 10s · 2ⁿ capped at 5min. */
const RETRY_BASE_MS = 10_000;
const RETRY_CAP_MS = 5 * 60 * 1000;

const DRAIN_BATCH_LIMIT = 25;
const REBUILD_BATCH_LIMIT = 50;

function retryBackoffMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_CAP_MS);
}

export function inboundTurnJobDedupKey(conversationId: number): string {
  return `turn:${conversationId}`;
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.slice(0, 500);
}

// ─── Schema tolerance ───────────────────────────────────────────────────────
// Un-migrated installs (42P01) must behave exactly like the pre-queue code:
// every entry point degrades quietly and warns once per process.

let schemaWarned = false;

function warnQueueNotReady(): void {
  if (schemaWarned) return;
  schemaWarned = true;
  console.warn(
    "[queue] agent_inbound_jobs not migrated — durable queue disabled; in-memory scheduling only"
  );
}

function logQueueError(op: string, error: unknown): void {
  if (isSchemaNotReady(error)) {
    warnQueueNotReady();
    return;
  }
  console.error(`[queue] ${op} failed:`, error);
}

// ─── Writes (in-process flush lifecycle) ────────────────────────────────────

/**
 * Enqueue the durable shadow of a buffered turn. Returns true when a new live
 * job was created; false when an existing live job already covers the
 * conversation (debounce coalescing) or the queue is unavailable. `runAfter`
 * is pushed past the debounce window + a grace margin so the in-process flush
 * always wins the race on a healthy process.
 */
export async function enqueueInboundTurnJob(input: {
  channel: ChannelKind;
  channelAccountId: number | null;
  conversationId: number;
  conversationKey: string;
  payload: InboundTurnJobPayload;
}): Promise<boolean> {
  const debounceMs =
    BUFFER_CONFIG[input.channel]?.debounceMs ?? BUFFER_CONFIG.whatsapp.debounceMs;
  try {
    const inserted = await db
      .insert(agentInboundJobs)
      .values({
        dedupKey: inboundTurnJobDedupKey(input.conversationId),
        channel: input.channel,
        channelAccountId: input.channelAccountId,
        conversationId: input.conversationId,
        conversationKey: input.conversationKey,
        payload: input.payload,
        status: "queued",
        runAfter: new Date(Date.now() + debounceMs + RUN_AFTER_GRACE_MS),
      })
      .onConflictDoNothing()
      .returning({ id: agentInboundJobs.id });
    return inserted.length > 0;
  } catch (error) {
    logQueueError("enqueue inbound turn", error);
    return false;
  }
}

/**
 * In-process flush claim: the debounce fired and dispatch wants to start.
 * Returns true ONLY when this flush owns the dispatch — either it moved the
 * job to 'running' itself (including reclaiming a lease-expired row) or no
 * live row exists at all (queue not populated/un-migrated). False means a
 * live row is owned by another claimant (a drain pass or a concurrent
 * process's flush): the caller must NOT dispatch or it would double-send.
 *
 * Stale 'running' rows (no update for INBOUND_JOB_LEASE_MS) are treated as
 * crashed and re-claimable here — the same rule the drain applies.
 */
export async function markInboundJobRunning(dedupKey: string): Promise<boolean> {
  try {
    const leaseCutoff = new Date(Date.now() - INBOUND_JOB_LEASE_MS);
    const claimed = await db
      .update(agentInboundJobs)
      .set({
        status: "running",
        attempts: sql`${agentInboundJobs.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentInboundJobs.dedupKey, dedupKey),
          or(
            eq(agentInboundJobs.status, "queued"),
            and(
              eq(agentInboundJobs.status, "running"),
              lt(agentInboundJobs.updatedAt, leaseCutoff)
            )
          )
        )
      )
      .returning({ id: agentInboundJobs.id });
    if (claimed.length > 0) return true;

    const [live] = await db
      .select({ id: agentInboundJobs.id })
      .from(agentInboundJobs)
      .where(
        and(
          eq(agentInboundJobs.dedupKey, dedupKey),
          inArray(agentInboundJobs.status, ["queued", "running"])
        )
      )
      .limit(1);
    // A live row we could not claim belongs to another claimant → skip the
    // dispatch. No live row → in-memory path stays authoritative.
    return !live;
  } catch (error) {
    // Queue unavailable (42P01 or transient): preserve in-memory dispatch —
    // a false here would silently drop turns on un-migrated installs.
    logQueueError("mark running", error);
    return true;
  }
}

/**
 * Close the durable job when the in-process flush is done — but only when the
 * conversation is truly quiet: no flush holds the per-key lock and no buffered
 * messages remain. Otherwise the row stays live and the next drain pass (or
 * the in-flight flush's own settle) picks it up.
 *
 * A fresh buffer dead-letter (the callback exhausted its retries inside this
 * flush) moves the job straight to 'dead' — the durable DLQ mirrors the
 * terminal outcome instead of dropping it in process memory.
 */
export async function settleInboundTurnJob(input: {
  dedupKey: string;
  channel: ChannelKind;
  userKey: string;
  deadLettersBefore: number;
}): Promise<void> {
  const { dedupKey, channel, userKey, deadLettersBefore } = input;
  try {
    const lockFree = await BufferManager.acquireLock(channel, userKey);
    if (!lockFree) return; // a flush is in flight — its settle closes the job
    try {
      if (await BufferManager.hasNewMessages(channel, userKey)) return;
      const deadLetters = await BufferManager.getDeadLetters(channel, userKey);
      if (deadLetters.length > deadLettersBefore) {
        await deadletterInboundJobByDedup(
          dedupKey,
          "dispatch callback exhausted buffer retries"
        );
      } else {
        await completeInboundJobByDedup(dedupKey);
      }
    } finally {
      await BufferManager.releaseLock(channel, userKey);
    }
  } catch (error) {
    logQueueError("settle", error);
  }
}

async function completeInboundJobByDedup(dedupKey: string): Promise<void> {
  await db
    .update(agentInboundJobs)
    .set({ status: "done", updatedAt: new Date() })
    .where(
      and(
        eq(agentInboundJobs.dedupKey, dedupKey),
        inArray(agentInboundJobs.status, ["queued", "running"])
      )
    );
}

async function deadletterInboundJobByDedup(
  dedupKey: string,
  error: string
): Promise<void> {
  await db
    .update(agentInboundJobs)
    .set({ status: "dead", lastError: error, updatedAt: new Date() })
    .where(
      and(
        eq(agentInboundJobs.dedupKey, dedupKey),
        inArray(agentInboundJobs.status, ["queued", "running"])
      )
    );
}

// ─── Drain (restart / retry recovery) ───────────────────────────────────────

/**
 * Atomically claim up to `limit` due jobs: due `queued` rows plus `running`
 * orphans past the lease. Single statement with FOR UPDATE SKIP LOCKED — safe
 * under concurrent drains and compatible with the Neon HTTP driver (no
 * interactive transaction needed).
 */
export async function claimDueInboundJobs(
  limit = DRAIN_BATCH_LIMIT
): Promise<AgentInboundJob[]> {
  try {
    const result = await db.execute(sql`
      UPDATE "agent_inbound_jobs"
      SET "status" = 'running',
          "attempts" = "attempts" + 1,
          "updated_at" = now()
      WHERE "id" IN (
        SELECT "id" FROM "agent_inbound_jobs"
        WHERE ("status" = 'queued' AND "run_after" <= now())
           OR ("status" = 'running' AND "updated_at" < now() - (${INBOUND_JOB_LEASE_MS} * interval '1 millisecond'))
        ORDER BY "run_after" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);
    return (result.rows as Record<string, unknown>[]).map(rowToJob);
  } catch (error) {
    if (isSchemaNotReady(error)) {
      warnQueueNotReady();
      return [];
    }
    console.error("[queue] claim inbound jobs failed:", error);
    return [];
  }
}

export type DrainTurnResult = "dispatched" | "skipped";

/**
 * Claim due jobs, rebuild each turn from the canonical message store, and hand
 * it to `handler` (the pipeline's dispatcher seam). A handler throwing marks
 * the job for retry with exponential backoff — or 'dead' once attempts are
 * exhausted. Returns how many jobs were actually dispatched.
 */
export async function drainInboundJobs(
  handler: (turn: InboundTurn) => Promise<DrainTurnResult>,
  limit = DRAIN_BATCH_LIMIT
): Promise<number> {
  const jobs = await claimDueInboundJobs(limit);
  let dispatched = 0;
  for (const job of jobs) {
    try {
      const turn = await rebuildInboundTurn(job);
      if (!turn) {
        await completeInboundJob(job.id);
        continue;
      }
      const outcome = await handler(turn);
      await completeInboundJob(job.id);
      if (outcome === "dispatched") dispatched += 1;
    } catch (error) {
      await rescheduleInboundJob(job, error);
    }
  }
  return dispatched;
}

async function completeInboundJob(id: number): Promise<void> {
  await db
    .update(agentInboundJobs)
    .set({ status: "done", updatedAt: new Date() })
    .where(
      and(
        eq(agentInboundJobs.id, id),
        inArray(agentInboundJobs.status, ["queued", "running"])
      )
    );
}

async function rescheduleInboundJob(
  job: AgentInboundJob,
  error: unknown
): Promise<void> {
  const exhausted = job.attempts >= INBOUND_JOB_MAX_ATTEMPTS;
  try {
    await db
      .update(agentInboundJobs)
      .set({
        status: exhausted ? "dead" : "queued",
        lastError: errorText(error),
        runAfter: exhausted
          ? job.runAfter
          : new Date(Date.now() + retryBackoffMs(job.attempts)),
        updatedAt: new Date(),
      })
      .where(eq(agentInboundJobs.id, job.id));
    if (exhausted) {
      console.error(
        `[queue] inbound job ${job.id} exhausted ${job.attempts} attempts — dead-lettered`
      );
    } else {
      console.warn(
        `[queue] inbound job ${job.id} failed (attempt ${job.attempts}) — requeued: ${errorText(error)}`
      );
    }
  } catch (updateError) {
    logQueueError("reschedule", updateError);
  }
}

/**
 * Rebuild a dispatchable turn for a claimed job. The message batch is
 * re-derived from `chat_messages` — every inbound customer row newer than the
 * last outbound — because the buffered copy dies with the process while the
 * DB rows are the durable fact. Returns null when nothing is pending anymore
 * (already answered, operator handled it, or the conversation is gone).
 */
async function rebuildInboundTurn(
  job: AgentInboundJob
): Promise<InboundTurn | null> {
  if (job.channel !== "whatsapp" && job.channel !== "telegram") return null;
  if (!job.conversationId) return null;

  const payload = readPayload(job.payload);
  if (!payload) return null;

  const messages = await pendingInboundBatch(job.conversationId);
  if (messages.length === 0) return null;

  let account: ChannelAccount | undefined;
  if (job.channelAccountId) {
    const resolution = await resolveChannelAccountByIdStrict(job.channelAccountId);
    if (resolution.kind === "db-error") {
      throw new ChannelAccountResolutionError(resolution);
    }
    if (resolution.kind === "resolved") account = resolution.account;
  }

  return {
    channel: job.channel,
    channelAccountId: job.channelAccountId,
    conversationId: job.conversationId,
    externalUserId: payload.externalUserId,
    to: payload.to,
    providerConversationId: payload.providerConversationId ?? undefined,
    account,
    messages,
  };
}

function readPayload(raw: unknown): InboundTurnJobPayload | null {
  if (raw === null || typeof raw !== "object") return null;
  const payload = raw as Record<string, unknown>;
  const externalUserId = payload.externalUserId;
  const to = payload.to;
  if (typeof externalUserId !== "string" || typeof to !== "string") {
    return null;
  }
  const providerConversationId = payload.providerConversationId;
  return {
    externalUserId,
    to,
    providerConversationId:
      typeof providerConversationId === "string" ? providerConversationId : null,
  };
}

/**
 * The pending batch: inbound customer rows (role 'user' — S3 keeps writing
 * the legacy role while sender columns are stamped in S5) newer than the
 * last business-side row. The watermark is ANY outbound row (assistant /
 * human / system) except the auto-reply claim, which is a reservation, not
 * an answer: treating it as the watermark would rebuild an "already
 * answered" turn out of unanswered inbound rows.
 */
async function pendingInboundBatch(
  conversationId: number
): Promise<BufferedMessage[]> {
  const [lastOutbound] = await db
    .select({ createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.conversationId, conversationId),
        inArray(chatMessages.role, ["assistant", "human", "system"]),
        notLike(chatMessages.platformMessageId, "auto-reply:%")
      )
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(1);

  const rows = await db
    .select({
      id: chatMessages.id,
      content: chatMessages.content,
      platformMessageId: chatMessages.platformMessageId,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.conversationId, conversationId),
        eq(chatMessages.role, "user"),
        lastOutbound ? gt(chatMessages.createdAt, lastOutbound.createdAt) : undefined
      )
    )
    .orderBy(chatMessages.createdAt)
    .limit(REBUILD_BATCH_LIMIT);

  return rows.map((row) => ({
    content: row.content,
    messageId: row.platformMessageId ?? String(row.id),
    timestamp: row.createdAt.getTime(),
  }));
}

function rowToJob(row: Record<string, unknown>): AgentInboundJob {
  return {
    id: Number(row.id),
    tenantId: String(row.tenant_id ?? "default"),
    dedupKey: String(row.dedup_key),
    channel: row.channel as AgentInboundJob["channel"],
    channelAccountId: (row.channel_account_id as number | null) ?? null,
    conversationId: Number(row.conversation_id),
    conversationKey: String(row.conversation_key ?? ""),
    payload: (row.payload as Record<string, unknown> | null) ?? null,
    status: String(row.status) as AgentInboundJobStatus,
    attempts: Number(row.attempts ?? 0),
    runAfter: new Date(String(row.run_after)),
    lastError: (row.last_error as string | null) ?? null,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

// ─── DLQ surface ────────────────────────────────────────────────────────────

/** Dead-lettered jobs, newest first, joined with account display data. */
export async function listDeadInboundJobs(limit = 100): Promise<DeadInboundJob[]> {
  try {
    const rows = await db
      .select({
        job: agentInboundJobs,
        accountProvider: channelAccounts.provider,
        accountSender: channelAccounts.senderAddress,
        accountDisplayName: channelAccounts.displayName,
      })
      .from(agentInboundJobs)
      .leftJoin(
        channelAccounts,
        eq(agentInboundJobs.channelAccountId, channelAccounts.id)
      )
      .where(eq(agentInboundJobs.status, "dead"))
      .orderBy(desc(agentInboundJobs.updatedAt))
      .limit(limit);
    return rows.map(({ job, accountProvider, accountSender, accountDisplayName }) => ({
      id: job.id,
      dedupKey: job.dedupKey,
      channel: job.channel,
      channelAccountId: job.channelAccountId,
      accountProvider,
      accountSender,
      accountDisplayName,
      conversationId: job.conversationId,
      conversationKey: job.conversationKey,
      status: job.status as AgentInboundJobStatus,
      attempts: job.attempts,
      runAfter: job.runAfter,
      lastError: job.lastError,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    }));
  } catch (error) {
    if (isSchemaNotReady(error)) {
      warnQueueNotReady();
      return [];
    }
    throw error;
  }
}

/**
 * Re-queue a dead job for another dispatch cycle (manual DLQ retry). Resets
 * the attempt counter and clears the error; the partial unique index still
 * guarantees only one live job per conversation.
 */
export async function requeueDeadInboundJob(id: number): Promise<boolean> {
  try {
    const [row] = await db
      .update(agentInboundJobs)
      .set({
        status: "queued",
        attempts: 0,
        runAfter: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(agentInboundJobs.id, id), eq(agentInboundJobs.status, "dead"))
      )
      .returning({ id: agentInboundJobs.id });
    return !!row;
  } catch (error) {
    if (isSchemaNotReady(error)) {
      warnQueueNotReady();
      return false;
    }
    // A live job for the same conversation already exists — the dead row must
    // not resurrect a duplicate (partial unique index on live statuses).
    if ((error as { code?: string } | null)?.code === "23505") return false;
    throw error;
  }
}
