/**
 * `/api/runs/{runId}` — one run, with its score and its phase.
 *
 * This is the run view's first paint: state, phase, sandbox occupancy against
 * the cap (A11.2), the criterion matrix (A2.5), the delta once a final phase
 * exists (A8.2), and any pending handoff (A7.5).
 *
 * Next 16: `params` is a Promise.
 */
import { desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { db } from '@/lib/db';
import { pages, patches } from '@/lib/db/schema';
import { currentUser, NOT_FOUND, runForUser, UNAUTHORIZED } from '@/lib/pipeline/access';
import { pendingHandoffs } from '@/lib/pipeline/handoff';
import { listJobs } from '@/lib/pipeline/jobs';
import { scoreDelta, scoreRun } from '@/lib/pipeline/score';
import { isRunning } from '@/lib/pipeline/orchestrate';
import { readState } from '@/lib/pipeline/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const { runId } = await params;

  // Scoped through `targets.user_id`: a run id is not a capability.
  const owned = await runForUser(runId, user.id);
  if (!owned) return NextResponse.json(NOT_FOUND, { status: 404 });

  const url = new URL(request.url);
  const wantJobs = url.searchParams.get('jobs') === 'true';

  const [{ state, pausedFrom }, baseline, pageRows, patchRows, handoffRows] = await Promise.all([
    readState(runId),
    scoreRun(runId, 'baseline'),
    db.select().from(pages).where(eq(pages.runId, runId)).orderBy(pages.crawledAt),
    db.select().from(patches).where(eq(patches.runId, runId)).orderBy(desc(patches.createdAt)),
    pendingHandoffs(runId),
  ]);

  // The delta only exists once the final audit has written rows. Computing it
  // early would report every criterion as a regression.
  const final = owned.run.phase === 'final' ? await scoreRun(runId, 'final') : null;
  const delta = final && final.totalFindings > 0 ? await scoreDelta(runId) : null;

  const jobs = wantJobs ? await listJobs(runId) : undefined;

  return NextResponse.json({
    run: {
      id: owned.run.id,
      targetId: owned.run.targetId,
      phase: owned.run.phase,
      state,
      /** Present only while paused: the state the run returns to (A7.4). */
      pausedFrom,
      status: owned.run.status,
      inFlight: isRunning(runId),
      maxSandboxes: owned.run.maxSandboxes,
      sandboxesUsed: owned.run.sandboxesUsed,
      failureReason: owned.run.failureReason,
      startedAt: owned.run.startedAt,
      completedAt: owned.run.completedAt,
      createdAt: owned.run.createdAt,
    },
    target: {
      id: owned.target.id,
      repoFullName: owned.target.repoFullName,
      deployedUrl: owned.target.deployedUrl,
    },
    score: baseline,
    finalScore: final,
    delta,
    pages: pageRows,
    patches: patchRows,
    /** A7.5: an unanswered handoff is surfaced rather than left to be noticed. */
    pendingHandoffs: handoffRows,
    ...(jobs ? { jobs } : {}),
  });
}
