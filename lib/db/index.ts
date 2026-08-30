/**
 * The Drizzle client.
 *
 * The connection is a Supabase **session pooler** on port 5432, not the
 * transaction pooler on 6543. Two consequences, both handled here:
 *
 *   - `prepare: false`. The pooler can hand a later query to a different
 *     backend, where a named prepared statement does not exist. postgres-js
 *     would then fail with `prepared statement "..." does not exist`.
 *   - A small `max`. Serverless functions multiply connections; the pooler has
 *     a hard ceiling and will refuse the surplus.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { sslModeFor } from './env';
import * as schema from './schema';

export * as schema from './schema';
export * from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env.local and paste the Supabase session pooler URI (port 5432).',
  );
}

/**
 * Next.js dev reloads this module on every edit. Without a global cache each
 * reload opens a fresh pool and the pooler runs out of connections.
 */
const globalForDb = globalThis as unknown as { accessifixSql?: postgres.Sql };

const client =
  globalForDb.accessifixSql ??
  postgres(connectionString, {
    // Required for the Supabase session pooler.
    prepare: false,
    /*
     * One connection per serverless instance, five for a long-lived server.
     *
     * Supabase's poolers have a hard client ceiling — 15 on this project — and
     * a serverless host multiplies instances rather than reusing one process.
     * At `max: 5` a handful of concurrent requests exhausted it and every query
     * failed with `EMAXCONNSESSION`, which surfaced as "This page couldn't
     * load" on a deployment that was otherwise healthy. A serverless instance
     * handles one request at a time, so a pool of one costs it nothing.
     */
    max: process.env.VERCEL ? 1 : 5,
    idle_timeout: 20,
    connect_timeout: 15,
    ssl: sslModeFor(connectionString),
  });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.accessifixSql = client;
}

export type AccessifixDatabase = PostgresJsDatabase<typeof schema>;

export const db: AccessifixDatabase = drizzle(client, { schema });

/**
 * The raw postgres-js handle, for the rare query Drizzle cannot express.
 * Deliberately not named `sql` - that name belongs to drizzle-orm's template tag.
 */
export const pgClient = client;

/** Scripts must close the pool or the process hangs. The app never calls this. */
export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 });
}
