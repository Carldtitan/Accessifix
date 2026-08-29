/**
 * Auth.js v5, GitHub only (A1.1).
 *
 * The `repo` scope is what lets AccessiFix push a branch and open a pull
 * request as the signed-in user rather than as a bot (A1.4).
 *
 * The GitHub access token is deliberately NOT placed on the session. The
 * session object is serialised to the browser, and a `repo`-scoped token in
 * client-reachable state is a full account compromise if any script reads it.
 * The token lives only in the `accounts` row and is read server-side via
 * `getGitHubAccessToken()`.
 *
 * Environment: `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`.
 */
import NextAuth, { type DefaultSession } from 'next-auth';
import GitHub from 'next-auth/providers/github';

import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { accounts, sessions, users } from '@/lib/db/schema';

/** Everything AccessiFix needs to open a pull request on the user's behalf. */
export const GITHUB_SCOPE = 'repo read:user user:email';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
    } & DefaultSession['user'];
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    userId?: string;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
  }),
  trustHost: process.env.AUTH_TRUST_HOST === 'true' || Boolean(process.env.VERCEL),
  /**
   * JWT sessions, not database sessions. The adapter still writes `users` and
   * `accounts` - we need the persisted GitHub token - but the session itself
   * rides in the cookie so a run view does not hit the pooler on every poll.
   */
  session: { strategy: 'jwt' },
  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET,
      authorization: { params: { scope: GITHUB_SCOPE } },
    }),
  ],
  callbacks: {
    /**
     * The token is NOT put on the JWT. The JWT is decodable by the browser, so
     * a `repo`-scoped token there is client-reachable. Only the user id rides
     * along; the token is read from `accounts` server-side when needed.
     */
    jwt({ token, user }) {
      if (typeof user?.id === 'string') {
        token.userId = user.id;
      }
      return token;
    },
    session({ session, token }) {
      if (typeof token.userId === 'string') {
        session.user.id = token.userId;
      }
      return session;
    },
    /**
     * A5/A1.4: refresh the stored token on EVERY sign-in, not just the first.
     * `linkAccount` fires only when an account row is created, so without this
     * a re-sign-in after a revoke leaves a dead token in the database and PR
     * creation fails with a confusing 401 much later.
     */
    async signIn({ account, user }) {
      if (account?.provider === 'github' && account.access_token && user?.id) {
        await db
          .update(accounts)
          .set({
            access_token: account.access_token,
            expires_at: account.expires_at ?? null,
            refresh_token: account.refresh_token ?? null,
            scope: account.scope ?? null,
            token_type: account.token_type ?? null,
          })
          .where(
            and(
              eq(accounts.provider, 'github'),
              eq(accounts.providerAccountId, account.providerAccountId),
            ),
          );
      }
      return true;
    },
  },
});

/**
 * The signed-in user's GitHub token, or `null` when nobody is signed in.
 * A1.4: pull requests are opened with this, never with a shared bot token.
 */
export async function getGitHubAccessToken(): Promise<string | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;

  const [row] = await db
    .select({ token: accounts.access_token })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, 'github')))
    .limit(1);

  return row?.token ?? null;
}
