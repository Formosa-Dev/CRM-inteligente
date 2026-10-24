import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { inboundTurnJobDedupKey, INBOUND_JOB_MAX_ATTEMPTS } from "./inbound-queue";

// The durable queue's DB paths are exercised by the pipeline contract; these
// tests pin the pure surface (dedup key shape, attempt bound) plus the
// source-level invariants the schema and lifecycle depend on — integer ids,
// live-status dedup, lease reclaim, bounded backoff, 42P01 fallback, and the
// chat_messages-rebuilt batch (never the serialized payload).

describe("inbound-turn job identity", () => {
  it("dedups one live job per debounced conversation turn", () => {
    assert.equal(inboundTurnJobDedupKey(42), "turn:42");
    assert.equal(inboundTurnJobDedupKey(7), "turn:7");
    assert.notEqual(inboundTurnJobDedupKey(7), inboundTurnJobDedupKey(8));
  });

  it("bounds retries before the DLQ", () => {
    assert.equal(INBOUND_JOB_MAX_ATTEMPTS, 5);
  });
});

describe("inbound-queue module invariants", () => {
  const src = readFileSync("src/lib/messaging/inbound-queue.ts", "utf8");

  it("enqueues with onConflictDoNothing against the live-status unique index", () => {
    assert.match(src, /onConflictDoNothing\(\)/);
    const schema = readFileSync("src/db/schema.ts", "utf8");
    assert.match(schema, /agent_inbound_jobs_live_dedup_uq/);
    assert.match(schema, /queued', 'running/);
  });

  it("claims due jobs atomically with FOR UPDATE SKIP LOCKED", () => {
    assert.match(src, /FOR UPDATE SKIP LOCKED/);
    // Due = queued and due, or running past the 10-minute lease.
    assert.match(src, /status" = 'queued' AND "run_after" <= now\(\)/);
    assert.match(src, /status" = 'running' AND "updated_at"/);
  });

  it("reclaims stale running jobs after a 10-minute lease", () => {
    assert.match(src, /INBOUND_JOB_LEASE_MS = 10 \* 60 \* 1000/);
  });

  it("backs off exponentially: 10s·2ⁿ capped at 5min, 5 attempts → dead", () => {
    assert.match(src, /RETRY_BASE_MS = 10_000/);
    assert.match(src, /RETRY_CAP_MS = 5 \* 60 \* 1000/);
    assert.match(src, /2 \*\* Math\.max\(0, attempts - 1\)/);
    assert.match(src, /status: exhausted \? "dead" : "queued"/);
  });

  it("falls back to the in-memory path only on 42P01 schema absence", () => {
    assert.match(src, /isSchemaNotReady\(error\)/);
    const errors = readFileSync("src/lib/messaging/errors.ts", "utf8");
    assert.match(errors, /42P01/);
  });

  it("rebuilds the batch from chat_messages, never the job payload", () => {
    const rebuild = src.slice(src.indexOf("async function pendingInboundBatch"));
    assert.match(rebuild, /chatMessages\.conversationId/);
    assert.match(rebuild, /eq\(chatMessages\.role, "user"\)/);
    // Watermark: last business-side row except the auto-reply claim.
    assert.match(rebuild, /inArray\(chatMessages\.role, \["assistant", "human", "system"\]\)/);
    assert.match(rebuild, /notLike\(chatMessages\.platformMessageId, "auto-reply:%"\)/);
    // Bounded batch.
    assert.match(rebuild, /REBUILD_BATCH_LIMIT/);
  });

  it("exposes manual DLQ list + requeue", () => {
    assert.match(src, /export async function listDeadInboundJobs/);
    assert.match(src, /export async function requeueDeadInboundJob/);
  });
});
