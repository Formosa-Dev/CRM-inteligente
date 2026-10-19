const YCLOUD_API_URL =
  "https://api.ycloud.com/v2/whatsapp/messages/sendDirectly";

export type SendTextResult =
  | { ok: true; wamid?: string }
  | { ok: false; error: string };

/** Credentials: DB (admin UI, encrypted at rest) first, env fallback. */
async function getYCloudCreds(): Promise<{ apiKey: string; from: string }> {
  const { getYCloudApiKey } = await import("@/lib/integrations");
  const { getBusinessInfo } = await import("@/lib/business");
  const [apiKey, biz] = await Promise.all([getYCloudApiKey(), getBusinessInfo()]);
  return {
    apiKey,
    from: biz.whatsappPhone || process.env.WHATSAPP_PHONE_NUMBER || "",
  };
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendText(
  to: string,
  text: string,
  externalId?: string
): Promise<SendTextResult> {
  const { apiKey, from } = await getYCloudCreds();

  if (!apiKey || !from) {
    return { ok: false, error: "Missing YCLOUD_API_KEY or WHATSAPP_PHONE_NUMBER" };
  }

  const body = JSON.stringify({
    from,
    to,
    type: "text",
    text: { body: text, preview_url: false },
    ...(externalId ? { externalId } : {}),
  });

  for (let attempt = 0; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20_000);

    try {
      const response = await fetch(YCLOUD_API_URL, {
        method: "POST",
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        // Capturar wamid de la respuesta de YCloud para persistirlo como platformMessageId
        try {
          const responseData = await response.clone().json() as { id?: string };
          if (responseData?.id) {
            return { ok: true, wamid: responseData.id };
          }
        } catch {
          // Si no se puede parsear el JSON, devolver ok sin wamid (no crítico)
        }
        return { ok: true };
      }

      if (response.status >= 500 && attempt < 2) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }

      const errorText = await response.text().catch(() => "unknown error");
      return { ok: false, error: `YCloud error ${response.status}: ${errorText}` };
    } catch (err) {
      clearTimeout(timeoutId);
      if (attempt < 2) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Fetch error: ${message}` };
    }
  }

  return { ok: false, error: "Max retries exceeded" };
}

export async function sendImage(
  to: string,
  imageUrl: string,
  caption?: string,
  externalId?: string
): Promise<SendTextResult> {
  const { apiKey, from } = await getYCloudCreds();

  if (!apiKey || !from) {
    return { ok: false, error: "Missing YCLOUD_API_KEY or WHATSAPP_PHONE_NUMBER" };
  }

  const body = JSON.stringify({
    from,
    to,
    type: "image",
    image: { link: imageUrl, caption: caption || "" },
    ...(externalId ? { externalId } : {}),
  });

  for (let attempt = 0; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20_000);

    try {
      const response = await fetch(YCLOUD_API_URL, {
        method: "POST",
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        return { ok: true };
      }

      if (response.status >= 500 && attempt < 2) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }

      const errorText = await response.text().catch(() => "unknown error");
      return { ok: false, error: `YCloud error ${response.status}: ${errorText}` };
    } catch (err) {
      clearTimeout(timeoutId);
      if (attempt < 2) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Fetch error: ${message}` };
    }
  }

  return { ok: false, error: "Max retries exceeded" };
}

export async function sendDocument(
  to: string,
  documentUrl: string,
  caption?: string,
  fileName?: string,
  externalId?: string
): Promise<SendTextResult> {
  const { apiKey, from } = await getYCloudCreds();

  if (!apiKey || !from) {
    return { ok: false, error: "Missing YCLOUD_API_KEY or WHATSAPP_PHONE_NUMBER" };
  }

  const body = JSON.stringify({
    from,
    to,
    type: "document",
    document: {
      link: documentUrl,
      caption: caption || "",
      filename: fileName || "documento.pdf",
    },
    ...(externalId ? { externalId } : {}),
  });

  for (let attempt = 0; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20_000);

    try {
      const response = await fetch(YCLOUD_API_URL, {
        method: "POST",
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        return { ok: true };
      }

      if (response.status >= 500 && attempt < 2) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }

      const errorText = await response.text().catch(() => "unknown error");
      return { ok: false, error: `YCloud error ${response.status}: ${errorText}` };
    } catch (err) {
      clearTimeout(timeoutId);
      if (attempt < 2) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Fetch error: ${message}` };
    }
  }

  return { ok: false, error: "Max retries exceeded" };
}
