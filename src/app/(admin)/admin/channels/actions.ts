"use server";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { channelAccounts } from "@/db/schema";
import { auth } from "@/auth";
import { requireAdmin } from "@/lib/auth/require-admin";
import {
  CHANNEL_KINDS,
  PROVIDER_IDS,
} from "@/lib/messaging/registry";
import type { ChannelKind, ProviderId } from "@/lib/messaging/types";

export interface ChannelAccountRow {
  id: number;
  provider: string;
  channel: string;
  providerAccountId: string;
  senderAddress: string;
  displayName: string | null;
  credentialsRef: string | null;
  status: string;
  createdAt: Date;
}

/** Read access: any authenticated admin-shell user. */
export async function fetchChannelAccounts(): Promise<ChannelAccountRow[]> {
  const session = await auth();
  if (!session) return [];
  const rows = await db
    .select({
      id: channelAccounts.id,
      provider: channelAccounts.provider,
      channel: channelAccounts.channel,
      providerAccountId: channelAccounts.providerAccountId,
      senderAddress: channelAccounts.senderAddress,
      displayName: channelAccounts.displayName,
      credentialsRef: channelAccounts.credentialsRef,
      status: channelAccounts.status,
      createdAt: channelAccounts.createdAt,
    })
    .from(channelAccounts)
    .orderBy(desc(channelAccounts.createdAt));
  return rows;
}

export interface CreateChannelAccountInput {
  provider: string;
  channel: string;
  providerAccountId: string;
  senderAddress: string;
  displayName?: string;
  /** `env:PREFIX` (→ PREFIX_API_KEY/PREFIX_WEBHOOK_SECRET) or vault ref. */
  credentialsRef?: string;
}

const CREDENTIALS_REF_RE = /^[a-z]+:[A-Za-z0-9_.-]+$/;

export async function createChannelAccount(
  input: CreateChannelAccountInput
): Promise<{ ok: boolean; error?: string }> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Solo administradores pueden crear cuentas" };
  }
  if (!PROVIDER_IDS.includes(input.provider as ProviderId)) {
    return { ok: false, error: `Proveedor inválido: ${input.provider}` };
  }
  if (!CHANNEL_KINDS.includes(input.channel as ChannelKind)) {
    return { ok: false, error: `Canal inválido: ${input.channel}` };
  }
  const providerAccountId = input.providerAccountId.trim();
  const senderAddress = input.senderAddress.trim();
  if (!providerAccountId || !senderAddress) {
    return {
      ok: false,
      error: "providerAccountId y senderAddress son obligatorios",
    };
  }
  const credentialsRef = input.credentialsRef?.trim() || null;
  if (credentialsRef && !CREDENTIALS_REF_RE.test(credentialsRef)) {
    return {
      ok: false,
      error:
        "credentialsRef debe tener formato 'prefix:VALUE' (ej. env:ZERNIO_MAIN)",
    };
  }

  try {
    await db.insert(channelAccounts).values({
      provider: input.provider,
      channel: input.channel as ChannelKind,
      providerAccountId,
      senderAddress,
      displayName: input.displayName?.trim() || null,
      credentialsRef,
      status: "active",
    });
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "23505") {
      return {
        ok: false,
        error: `Ya existe una cuenta ${input.provider} con providerAccountId '${providerAccountId}'`,
      };
    }
    throw error;
  }
  revalidatePath("/admin/channels");
  return { ok: true };
}

export async function setChannelAccountStatus(
  id: number,
  status: "active" | "disconnected"
): Promise<{ ok: boolean; error?: string }> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Solo administradores pueden cambiar estados" };
  }
  await db
    .update(channelAccounts)
    .set({ status, updatedAt: new Date() })
    .where(eq(channelAccounts.id, id));
  revalidatePath("/admin/channels");
  return { ok: true };
}
