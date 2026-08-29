/**
 * Ownership scoping for every API route, and the background job's route to the
 * user's GitHub token.
 *
 * One rule, applied without exception: **a query is scoped to the signed-in
 * user or it does not run.** A run id is a UUID, not a capability — guessing
 * one must not disclose another user's audit, so every read joins through
 * `targets.user_id` rather than trusting the id in the URL.
 */
import { and, eq } from 'drizzle-orm';

import { auth } from '@/auth';
import { db } from '@/lib/db';
import { accounts, runs, targets, type Run, type Target } from '@/lib/db/schema';

export interface SignedInUser {
  id: string;
  email: string | null | undefined;
}

/** The signed-in user, or `null`. Routes turn `null` into a 401. */
export async function currentUser(): Promise<SignedInUser | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  return { id, email: session.user.email };
}

export interface OwnedRun {
  run: Run;
  target: Target;
}

/**
 * A run the signed-in user owns, or `null`.
 *
 * `null` covers both "no such run" and "not yours" on purpose: distinguishing
 * them would confirm the existence of another user's run.
 */
export async function runForUser(runId: string, userId: string): Promise<OwnedRun | null> {
  if (!isUuid(runId)) return null;

  const [row] = await db
    .select({ run: runs, target: targets })
    .from(runs)
    .innerJoin(targets, eq(runs.targetId, targets.id))
    .where(and(eq(runs.id, runId), eq(targets.userId, userId)))
    .limit(1);

  return row ?? null;
}

/** A target the signed-in user owns, or `null`. */
export async function targetForUser(targetId: string, userId: string): Promise<Target | null> {
  if (!isUuid(targetId)) return null;

  const [row] = await db
    .select()
    .from(targets)
    .where(and(eq(targets.id, targetId), eq(targets.userId, userId)))
    .limit(1);

  return row ?? null;
}

/**
 * The user's own GitHub token, read from the `accounts` table (A1.4).
 *
 * `getGitHubAccessToken()` in `auth.ts` reads the session cookie, which a
 * background job does not have. The adapter persists the token on sign-in
 * precisely so the pipeline can reach it here, long after the request that
 * started the run has been answered.
 */
export async function githubTokenForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ token: accounts.access_token })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, 'github')))
    .limit(1);

  return row?.token ?? null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/* -------------------------------------------------------------------------- */
/* Route helpers                                                              */
/* -------------------------------------------------------------------------- */

/** A JSON error body with a stated reason. Never a bare status code. */
export function errorBody(error: string, reason?: string): Record<string, unknown> {
  return reason ? { error, reason } : { error };
}

export const UNAUTHORIZED = errorBody(
  'Not signed in.',
  'Sign in with GitHub to reach this endpoint.',
);

export const NOT_FOUND = errorBody(
  'Not found.',
  'No such resource, or it does not belong to the signed-in account.',
);
