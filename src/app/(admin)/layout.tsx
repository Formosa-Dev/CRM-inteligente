import { redirect } from "next/navigation";
import { auth } from "@/auth";
import AdminSidebar from "@/components/admin/sidebar";
import AdminTopbar from "@/components/admin/topbar";
import PageTransition from "@/components/admin/page-transition";
import { AdminRoleProvider } from "@/components/admin/role-context";
import { Toaster } from "sonner";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session) {
    redirect("/login");
  }

  // Viewers get read-only UI: nav/data stay visible, mutation controls hide.
  // Anything other than "admin" (incl. missing role) is treated as read-only.
  return (
    <AdminRoleProvider role={session.user.role === "admin" ? "admin" : "viewer"}>
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar desktop */}
      <AdminSidebar />

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <AdminTopbar user={session.user} />
        <PageTransition>{children}</PageTransition>
      </div>

      <Toaster richColors position="top-right" />
    </div>
    </AdminRoleProvider>
  );
}
