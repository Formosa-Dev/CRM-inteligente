"use client";

import { usePathname } from "next/navigation";
import { Toaster } from "sonner";

/**
 * Public-surface toast host. Sonner renders every toast without a `toasterId`
 * in EACH mounted <Toaster>, so this mount skips /admin — the admin layout
 * already renders its own top-right Toaster and double-mounting would show
 * every admin toast twice.
 */
export function PublicToaster() {
  const pathname = usePathname();
  if (pathname?.startsWith("/admin")) return null;
  return <Toaster richColors position="top-center" />;
}
