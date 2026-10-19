"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { navItems } from "./nav-items";
import { staggerContainer, fadeUpSmall } from "@/lib/animation-variants";
import { useBusiness } from "@/lib/hooks/use-business";
import { useIsAdmin } from "./role-context";

interface AdminSidebarContentProps {
  showFooter?: boolean;
}

export default function AdminSidebarContent({
  showFooter = false,
}: AdminSidebarContentProps) {
  const pathname = usePathname();
  const business = useBusiness();
  const isAdmin = useIsAdmin();

  return (
    <div className="flex h-full flex-col bg-sidebar">
      {/* Brand / Logo */}
      <div className="flex h-14 items-center border-b border-sidebar-border px-6">
        <motion.span
          className="cursor-default select-none text-base font-black tracking-tight text-gold-gradient"
          whileHover={{
            filter: "brightness(1.3)",
            transition: { duration: 0.25 },
          }}
        >
          {business?.name || "Admin"}
        </motion.span>
      </div>

      {/* Nav */}
      <motion.nav
        className="flex flex-1 flex-col gap-0.5 p-3"
        variants={staggerContainer}
        initial="hidden"
        animate="visible"
      >
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive =
            item.href === "/admin"
              ? pathname === "/admin"
              : pathname.startsWith(item.href);

          return (
            <motion.div key={item.href} variants={fadeUpSmall}>
              <Link
                href={item.disabled ? "#" : item.href}
                aria-disabled={item.disabled}
                tabIndex={item.disabled ? -1 : undefined}
                className={cn(
                  "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
                  isActive
                    ? "bg-primary/[0.12] text-gold-bright"
                    : "text-sidebar-foreground/50 hover:bg-primary/5 hover:text-sidebar-foreground/85",
                  item.disabled && "pointer-events-none opacity-40"
                )}
              >
                {/* Gold left border indicator */}
                <span
                  className={cn(
                    "absolute left-0 top-1/2 w-[3px] -translate-y-1/2 rounded-r-full bg-gradient-to-br from-gold via-gold-bright to-gold-ember transition-all duration-200",
                    isActive ? "h-[60%] opacity-100" : "h-0 opacity-0"
                  )}
                />

                <Icon className="size-4 shrink-0" />
                <span>{item.label}</span>
                {item.disabled && (
                  <span className="ml-auto text-[10px] font-normal text-sidebar-foreground/30">
                    pronto
                  </span>
                )}
              </Link>
            </motion.div>
          );
        })}
      </motion.nav>

      {/* Read-only indicator for viewer accounts */}
      {!isAdmin && (
        <div className="px-3 pb-3">
          <span className="block rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-center text-[11px] font-medium text-amber-400">
            Solo lectura
          </span>
        </div>
      )}

      {/* Footer */}
      {showFooter && (
        <div className="border-t border-sidebar-border p-4">
          <p className="text-xs text-sidebar-foreground/25">Panel Admin v1.0</p>
        </div>
      )}
    </div>
  );
}
