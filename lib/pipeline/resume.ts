/**
 * Resumability (A12, A13.8).
 *
 * "A run interrupted: the ledger holds phase and session identifiers; the run
 * resumes." Nothing here reconstructs state from memory, because after a
 * restart there is no memory. Everything is read back out of three places:
 *
 *   - `runs`          the state and the phase
 *   - `run_events`    the state history, which is how a paused run learns which
 *                     state it was paused *from*
 *   - `pipeline_jobs` the unit-of-work rows, each carrying the TrueForge
 *                     `session_id` that lets a restart **reattach** to a turn
 *                     still running on the harness instead of paying for it
 *                     again (A12.1)
 *
 * The distinction that matters: a job row with a `session_id` and status
 * `running` is not lost work. TrueForge is still holding that session. The
 * restart polls it with `waitForTurn` and picks up the answer.
 */
import { and, eq, inArray } from 'drizzle-orm';

import { getTrueForgeClient, requiredActionsOf } from '@/lib/harness/client';
import { waitForTurn } from '@/lib/harness/run';
import { db } from '@/lib/db';
import { findings, handoffs, pages, runs, targets, type Handoff, type Page, type Run, type Target } from '@/lib/db/schema';

import { emitEvent } from './events';
import { failJob, listJobs } from './jobs';
import { isRunning, startRun, type RunPipelineOptions } from './orchestrate';
import {
  isTerminal,
  readState,
  RESUMABLE_STATES,
  stateRank,
  type PipelineState,
} from './state';
import { pipelineJobs, type PipelineJob, type PipelinePhase } from './schema';

/* -------------------------------------------------------------------------- */
/* Snapshot                                                                   */
/* -------------------------------------------------------------------------- */

export interface ReattachableSession {
  jobId: string;
  phase: PipelinePhase;
  jobKey: string;
  agent: string | null;
  sessionId: string;
  turnId: string | null;
}

export interface ResumeSnapshot {
  run: Run;
  target: Target;
  state: PipelineState;
  /** For a paused run, the state it returns to once the handoff is answered. */
  pausedFrom: PipelineState | null;
  /** How far the run got, as a position in `STATE_ORDER`. */
  rank: number;
  pages: Page[];
  jobs: PipelineJob[];
  /** Jobs that were mid-flight when the process died. */
  inFlight: PipelineJob[];
  /** Of those, the ones with a TrueForge session a restart can reattach to. */
  reattachable: ReattachableSession[];
  pendingHandoffs: Handoff[];
  findingsByPhase: { baseline: number; final: number };
  /** True when the run can be picked up again. */
  resumable: boolean;
  /** Why not, when `resumable` is false. */
  reason: string;
}

/**
 * Everything needed to decide what to do with an interrupted run, read from the
 * database alone.
 */
export async function loadResumeSnapshot(runId: string): Promise<ResumeSnapshot | null> {
  const [row] = await db
    .select({ run: runs, target: targets })
    .from(runs)
    .innerJoin(targets, eq(runs.targetId, targets.id))
    .where(eq(runs.id, runId))
    .limit(1);

  if (!row) return null;

  const [{ state, pausedFrom }, pageRows, jobRows, handoffRows, findingRows] = await Promise.all([
    readState(runId),
    db.select().from(pages).where(eq(pages.runId, runId)),
    listJobs(runId),
    db
      .select()
      .from(handoffs)
      .where(and(eq(handoffs.runId, runId), eq(handoffs.status, 'pending'))),
    db.select({ phase: findings.phase }).from(findings).where(eq(findings.runId, runId)),
  ]);

  const inFlight = jobRows.filter(
    (job) => job.status === 'running' || job.status === 'awaiting_approval',
  );

  const reattachable: ReattachableSession[] = inFlight
    .filter((job): job is PipelineJob & { sessionId: string } => Boolean(job.sessionId))
    .map((job) => ({
      jobId: job.id,
      phase: job.phase,
      jobKey: job.jobKey,
      agent: job.agent,
      sessionId: job.sessionId,
      turnId: job.turnId,
    }));

  const findingsByPhase = { baseline: 0, final: 0 };
  for (const finding of findingRows) findingsByPhase[finding.phase] += 1;

  const resumable = RESUMABLE_STATES.includes(state);

  return {
    run: row.run,
    target: row.target,
    state,
    pausedFrom,
    rank: stateRank(state, pausedFrom),
    pages: pageRows,
    jobs: jobRows,
    inFlight,
    reattachable,
    pendingHandoffs: handoffRows,
    findingsByPhase,
    resumable,
    reason: resumable
      ? `Run is ${state} and can be resumed.`
      : `Run is ${state}; there is nothing to resume.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Reattach                                                                   */
/* -------------------------------------------------------------------------- */

export interface ReattachOutcome {
  jobId: string;
  sessionId: string;
  /** `finished` the turn completed, `paused` it is waiting on a human,
   *  `gone` the harness no longer knows the session, `running` still working. */
  status: 'finished' | 'paused' | 'running' | 'gone';
  detail: string;
}

/**
 * Reattach to the TrueForge sessions an interrupted run left behind (A12.1).
 *
 * This is the difference between resuming and restarting. A session that is
 * still alive on the harness has already been paid for; the restart's job is to
 * collect the answer, not to ask the question again. A session the harness has
 * forgotten fails its job row, and the phase re-runs it.
 *
 * Never throws: a failure to reattach degrades to re-running the job.
 */
export async function reattachSessions(
  runId: string,
  sessions: readonly ReattachableSession[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ReattachOutcome[]> {
  if (sessions.length === 0) return [];

  const client = getTrueForgeClient();
  const outcomes: ReattachOutcome[] = [];

  for (const session of sessions) {
    try {
      if (!session.turnId) {
        // A session with no recorded turn cannot be polled. The work is redone.
        await failJob(session.jobId, 'Session recorded with no turn to reattach to.');
        outcomes.push({
          jobId: session.jobId,
          sessionId: session.sessionId,
          status: 'gone',
          detail: 'No turn id was recorded; the job will be re-run.',
        });
        continue;
      }

      const turn = await waitForTurn(session.sessionId, session.turnId, {
        client,
        timeoutMs: options.timeoutMs ?? 60_000,
        signal: options.signal,
      });

      /*
       * TrueForge's `done` covers both "finished" and "finished but waiting on
       * a human" — the difference is whether the turn carries required actions
       * (A7.1). Anything still `running` stays running; `error` and `cancelled`
       * mean the session is no longer usable and the job is re-run.
       */
      const actions = requiredActionsOf(turn);
      const status: ReattachOutcome['status'] =
        turn.state.status === 'done'
          ? actions.length > 0
            ? 'paused'
            : 'finished'
          : turn.state.status === 'running'
            ? 'running'
            : 'gone';

      if (status === 'gone') {
        await failJob(
          session.jobId,
          `TrueForge turn ended as "${turn.state.status}"; the job will be re-run.`,
        );
      }

      outcomes.push({
        jobId: session.jobId,
        sessionId: session.sessionId,
        status,
        detail: `Turn ${session.turnId} is ${turn.state.status}${actions.length > 0 ? `, waiting on ${actions.length} action(s)` : ''}.`,
      });

      await emitEvent({
        runId,
        type: 'job',
        agent: session.agent ?? 'APP',
        capability: 'subagent',
        summary: `Reattached to TrueForge session ${session.sessionId.slice(0, 8)} for ${session.phase}.`,
        detail: `Turn ${session.turnId} is ${turn.state.status}. The run resumed rather than restarting (A12.1).`,
        data: { jobId: session.jobId, sessionId: session.sessionId, phase: session.phase },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await failJob(session.jobId, `Could not reattach: ${reason}`);
      outcomes.push({
        jobId: session.jobId,
        sessionId: session.sessionId,
        status: 'gone',
        detail: reason,
      });

      await emitEvent({
        runId,
        type: 'log',
        agent: session.agent ?? 'APP',
        summary: `TrueForge session ${session.sessionId.slice(0, 8)} could not be reattached.`,
        detail: `${reason} The ${session.phase} job will be re-run.`,
      });
    }
  }

  return outcomes;
}

/* -------------------------------------------------------------------------- */
/* Resume                                                                     */
/* -------------------------------------------------------------------------- */

export interface ResumeResult {
  runId: string;
  resumed: boolean;
  state: PipelineState;
  reason: string;
  reattached: ReattachOutcome[];
}

/**
 * Pick an interrupted run back up.
 *
 * Order matters:
 *   1. reattach to live TrueForge sessions, so nothing already paid for is
 *      thrown away;
 *   2. release job rows the dead process left `running`, so the conductor is
 *      free to redo only what was actually lost;
 *   3. hand the run back to `startRun`, which skips every state it is already
 *      past and every job row that already succeeded.
 */
export async function resumeRun(
  runId: string,
  options: RunPipelineOptions = {},
): Promise<ResumeResult> {
  const snapshot = await loadResumeSnapshot(runId);

  if (!snapshot) {
    return { runId, resumed: false, state: 'failed', reason: 'No such run.', reattached: [] };
  }

  if (isTerminal(snapshot.state)) {
    return {
      runId,
      resumed: false,
      state: snapshot.state,
      reason: `Run is already ${snapshot.state}.`,
      reattached: [],
    };
  }

  if (isRunning(runId)) {
    return {
      runId,
      resumed: false,
      state: snapshot.state,
      reason: 'The run is already in flight in this process.',
      reattached: [],
    };
  }

  await emitEvent({
    runId,
    type: 'log',
    summary: `Resuming run from the ledger at state "${snapshot.state}".`,
    detail:
      `${snapshot.pages.length} page(s), ${snapshot.jobs.length} job row(s), ` +
      `${snapshot.reattachable.length} live TrueForge session(s), ` +
      `${snapshot.pendingHandoffs.length} pending handoff(s).`,
    data: {
      state: snapshot.state,
      pausedFrom: snapshot.pausedFrom,
      findingsByPhase: snapshot.findingsByPhase,
    },
  });

  const reattached = await reattachSessions(runId, snapshot.reattachable, options);

  // Release anything the dead process left mid-flight and did not reattach.
  const stranded = snapshot.inFlight
    .filter((job) => job.status === 'running')
    .filter((job) => !reattached.some((outcome) => outcome.jobId === job.id && outcome.status === 'finished'))
    .map((job) => job.id);

  if (stranded.length > 0) {
    await db
      .update(pipelineJobs)
      .set({
        status: 'pending',
        error: 'Interrupted by an application restart; queued to run again.',
      })
      .where(inArray(pipelineJobs.id, stranded));
  }

  const { started } = startRun(runId, options);

  return {
    runId,
    resumed: started,
    state: snapshot.state,
    reason: started
      ? `Resumed at "${snapshot.state}".`
      : 'Another conductor claimed the run first.',
    reattached,
  };
}

/**
 * Boot sweep: every run left mid-flight by the previous process.
 *
 * Call this once from a server-start hook (A12.2). It is safe to call twice —
 * `startRun` refuses a run already in flight.
 */
export async function resumeInterruptedRuns(
  options: RunPipelineOptions = {},
): Promise<ResumeResult[]> {
  const stuck = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      inArray(runs.status, ['queued', 'crawling', 'auditing', 'fixing', 'verifying']),
    );

  const results: ResumeResult[] = [];
  for (const run of stuck) {
    if (isRunning(run.id)) continue;
    results.push(await resumeRun(run.id, options));
  }
  return results;
}

/**
 * Runs paused on a human decision.
 *
 * These are *not* swept automatically: they are not stuck, they are waiting,
 * and the approve route restarts them when someone answers. This exists so the
 * interface can surface the reminder A7.5 asks for.
 */
export async function runsAwaitingApproval(): Promise<
  { runId: string; handoffs: Handoff[]; waitingSinceMs: number }[]
> {
  const paused = await db
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.status, 'awaiting_approval'));

  const now = Date.now();
  const results: { runId: string; handoffs: Handoff[]; waitingSinceMs: number }[] = [];

  for (const run of paused) {
    const rows = await db
      .select()
      .from(handoffs)
      .where(and(eq(handoffs.runId, run.id), eq(handoffs.status, 'pending')));

    if (rows.length === 0) continue;

    const oldest = rows.reduce(
      (min, row) => Math.min(min, row.createdAt.getTime()),
      Number.POSITIVE_INFINITY,
    );
    results.push({ runId: run.id, handoffs: rows, waitingSinceMs: now - oldest });
  }

  return results;
}
