import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Facebook from "next-auth/providers/facebook";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { clientIpFromRequest } from "@/lib/infra/rate-limit";
import { checkLoginThrottle } from "@/lib/auth/login-throttle";
import { lookupUserRole } from "@/lib/auth/session-users";
import { findProvisionedUser } from "./oauth-allowlist";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// F11: cost-12 bcrypt hash compared against whenever the email is unknown, so
// a nonexistent account costs the same ~100ms as a real one and returns the
// same generic null — no timing oracle, no distinct error.
const DUMMY_PASSWORD_HASH =
  "$2b$12$yJcZC9865qukHD1W2kpLdO7FurNpRDd5DeyH4H7nhdO4xDfoFKABS";

export const { handlers, auth, signIn, signOut } = NextAuth({
  // F9: 24h sessions — a stolen JWT is dead within a day, not a week.
  // (JWT logout remains client-side: there is no server denylist. The role
  // revalidation below is the revocation path for demoted/deleted users.)
  session: { strategy: "jwt", maxAge: 24 * 60 * 60 },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const email = parsed.data.email.toLowerCase().trim();
        const { password } = parsed.data;

        // F11: per-IP + per-email buckets (Redis when configured, bounded
        // in-memory otherwise). A single client gets 5 tries per account;
        // locking the admin out from the outside now requires sustained
        // multi-IP spend instead of 5 requests.
        const throttle = await checkLoginThrottle(clientIpFromRequest(request), email);

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        // Always pay exactly one bcrypt comparison — known users compare
        // against their hash, unknown ones against a constant dummy, so the
        // response timing and shape never reveal account existence.
        const passwordMatch = await bcrypt.compare(
          password,
          user?.hashedPassword ?? DUMMY_PASSWORD_HASH
        );

        if (!user || !passwordMatch) return null;

        if (!throttle.allowed) {
          // Correct credentials held back by a limiter = an admin being
          // locked out or a distributed attack succeeding — worth a signal.
          console.warn(
            `[auth] valid login blocked by rate limit (emailLimited=${throttle.emailLimited}, ipLimited=${throttle.ipLimited})`
          );
          return null;
        }

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
        return token;
      }

      // F9: the jwt callback runs on every auth() call — re-read the user's
      // row (60s TTL cache) so role changes propagate within a minute and a
      // deleted user loses the session entirely. Returning null makes
      // @auth/core clean the session cookie and auth() resolve to null, so
      // every gate (requireAdmin, layouts, proxy) fails closed without
      // per-site changes. On a DB error the minted claims stand: a blip must
      // not log everyone out.
      if (token.id === undefined || token.id === null) return null;
      const check = await lookupUserRole(token.id as string);
      if (check.status === "error") return token;
      if (check.role === null) return null;
      token.role = check.role;
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
