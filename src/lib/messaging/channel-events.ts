/**
 * Durable channel events for normalized kinds that have no conversation row
 * (message.status, account.lifecycle, other). Idempotent on the provider
 * delivery id, with a secondary platform-message/status key.
 *
 * Only a positively identified missing schema may degrade to "ack without
 * persistence"; any other failure is surfaced (retryable) by the caller.
 */

import { db } from "@/db";
import { channelEvents } from "@/db/schema";

import { isSchemaNotReady } from "./errors";
import type { ChannelAccount, ChannelKind, NormalizedInboundEvent } from "./types";

export interface ChannelEventContext {
  channel: ChannelKind;
  account?: ChannelAccount;
  channelAccountId?: number;
}

export interface ChannelEventInsert {
  tenantId: string;
  provider: string;
  channel: ChannelKind | null;
  channelAccountId: number | null;
  providerAccountId: string | null;
  deliveryId: string;
  platformMessageId: string | null;
  kind: string;
  direction: string;
  status: string | null;
  eventTimestamp: Date | null;
  payload: unknown;
  eventKey: string;
}

export type ChannelEventPersistResult =
  | { kind: "persisted" }
  | { kind: "duplicate" }
  | { kind: "schema-not-ready"; error: unknown };

export interface ChannelEventRepository {
  insert(input: ChannelEventInsert): Promise<"inserted" | "duplicate">;
}

export function channelEventKey(
  event: Pick<NormalizedInboundEvent, "provider" | "deliveryId" | "platformMessageId" | "kind" | "status">
): string {
  if (event.deliveryId) return `${event.provider}:delivery:${event.deliveryId}`;
  return `${event.provider}:platform:${event.platformMessageId ?? "none"}:${event.kind}:${event.status ?? "none"}`;
}

function eventTimestamp(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function toChannelEventInsert(
  event: NormalizedInboundEvent,
  ctx: ChannelEventContext
): ChannelEventInsert {
  return {
    tenantId: ctx.account?.tenantId ?? "default",
    provider: event.provider,
    channel: ctx.channel ?? null,
    channelAccountId: ctx.channelAccountId ?? null,
    providerAccountId: event.providerAccountId || null,
    deliveryId: event.deliveryId,
    platformMessageId: event.platformMessageId ?? null,
    kind: event.kind,
    direction: event.direction,
    status: event.status ?? null,
    eventTimestamp: eventTimestamp(event.timestamp),
    payload: event.raw,
    eventKey: channelEventKey(event),
  };
}

/** Pure persistence flow over an injected repository (testable without a DB). */
export async function persistChannelEventWithRepo(
  repo: ChannelEventRepository,
  event: NormalizedInboundEvent,
  ctx: ChannelEventContext
): Promise<ChannelEventPersistResult> {
  try {
    const outcome = await repo.insert(toChannelEventInsert(event, ctx));
    return outcome === "inserted" ? { kind: "persisted" } : { kind: "duplicate" };
  } catch (error) {
    if (isSchemaNotReady(error)) return { kind: "schema-not-ready", error };
    throw error;
  }
}

class DrizzleChannelEventRepository implements ChannelEventRepository {
  async insert(input: ChannelEventInsert): Promise<"inserted" | "duplicate"> {
    const rows = await db
      .insert(channelEvents)
      .values({
        tenantId: input.tenantId,
        provider: input.provider,
        channel: input.channel,
        channelAccountId: input.channelAccountId,
        providerAccountId: input.providerAccountId,
        deliveryId: input.deliveryId,
        platformMessageId: input.platformMessageId,
        kind: input.kind,
        direction: input.direction,
        status: input.status,
        eventTimestamp: input.eventTimestamp,
        payload: input.payload,
      })
      .onConflictDoNothing()
      .returning({ id: channelEvents.id });
    return rows.length > 0 ? "inserted" : "duplicate";
  }
}

export async function persistChannelEvent(
  event: NormalizedInboundEvent,
  ctx: ChannelEventContext
): Promise<ChannelEventPersistResult> {
  return persistChannelEventWithRepo(
    new DrizzleChannelEventRepository(),
    event,
    ctx
  );
}
