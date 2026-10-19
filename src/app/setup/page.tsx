import { redirect } from "next/navigation";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import SetupShell from "./setup-shell";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Configuración inicial",
  robots: { index: false },
};

export default async function SetupPage() {
  // First access only — once any user exists, setup is permanently closed.
  try {
    const { rows } = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM users`
    );
    if ((rows[0]?.count ?? 0) > 0) redirect("/login");
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    // Users table missing → migrations not run yet; show instructions state.
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <p className="max-w-md text-center text-sm text-muted-foreground">
          La base de datos todavía no tiene las tablas. Corré{" "}
          <code className="text-primary">npm run db:migrate</code> y recargá
          esta página.
        </p>
      </div>
    );
  }

  return <SetupShell />;
}
