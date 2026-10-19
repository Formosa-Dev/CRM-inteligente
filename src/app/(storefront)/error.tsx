"use client";

import { useEffect } from "react";

export default function StorefrontError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[storefront]", error);
  }, [error]);

  return (
    <div className="digital-menu flex flex-col items-center justify-center gap-5 px-6 text-center">
      <p className="text-[0.7rem] font-semibold uppercase tracking-[0.35em] text-[var(--menu-gold)]">
        Algo salió mal
      </p>
      <h1 className="font-heading text-4xl font-black leading-[1.05] sm:text-5xl">
        No pudimos <em>cargar</em> esta página
      </h1>
      <p className="max-w-md text-sm leading-relaxed text-[var(--menu-muted)] sm:text-base">
        Fue un error de nuestro lado. Reintentá y, si sigue fallando,
        escribinos por WhatsApp.
      </p>
      <button
        type="button"
        onClick={reset}
        className="btn-gold mt-2 inline-flex items-center gap-2 px-6 py-3 text-xs font-bold uppercase tracking-wider"
      >
        Reintentar
      </button>
    </div>
  );
}
