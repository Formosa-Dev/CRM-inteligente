import fs from "fs/promises";
import path from "path";

const ALLOWED_DOMAINS = [
  "api.ycloud.com",
  "cdn.ycloud.com",
  "api.telegram.org",
];

/**
 * Inbound customer media lives OUTSIDE `public/` — anything under public/ is
 * served statically without auth, and these are customer files. Default
 * `<cwd>/data/uploads`; overridable via MEDIA_UPLOADS_DIR for deploys that
 * mount persistent storage elsewhere. The /api/media/[...path] route is the
 * only read path (session-gated).
 */
export function mediaUploadsDir(): string {
  const configured = process.env.MEDIA_UPLOADS_DIR;
  return configured
    ? path.resolve(configured)
    : path.join(process.cwd(), "data", "uploads");
}

function isAllowedDomain(url: string, extraAllowedDomains: readonly string[] = []): boolean {
  try {
    const parsed = new URL(url);
    return [...ALLOWED_DOMAINS, ...extraAllowedDomains].some((d) =>
      parsed.hostname.endsWith(d)
    );
  } catch {
    return false;
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

/**
 * `extraAllowedDomains` is the per-provider seam (C12): provider adapters
 * pass their media domains (e.g. KAPSO_MEDIA_DOMAINS) so the global
 * allowlist never grows speculatively.
 */
export async function downloadMedia(
  url: string,
  headers?: Record<string, string>,
  extraAllowedDomains?: readonly string[]
): Promise<Buffer> {
  if (!isAllowedDomain(url, extraAllowedDomains)) {
    throw new Error(`Domain not allowed: ${url}`);
  }

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export async function saveMediaLocally(
  buffer: Buffer,
  conversationId: number,
  filename: string,
  mimeType?: string
): Promise<string> {
  const dir = path.join(mediaUploadsDir(), String(conversationId));
  await fs.mkdir(dir, { recursive: true });

  const ext = mimeType ? mimeTypeToExt(mimeType) : path.extname(filename) || ".bin";
  const safeName = `${Date.now()}-${sanitizeFilename(filename)}`;
  const finalName = safeName.endsWith(ext) ? safeName : `${safeName}${ext}`;

  const filePath = path.join(dir, finalName);
  await fs.writeFile(filePath, buffer);

  return `/api/media/${conversationId}/${finalName}`;
}

function mimeTypeToExt(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/opus": ".opus",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  };
  return map[mime] || ".bin";
}

// Download media from YCloud WhatsApp API
export async function downloadYCloudMedia(
  mediaId: string,
  apiKey: string
): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  // Step 1: Get media URL
  const metaResp = await fetch(
    `https://api.ycloud.com/v2/whatsapp/media/${mediaId}`,
    {
      headers: { "X-API-Key": apiKey },
      signal: AbortSignal.timeout(10_000),
    }
  );

  if (!metaResp.ok) {
    const body = await metaResp.text().catch(() => "no body");
    throw new Error(
      `YCloud media metadata failed: ${metaResp.status} - ${body.slice(0, 200)}` +
      (metaResp.status === 401 ? " — La API key de YCloud no tiene permiso para leer medios. En YCloud Dashboard > API Keys, habilita el permiso 'Media > Read'." : "")
    );
  }

  const meta = (await metaResp.json()) as {
    url?: string;
    mime_type?: string;
    file_name?: string;
  };

  if (!meta.url) throw new Error("No media URL returned by YCloud");

  // Step 2: Download the actual file
  const buffer = await downloadMedia(meta.url, { "X-API-Key": apiKey });

  return {
    buffer,
    mimeType: meta.mime_type || "application/octet-stream",
    filename: meta.file_name || `media-${mediaId}`,
  };
}


