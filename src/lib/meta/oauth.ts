import { encrypt } from "@/lib/encryption";

const META_GRAPH_VERSION = "v22.0";

// Cookie holding the CSRF nonce between the OAuth request and its callback.
export const META_OAUTH_STATE_COOKIE = "meta_oauth_state";

export async function buildMetaOAuthUrl(redirectUri: string, state: string): Promise<string> {
  const { getIntegrationSecrets } = await import("@/lib/integrations");
  const { metaAppId } = await getIntegrationSecrets();
  const params = new URLSearchParams({
    client_id: metaAppId,
    redirect_uri: redirectUri,
    scope: "whatsapp_business_management,whatsapp_business_messaging",
    response_type: "code",
    state,
  });
  return `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth?${params}`;
}

export async function exchangeCodeForToken(
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const { getIntegrationSecrets } = await import("@/lib/integrations");
  const secrets = await getIntegrationSecrets();
  const params = new URLSearchParams({
    client_id: secrets.metaAppId,
    client_secret: secrets.metaAppSecret,
    code,
    redirect_uri: redirectUri,
  });

  const resp = await fetch(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token?${params}`,
    { signal: AbortSignal.timeout(15_000) }
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Meta token exchange failed: ${resp.status} ${body}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}

export async function getMetaBusinessInfo(accessToken: string): Promise<{
  name: string;
  phoneNumberId: string | null;
}> {
  const resp = await fetch(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/me?fields=name&access_token=${accessToken}`,
    { signal: AbortSignal.timeout(10_000) }
  );

  if (!resp.ok) {
    throw new Error(`Meta business info failed: ${resp.status}`);
  }

  const data = (await resp.json()) as { name?: string; id?: string };

  return {
    name: data.name || "Meta Business",
    phoneNumberId: null, // Will be set after WABA selection
  };
}

export function encryptToken(token: string): string {
  return encrypt(token);
}
