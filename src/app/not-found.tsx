import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Página no encontrada",
};

export default function NotFound() {
  return (
    <main className="digital-menu flex flex-col items-center justify-center gap-5 px-6 text-center">
      <p className="text-[0.7rem] font-semibold uppercase tracking-[0.35em] text-[var(--menu-gold)]">
        Error 404
      </p>
      <h1 className="font-heading text-4xl font-black leading-[1.05] sm:text-6xl">
        Esta página <em>no está</em> en la carta
      </h1>
      <p className="max-w-md text-sm leading-relaxed text-[var(--menu-muted)] sm:text-base">
        El enlace puede estar roto o ese producto ya no está disponible.
        La carta completa sigue esperándote.
      </p>
      <Link
        href="/carta-digital"
        className="btn-gold mt-2 inline-flex items-center gap-2 px-6 py-3 text-xs font-bold uppercase tracking-wider"
      >
        Volver a la carta
      </Link>
    </main>
  );
}
