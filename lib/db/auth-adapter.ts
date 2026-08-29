/**
 * A Drizzle adapter for Auth.js v5.
 *
 * This is deliberately hand-rolled rather than pulled from
 * `@auth/drizzle-adapter`: that package is not in the dependency set, and the
 * adapter contract is small enough that owning it costs less than owning
 * another dependency. The tables in `schema.ts` keep the exact property names
 * the official adapter expects, so swapping to it later is:
 *
 *     DrizzleAdapter(db, { usersTable: users, accountsTable: accounts,
 *                          sessionsTable: sessions })
 *
 * Verification-token methods are omitted. They are optional in the `Adapter`
 * contract and are only used by the email provider, which AccessiFix does not
 * offer - GitHub OAuth is the only way in (A1.1).
 */
import { and, eq } from 'drizzle-orm';
import type {
  Adapter,
  AdapterAccount,
  AdapterSession,
  AdapterUser,
} from 'next-auth/adapters';

import type { AccessifixDatabase } from './index';
import { accounts, sessions, users, type User } from './schema';

/**
 * `AdapterAccount` carries an index signature of `unknown`, so token fields
 * have to be narrowed rather than assumed.
 */
function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function toAdapterUser(row: User): AdapterUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerified,
    image: row.image,
  };
}

function accountValues(account: AdapterAccount) {
  return {
    userId: account.userId,
    type: account.type,
    provider: account.provider,
    providerAccountId: account.providerAccountId,
    refresh_token: asText(account.refresh_token),
    access_token: asText(account.access_token),
    expires_at: asInt(account.expires_at),
    token_type: asText(account.token_type),
    scope: asText(account.scope),
    id_token: asText(account.id_token),
    session_state: asText(account.session_state),
  };
}

export function DrizzleAdapter(db: AccessifixDatabase): Adapter {
  return {
    async createUser(data: AdapterUser): Promise<AdapterUser> {
      const [row] = await db
        .insert(users)
        .values({
          id: data.id,
          name: data.name ?? null,
          email: data.email,
          emailVerified: data.emailVerified ?? null,
          image: data.image ?? null,
        })
        .returning();
      return toAdapterUser(row);
    },

    async getUser(id: string): Promise<AdapterUser | null> {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row ? toAdapterUser(row) : null;
    },

    async getUserByEmail(email: string): Promise<AdapterUser | null> {
      const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      return row ? toAdapterUser(row) : null;
    },

    async getUserByAccount(
      providerAccount: Pick<AdapterAccount, 'provider' | 'providerAccountId'>,
    ): Promise<AdapterUser | null> {
      const [row] = await db
        .select({ user: users })
        .from(accounts)
        .innerJoin(users, eq(accounts.userId, users.id))
        .where(
          and(
            eq(accounts.provider, providerAccount.provider),
            eq(accounts.providerAccountId, providerAccount.providerAccountId),
          ),
        )
        .limit(1);
      return row ? toAdapterUser(row.user) : null;
    },

    async updateUser(
      data: Partial<AdapterUser> & Pick<AdapterUser, 'id'>,
    ): Promise<AdapterUser> {
      const [row] = await db
        .update(users)
        .set({
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.email !== undefined ? { email: data.email } : {}),
          ...(data.emailVerified !== undefined ? { emailVerified: data.emailVerified } : {}),
          ...(data.image !== undefined ? { image: data.image } : {}),
        })
        .where(eq(users.id, data.id))
        .returning();
      if (!row) throw new Error(`Cannot update unknown user ${data.id}.`);
      return toAdapterUser(row);
    },

    async deleteUser(userId: string): Promise<void> {
      await db.delete(users).where(eq(users.id, userId));
    },

    /**
     * Upsert rather than insert. GitHub hands back a fresh `access_token` on
     * every sign-in and A1.4 opens pull requests with it, so the stored token
     * must be the newest one.
     */
    async linkAccount(account: AdapterAccount): Promise<void> {
      const values = accountValues(account);
      await db
        .insert(accounts)
        .values(values)
        .onConflictDoUpdate({
          target: [accounts.provider, accounts.providerAccountId],
          set: {
            userId: values.userId,
            type: values.type,
            refresh_token: values.refresh_token,
            access_token: values.access_token,
            expires_at: values.expires_at,
            token_type: values.token_type,
            scope: values.scope,
            id_token: values.id_token,
            session_state: values.session_state,
          },
        });
    },

    async unlinkAccount(
      providerAccount: Pick<AdapterAccount, 'provider' | 'providerAccountId'>,
    ): Promise<void> {
      await db
        .delete(accounts)
        .where(
          and(
            eq(accounts.provider, providerAccount.provider),
            eq(accounts.providerAccountId, providerAccount.providerAccountId),
          ),
        );
    },

    async createSession(session: AdapterSession): Promise<AdapterSession> {
      const [row] = await db.insert(sessions).values(session).returning();
      return row;
    },

    async getSessionAndUser(
      sessionToken: string,
    ): Promise<{ session: AdapterSession; user: AdapterUser } | null> {
      const [row] = await db
        .select({ session: sessions, user: users })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(eq(sessions.sessionToken, sessionToken))
        .limit(1);
      return row ? { session: row.session, user: toAdapterUser(row.user) } : null;
    },

    async updateSession(
      data: Partial<AdapterSession> & Pick<AdapterSession, 'sessionToken'>,
    ): Promise<AdapterSession | null> {
      const [row] = await db
        .update(sessions)
        .set({
          ...(data.userId !== undefined ? { userId: data.userId } : {}),
          ...(data.expires !== undefined ? { expires: data.expires } : {}),
        })
        .where(eq(sessions.sessionToken, data.sessionToken))
        .returning();
      return row ?? null;
    },

    async deleteSession(sessionToken: string): Promise<void> {
      await db.delete(sessions).where(eq(sessions.sessionToken, sessionToken));
    },
  };
}
