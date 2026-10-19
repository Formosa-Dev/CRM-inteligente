import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { timingSafeEqual } from "node:crypto";

import { requireAdmin } from "@/lib/auth/require-admin";
import { db } from "@/db";
import { channelAccounts } from "@/db/schema";
import { isChannelKind } from "@/lib/messaging/registry";
import {
  ZERNIO_CONNECT_STATE_COOKIE,
  fetchZernioAccount,
} from "@/lib/messaging/providers/zernio-connect";

/**
 * GET /api/channels/zernio/callback — Zernio embedded-connect return URL.
 *
 * The connect flow started by startZernioConnect() sends the operator to
 * Zernio's authUrl; after approval Zernio lands them back here with
 * `connected={platform}&accountId&username&profileId` appended to our
 * redirect_url — which already carried our `state` nonce (CSRF: Zernio
 * preserves our query string per connecting-accounts.mdx).
 *
 * On success the channel_accounts row is upserted (provider=zernio,
 * credentialsRef=env:ZERNIO_) and the browser lands on /admin/channels
 * with a flash param the view turns into a toast.
 */

function backToChannels(
  req: NextRequest,
  params: Record<string, string>
): NextResponse {
  // The browser is already on our origin — env config could be wrong or
  // absent; the request's own origin is the authoritative redirect base.
  const url = new URL("/admin/channels", req.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.redirect(new URL("/login", req.nextUrl.origin));
  }

  const sp = req.nextUrl.searchParams;
  const platform = sp.get("connected") ?? sp.get("platform") ?? "";
  const accountId = sp.get("accountId") ?? "";
  const username = sp.get("username") ?? "";
  const state = sp.get("state") ?? "";

  // CSRF: the state issued by startZernioConnect must match — Zernio keeps
  // our query string through the OAuth roundtrip. One-shot cookie.
  const cookieStore = await cookies();
  const expected = cookieStore.get(ZERNIO_CONNECT_STATE_COOKIE)?.value ?? "";
  cookieStore.delete(ZERNIO_CONNECT_STATE_COOKIE);
  const a = Buffer.from(state);
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
    return backToChannels(req, { error: "oauth-state" });
  }

  if (!isChannelKind(platform) || !accountId) {
    return backToChannels(req, { error: "connect-params" });
  }

  const apiKey = process.env.ZERNIO_API_KEY?.trim();
  // Best-effort enrichment: the callback carries only username; the account
  // record adds phoneNumber (WhatsApp) / displayName. Never fatal.
  const detail = apiKey ? await fetchZernioAccount(apiKey, accountId) : null;

  const handle = detail?.username ?? username;
  const senderAddress =
    detail?.phoneNumber ??
    (handle ? `@${handle}` : undefined) ??
    detail?.platformUserId ??
    accountId;
  const displayName = detail?.displayName ?? detail?.username ?? username ?? null;

  try {
    await db
      .insert(channelAccounts)
      .values({
        provider: "zernio",
        channel: platform,
        providerAccountId: accountId,
        senderAddress,
        displayName,
        credentialsRef: "env:ZERNIO_",
        status: "active",
      })
      .onConflictDoUpdate({
        target: [channelAccounts.provider, channelAccounts.providerAccountId],
        set: {
          channel: platform,
          senderAddress,
          displayName,
          status: "active",
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    console.error("[zernio/callback] channel_accounts upsert failed", error);
    return backToChannels(req, { error: "persist-failed" });
  }

  return backToChannels(req, { connected: `zernio:${platform}` });
}
