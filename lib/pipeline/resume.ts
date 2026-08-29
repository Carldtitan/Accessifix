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

import { getTrueForgeClient, messageText, requiredActionsOf, type Turn } from '@/lib/harness/client';
import { waitForTurn } from '@/lib/harness/run';
import { FindingsResponseSchema } from '@/lib/harness/schemas';
import { db } from '@/lib/db';
import {
  AGENT_NAMES,
  RUN_PHASES,
  findings,
  handoffs,
  pages,
  runs,
  targets,
  type AgentName,
  type Handoff,
  type Page,
  type Run,
  type RunPhase,
  type Target,
} from '@/lib/db/schema';

import { emitEvent } from './events';
import { completeJob, failJob, listJobs } from './jobs';
import { recordFindings, type FindingClaim } from './ledger';
import { claimRun, holdLease, type LeaseHandle } from './lease';
import { isRunning, startRun, type RunPipelineOptions } from './orchestrate';
import {
  isTerminal,
  readState,
  RESUMABLE_STATES,
  SWEEPABLE_STATES,
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
  /** For a `finished` turn: whether its answer was recovered into the ledger. */
  recovered?: { findings: number; rejected: number } | null;
}

/* -------------------------------------------------------------------------- */
/* Recovering a finished turn                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Phases whose harness answer can be replayed into the ledger from the turn
 * alone.
 *
 * The per-page audit lanes qualify because everything needed to place a claim
 * is recoverable: the page URL is in the job key, the lane is in `agent`, and
 * the claims themselves are `FindingsResponseSchema`.
 *
 * `pages` and `paths` do not. PAGES spans the whole crawl and its claims carry
 * a page URL the lane attached from context the turn does not contain; path
 * enumeration returns a different shape entirely. `fix`, `verify` and `pr` are
 * excluded on purpose — replaying a patch set or a pull request from a
 * half-remembered turn is exactly the kind of guess this pipeline must not
 * make. Those phases re-run, guarded by their own idempotence checks.
 */
const REPLAYABLE_PHASES = new Set<PipelinePhase>(['tree', 'vis', 'act', 'media', 'code']);

const AGENT_SET = new Set<string>(AGENT_NAMES);
const RUN_PHASE_SET = new Set<string>(RUN_PHASES);

/** Pull a JSON object out of an agent's reply, fenced or bare. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // A model that prefixed prose still usually emitted one complete object.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return undefined;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

/** `${runPhase}:${pageUrl}` — the key `laneOverPages` writes. */
function splitLaneJobKey(jobKey: string): { phase: RunPhase; pageUrl: string } | null {
  const separator = jobKey.indexOf(':');
  if (separator === -1) return null;

  const phase = jobKey.slice(0, separator);
  const pageUrl = jobKey.slice(separator + 1);
  if (!RUN_PHASE_SET.has(phase) || !pageUrl) return null;

  return { phase: phase as RunPhase, pageUrl };
}

/**
 * Turn a finished TrueForge turn back into ledger rows.
 *
 * This is the half that was missing. Labelling a turn `finished` and moving on
 * recovered nothing: the job row stayed `running`, the conductor reclaimed it,
 * and the work the reattachment was supposed to save was paid for twice.
 *
 * Note what this does *not* do: it does not write to `findings`. It hands the
 * recovered claims to `recordFindings()` like any lane would, so a resumed run
 * is validated by exactly the same gate as a fresh one (A13.6).
 */
async function recoverFinishedTurn(
  runId: string,
  session: ReattachableSession,
  turn: Turn,
): Promise<{ findings: number; rejected: number } | null> {
  if (!REPLAYABLE_PHASES.has(session.phase)) return null;
  if (!session.agent || !AGENT_SET.has(session.agent)) return null;

  const key = splitLaneJobKey(session.jobKey);
  if (!key) return null;

  const output = turn.state.status === 'done' ? turn.state.output : null;
  const parsed = FindingsResponseSchema.safeParse(extractJson(messageText(output)));
  if (!parsed.success) return null;

  const claims: FindingClaim[] = parsed.data.findings.map((finding) => ({
    criterion: finding.criterion,
    severity: finding.severity,
    summary: finding.summary,
    detail: finding.detail,
    selector: finding.selector ?? null,
    sourcePath: finding.sourcePath ?? null,
    verdict: finding.verdict,
    pageUrl: key.pageUrl,
  }));

  const recorded = await recordFindings({
    runId,
    phase: key.phase,
    agent: session.agent as AgentName,
    sessionId: session.sessionId,
    claims,
  });

  return { findings: recorded.inserted.length, rejected: recorded.rejected.length };
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

      /*
       * A finished turn is the whole point of reattaching, and until now it was
       * the case that did the least: the outcome said `finished` while the job
       * row stayed `running`, so the conductor reclaimed it and paid for the
       * turn a second time.
       *
       * Collect the answer, put it through the ledger's gate, and complete the
       * row with a result shaped exactly like the one `laneOverPages` stores —
       * that is what `runJob`'s `fromResult` rehydrates from, and it is what
       * makes the resumed conductor skip the work instead of redoing it.
       */
      let recovered: { findings: number; rejected: number } | null = null;

      if (status === 'finished') {
        recovered = await recoverFinishedTurn(runId, session, turn).catch(() => null);

        if (recovered) {
          await completeJob(session.jobId, {
            sessionId: session.sessionId,
            turnId: session.turnId,
            result: { recorded: recovered.findings, rejected: recovered.rejected },
          });
        } else {
          // The turn finished but its answer cannot be replayed from the turn
          // alone (FIX, VERIFY, PR, PAGES, path enumeration, or output that no
          // longer parses). Say so and let the phase re-run under its own
          // idempotence guard rather than silently losing the work.
          await failJob(
            session.jobId,
            `The turn finished but its ${session.phase} result could not be recovered from the ` +
              'harness alone; the job will be re-run.',
          );
        }
      }

      outcomes.push({
        jobId: session.jobId,
        sessionId: session.sessionId,
        status,
        detail: `Turn ${session.turnId} is ${turn.state.status}${actions.length > 0 ? `, waiting on ${actions.length} action(s)` : ''}.`,
        recovered,
      });

      await emitEvent({
        runId,
        type: 'job',
        agent: session.agent ?? 'APP',
        capability: 'subagent',
        summary: `Reattached to TrueForge session ${session.sessionId.slice(0, 8)} for ${session.phase}.`,
        detail:
          `Turn ${session.turnId} is ${turn.state.status}. ` +
          (recovered
            ? `${recovered.findings} finding(s) recovered into the ledger without re-running the turn (A12.1).`
            : 'The run resumed rather than restarting (A12.1).'),
        data: {
          jobId: session.jobId,
          sessionId: session.sessionId,
          phase: session.phase,
          recovered,
        },
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
 *   0. take the conductor lease, *before touching anything*;
 *   1. reattach to live TrueForge sessions, so nothing already paid for is
 *      thrown away;
 *   2. release job rows the dead process left `running`, so the conductor is
 *      free to redo only what was actually lost;
 *   3. hand the run - and the lease - to `startRun`, which skips every state it
 *      is already past and every job row that already succeeded.
 *
 * Step 0 used to be step 3, inside `startRun`, and that was the wrong way
 * round. Steps 1 and 2 are not inspection: reattaching polls a live harness
 * session and completes or fails its job row, and the stranded sweep rewrites
 * `running` rows to `pending`. Performed without ownership - by a boot sweep on
 * a second instance, or by a request arriving during a rolling deploy - they
 * reach into a run a healthy conductor is still working, resetting its active
 * job to pending so the work is started twice, and only *afterwards* does
 * `startRun` discover the lease was never available. Ownership has to come
 * first, and it has to be the same ownership the conductor then runs under,
 * which is why the live handle is handed across rather than claimed twice.
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

  /*
   * Ownership, before the first mutation.
   *
   * A refused claim means a live conductor holds this run, and there is nothing
   * to recover: it is not interrupted, it is working. Returning here leaves
   * every job row exactly as that conductor left it.
   */
  const claim = await claimRun(runId);
  if (!claim.ok) {
    return {
      runId,
      resumed: false,
      state: snapshot.state,
      reason: `Not resumed: ${claim.reason}`,
      reattached: [],
    };
  }

  /*
   * Renew in the background from here on. Reattaching polls the harness with a
   * sixty-second timeout per session, so recovery alone can outlive a lease
   * that is not being kept alive - and a lease that lapses mid-recovery is the
   * same split ownership this claim exists to prevent.
   */
  const lease = holdLease(runId, { owner: claim.owner });

  try {
    return await recoverAndStart(runId, snapshot, lease, options);
  } catch (error) {
    /*
     * Recovery failed, so nothing will conduct this run and the lease should
     * not sit out its TTL delaying the next sweep - unless a conductor started
     * in this process while recovery was in flight, in which case the row is
     * now that conductor's and deleting it would evict a healthy run.
     */
    if (isRunning(runId)) lease.detach();
    else await lease.release();
    throw error;
  }
}

/**
 * The recovery itself, performed under a lease this process already holds.
 *
 * Split out so the lease is released on exactly one path: this function hands
 * the handle to `startRun`, which owns it from the moment the run starts, and
 * releases it itself on every path where the run does not start.
 */
async function recoverAndStart(
  runId: string,
  snapshot: ResumeSnapshot,
  lease: LeaseHandle,
  options: RunPipelineOptions,
): Promise<ResumeResult> {
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

  /*
   * Release anything the dead process left mid-flight and did not reattach.
   *
   * `finished` rows were completed above and must not be reopened. `running`
   * rows are live turns on the harness — resetting one to `pending` is how the
   * conductor comes to start a second turn beside a first that is still being
   * paid for.
   */
  const keptAlive = new Set(
    reattached
      .filter((outcome) => outcome.status === 'finished' || outcome.status === 'running')
      .map((outcome) => outcome.jobId),
  );

  const stranded = snapshot.inFlight
    .filter((job) => job.status === 'running')
    .filter((job) => !keptAlive.has(job.id))
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

  /*
   * Hand the lease across rather than letting `startRun` claim a second one.
   *
   * The conductor then runs under the very lease this recovery was performed
   * under, so ownership is continuous from the first job row rewritten to the
   * last phase executed. `startRun` owns the handle from here: it releases it
   * when the run ends, and detaches rather than releases if it declines,
   * because a decline means another conductor in this process holds the row.
   */
  const { started, reason } = await startRun(runId, { ...options, lease });

  return {
    runId,
    resumed: started,
    state: snapshot.state,
    reason: started ? `Resumed at "${snapshot.state}".` : `Not resumed: ${reason}`,
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
  /*
   * Derived from the state machine, never restated. A hand-written copy is how
   * `scoring` came to be missing here: the pipeline gained a state, this list
   * did not, and a run interrupted mid-score was stranded with no way back.
   */
  const stuck = await db
    .select({ id: runs.id })
    .from(runs)
    .where(inArray(runs.status, [...SWEEPABLE_STATES]));

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
