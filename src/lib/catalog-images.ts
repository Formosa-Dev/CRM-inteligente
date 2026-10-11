import { PRODUCT_IMAGE_BY_NAME, PRODUCT_IMAGE_MAP } from "@/lib/constants";

type CatalogProduct = {
  id: string | number;
  name: string;
  imageUrl?: string | null;
};

/**
 * Visual treatment for a catalog asset:
 * - `cutout`: transparency-preserving product render that must float over the
 *   card frame (contain, no crop, no opaque rectangular panel).
 * - `photo`: photographic asset (JPEG/WebP) that fills the frame with cover.
 */
export type MediaTreatment = "cutout" | "photo";

const CUTOUT_ASSETS = new Set<string>([
  ...Object.values(PRODUCT_IMAGE_MAP),
  ...Object.values(PRODUCT_IMAGE_BY_NAME),
]);

/**
 * Classifies an image semantically instead of by filename: bundled product
 * renders and transparency-capable PNGs are cutouts; everything else (JPEG,
 * WebP, uploaded photography) keeps the cover treatment.
 */
export function resolveMediaTreatment(src?: string | null): MediaTreatment {
  const value = src?.trim();
  if (!value) return "photo";
  if (CUTOUT_ASSETS.has(value)) return "cutout";
  const path = value.split(/[?#]/)[0].toLowerCase();
  return path.endsWith(".png") ? "cutout" : "photo";
}

/**
 * Normaliza URLs históricas y actuales guardadas en la base.
 * Cloudinary devuelve URLs absolutas; instalaciones anteriores pueden tener
 * rutas relativas a /public, /uploads o /assets.
 */
export function resolveCatalogImageUrl(imageUrl?: string | null): string | null {
  const value = imageUrl?.trim();
  if (!value) return null;

  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return url.username || url.password ? null : url.href;
    } catch { return null; }
  }
  // Protocol-relative URLs and non-image schemes are not local paths.
  if (value.startsWith("//") || value.includes("\\")) return null;

  const withoutPublicPrefix = value.replace(/^\.?\/?public\//i, "");
  if (withoutPublicPrefix.startsWith("uploads/") || withoutPublicPrefix.startsWith("assets/")) {
    return `/${withoutPublicPrefix}`;
  }

  if (value.startsWith("/public/")) return value.slice(7);
  if (value.startsWith("/")) return value;
  return null;
}

/** Preferimos siempre la imagen configurada desde admin/DB sobre el fallback del repo. */
export function getCatalogProductImage(product: CatalogProduct): string | null {
  return (
    resolveCatalogImageUrl(product.imageUrl) ??
    PRODUCT_IMAGE_MAP[String(product.id)] ??
    PRODUCT_IMAGE_BY_NAME[product.name.trim().toLowerCase()] ??
    null
  );
}
