/**
 * `/api/runs` — starting and listing runs.
 *
 * `POST` starts the pipeline and returns immediately. A baseline over 25 pages
 * takes minutes; holding the HTTP response open for it would time out on every
 * platform and tell the user nothing while it did. The response carries the run
 * id, and the browser watches `/api/runs/{id}/events` from there.
 *
 * The deployed URL is re-checked here even though `/api/targets` checked it at
 * connection time (A1.3). A target connected an hour ago may be a 502 now, and
 * "refuse to start a run" is what the requirement asks for — not "refuse to
 * connect a target".
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { db } from '@/lib/db';
import { findings, runs, targets, RUN_STATUSES } from '@/lib/db/schema';
import { currentUser, errorBody, targetForUser, UNAUTHORIZED } from '@/lib/pipeline/access';
import { startRun } from '@/lib/pipeline/orchestrate';
import { checkDeployedUrl } from '@/lib/pipeline/reachability';
import { DEFAULT_MAX_CONCURRENT_SANDBOXES, MAX_PAGES_PER_CRAWL } from '@/lib/sandbox/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const StartRun = z.object({
  targetId: z.string().regex(UUID, 'targetId must be a UUID.'),
  /** Sandbox budget for this run. Never derived from `nproc`. */
  maxSandboxes: z.number().int().min(1).max(50).optional(),
  /** Page cap for the crawl. Clamped to the configured ceiling. */
  maxPages: z.number().int().min(1).max(MAX_PAGES_PER_CRAWL).optional(),
  /** Stop after the baseline score. A12.3: a baseline can be run ahead of time. */
  baselineOnly: z.boolean().optional(),
});

/* -------------------------------------------------------------------------- */
/* GET — the signed-in user's runs                                            */
/* -------------------------------------------------------------------------- */

export async function GET(request: Request): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const params = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(params.get('limit') ?? 50) || 50, 1), 200);

  const clauses = [eq(targets.userId, user.id)];

  const targetId = params.get('targetId');
  if (targetId) clauses.push(eq(runs.targetId, targetId));

  const status = params.getAll('status').filter((value) => (RUN_STATUSES as readonly string[]).includes(value));
  if (status.length > 0) {
    clauses.push(inArray(runs.status, status as (typeof RUN_STATUSES)[number][]));
  }

  const rows = await db
    .select({
      id: runs.id,
      targetId: runs.targetId,
      repoFullName: targets.repoFullName,
      deployedUrl: targets.deployedUrl,
      phase: runs.phase,
      status: runs.status,
      maxSandboxes: runs.maxSandboxes,
      sandboxesUsed: runs.sandboxesUsed,
      failureReason: runs.failureReason,
      startedAt: runs.startedAt,
      completedAt: runs.completedAt,
      createdAt: runs.createdAt,
      findingCount: sql<number>`(
        select count(*)::int from ${findings} where ${findings.runId} = ${runs.id}
      )`,
    })
    .from(runs)
    .innerJoin(targets, eq(runs.targetId, targets.id))
    .where(and(...clauses))
    .orderBy(desc(runs.createdAt))
    .limit(limit);

  return NextResponse.json({ runs: rows });
}

/* -------------------------------------------------------------------------- */
/* POST — start a run                                                         */
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

  const parsed = StartRun.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ...errorBody(
          'Invalid run request.',
          parsed.error.issues.map((issue) => issue.message).join(' '),
        ),
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  // Scoped to the signed-in user: a target id from another account is a 404,
  // not a 403, so its existence is not confirmed.
  const target = await targetForUser(parsed.data.targetId, user.id);
  if (!target) {
    return NextResponse.json(
      errorBody('Target not found.', 'No such target, or it belongs to another account.'),
      { status: 404 },
    );
  }

  // A1.3: refuse to start, and say why.
  const reachability = await checkDeployedUrl(target.deployedUrl);
  if (!reachability.ok) {
    return NextResponse.json(
      {
        ...errorBody('Cannot start a run.', reachability.reason),
        deployedUrl: target.deployedUrl,
        status: reachability.status,
        requirement: 'A1.3',
      },
      { status: 422 },
    );
  }

  const [run] = await db
    .insert(runs)
    .values({
      targetId: target.id,
      // Every run opens in `baseline`. The conductor flips it to `final` after
      // verification, so the A8 delta is one query over one run.
      phase: 'baseline',
      status: 'queued',
      maxSandboxes: parsed.data.maxSandboxes ?? DEFAULT_MAX_CONCURRENT_SANDBOXES,
    })
    .returning();

  // Long work must not block the response. Start it and return.
  const { started } = startRun(run.id, {
    baselineOnly: parsed.data.baselineOnly,
    maxPages: parsed.data.maxPages,
  });

  return NextResponse.json(
    {
      run,
      started,
      target: { id: target.id, repoFullName: target.repoFullName, deployedUrl: target.deployedUrl },
      events: `/api/runs/${run.id}/events`,
    },
    { status: 202 },
  );
}
