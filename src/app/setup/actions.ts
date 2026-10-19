"use server";

import { db } from "@/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";

const setupSchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio").max(255),
  email: z.string().trim().email("Email inválido").max(255),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres").max(200),
});

export type SetupState = { error: string };

export type FirstAdminStore = {
  /**
   * Atomically inserts the first admin iff the users table is empty.
   * Returns true when this call created the row, false when setup already ran.
   */
  insertFirstAdmin(values: {
    email: string;
    hashedPassword: string;
    name: string;
  }): Promise<boolean>;
};

/**
 * The neon-http driver backing `db` has no transaction support
 * (`db.transaction()` throws), so the "only while the table is empty" guard
 * lives inside a single atomic INSERT ... SELECT ... WHERE NOT EXISTS.
 * `ON CONFLICT (email)` adds the users.email unique index as the singleton
 * backstop: a same-email concurrent submit skips the insert instead of
 * raising a unique violation.
 */
function createDbFirstAdminStore(): FirstAdminStore {
  return {
    async insertFirstAdmin(values) {
      const result = await db.execute(sql`
        INSERT INTO users (email, hashed_password, name, role)
        SELECT ${values.email}, ${values.hashedPassword}, ${values.name}, 'admin'::user_role
        WHERE NOT EXISTS (SELECT 1 FROM users)
        ON CONFLICT (email) DO NOTHING
        RETURNING id
      `);
      return (result.rows?.length ?? 0) > 0;
    },
  };
}

/**
 * First-access bootstrap: creates the first admin account — only while the
 * users table is empty. Race safety comes from the conditional INSERT above;
 * concurrent submissions cannot both create an admin.
 */
export async function createFirstAdmin(
  _prevState: SetupState,
  formData: FormData,
  store: FirstAdminStore = createDbFirstAdminStore()
): Promise<SetupState> {
  const parsed = setupSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  }

  const email = parsed.data.email.toLowerCase();
  const hashedPassword = await bcrypt.hash(parsed.data.password, 12);

  const created = await store.insertFirstAdmin({
    email,
    hashedPassword,
    name: parsed.data.name,
  });

  if (!created) {
    return { error: "La configuración inicial ya fue realizada." };
  }

  redirect("/login");
}
