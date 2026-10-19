/**
 * YCloud webhook signature verification using HMAC-SHA256
 *
 * El header `ycloud-signature` tiene el formato:
 *   t=<timestamp>,s=<hmac>
 *
 * El payload firmado es: `${timestamp}.${rawBody}`
 * La firma se computa con HMAC-SHA256 usando YCLOUD_WEBHOOK_SECRET.
 */

import { createHmac, timingSafeEqual } from "crypto";

/**
 * Clock-skew allowance for FUTURE timestamps, in seconds. The replay window
 * is asymmetric: provider clocks can legitimately drift a few seconds ahead
 * of ours, but accepting a timestamp far in the future hands a captured
 * signature a long validity window.
 */
export const YCLOUD_MAX_FUTURE_SKEW_SEC = 30;

/**
 * Timestamp acceptance window: [now - maxAgeSec, now + YCLOUD_MAX_FUTURE_SKEW_SEC].
 * Exported so the provider's failure classifier can mirror the same bounds.
 */
export function ycloudTimestampInWindow(
  timestampSec: number,
  maxAgeSec = 300,
  nowSec = Date.now() / 1000
): boolean {
  if (timestampSec > nowSec + YCLOUD_MAX_FUTURE_SKEW_SEC) return false;
  return nowSec - timestampSec <= maxAgeSec;
}

/**
 * Parsea el header `ycloud-signature` y extrae timestamp + firma.
 */
function parseSignatureHeader(header: string): {
  timestamp: string;
  signature: string;
} | null {
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const idx = p.indexOf("=");
      if (idx === -1) return [p, ""];
      return [p.slice(0, idx), p.slice(idx + 1)];
    })
  );

  const t = parts["t"];
  const s = parts["s"];

  if (!t || !s) return null;
  return { timestamp: t, signature: s };
}

/**
 * Verifica la firma de un webhook de YCloud.
 *
 * @param rawBody - El body crudo del request (string)
 * @param signatureHeader - El valor del header `ycloud-signature`
 * @param secret - YCLOUD_WEBHOOK_SECRET
 * @param maxAgeSec - Tolerancia máxima de timestamp (default: 300s = 5min)
 */
export function verifyYCloudSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  maxAgeSec = 300
): boolean {
  if (!rawBody || !signatureHeader || !secret) return false;

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;

  const timestamp = parseInt(parsed.timestamp, 10);
  if (isNaN(timestamp)) return false;

  // Anti-replay window [now-300s, now+30s] — the previous Math.abs check
  // accepted future timestamps up to 300s out, extending the replay window.
  if (!ycloudTimestampInWindow(timestamp, maxAgeSec)) return false;

  // El payload firmado es: `${timestamp}.${rawBody}`
  const signedPayload = `${parsed.timestamp}.${rawBody}`;

  const computed = createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");

  // Constant-time comparison
  try {
    return timingSafeEqual(
      Buffer.from(computed, "hex"),
      Buffer.from(parsed.signature, "hex")
    );
  } catch {
    return false;
  }
}
