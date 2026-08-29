/**
 * `/api/targets` — connecting a repository to its deployed site (A1).
 *
 * `POST` does not just record a URL. A1.3 requires the application to fetch the
 * deployed URL and refuse with a stated reason when it does not answer 2xx, so
 * the check happens here, before the target exists. A target that cannot be
 * reached is not a target, and finding that out at run time — after the user
 * has walked away expecting a score — is the wrong moment.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@/lib/db';
import { runs, targets } from '@/lib/db/schema';
import { checkDeployedUrl } from '@/lib/pipeline/reachability';
import { currentUser, errorBody, UNAUTHORIZED } from '@/lib/pipeline/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `owner/repo`. GitHub allows letters, digits, dot, dash and underscore. */
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const CreateTarget = z.object({
  repoFullName: z
    .string()
    .trim()
    .regex(REPO, 'Repository must be in `owner/repo` form, for example `clearway/clearway`.'),
  deployedUrl: z.string().trim().min(1, 'A deployed URL is required.'),
});

/* -------------------------------------------------------------------------- */
/* GET — the signed-in user's targets                                         */
/* -------------------------------------------------------------------------- */

export async function GET(): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const rows = await db
    .select({
      id: targets.id,
      repoFullName: targets.repoFullName,
      deployedUrl: targets.deployedUrl,
      createdAt: targets.createdAt,
      runCount: sql<number>`count(${runs.id})::int`,
      lastRunAt: sql<string | null>`max(${runs.createdAt})`,
    })
    .from(targets)
    .leftJoin(runs, eq(runs.targetId, targets.id))
    .where(eq(targets.userId, user.id))
    .groupBy(targets.id)
    .orderBy(desc(targets.createdAt));

  return NextResponse.json({ targets: rows });
}

/* -------------------------------------------------------------------------- */
/* POST — create a target, but only if the deployment answers (A1.3)          */
/* -------------------------------------------------------------------------- */

export async function POST(request: Request): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      errorBody('Malformed request.', 'The request body was not valid JSON.'),
      { status: 400 },
    );
  }

  const parsed = CreateTarget.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ...errorBody(
          'Invalid target.',
          parsed.error.issues.map((issue) => issue.message).join(' '),
        ),
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const { repoFullName, deployedUrl } = parsed.data;

  /*
   * A1.3. The refusal states why, in prose the developer can act on: a 401 is
   * "the deployment is behind authentication", not "request failed".
   */
  const reachability = await checkDeployedUrl(deployedUrl);
  if (!reachability.ok) {
    return NextResponse.json(
      {
        ...errorBody('The deployed URL is not reachable.', reachability.reason),
        deployedUrl: reachability.url,
        status: reachability.status,
        requirement: 'A1.3',
      },
      { status: 422 },
    );
  }

  // Store the URL as it was reached, redirects followed, so the crawl starts
  // from the page that actually exists.
  const canonicalUrl = reachability.finalUrl ?? reachability.url;

  const [created] = await db
    .insert(targets)
    .values({ userId: user.id, repoFullName, deployedUrl: canonicalUrl })
    .onConflictDoNothing({
      target: [targets.userId, targets.repoFullName, targets.deployedUrl],
    })
    .returning();

  if (created) {
    return NextResponse.json(
      {
        target: created,
        reachability: {
          status: reachability.status,
          finalUrl: reachability.finalUrl,
          elapsedMs: reachability.elapsedMs,
        },
      },
      { status: 201 },
    );
  }

  // Already connected. Return it rather than erroring — reconnecting the same
  // repository and URL is a no-op, not a mistake.
  const [existing] = await db
    .select()
    .from(targets)
    .where(
      and(
        eq(targets.userId, user.id),
        eq(targets.repoFullName, repoFullName),
        eq(targets.deployedUrl, canonicalUrl),
      ),
    )
    .limit(1);

  return NextResponse.json(
    {
      target: existing,
      reachability: {
        status: reachability.status,
        finalUrl: reachability.finalUrl,
        elapsedMs: reachability.elapsedMs,
      },
      note: 'This repository and URL were already connected.',
    },
    { status: 200 },
  );
}
