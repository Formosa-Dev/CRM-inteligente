"use client";

import { createContext, useContext } from "react";

// Role from the NextAuth session, provided by the (admin) layout.
// IMPORTANT: this is honest UX only — the authoritative gate is
// requireAdmin() inside every server action.
const AdminRoleContext = createContext<string>("admin");

export function AdminRoleProvider({
  role,
  children,
}: {
  role: string;
  children: React.ReactNode;
}) {
  return (
    <AdminRoleContext.Provider value={role}>
      {children}
    </AdminRoleContext.Provider>
  );
}

export function useAdminRole() {
  return useContext(AdminRoleContext);
}

export function useIsAdmin() {
  return useAdminRole() === "admin";
}
