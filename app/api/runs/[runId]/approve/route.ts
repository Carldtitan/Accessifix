/**
 * `/api/runs/{runId}/approve` — answering a handoff (A7).
 *
 * The agent never performs an irreversible action without human approval, so
 * this is the only door through which a paused run moves again. Two things
 * happen here, in this order, and the order matters:
 *
 *   1. **The `handoffs` row is answered.** That row *is* the wait — the
 *      conductor polls it — so recording the decision is what actually
 *      unblocks the run, and it works whether the conductor is in this process,
 *      another one, or not yet started after a restart (A7.4).
 *
 *   2. **TrueForge is told, when the pause came from the harness.** A pause on
 *      a write-class tool is resumed with a `user.tool_approval` input chained
 *      to the paused turn. The coordinates live on the job row, put there when
 *      the job paused.
 *
 * A decision on a handoff that has already been answered is not an error: it
 * returns the standing decision. Double-clicking approve must not approve
 * twice.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { approveToolCall } from '@/lib/harness/run';
import { currentUser, errorBody, NOT_FOUND, runForUser, UNAUTHORIZED } from '@/lib/pipeline/access';
import { answerHandoff, loadHandoff, pendingHandoffs } from '@/lib/pipeline/handoff';
import { findJobByHandoff } from '@/lib/pipeline/jobs';
import { emitEvent } from '@/lib/pipeline/events';
import { isRunning } from '@/lib/pipeline/orchestrate';
import { resumeRun } from '@/lib/pipeline/resume';
import { readState } from '@/lib/pipeline/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Decision = z.object({
  /** Omit to answer the run's single pending handoff. */
  handoffId: z.string().optional(),
  decision: z.enum(['approve', 'reject']),
  /**
   * The human's words. On a rejection this is passed to the agent as the deny
   * reason, so it is told *why* rather than merely refused.
   */
  reason: z.string().trim().max(4000).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const { runId } = await params;

  const owned = await runForUser(runId, user.id);
  if (!owned) return NextResponse.json(NOT_FOUND, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      errorBody('Malformed request.', 'The request body was not valid JSON.'),
      { status: 400 },
    );
  }

  const parsed = Decision.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ...errorBody(
          'Invalid decision.',
          parsed.error.issues.map((issue) => issue.message).join(' '),
        ),
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const approved = parsed.data.decision === 'approve';

  /* ---- Which handoff? ---------------------------------------------------- */

  let handoffId: string;

  if (parsed.data.handoffId) {
    handoffId = parsed.data.handoffId;
  } else {
    // No id given: answer the run's single pending handoff, or refuse to guess.
    const pending = await pendingHandoffs(runId);
    if (pending.length === 0) {
      return NextResponse.json(
        errorBody('Nothing to approve.', 'This run has no pending handoff.'),
        { status: 409 },
      );
    }
    if (pending.length > 1) {
      return NextResponse.json(
        {
          ...errorBody(
            'More than one handoff is pending.',
            'Name the one you are answering with `handoffId`.',
          ),
          pending: pending.map((row) => ({ id: row.id, intent: row.intent })),
        },
        { status: 409 },
      );
    }
    handoffId = pending[0].id;
  }

  const handoff = await loadHandoff(handoffId);
  // Cross-run handoff ids are refused: the handoff must belong to *this* run,
  // which is the run already scoped to the signed-in user.
  if (!handoff || handoff.runId !== runId) {
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }

  if (handoff.status !== 'pending') {
    return NextResponse.json(
      {
        handoff,
        applied: false,
        note: `This handoff was already ${handoff.status}.`,
      },
      { status: 200 },
    );
  }

  /* ---- 1. Record the decision. This is what releases the run. ------------- */

  const decision = await answerHandoff(handoffId, approved, {
    response: parsed.data.reason ?? null,
  });

  if (!decision) return NextResponse.json(NOT_FOUND, { status: 404 });

  /* ---- 2. Tell TrueForge, when the pause was a harness tool gate. --------- */

  const job = await findJobByHandoff(handoffId);
  let harness: { forwarded: boolean; reason: string } = {
    forwarded: false,
    reason: 'Application-side handoff; no TrueForge tool call to answer.',
  };

  if (job?.sessionId && job.turnId && job.threadId && job.toolCallId) {
    try {
      await approveToolCall(
        job.sessionId,
        job.turnId,
        { threadId: job.threadId, toolCallId: job.toolCallId },
        approved,
        { reason: parsed.data.reason },
      );
      harness = { forwarded: true, reason: `Answered tool call ${job.toolCallId}.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      harness = { forwarded: false, reason: `Could not reach TrueForge: ${message}` };

      await emitEvent({
        runId,
        type: 'error',
        capability: 'approval',
        summary: 'The decision was recorded but TrueForge could not be told.',
        detail: `${message} The run may need to be resumed once the harness is reachable.`,
        data: { handoffId, sessionId: job.sessionId, turnId: job.turnId },
      });
    }
  }

  /* ---- 3. If nothing is conducting this run, pick it back up. ------------- */

  let resumed = false;
  if (!isRunning(runId)) {
    // The conductor died while waiting — a restart, a redeploy. The answer is
    // recorded, so resuming re-enters the wait and reads it immediately (A7.4).
    const outcome = await resumeRun(runId);
    resumed = outcome.resumed;
  }

  const state = await readState(runId);

  return NextResponse.json({
    handoff: decision.handoff,
    approved,
    applied: true,
    harness,
    resumed,
    run: {
      id: runId,
      state: state.state,
      pausedFrom: state.pausedFrom,
      phase: state.phase,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* GET — what is waiting (A7.2, A7.5)                                         */
/* -------------------------------------------------------------------------- */

/**
 * The handoff queue for one run: what the agent intends to do, why, and the
 * evidence behind it. Prose, not a raw tool payload (A7.3).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json(UNAUTHORIZED, { status: 401 });

  const { runId } = await params;

  const owned = await runForUser(runId, user.id);
  if (!owned) return NextResponse.json(NOT_FOUND, { status: 404 });

  const pending = await pendingHandoffs(runId);
  const now = Date.now();

  return NextResponse.json({
    handoffs: pending.map((row) => ({
      id: row.id,
      kind: row.kind,
      intent: row.intent,
      reason: row.reason,
      evidenceIds: row.evidenceIds,
      createdAt: row.createdAt,
      /** A7.5: how long it has gone unanswered, so the interface can remind. */
      waitingMs: now - row.createdAt.getTime(),
    })),
    state: owned.run.status,
  });
}
