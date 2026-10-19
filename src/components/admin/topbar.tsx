"use client";

import { signOut } from "next-auth/react";
import { LogOutIcon, MenuIcon } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import AdminSidebarContent from "./sidebar-content";
import { fadeUp } from "@/lib/animation-variants";

interface TopbarProps {
  user: {
    name?: string | null;
    email?: string | null;
    role?: string;
  };
}

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrador",
  viewer: "Solo lectura",
};

function getInitials(name?: string | null, email?: string | null): string {
  if (name) {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  }
  if (email) return email[0].toUpperCase();
  return "A";
}

export default function AdminTopbar({ user }: TopbarProps) {
  const initials = getInitials(user.name, user.email);
  const displayName = user.name ?? user.email ?? "Admin";

  return (
    <motion.header
      className="flex h-14 shrink-0 items-center gap-3 border-b border-sidebar-border bg-sidebar px-4"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
    >
      {/* Mobile menu trigger */}
      <Sheet>
        <motion.div
          className="md:hidden"
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <SheetTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-foreground"
              />
            }
          >
            <MenuIcon className="size-5" />
            <span className="sr-only">Abrir menú</span>
          </SheetTrigger>
        </motion.div>
        <SheetContent
          side="left"
          className="w-64 border-r border-sidebar-border bg-sidebar p-0"
        >
          <AdminSidebarContent />
        </SheetContent>
      </Sheet>

      <div className="flex-1" />

      {/* User info */}
      <div className="flex items-center gap-3">
        <motion.div
          className="hidden sm:flex flex-col items-end"
          variants={fadeUp}
          initial="hidden"
          animate="visible"
        >
          <span className="text-sm font-medium leading-none text-foreground/90">
            {displayName}
          </span>
          <span className="text-xs mt-0.5 text-muted-foreground">
            {ROLE_LABELS[user.role ?? ""] ?? user.role ?? "Usuario"}
          </span>
        </motion.div>

        <motion.div
          whileHover={{ scale: 1.08 }}
          transition={{ type: "spring", stiffness: 400, damping: 17 }}
        >
          <Avatar>
            <AvatarFallback className="bg-gradient-to-br from-primary/25 to-gold-bright/15 font-bold text-gold-bright">
              {initials}
            </AvatarFallback>
          </Avatar>
        </motion.div>

        <motion.div
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => signOut({ callbackUrl: "/login" })}
            title="Cerrar sesión"
            className="text-muted-foreground hover:text-foreground"
          >
            <LogOutIcon className="size-4" />
            <span className="sr-only">Cerrar sesión</span>
          </Button>
        </motion.div>
      </div>
    </motion.header>
  );
}
