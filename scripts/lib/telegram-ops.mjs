// ─── Helpers compartidos para los scripts de ops de Telegram ──────────────────
// configure + diagnose. Mantener en sync con la app:
//   - Encriptación: src/lib/encryption.ts (AES-256-GCM, scrypt(AUTH_SECRET))
//   - Telegram Bot API: src/lib/telegram/bot.ts
// Nunca imprime valores de tokens: para eso están maskToken / maskWebhookUrl.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

const TELEGRAM_API = "https://api.telegram.org/bot";
// Debe coincidir con ALGORITHM de src/lib/encryption.ts.
const ALGORITHM = "aes-256-gcm";
// Mismo formato que el backend: salt(16):iv(12):authTag(16):ciphertext.
const ENCRYPTED_PATTERN = /^[0-9a-f]{32}:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i;

export function getAuthSecret() {
  return process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "";
}

function getKey(salt, secret) {
  if (!secret) {
    throw new Error("AUTH_SECRET is required to encrypt/decrypt credentials");
  }
  return scryptSync(secret, salt, 32);
}

/** Encripta un texto igual que src/lib/encryption.ts#encrypt. */
export function encrypt(text, secret) {
  if (!text) return "";
  const salt = randomBytes(16);
  const key = getKey(salt, secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();
  return `${salt.toString("hex")}:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

export function isEncrypted(value) {
  return !!value && ENCRYPTED_PATTERN.test(value);
}

/** Desencripta un valor del formato del backend; "" si no aplica o falla. */
export function decrypt(value, secret) {
  if (!value || !isEncrypted(value)) return "";
  try {
    const [saltHex, ivHex, authTagHex, encrypted] = value.split(":");
    const key = getKey(Buffer.from(saltHex, "hex"), secret);
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return "";
  }
}

export function maskToken(token) {
  if (!token || token.length < 8) return "••••••••";
  return token.slice(0, 4) + "••••••••" + token.slice(-4);
}

/** Enmascara el token del path de la URL de webhook. */
export function maskWebhookUrl(url) {
  if (!url) return url;
  return url.replace(/\/api\/telegram\/webhook\/[^/?#]+/, "/api/telegram/webhook/••••••••");
}

export function maskChatId(id) {
  const s = String(id);
  return s.length <= 4 ? "****" : "***" + s.slice(-4);
}

export function maskDbHost(databaseUrl) {
  try {
    return new URL(databaseUrl).host.replace(/^[^.]+/, "***");
  } catch {
    return "***";
  }
}

/** URL pública del deploy (misma prioridad que la UI admin). */
export function resolvePublicUrl() {
  const raw =
    process.env.AUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.RENDER_EXTERNAL_URL ??
    "";
  return raw.replace(/\/$/, "");
}

export async function getMe(token) {
  try {
    const res = await fetch(`${TELEGRAM_API}${token}/getMe`);
    const data = await res.json().catch(() => ({}));
    if (!data.ok) return { ok: false, error: data.description ?? `HTTP ${res.status}` };
    return { ok: true, username: data.result?.username, id: data.result?.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function setWebhook(token, url) {
  try {
    const res = await fetch(`${TELEGRAM_API}${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) return { ok: false, error: data.description ?? `HTTP ${res.status}` };
    return { ok: true, description: data.description };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getWebhookInfo(token) {
  try {
    const res = await fetch(`${TELEGRAM_API}${token}/getWebhookInfo`);
    const data = await res.json().catch(() => ({}));
    if (!data.ok) return { ok: false, error: data.description ?? `HTTP ${res.status}` };
    return {
      ok: true,
      url: data.result?.url ?? "",
      pendingUpdateCount: data.result?.pending_update_count ?? 0,
      lastErrorMessage: data.result?.last_error_message,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Parser CLI mínimo: soporta `--key value` y `--key=value`; el resto va a `_`. */
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      args._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      args[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}
