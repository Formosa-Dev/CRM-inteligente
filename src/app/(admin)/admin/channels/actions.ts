"use server";

import { randomBytes } from "node:crypto";

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { db } from "@/db";
import { channelAccounts } from "@/db/schema";
import { auth } from "@/auth";
import { requireAdmin } from "@/lib/auth/require-admin";
import {
  CHANNEL_KINDS,
  PROVIDER_IDS,
} from "@/lib/messaging/registry";
import {
  connectStateCookieName,
  getZernioConnectUrl,
  isZernioConnectPlatform,
  registerZernioWebhook,
  resolveZernioProfileId,
} from "@/lib/messaging/providers/zernio-connect";
import type { ChannelKind, ProviderId } from "@/lib/messaging/types";
import { publicBaseUrl } from "./webhook-endpoints";

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

/**
 * Embedded connect for Zernio: returns Zernio's `authUrl` so the client
 * navigates the operator there. The callback lands on
 * /api/channels/zernio/callback and upserts the channel_accounts row.
 * Requires ZERNIO_API_KEY in env (the same key the row references via
 * env:ZERNIO_) — this action never sees or stores the key itself.
 */
export async function startZernioConnect(
  platform: string
): Promise<{ ok: boolean; authUrl?: string; error?: string }> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Solo administradores pueden conectar cuentas" };
  }
  if (!isZernioConnectPlatform(platform)) {
    return { ok: false, error: `Conexión embebida no disponible para '${platform}'` };
  }
  const apiKey = process.env.ZERNIO_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      error: "Falta ZERNIO_API_KEY en las variables de entorno",
    };
  }
  const baseUrl = publicBaseUrl();
  if (!baseUrl) {
    return {
      ok: false,
      error: "Falta la URL pública (AUTH_URL o NEXT_PUBLIC_APP_URL)",
    };
  }

  const profile = await resolveZernioProfileId(apiKey);
  if (!profile.ok) return { ok: false, error: profile.error };

  // CSRF nonce rides inside our own redirect_url — Zernio preserves the
  // query string through the OAuth roundtrip (connecting-accounts.mdx).
  // The cookie is keyed per platform: starting a second connect (another
  // tab, another platform) must not clobber the first one's state.
  const state = randomBytes(16).toString("hex");
  const cookieStore = await cookies();
  cookieStore.set(connectStateCookieName(platform), state, {
    httpOnly: true,
    sameSite: "lax",
    secure: baseUrl.startsWith("https"),
    path: "/",
    maxAge: 10 * 60,
  });

  const connect = await getZernioConnectUrl({
    platform,
    profileId: profile.profileId,
    redirectUrl: `${baseUrl}/api/channels/zernio/callback?state=${state}`,
    apiKey,
  });
  if (!connect.ok) return { ok: false, error: connect.error };
  return { ok: true, authUrl: connect.authUrl };
}

/**
 * One-click webhook registration for Zernio: posts our ingress URL and the
 * caller-chosen secret (ZERNIO_WEBHOOK_SECRET) to /v1/webhooks/settings.
 * YCloud/Kapso still configure webhooks in their own consoles — the URLs
 * shown above are what to paste there.
 */
export async function registerZernioWebhookAction(): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Solo administradores pueden registrar webhooks" };
  }
  const apiKey = process.env.ZERNIO_API_KEY?.trim();
  const secret = process.env.ZERNIO_WEBHOOK_SECRET?.trim();
  if (!apiKey || !secret) {
    return {
      ok: false,
      error: "Faltan ZERNIO_API_KEY y/o ZERNIO_WEBHOOK_SECRET en el entorno",
    };
  }
  const baseUrl = publicBaseUrl();
  if (!baseUrl) {
    return {
      ok: false,
      error: "Falta la URL pública (AUTH_URL o NEXT_PUBLIC_APP_URL)",
    };
  }
  return registerZernioWebhook({
    url: `${baseUrl}/api/webhooks/ingress/zernio`,
    secret,
    apiKey,
  });
}
