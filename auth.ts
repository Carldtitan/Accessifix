/**
 * Auth.js v5, GitHub only (A1.1).
 *
 * The `repo` scope is what lets AccessiFix push a branch and open a pull
 * request as the signed-in user rather than as a bot (A1.4). The GitHub access
 * token is carried on the JWT and exposed on the session so the PR step can
 * reach it; it is also persisted in the `accounts` table by the adapter, which
 * is where a background job should read it from.
 *
 * Environment: `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`.
 */
import NextAuth, { type DefaultSession } from 'next-auth';
import GitHub from 'next-auth/providers/github';

import { DrizzleAdapter } from '@/lib/db/auth-adapter';
import { db } from '@/lib/db';

/** Everything AccessiFix needs to open a pull request on the user's behalf. */
export const GITHUB_SCOPE = 'repo read:user user:email';

declare module 'next-auth' {
  interface Session {
    /** The user's own GitHub OAuth token. Server-side use only. */
    accessToken?: string;
    user: {
      id: string;
    } & DefaultSession['user'];
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    accessToken?: string;
    userId?: string;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db),
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
    jwt({ token, account, user }) {
      // `account` is present only on the sign-in turn.
      if (account?.access_token) {
        token.accessToken = account.access_token;
      }
      if (typeof user?.id === 'string') {
        token.userId = user.id;
      }
      return token;
    },
    session({ session, token }) {
      if (typeof token.userId === 'string') {
        session.user.id = token.userId;
      }
      session.accessToken =
        typeof token.accessToken === 'string' ? token.accessToken : undefined;
      return session;
    },
  },
});

/**
 * The signed-in user's GitHub token, or `null` when nobody is signed in.
 * A1.4: pull requests are opened with this, never with a shared bot token.
 */
export async function getGitHubAccessToken(): Promise<string | null> {
  const session = await auth();
  return session?.accessToken ?? null;
}
