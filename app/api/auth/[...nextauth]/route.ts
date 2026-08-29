import { handlers } from '@/auth';

/**
 * The Drizzle adapter talks to Postgres over TCP, so this route cannot run on
 * the edge runtime.
 */
export const runtime = 'nodejs';

export const { GET, POST } = handlers;
