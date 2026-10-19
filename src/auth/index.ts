import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Facebook from "next-auth/providers/facebook";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { findProvisionedUser } from "./oauth-allowlist";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Strict per-email login limiter — the generic API limiter (20/min) is too
// permissive for credential brute-forcing. 5 attempts per 10 minutes.
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function isLoginRateLimited(email: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(email.toLowerCase());
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(email.toLowerCase(), { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // 7-day sessions — a stolen JWT expires in a week, not a month.
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  pages: {
    signIn: "/admin/login",
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const { email, password } = parsed.data;

        if (isLoginRateLimited(email)) return null;

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        if (!user) return null;

        const passwordMatch = await bcrypt.compare(password, user.hashedPassword);
        if (!passwordMatch) return null;

        return {
          id: String(user.id),
          email: user.email,
          name: user.name ?? undefined,
          role: user.role,
        };
      },
    }),
    // Facebook OAuth only registers when credentials are configured — empty
    // strings create a broken provider that fails at use.
    ...(process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET
      ? [
          Facebook({
            clientId: process.env.FACEBOOK_CLIENT_ID,
            clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
          }),
        ]
      : []),
  ],
  callbacks: {
    // A-03: OAuth providers are open registries of identities — without a
    // gate, any Facebook account would mint a session that passes bare
    // auth() checks (all leads/PII, /admin pages). Admit only emails already
    // provisioned in `users`, and attach the real id + role so the JWT
    // session reflects the account's actual permissions.
    async signIn({ user, account }) {
      if (account?.provider === "credentials") return true;
      const email = user.email;
      if (!email) return false;
      try {
        const provisioned = await findProvisionedUser(email);
        if (!provisioned) return false;
        user.id = String(provisioned.id);
        user.role = provisioned.role;
        return true;
      } catch (err) {
        // Fail closed: a broken lookup denies the sign-in, never opens it.
        console.error("[auth] OAuth allowlist lookup failed:", err);
        return false;
      }
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role?: string }).role;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        (session.user as { role?: string }).role = token.role as string;
      }
      return session;
    },
  },
});
