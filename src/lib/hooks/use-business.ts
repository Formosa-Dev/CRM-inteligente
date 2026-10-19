"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { BusinessInfo } from "@/lib/business";

let cache: BusinessInfo | null = null;

/**
 * Client-side access to the public business identity served by
 * GET /api/business. Returns null while loading — callers decide
 * whether to hide or show a fallback.
 */
export function useBusiness(): BusinessInfo | null {
  const [info, setInfo] = useState<BusinessInfo | null>(cache);

  useEffect(() => {
    if (cache) return;
    let cancelled = false;
    fetch("/api/business")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          cache = data;
          setInfo(data);
        }
      })
      .catch(() => {
        toast.error("No se pudo cargar la información del negocio");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return info;
}
