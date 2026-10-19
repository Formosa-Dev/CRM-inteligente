import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { createFirstAdmin, type FirstAdminStore, type SetupState } from "./actions";

type UserRow = {
  id: number;
  email: string;
  hashedPassword: string;
  name: string;
  role: string;
};

/**
 * In-memory store that models the production statement's contract: the
 * emptiness check and the insert happen atomically (no await between check
 * and insert), and users.email is unique — so a same-email concurrent submit
 * cannot produce a second row either.
 */
function fakeStore(seed: UserRow[] = []) {
  const users = [...seed];
  const store: FirstAdminStore = {
    async insertFirstAdmin(values) {
      if (users.length > 0) return false;
      if (users.some((u) => u.email === values.email)) return false;
      users.push({
        id: users.length + 1,
        email: values.email,
        hashedPassword: values.hashedPassword,
        name: values.name,
        role: "admin",
      });
      return true;
    },
  };
  return { store, users };
}

function formData(values: { name?: string; email?: string; password?: string }): FormData {
  const fd = new FormData();
  if (values.name !== undefined) fd.set("name", values.name);
  if (values.email !== undefined) fd.set("email", values.email);
  if (values.password !== undefined) fd.set("password", values.password);
  return fd;
}

const PREV: SetupState = { error: "" };
const VALID = { name: "Admin", email: "Admin@Negocio.com", password: "super-secreta-123" };

function isLoginRedirect(error: unknown): boolean {
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT") && digest.includes("/login");
}

test("creates the first admin while the users table is empty and redirects to /login", async () => {
  const { store, users } = fakeStore();
  await assert.rejects(
    createFirstAdmin(PREV, formData(VALID), store),
    (error: unknown) => isLoginRedirect(error),
  );
  assert.equal(users.length, 1);
  const admin = users[0];
  assert.equal(admin.role, "admin");
  assert.equal(admin.email, "admin@negocio.com"); // lowercased before insert
  assert.equal(admin.name, "Admin");
  assert.notEqual(admin.hashedPassword, VALID.password);
  assert.ok(await bcrypt.compare(VALID.password, admin.hashedPassword));
});

test("concurrent bootstrap calls create exactly ONE admin; the loser gets already-exists", async () => {
  const { store, users } = fakeStore();
  const outcomes = await Promise.allSettled([
    createFirstAdmin(PREV, formData({ ...VALID, email: "first@negocio.com" }), store),
    createFirstAdmin(PREV, formData({ ...VALID, email: "second@negocio.com" }), store),
  ]);

  assert.equal(users.length, 1);

  const redirected = outcomes.filter(
    (o) => o.status === "rejected" && isLoginRedirect(o.reason),
  );
  const alreadyExists = outcomes.filter(
    (o) =>
      o.status === "fulfilled" &&
      o.value.error === "La configuración inicial ya fue realizada.",
  );
  assert.equal(redirected.length, 1);
  assert.equal(alreadyExists.length, 1);
});

test("a repeated submit with the same email creates no second admin", async () => {
  const { store, users } = fakeStore();
  await assert.rejects(createFirstAdmin(PREV, formData(VALID), store), (e) => isLoginRedirect(e));
  const second = await createFirstAdmin(PREV, formData(VALID), store);
  assert.equal(users.length, 1);
  assert.equal(second.error, "La configuración inicial ya fue realizada.");
});

test("returns already-exists when setup already ran", async () => {
  const { store, users } = fakeStore([
    { id: 1, email: "otro@negocio.com", hashedPassword: "x", name: "Otro", role: "admin" },
  ]);
  const result = await createFirstAdmin(PREV, formData(VALID), store);
  assert.deepEqual(result, { error: "La configuración inicial ya fue realizada." });
  assert.equal(users.length, 1);
});

test("rejects invalid payloads before touching the store", async () => {
  const { store, users } = fakeStore();
  const badEmail = await createFirstAdmin(
    PREV,
    formData({ ...VALID, email: "not-an-email" }),
    store,
  );
  assert.equal(badEmail.error, "Email inválido");

  const shortPassword = await createFirstAdmin(
    PREV,
    formData({ ...VALID, password: "short" }),
    store,
  );
  assert.equal(shortPassword.error, "La contraseña debe tener al menos 8 caracteres");

  const noName = await createFirstAdmin(PREV, formData({ ...VALID, name: "" }), store);
  assert.equal(noName.error, "El nombre es obligatorio");

  assert.equal(users.length, 0);
});
