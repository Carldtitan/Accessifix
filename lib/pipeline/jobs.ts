/**
 * Job rows: the unit of work the pipeline resumes from.
 *
 * A12.1 requires every job row to store its TrueForge session identifier, and
 * A12.2 requires a restart to resume from the ledger rather than restarting.
 * Those two together mean a job has to be a row *before* the work begins, not
 * a record written after it finishes — otherwise a crash mid-turn leaves no
 * trace of the session that is still running on the harness.
 *
 * So the shape is always the same:
 *
 *     const job = await beginJob(...);          // row exists, status 'running'
 *     ...call the harness, record the session as soon as it exists...
 *     await completeJob(job.id, { result });    // or failJob / skipJob
 *
 * `runJob()` wraps that, and adds the part that makes a restart cheap: if the
 * job already succeeded, it returns the stored result without doing the work
 * again.
 */
import { and, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';

import { db } from '@/lib/db';

import { emitEvent } from './events';
import {
  pipelineJobs,
  type JobStatus,
  type PipelineJob,
  type PipelinePhase,
} from './schema';

export interface BeginJobInput {
  runId: string;
  phase: PipelinePhase;
  /** The unit of work: a page URL, a source path, or the phase name. */
  jobKey: string;
  agent?: string | null;
}

/**
 * How long a `running` job row may go untouched before another conductor may
 * reclaim it.
 *
 * Longer than the harness turn timeout (10 minutes), because a job that is
 * genuinely still running on TrueForge must not be stolen out from under it.
 * The normal recovery path is much faster than this: the run lease expires in a
 * minute, and `resumeRun()` releases stranded rows explicitly.
 */
const JOB_STALE_AFTER_MS = 30 * 60_000;

/**
 * A job key that is already being worked on by someone else.
 *
 * Thrown rather than returned so the row is left exactly as it is: failing it
 * would discard a TrueForge session that is still alive and paid for.
 */
export class JobLockedError extends Error {
  readonly job: PipelineJob | null;

  constructor(input: BeginJobInput, job: PipelineJob | null) {
    super(
      `The ${input.phase} job for "${input.jobKey}" on run ${input.runId} is already ` +
        `running${job?.sessionId ? ` in TrueForge session ${job.sessionId}` : ''}; it was not reclaimed.`,
    );
    this.name = 'JobLockedError';
    this.job = job;
  }
}

/**
 * Create or reclaim the job row, and mark it running.
 *
 * The reclaim is *conditional*. An unconditional upsert would reset a row that
 * another conductor is actively working — the run lease makes that unlikely,
 * but "unlikely" is not the standard for a write that discards a live harness
 * session. A row is reclaimed only when it is not running, or when it has been
 * running long enough that nothing can plausibly still be behind it.
 *
 * @throws JobLockedError when the row belongs to live work elsewhere.
 */
export async function beginJob(input: BeginJobInput): Promise<PipelineJob> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - JOB_STALE_AFTER_MS);

  const [row] = await db
    .insert(pipelineJobs)
    .values({
      runId: input.runId,
      phase: input.phase,
      jobKey: input.jobKey,
      agent: input.agent ?? null,
      status: 'running',
      attempts: 1,
      startedAt: now,
    })
    .onConflictDoUpdate({
      target: [pipelineJobs.runId, pipelineJobs.phase, pipelineJobs.jobKey],
      set: {
        status: 'running',
        startedAt: now,
        completedAt: null,
        error: null,
        attempts: sql`${pipelineJobs.attempts} + 1`,
      },
      setWhere: or(
        ne(pipelineJobs.status, 'running'),
        lt(pipelineJobs.startedAt, staleBefore),
      ),
    })
    .returning();

  if (row) return row;

  // No row came back: the conflict target matched and `setWhere` refused the
  // update, which can only mean the row is running under someone else.
  throw new JobLockedError(input, await findJob(input.runId, input.phase, input.jobKey));
}

/**
 * Record the TrueForge session as soon as the harness hands one back (A12.1).
 *
 * Called before the turn finishes, not after — the whole point is that a crash
 * during the turn still leaves a session a restart can reattach to.
 */
export async function attachSession(
  jobId: string,
  session: { sessionId?: string | null; turnId?: string | null },
): Promise<void> {
  await db
    .update(pipelineJobs)
    .set({
      sessionId: session.sessionId ?? null,
      turnId: session.turnId ?? null,
    })
    .where(eq(pipelineJobs.id, jobId));
}

/**
 * Park a job on a human decision, recording the coordinates needed to resume it.
 *
 * `result` is written here rather than only on completion because some cards
 * carry the thing they are a card *about* — the pull-request gate records the
 * exact operations it is asking permission for, so a resumed run can tell
 * whether the card still up describes what it is now about to do (A7.1, A7.4).
 */
export async function pauseJobForApproval(
  jobId: string,
  approval: {
    handoffId: string;
    sessionId?: string | null;
    turnId?: string | null;
    threadId?: string | null;
    toolCallId?: string | null;
    /** What was asked, for the resumed run to compare against. */
    result?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .update(pipelineJobs)
    .set({
      status: 'awaiting_approval',
      handoffId: approval.handoffId,
      ...(approval.sessionId ? { sessionId: approval.sessionId } : {}),
      ...(approval.turnId ? { turnId: approval.turnId } : {}),
      ...(approval.result ? { result: approval.result } : {}),
      threadId: approval.threadId ?? null,
      toolCallId: approval.toolCallId ?? null,
    })
    .where(eq(pipelineJobs.id, jobId));
}

export async function completeJob(
  jobId: string,
  options: { result?: Record<string, unknown>; sessionId?: string | null; turnId?: string | null } = {},
): Promise<void> {
  await db
    .update(pipelineJobs)
    .set({
      status: 'succeeded',
      completedAt: new Date(),
      error: null,
      ...(options.result ? { result: options.result } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.turnId ? { turnId: options.turnId } : {}),
    })
    .where(eq(pipelineJobs.id, jobId));
}

export async function failJob(jobId: string, reason: string): Promise<void> {
  await db
    .update(pipelineJobs)
    .set({ status: 'failed', completedAt: new Date(), error: reason.slice(0, 2000) })
    .where(eq(pipelineJobs.id, jobId));
}

/** A job deliberately not run, with a stated reason (design, "Failure Handling"). */
export async function skipJob(jobId: string, reason: string): Promise<void> {
  await db
    .update(pipelineJobs)
    .set({ status: 'skipped', completedAt: new Date(), error: reason.slice(0, 2000) })
    .where(eq(pipelineJobs.id, jobId));
}

export async function findJob(
  runId: string,
  phase: PipelinePhase,
  jobKey: string,
): Promise<PipelineJob | null> {
  const [row] = await db
    .select()
    .from(pipelineJobs)
    .where(
      and(
        eq(pipelineJobs.runId, runId),
        eq(pipelineJobs.phase, phase),
        eq(pipelineJobs.jobKey, jobKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listJobs(
  runId: string,
  options: { phase?: PipelinePhase; status?: JobStatus | JobStatus[] } = {},
): Promise<PipelineJob[]> {
  const clauses = [eq(pipelineJobs.runId, runId)];
  if (options.phase) clauses.push(eq(pipelineJobs.phase, options.phase));
  if (options.status) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    clauses.push(inArray(pipelineJobs.status, statuses));
  }
  return db.select().from(pipelineJobs).where(and(...clauses));
}

export async function findJobByHandoff(handoffId: string): Promise<PipelineJob | null> {
  const [row] = await db
    .select()
    .from(pipelineJobs)
    .where(eq(pipelineJobs.handoffId, handoffId))
    .limit(1);
  return row ?? null;
}

/** Context handed to the work function, so it can record its session mid-flight. */
export interface JobContext {
  job: PipelineJob;
  /** Record the TrueForge session the moment the harness returns one (A12.1). */
  attach(session: { sessionId?: string | null; turnId?: string | null }): Promise<void>;
}

export interface RunJobOptions<T> {
  /** Reuse the stored result instead of redoing succeeded work. Default true. */
  reuseCompleted?: boolean;
  /** Rebuild the return value from the stored `result` jsonb on a resume. */
  fromResult?: (result: Record<string, unknown>) => T;
  /** A thrown error fails the job and rethrows unless this returns a value. */
  onError?: (error: unknown) => T | undefined;
  /** Small, structured summary to persist. Anything large stays in the sandbox. */
  toResult?: (value: T) => Record<string, unknown>;
}

/**
 * Run one unit of work exactly once per run, even across restarts.
 *
 * On a resume, a job that already succeeded is not re-run: its stored result is
 * rehydrated through `fromResult` when the caller supplied one, and otherwise
 * the work is redone — which is the safe default, because re-auditing a page is
 * idempotent at the ledger (`recordFindings` dedupes) while re-opening a pull
 * request is not.
 */
export async function runJob<T>(
  input: BeginJobInput,
  work: (context: JobContext) => Promise<T>,
  options: RunJobOptions<T> = {},
): Promise<T> {
  const reuse = options.reuseCompleted ?? true;

  if (reuse && options.fromResult) {
    const existing = await findJob(input.runId, input.phase, input.jobKey);
    if (existing?.status === 'succeeded' && existing.result) {
      await emitEvent({
        runId: input.runId,
        type: 'job',
        agent: input.agent ?? 'APP',
        summary: `Reused completed ${input.phase} job for ${input.jobKey}.`,
        detail: 'Resumed from the ledger rather than repeating the work (A12.2).',
        data: { phase: input.phase, jobKey: input.jobKey, sessionId: existing.sessionId },
      });
      return options.fromResult(existing.result);
    }
  }

  let job: PipelineJob;
  try {
    job = await beginJob(input);
  } catch (error) {
    if (!(error instanceof JobLockedError)) throw error;

    // Someone else is on it. Say so and step aside — failing the row here would
    // throw away the session that is still working.
    await emitEvent({
      runId: input.runId,
      type: 'job',
      agent: input.agent ?? 'APP',
      summary: `Skipped the ${input.phase} job for ${input.jobKey}; it is already running.`,
      detail: error.message,
      data: { phase: input.phase, jobKey: input.jobKey, sessionId: error.job?.sessionId ?? null },
    });

    const stepped = options.onError?.(error);
    if (stepped !== undefined) return stepped;
    throw error;
  }

  try {
    const value = await work({
      job,
      attach: (session) => attachSession(job.id, session),
    });
    await completeJob(job.id, {
      result: options.toResult ? options.toResult(value) : undefined,
    });
    return value;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await failJob(job.id, reason);
    await emitEvent({
      runId: input.runId,
      type: 'error',
      agent: input.agent ?? 'APP',
      summary: `${input.phase} job failed for ${input.jobKey}.`,
      detail: reason,
      data: { phase: input.phase, jobKey: input.jobKey },
    });

    const recovered = options.onError?.(error);
    if (recovered !== undefined) return recovered;
    throw error;
  }
}
