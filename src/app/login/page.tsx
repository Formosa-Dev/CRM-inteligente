import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import LoginShell from "./login-shell";

export const metadata = {
  title: "Iniciar sesión — Admin",
  robots: { index: false },
};

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const session = await auth();
  if (session) {
    redirect("/admin");
  }

  // Fresh deploy with no users → send them to first-access setup.
  try {
    const { rows } = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM users`
    );
    if ((rows[0]?.count ?? 0) === 0) redirect("/setup");
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    // DB not migrated yet — let /setup or the login form surface the error.
  }

  return <LoginShell />;
}
