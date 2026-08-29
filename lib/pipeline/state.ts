/**
 * The run state machine.
 *
 *     queued -> crawling -> auditing -> scoring -> fixing -> verifying
 *                                                              |
 *                                        awaiting_approval <---+
 *                                                              |
 *                                                       done | failed
 *
 * Two rules, and they are the whole point of this file:
 *
 *   1. **Legal transitions only.** An illegal transition throws
 *      `IllegalTransitionError` rather than quietly corrupting a run. The
 *      conductor is the only thing that moves a run, so a wrong move is a bug
 *      to be surfaced immediately, not smoothed over.
 *   2. **Every change is persisted before it is announced.** `runs.status` is
 *      updated and a `state` event is appended in the same call, so a restart
 *      reads the true state back out of the database and resumes from it
 *      (A12.2, A13.8).
 *
 * `awaiting_approval` is an *overlay*, not a destination. A run pauses there
 * from whichever state raised the handoff, and returns to that same state when
 * a human answers (A7.4). The state it paused from is recovered from the event
 * log rather than stored in a column, which keeps `runs` unchanged.
 */
import { eq } from 'drizzle-orm';

import { db } from '@/lib/db';
import { runs, RUN_STATUSES, type Run, type RunPhase, type RunStatus } from '@/lib/db/schema';

import { emitEvent, lastStateEvent, stateBeforePause } from './events';

/* -------------------------------------------------------------------------- */
/* States                                                                     */
/* -------------------------------------------------------------------------- */

export const PIPELINE_STATES = [
  'queued',
  'crawling',
  'auditing',
  'scoring',
  'fixing',
  'verifying',
  'awaiting_approval',
  'done',
  'failed',
] as const;

export type PipelineState = (typeof PIPELINE_STATES)[number];

export const TERMINAL_STATES: readonly PipelineState[] = ['done', 'failed'];

/** States a run can be resumed into after an interruption or an answered handoff. */
export const RESUMABLE_STATES: readonly PipelineState[] = [
  'queued',
  'crawling',
  'auditing',
  'scoring',
  'fixing',
  'verifying',
  'awaiting_approval',
];

/**
 * The legal transition table. Anything not listed here throws.
 *
 * `crawling`, `auditing` and `scoring` can each raise a handoff — an agent is
 * entitled to ask a structured clarifying question mid-run (A7.6), not only at
 * the write-class gates.
 */
const TRANSITIONS: Readonly<Record<PipelineState, readonly PipelineState[]>> = {
  queued: ['crawling', 'failed'],
  crawling: ['auditing', 'awaiting_approval', 'failed'],
  auditing: ['scoring', 'awaiting_approval', 'failed'],
  // A baseline-only run finishes at `scoring`; a full run continues to `fixing`.
  scoring: ['fixing', 'awaiting_approval', 'done', 'failed'],
  // `done` from `fixing`: FIX produced no patch, so there is nothing to verify.
  fixing: ['verifying', 'awaiting_approval', 'done', 'failed'],
  // A6.4: a failing test suite ends the run without a pull request.
  verifying: ['auditing', 'awaiting_approval', 'done', 'failed'],
  awaiting_approval: [
    'crawling',
    'auditing',
    'scoring',
    'fixing',
    'verifying',
    'done',
    'failed',
  ],
  done: [],
  failed: [],
};

export function isPipelineState(value: unknown): value is PipelineState {
  return typeof value === 'string' && (PIPELINE_STATES as readonly string[]).includes(value);
}

export function isTerminal(state: PipelineState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** The states reachable from here. Exported so the run view can explain a stall. */
export function legalNextStates(from: PipelineState): readonly PipelineState[] {
  return TRANSITIONS[from];
}

export function canTransition(from: PipelineState, to: PipelineState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  readonly from: PipelineState;
  readonly to: PipelineState;
  readonly runId: string;

  constructor(runId: string, from: PipelineState, to: PipelineState) {
    super(
      `Illegal run state transition ${from} -> ${to} for run ${runId}. ` +
        `Legal from ${from}: ${TRANSITIONS[from].join(', ') || '(terminal)'}.`,
    );
    this.name = 'IllegalTransitionError';
    this.runId = runId;
    this.from = from;
    this.to = to;
  }
}

export class RunNotFoundError extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`Run ${runId} does not exist.`);
    this.name = 'RunNotFoundError';
    this.runId = runId;
  }
}

/* -------------------------------------------------------------------------- */
/* Persistence bridge                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `runs.status` is a Postgres enum. If the deployed enum does not yet carry
 * `scoring`, writing it would throw at runtime and take the run down, so the
 * value is folded into `auditing` for storage only. The *true* pipeline state
 * always goes to the event log as text, and `readState()` prefers that, so
 * nothing downstream loses the distinction.
 *
 * SCHEMA OWNER: adding `'scoring'` to `RUN_STATUSES` in `lib/db/schema.ts`
 * (between `'auditing'` and `'fixing'`) removes this fallback entirely — the
 * check below is a runtime membership test, so no other change is needed.
 */
const DB_SUPPORTS_SCORING = (RUN_STATUSES as readonly string[]).includes('scoring');

/** Map a pipeline state onto a value the `run_status` enum will accept. */
export function toRunStatus(state: PipelineState): RunStatus {
  if (state === 'scoring' && !DB_SUPPORTS_SCORING) return 'auditing';
  return state as RunStatus;
}

/** True when `runs.status` can represent every pipeline state losslessly. */
export function statusColumnIsLossless(): boolean {
  return DB_SUPPORTS_SCORING;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

export interface RunState {
  run: Run;
  state: PipelineState;
  phase: RunPhase;
  /** For a paused run, the state it will return to when the handoff is answered. */
  pausedFrom: PipelineState | null;
}

export async function loadRun(runId: string): Promise<Run | null> {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  return row ?? null;
}

export async function requireRun(runId: string): Promise<Run> {
  const run = await loadRun(runId);
  if (!run) throw new RunNotFoundError(runId);
  return run;
}

/**
 * The authoritative current state.
 *
 * The event log wins over `runs.status` when the two disagree, because the log
 * is written with the full vocabulary while the column may be narrower (see
 * `toRunStatus`). They are written in the same call, so a disagreement only
 * ever means "the column could not hold this value".
 */
export async function readState(runId: string): Promise<RunState> {
  const run = await requireRun(runId);
  const stored: PipelineState = isPipelineState(run.status) ? run.status : 'queued';

  let state: PipelineState = stored;
  if (!DB_SUPPORTS_SCORING && stored === 'auditing') {
    // The column folded `scoring` into `auditing`; the log did not.
    const last = await lastStateEvent(runId);
    if (last?.data?.to === 'scoring') state = 'scoring';
  }

  const pausedFrom =
    state === 'awaiting_approval'
      ? ((await stateBeforePause(runId)) as PipelineState | null)
      : null;

  return {
    run,
    state,
    phase: run.phase,
    pausedFrom: pausedFrom && isPipelineState(pausedFrom) ? pausedFrom : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

export interface TransitionOptions {
  /** Why. Required for `failed`, so a failure always states its reason. */
  reason?: string;
  /** Extra context attached to the state event, for the timeline. */
  data?: Record<string, unknown>;
  /** Attribute the transition to an agent. Defaults to the dispatcher. */
  agent?: string;
}

/**
 * Move a run to `to`, persisting before announcing.
 *
 * @throws IllegalTransitionError when the move is not in the transition table,
 *         including a no-op `X -> X`. Use `enterState` when idempotence is what
 *         you want.
 */
export async function transition(
  runId: string,
  to: PipelineState,
  options: TransitionOptions = {},
): Promise<RunState> {
  const current = await readState(runId);
  const from = current.state;

  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(runId, from, to);
  }

  if (to === 'failed' && !options.reason) {
    throw new Error(`Run ${runId} cannot fail without a stated reason.`);
  }

  const now = new Date();
  const patch: Partial<typeof runs.$inferInsert> = { status: toRunStatus(to) };

  if (from === 'queued' && !current.run.startedAt) patch.startedAt = now;
  if (to === 'done' || to === 'failed') patch.completedAt = now;
  if (to === 'failed') patch.failureReason = options.reason ?? null;
  // Leaving a failure behind (a resumed run) clears the stale reason.
  if (to !== 'failed' && current.run.failureReason) patch.failureReason = null;

  const [updated] = await db.update(runs).set(patch).where(eq(runs.id, runId)).returning();
  if (!updated) throw new RunNotFoundError(runId);

  await emitEvent({
    runId,
    type: 'state',
    agent: options.agent ?? 'APP',
    capability: to === 'awaiting_approval' ? 'approval' : 'ledger',
    summary: describeTransition(from, to),
    detail: options.reason ?? null,
    data: { from, to, ...(options.data ?? {}) },
  });

  return {
    run: updated,
    state: to,
    phase: updated.phase,
    pausedFrom: to === 'awaiting_approval' ? from : null,
  };
}

/**
 * Idempotent form. Returns the current state untouched when the run is already
 * there, which is what a resumed run needs when it re-enters a phase it had
 * already reached.
 */
export async function enterState(
  runId: string,
  to: PipelineState,
  options: TransitionOptions = {},
): Promise<RunState> {
  const current = await readState(runId);
  if (current.state === to) return current;
  return transition(runId, to, options);
}

/**
 * Fail a run with a stated reason. Terminal states are left alone, so a late
 * error in a cleanup path cannot overwrite a completed run.
 */
export async function failRun(
  runId: string,
  reason: string,
  options: Omit<TransitionOptions, 'reason'> = {},
): Promise<RunState> {
  const current = await readState(runId);
  if (isTerminal(current.state)) return current;
  return transition(runId, 'failed', { ...options, reason });
}

/**
 * Forward-only ordering of the working states.
 *
 * A resumed run must not re-enter a state it has already left — `auditing ->
 * crawling` is not a legal move, and a resume that tried it would throw. The
 * conductor compares ranks and simply skips the `enterState` call for any phase
 * the run is already past, while still performing the work that phase owns
 * (page captures live in memory, so they are always retaken).
 */
export const STATE_ORDER: readonly PipelineState[] = [
  'queued',
  'crawling',
  'auditing',
  'scoring',
  'fixing',
  'verifying',
];

/** Position in `STATE_ORDER`. `awaiting_approval` ranks as the state it paused from. */
export function stateRank(state: PipelineState, pausedFrom: PipelineState | null = null): number {
  if (state === 'awaiting_approval' && pausedFrom) return stateRank(pausedFrom);
  const index = STATE_ORDER.indexOf(state);
  return index === -1 ? STATE_ORDER.length : index;
}

/** Resume from `awaiting_approval` to the state the run paused in (A7.4). */
export async function resumeFromPause(
  runId: string,
  options: TransitionOptions = {},
): Promise<RunState> {
  const current = await readState(runId);
  if (current.state !== 'awaiting_approval') return current;

  const target = current.pausedFrom ?? 'auditing';
  if (!canTransition('awaiting_approval', target)) {
    throw new IllegalTransitionError(runId, 'awaiting_approval', target);
  }
  return transition(runId, target, options);
}

/** Move the run between `baseline` and `final` (A8.1). Findings denormalise this. */
export async function setRunPhase(runId: string, phase: RunPhase): Promise<Run> {
  const [updated] = await db.update(runs).set({ phase }).where(eq(runs.id, runId)).returning();
  if (!updated) throw new RunNotFoundError(runId);

  await emitEvent({
    runId,
    type: 'phase',
    capability: 'ledger',
    summary: `Run phase set to ${phase}.`,
    data: { phase },
  });
  return updated;
}

/** Record sandbox occupancy against the cap, for the summary bar (A11.2). */
export async function recordSandboxUsage(runId: string, active: number): Promise<void> {
  await db.update(runs).set({ sandboxesUsed: Math.max(0, active) }).where(eq(runs.id, runId));
}

const TRANSITION_LABELS: Readonly<Record<PipelineState, string>> = {
  queued: 'Run queued.',
  crawling: 'Crawling same-origin pages.',
  auditing: 'Auditing against the 55 criteria.',
  scoring: 'Scoring the ledger.',
  fixing: 'Writing fixes.',
  verifying: 'Building and testing the patched tree.',
  awaiting_approval: 'Paused, waiting for a human decision.',
  done: 'Run complete.',
  failed: 'Run failed.',
};

function describeTransition(from: PipelineState, to: PipelineState): string {
  if (to === 'awaiting_approval') return `Paused for approval during ${from}.`;
  if (from === 'awaiting_approval') return `Approval answered, resuming ${to}.`;
  return TRANSITION_LABELS[to];
}
