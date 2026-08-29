/**
 * The conductor.
 *
 * The application owns the pipeline; the harness owns each job. That split is
 * forced rather than chosen: TrueForge subagents inherit their parent's model,
 * so one agent cannot fan out across seven models. Routing therefore happens
 * here, in application code, and this file is where it happens.
 *
 * The order is not arbitrary. Each step is here because the step before it
 * makes it cheaper or possible:
 *
 *     0  CRAWL       same-origin, capped at 25 pages. Captures tree, screenshot,
 *                    axe violations and links in one sandbox visit per page, so
 *                    nothing downstream reopens a page.
 *     1  TREE        every page, no sandbox, no model. The cheap gate runs first
 *                    and eliminates most findings before a provider is billed.
 *     2  VIS + ACT   in parallel. ACT takes one browser sandbox per interaction
 *                    path, capped by the run's sandbox budget; VIS is model-only
 *                    over screenshots already captured.
 *     2b MEDIA       started first, awaited last. Its own queue, no sandbox, so
 *                    it can never block browser work (A3.4).
 *     3  PAGES       held until the crawl is complete, because its criteria are
 *                    comparative across pages (A3.5).
 *     4  FIX         batched per source file, not per finding (A5.2).
 *     5  VERIFY      gates everything. A failing test suite ends the run with no
 *                    pull request (A6.4).
 *     6  PR          behind a human approval, then the final score and delta.
 *
 * Every finding reaches the database through `recordFindings()` and nowhere
 * else. Agents return claims; the application validates and persists them
 * (A13.6). That function lives in `./ledger` and is re-exported here so the
 * rule is visible from the conductor.
 *
 * ---------------------------------------------------------------------------
 * SIBLING MODULES
 *
 * The audit lanes, path enumeration, fixing, verification and GitHub belong to
 * other modules, built in parallel with this one. Every crossing into them goes
 * through `./lanes`, which states the contract each is held to. A signature
 * that turns out to differ is reconciled there, in one file, and the conductor
 * is untouched.
 * ---------------------------------------------------------------------------
 */
import { and, eq, inArray, ne } from 'drizzle-orm';

import type { InteractionPath } from '@/lib/browser/types';
import { db } from '@/lib/db';
import { findings, patches, runs, targets, type Finding, type RunPhase } from '@/lib/db/schema';
import { MAX_PAGES_PER_CRAWL } from '@/lib/sandbox/config';
import { sandboxPool } from '@/lib/sandbox/pool';

import { githubTokenForUser } from './access';
import { crawl, type CrawledPage } from './crawl';
// Every crossing into a lane, the fix pass, verification or GitHub goes through
// this one seam. See `lanes.ts` for the contract each is held to.
import {
  enumerateInteractionPaths,
  openPullRequest,
  runActLane,
  runCodeLane,
  runMediaLane,
  runPagesLane,
  runTreeLane,
  runVisLane,
  verifyPatches,
  writePatches,
  type AuditLaneResult,
  type AuditPageInput,
} from './lanes';
import { emitEvent } from './events';
import { awaitHandoff, loadHandoff, raiseHandoff } from './handoff';
import { assertLeaseHeld, claimRun, holdLease, LeaseLostError, type LeaseHandle } from './lease';
import {
  attachSession,
  beginJob,
  completeJob,
  failJob,
  findJob,
  JobLockedError,
  pauseJobForApproval,
  runJob,
  skipJob,
} from './jobs';
import { recordBlockedCriteria, recordFindings } from './ledger';
import { scoreDelta, scoreRun } from './score';
import {
  enterState,
  failRun,
  readState,
  recordSandboxUsage,
  resumeFromPause,
  setRunPhase,
  stateRank,
  transition,
  type PipelineState,
} from './state';

export { recordFindings } from './ledger';
export type { FindingClaim, RecordFindingsResult } from './ledger';

/* -------------------------------------------------------------------------- */
/* Options and process registry                                               */
/* -------------------------------------------------------------------------- */

export interface RunPipelineOptions {
  signal?: AbortSignal;
  /**
   * Stop after the baseline score. The run finishes at `done` with no patches
   * and no pull request — this is the A12.3 "baseline ahead of time" path.
   */
  baselineOnly?: boolean;
  /** Page cap override. Never exceeds `MAX_PAGES_PER_CRAWL`. */
  maxPages?: number;
  /**
   * The conductor lease this run is being executed under.
   *
   * Set by `startRun`. When absent, `executeRun` claims one itself, so calling
   * it directly (a test, a script) is still exclusive.
   *
   * A caller may also claim the lease itself and hand the live handle in -
   * `resumeRun` does, because it mutates job rows *before* the conductor
   * starts and must not do that without ownership. `startRun` then adopts the
   * handle rather than claiming a second time, and releases it when the run
   * ends, so ownership passes across in one piece.
   */
  lease?: LeaseHandle;
}

interface ActiveRun {
  controller: AbortController;
  promise: Promise<void>;
  startedAt: number;
}

/**
 * Next.js reloads modules on edit; without a global the registry forgets which
 * runs are in flight and `startRun` would launch a second conductor over the
 * same run.
 */
const globalForRuns = globalThis as unknown as { accessifixActiveRuns?: Map<string, ActiveRun> };
const activeRuns: Map<string, ActiveRun> = globalForRuns.accessifixActiveRuns ?? new Map();
if (process.env.NODE_ENV !== 'production') globalForRuns.accessifixActiveRuns = activeRuns;

export function isRunning(runId: string): boolean {
  return activeRuns.has(runId);
}

export function activeRunIds(): string[] {
  return [...activeRuns.keys()];
}

export interface StartRunOutcome {
  started: boolean;
  alreadyRunning: boolean;
  /** Prose, for the route to pass on when a start is refused. */
  reason: string;
}

/**
 * Start the pipeline and return immediately.
 *
 * The HTTP response must not wait for a run — a baseline over 25 pages takes
 * minutes. The route returns 202 and the browser watches the SSE stream.
 *
 * Exclusivity is settled twice, and both are needed. `activeRuns` is a
 * process-local map and is only a fast path; the guarantee is the `run_leases`
 * row claimed below, because two Node processes share no memory and this
 * application runs in more than one behind a load balancer or across a deploy.
 * A second conductor over one run means a second pull request.
 *
 * DEPLOYMENT NOTE: this holds the work in the Node process that accepted the
 * request. That is correct for the local/long-lived server topology this
 * project runs on. On a serverless platform that freezes a function after its
 * response, this needs a durable worker; `resumeRun()` already covers the
 * recovery half, so the change is where the loop lives, not what it does.
 */
export async function startRun(
  runId: string,
  options: RunPipelineOptions = {},
): Promise<StartRunOutcome> {
  if (activeRuns.has(runId)) {
    /*
     * A conductor in this process already has the run - and, being this
     * process, it holds the very lease row that was handed in, because owner
     * identity is per process. Stop renewing that handle, but do not delete the
     * row: it is the running conductor's ownership, and releasing it here would
     * read to that conductor as having lost the run to somebody else.
     */
    options.lease?.detach();
    return {
      started: false,
      alreadyRunning: true,
      reason: 'A conductor in this process is already running this run.',
    };
  }

  const controller = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true });
  }

  /*
   * The durable half of exclusivity.
   *
   * Normally claimed here: a lease held by a live conductor in any process
   * refuses the claim, and one whose owner died has expired and is taken over.
   *
   * A caller that had to establish ownership *before* calling - `resumeRun`,
   * which rewrites job rows the dead process left behind - hands its live
   * handle in instead. Adopting it rather than claiming again matters: a second
   * `claimRun` would succeed (it is re-entrant for the same owner) but would
   * leave two renewal timers on one row, and the second `release` would delete
   * a lease the first still believed it held.
   */
  let lease: LeaseHandle;
  let reason: string;

  if (options.lease) {
    lease = options.lease;
    reason = `Run ${runId} is conducted by ${lease.owner}.`;
  } else {
    const claim = await claimRun(runId);
    if (!claim.ok) {
      return { started: false, alreadyRunning: true, reason: claim.reason };
    }
    lease = holdLease(runId, { owner: claim.owner });
    reason = claim.reason;
  }

  /*
   * Losing the lease aborts the conductor. `lost` rather than `onLost` because
   * a handed-over handle was constructed by somebody else and carries no
   * callback of ours; `lost` resolves for both.
   */
  void lease.lost.then(() => {
    controller.abort(
      new LeaseLostError(runId, lease.lostReason ?? `The conductor lease on run ${runId} was lost.`),
    );
  });

  const promise = executeRun(runId, { ...options, signal: controller.signal, lease })
    .catch((error) => {
      console.error(`[pipeline] run ${runId} ended in an unhandled error`, error);
    })
    .finally(() => {
      activeRuns.delete(runId);
      void lease.release();
    });

  activeRuns.set(runId, { controller, promise, startedAt: Date.now() });
  return { started: true, alreadyRunning: false, reason };
}

/** Ask a running pipeline to stop. The run is then failed with the reason. */
export function abortRun(runId: string, reason = 'Aborted by request.'): boolean {
  const entry = activeRuns.get(runId);
  if (!entry) return false;
  entry.controller.abort(new Error(reason));
  return true;
}

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

interface PipelineContext {
  runId: string;
  userId: string;
  repoFullName: string;
  deployedUrl: string;
  phase: RunPhase;
  signal?: AbortSignal;
  options: RunPipelineOptions;
  /** The lease this run is being conducted under. Absent for a direct call. */
  lease?: LeaseHandle;
}

/**
 * Confirm ownership immediately before a side effect, and throw if it is gone.
 *
 * The conductor aborts an `AbortController` when it loses its lease, but that
 * only stops work which accepted the signal - the crawl and the handoff wait.
 * The audit lanes, FIX, VERIFY and the pull request take none, so an abort
 * leaves them running to completion and writing as they go. This is the
 * checkpoint that stops the *effects*: every durable write and every external
 * one is preceded by a question the database answers.
 */
async function stillOurs(context: PipelineContext, before: string): Promise<void> {
  await assertLeaseHeld(context.lease, before);
}

export type { AuditPageInput } from './lanes';

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Execute one run end to end.
 *
 * Awaitable, for tests and for the resume path. Route handlers use `startRun`.
 */
export async function executeRun(runId: string, options: RunPipelineOptions = {}): Promise<void> {
  /*
   * `startRun` normally owns the lease and passes it down. A direct call has to
   * claim its own, or two direct calls would conduct the same run — the exact
   * failure the lease exists to stop.
   */
  let ownLease: LeaseHandle | null = null;
  let signal = options.signal;

  if (!options.lease) {
    const claim = await claimRun(runId);
    if (!claim.ok) {
      await emitEvent({
        runId,
        type: 'log',
        summary: 'Another conductor already holds this run.',
        detail: claim.reason,
      });
      return;
    }

    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort(options.signal.reason);
      else {
        options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), {
          once: true,
        });
      }
    }
    ownLease = holdLease(runId, { owner: claim.owner });
    const held = ownLease;
    void held.lost.then(() => {
      controller.abort(
        new LeaseLostError(runId, held.lostReason ?? `The conductor lease on run ${runId} was lost.`),
      );
    });
    signal = controller.signal;
  }

  try {
    /*
     * The lease travels with the options so every phase can re-confirm
     * ownership before it writes. Aborting a signal only reaches work that
     * accepted one, and most of what this pipeline dispatches does not.
     */
    await conductRun(runId, { ...options, signal, lease: options.lease ?? ownLease ?? undefined });
  } finally {
    await ownLease?.release();
  }
}

async function conductRun(runId: string, options: RunPipelineOptions = {}): Promise<void> {
  const [row] = await db
    .select({ run: runs, target: targets })
    .from(runs)
    .innerJoin(targets, eq(runs.targetId, targets.id))
    .where(eq(runs.id, runId))
    .limit(1);

  if (!row) throw new Error(`Run ${runId} does not exist.`);

  const context: PipelineContext = {
    runId,
    userId: row.target.userId,
    repoFullName: row.target.repoFullName,
    deployedUrl: row.target.deployedUrl,
    phase: row.run.phase,
    signal: options.signal,
    options,
    lease: options.lease,
  };

  const releaseBudget = bindSandboxBudget(runId, row.run.maxSandboxes);

  try {
    const current = await readState(runId);
    if (current.state === 'done' || current.state === 'failed') {
      await emitEvent({
        runId,
        type: 'log',
        summary: `Run is already ${current.state}; nothing to do.`,
      });
      return;
    }

    /*
     * A resumed run is already past some of these states, and a backward
     * `enterState` is an illegal transition. `reached` skips the state change
     * for anything already behind us; the work itself still runs, because job
     * rows make it idempotent and the page captures live only in memory.
     */
    const startRank = stateRank(current.state, current.pausedFrom);
    const reached = (state: PipelineState): boolean => stateRank(state) >= startRank;

    /* ---- 0. Crawl ----------------------------------------------------- */
    if (reached('crawling')) await enterState(runId, 'crawling');
    const crawled = await crawlPhase(context);

    /* ---- 1-3. Audit --------------------------------------------------- */
    await stillOurs(context, 'the audit lanes');
    if (reached('auditing')) await enterState(runId, 'auditing');
    await auditPhase(context, crawled);

    /* ---- Baseline score ------------------------------------------------ */
    await stillOurs(context, 'scoring');
    if (reached('scoring')) await enterState(runId, 'scoring');
    await scorePhase(context, crawled[0]?.url ?? context.deployedUrl);

    if (options.baselineOnly) {
      await stillOurs(context, 'finishing a baseline-only run');
      await transition(runId, 'done', { reason: 'Baseline only: fixes were not requested.' });
      return;
    }

    /* ---- 4. Fix -------------------------------------------------------- */
    const decidable = await openDecideFindings(runId, 'baseline');
    if (decidable.length === 0) {
      await transition(runId, 'done', {
        reason: 'No DECIDE findings to fix. FLAG findings stay in the human queue (A5.4).',
      });
      return;
    }

    const token = await githubTokenForUser(context.userId);
    if (!token) {
      await transition(runId, 'done', {
        reason:
          'No GitHub token is stored for this account, so the repository cannot be ' +
          'cloned or patched. The baseline score is complete; sign in again to grant ' +
          'the repo scope and re-run.',
      });
      return;
    }

    await stillOurs(context, 'writing patches');
    if (reached('fixing')) await enterState(runId, 'fixing');
    const proposed = await fixPhase(context, token, decidable);

    if (proposed.length === 0) {
      await transition(runId, 'done', {
        reason: 'FIX produced no patches. The findings remain open for a human.',
      });
      return;
    }

    /* ---- 5. Verify ----------------------------------------------------- */
    await stillOurs(context, 'verifying patches');
    if (reached('verifying')) await enterState(runId, 'verifying');
    const verification = await verifyPhase(context, token, proposed);

    if (!verification.ok) {
      // A6.4 and the design's failure table: patch rejected, findings returned
      // to `open`, no pull request.
      await transition(runId, 'done', { reason: verification.reason });
      return;
    }

    /* ---- 6. Pull request, then the final score -------------------------- */
    await stillOurs(context, 'raising the approval handoff');
    const approved = await pullRequestGate(context, verification.reason);
    if (!approved) {
      await transition(runId, 'done', {
        reason: 'The pull request was declined. Patches are recorded but nothing was pushed.',
      });
      return;
    }

    /*
     * The one checkpoint that is not merely hygiene.
     *
     * The approval gate can hold a run for hours, which is many lease TTLs; if
     * this process was paused across that window the run may already belong to
     * a successor that is about to open its own pull request. Opening a second
     * one against a user's repository is the least reversible thing this
     * pipeline can do, so ownership is re-confirmed against the database on the
     * far side of the wait, not merely assumed from having entered it.
     */
    await stillOurs(context, 'opening the pull request');
    await prPhase(context, token, proposed, verification.criteriaFixed);

    await stillOurs(context, 'the final audit');
    await finalAuditPhase(context, verification.previewUrl ?? context.deployedUrl);

    await stillOurs(context, 'marking the run done');
    await transition(runId, 'done');
  } catch (error) {
    /*
     * A locked job means another conductor is holding work on this run. That is
     * not a run failure - failing it here would kill a run someone else is
     * successfully conducting - so this conductor stands down and leaves the
     * state alone.
     */
    if (error instanceof JobLockedError) {
      await emitEvent({
        runId,
        type: 'log',
        summary: 'Another conductor is working this run; standing down.',
        detail: error.message,
      });
      return;
    }

    /*
     * Losing the lease is an ownership handoff, not a pipeline failure.
     *
     * By the time this conductor notices, a successor has already taken the
     * expired lease and is conducting the run. Calling `failRun` here would
     * mark *its* run failed - the displaced process reaching across and killing
     * a healthy one - which is worse than the stall the lease exists to fix.
     *
     * The second arm catches the case the exception type cannot: an abort only
     * carries its reason out of the handful of APIs that accept a signal, so an
     * interrupted phase can surface as any error at all. The lease handle knows
     * regardless of what was thrown.
     */
    const leaseLost =
      error instanceof LeaseLostError ? error.message : (options.lease?.lostReason ?? null);

    if (leaseLost !== null) {
      await emitEvent({
        runId,
        type: 'log',
        summary: 'This conductor lost its lease; standing down without touching the run state.',
        detail: leaseLost,
      });
      return;
    }

    const reason = error instanceof Error ? error.message : String(error);
    await failRun(runId, reason).catch(() => undefined);
    throw error;
  } finally {
    releaseBudget();
  }
}

/* -------------------------------------------------------------------------- */
/* Sandbox budget (A11.2, design "Verified Constraints")                      */
/* -------------------------------------------------------------------------- */

/**
 * Point the process-wide governor at this run's cap and mirror occupancy into
 * `runs.sandboxes_used` so the summary bar can render "in use against the cap".
 *
 * The cap comes from the run row, never from `nproc` — inside a Daytona sandbox
 * `nproc` reports the host's core count.
 */
function bindSandboxBudget(runId: string, maxSandboxes: number): () => void {
  sandboxPool.setCap(maxSandboxes);

  let lastActive = -1;
  let lastQueued = -1;

  const unsubscribe = sandboxPool.subscribe((stats) => {
    if (stats.active === lastActive && stats.queued === lastQueued) return;
    lastActive = stats.active;
    lastQueued = stats.queued;

    void recordSandboxUsage(runId, stats.active).catch(() => undefined);
    void emitEvent({
      runId,
      type: 'sandbox',
      capability: 'sandbox',
      summary: `${stats.active}/${stats.cap} sandboxes in use${stats.queued > 0 ? `, ${stats.queued} queued` : ''}.`,
      data: { active: stats.active, queued: stats.queued, cap: stats.cap },
    });
  });

  return () => {
    unsubscribe();
    void recordSandboxUsage(runId, 0).catch(() => undefined);
  };
}

/* -------------------------------------------------------------------------- */
/* Phase 0: crawl                                                             */
/* -------------------------------------------------------------------------- */

async function crawlPhase(context: PipelineContext): Promise<CrawledPage[]> {
  const cap = Math.min(context.options.maxPages ?? MAX_PAGES_PER_CRAWL, MAX_PAGES_PER_CRAWL);

  const job = await beginJob({ runId: context.runId, phase: 'crawl', jobKey: 'crawl', agent: 'APP' });
  try {
    const result = await crawl(context.runId, context.deployedUrl, {
      maxPages: cap,
      signal: context.signal,
    });

    await completeJob(job.id, {
      result: {
        captured: result.pages.length,
        skipped: result.skipped.length,
        failed: result.failures.length,
        crossOriginRejected: result.rejectedCrossOrigin.length,
        origin: result.origin,
      },
    });
    return result.pages;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await failJob(job.id, reason);
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Phases 1-3: the audit                                                      */
/* -------------------------------------------------------------------------- */

async function auditPhase(context: PipelineContext, crawled: CrawledPage[]): Promise<void> {
  const inputs: AuditPageInput[] = crawled.map((page) => ({
    runId: context.runId,
    phase: context.phase,
    pageId: page.pageId,
    pageUrl: page.url,
    capture: page.capture,
    signal: context.signal,
  }));

  /* -- 2b. MEDIA first, awaited last. Its own queue, never blocks browsers. */
  const mediaQueue = laneOverPages(context, inputs, {
    phase: 'media',
    agent: 'MEDIA',
    concurrency: 2,
    run: (input) => runMediaLane(input),
  });
  // A rejection here must not become an unhandled rejection while VIS/ACT run.
  mediaQueue.catch(() => undefined);

  /* -- 1. TREE. Every page, no sandbox, no model. The cheap gate. --------- */
  await laneOverPages(context, inputs, {
    phase: 'tree',
    agent: 'TREE',
    concurrency: 6,
    run: (input) => runTreeLane(input),
  });

  /* -- Path enumeration: the tree and vision, diffed (A4.1, A4.2). -------- */
  const pathsByPage = await enumeratePaths(context, inputs);

  /* -- 2. VIS and ACT in parallel (A3.3). -------------------------------- */
  const vis = laneOverPages(context, inputs, {
    phase: 'vis',
    agent: 'VIS',
    concurrency: 4,
    run: (input) => runVisLane(input),
  });

  const code = laneOverPages(context, inputs, {
    phase: 'code',
    agent: 'CODE',
    concurrency: 4,
    run: (input) => runCodeLane(input),
  });

  // ACT's concurrency is the sandbox pool's, not this number: every path batch
  // takes a browser permit inside `runBrowserJob`, and excess paths queue there
  // rather than being dropped (A3.3, design "Failure Handling").
  const act = laneOverPages(context, inputs, {
    phase: 'act',
    agent: 'ACT',
    concurrency: inputs.length || 1,
    run: (input) => runActLane({ ...input, paths: pathsByPage.get(input.pageUrl) ?? [] }),
  });

  await Promise.all([vis, act, code]);

  /* -- 3. PAGES. Comparative, so it waits for the whole crawl (A3.5). ----- */
  await runJob(
    { runId: context.runId, phase: 'pages', jobKey: context.phase, agent: 'PAGES' },
    async ({ attach }) => {
      const outcome = await runPagesLane({
        runId: context.runId,
        phase: context.phase,
        pages: inputs,
        signal: context.signal,
      });
      await attach({ sessionId: outcome.sessionId ?? null });
      await recordFindings({
        runId: context.runId,
        phase: context.phase,
        agent: 'PAGES',
        sessionId: outcome.sessionId ?? null,
        claims: outcome.findings,
      });
      return { findings: outcome.findings.length };
    },
    {
      onError: () => ({ findings: 0 }),
      toResult: (value) => ({ findings: value.findings }),
      fromResult: (result) => ({ findings: Number(result.findings ?? 0) }),
    },
  );

  /* -- 2b joined. --------------------------------------------------------- */
  await mediaQueue;
}

interface LaneSpec {
  phase: 'tree' | 'vis' | 'act' | 'media' | 'code';
  agent: 'TREE' | 'VIS' | 'ACT' | 'MEDIA' | 'CODE';
  concurrency: number;
  run: (input: AuditPageInput) => Promise<AuditLaneResult>;
}

/**
 * Run one lane across every page.
 *
 * A lane that fails on one page fails that page's job row and moves on. Losing
 * a page from one lane costs a few findings; aborting the run costs the
 * baseline.
 */
async function laneOverPages(
  context: PipelineContext,
  inputs: readonly AuditPageInput[],
  spec: LaneSpec,
): Promise<void> {
  await emitEvent({
    runId: context.runId,
    type: 'phase',
    agent: spec.agent,
    capability: spec.agent === 'TREE' ? 'ledger' : 'model',
    summary: `${spec.agent} starting over ${inputs.length} page(s).`,
    data: { phase: spec.phase, pages: inputs.length },
  });

  await mapLimit(inputs, spec.concurrency, async (input) => {
    /*
     * Two cancellation questions, and both are cheap.
     *
     * `aborted` covers an explicit stop. `lostReason` covers the case an abort
     * cannot: a lease taken by another process, where the successor is already
     * auditing these same pages and a second set of rows through
     * `recordFindings` would be duplicate work charged to the same run. Asked
     * per page rather than per phase because a lane over 25 pages is minutes
     * long, and asked synchronously off the handle rather than against the
     * database, which the phase boundaries already do.
     */
    if (context.signal?.aborted) return;
    if (context.lease?.lostReason) return;

    await runJob(
      {
        runId: context.runId,
        phase: spec.phase,
        // The run phase is part of the key: the final audit covers the same
        // pages as the baseline, and without it the job rows would collide and
        // the final pass would be skipped as already done.
        jobKey: `${context.phase}:${input.pageUrl}`,
        agent: spec.agent,
      },
      async ({ attach }) => {
        const outcome = await spec.run(input);
        await attach({ sessionId: outcome.sessionId ?? null });

        const recorded = await recordFindings({
          runId: context.runId,
          phase: context.phase,
          agent: spec.agent,
          pageId: input.pageId,
          sessionId: outcome.sessionId ?? null,
          claims: outcome.findings,
        });
        return { recorded: recorded.inserted.length, rejected: recorded.rejected.length };
      },
      {
        // One page's failure is not the lane's failure.
        onError: () => ({ recorded: 0, rejected: 0 }),
        // A12.2: a restarted run does not pay for a lane it already completed.
        toResult: (value) => ({ recorded: value.recorded, rejected: value.rejected }),
        fromResult: (result) => ({
          recorded: Number(result.recorded ?? 0),
          rejected: Number(result.rejected ?? 0),
        }),
      },
    );
  });
}

/**
 * Enumerate interaction paths per page (A4.1, A4.2).
 *
 * The discrepancy findings — a control vision can see that the accessibility
 * tree cannot — come back from the same call and go straight into the ledger.
 * They are the div-button findings, and they are the point.
 */
async function enumeratePaths(
  context: PipelineContext,
  inputs: readonly AuditPageInput[],
): Promise<Map<string, InteractionPath[]>> {
  const byPage = new Map<string, InteractionPath[]>();

  await mapLimit(inputs, 4, async (input) => {
    const outcome = await runJob(
      {
        runId: context.runId,
        phase: 'paths',
        jobKey: `${context.phase}:${input.pageUrl}`,
        agent: 'VIS',
      },
      async ({ attach }) => {
        const enumerated = await enumerateInteractionPaths({
          runId: context.runId,
          pageUrl: input.pageUrl,
          capture: input.capture,
          signal: context.signal,
        });
        await attach({ sessionId: enumerated.sessionId ?? null });

        if (enumerated.findings.length > 0) {
          await recordFindings({
            runId: context.runId,
            phase: context.phase,
            agent: 'VIS',
            pageId: input.pageId,
            sessionId: enumerated.sessionId ?? null,
            claims: enumerated.findings,
          });
        }
        return { paths: [...enumerated.paths] };
      },
      {
        // Paths are small and structured, so they are stored on the job row.
        // A restart then feeds ACT the same paths without re-enumerating.
        toResult: (value) => ({ paths: value.paths as unknown as Record<string, unknown>[] }),
        fromResult: (result) => ({
          paths: (Array.isArray(result.paths) ? result.paths : []) as InteractionPath[],
        }),
        onError: () => ({ paths: [] as InteractionPath[] }),
      },
    );

    byPage.set(input.pageUrl, outcome.paths);
  });

  return byPage;
}

/* -------------------------------------------------------------------------- */
/* Score                                                                      */
/* -------------------------------------------------------------------------- */

async function scorePhase(context: PipelineContext, anyPageUrl: string): Promise<void> {
  await runJob(
    { runId: context.runId, phase: 'score', jobKey: context.phase, agent: 'APP' },
    async () => {
      // A2.4: the two blocked criteria are written as BLOCKED with a reason.
      // They are never reported as passing, and a left join cannot tell the
      // difference unless the block is a row.
      await recordBlockedCriteria(context.runId, context.phase, anyPageUrl);

      const score = await scoreRun(context.runId, context.phase);
      await emitEvent({
        runId: context.runId,
        type: 'score',
        capability: 'ledger',
        summary:
          `${context.phase} score: ${score.failingCriteria} failing, ` +
          `${score.flaggedCriteria} flagged, ${score.blockedCriteria} blocked, ` +
          `${score.totalFindings} finding(s).`,
        detail: score.disclaimer,
        data: {
          phase: context.phase,
          failingCriteria: score.failingCriteria,
          flaggedCriteria: score.flaggedCriteria,
          blockedCriteria: score.blockedCriteria,
          passingCriteria: score.passingCriteria,
          totalFindings: score.totalFindings,
          bySeverity: score.bySeverity,
        },
      });
      return score;
    },
    { toResult: (score) => ({ failing: score.failingCriteria, findings: score.totalFindings }) },
  );
}

/* -------------------------------------------------------------------------- */
/* Phase 4: FIX                                                               */
/* -------------------------------------------------------------------------- */

interface StoredPatch {
  id: string;
  filePath: string;
  diff: string;
  criteria: string[];
  findingIds: string[];
}

/**
 * A5.3: only `DECIDE` findings are fixable. `FLAG` stays with a human (A5.4).
 *
 * `fixing` is included alongside `open` because a run interrupted mid-FIX left
 * its findings in that state; excluding them would make a resumed run conclude
 * there was nothing to fix.
 */
async function openDecideFindings(runId: string, phase: RunPhase): Promise<Finding[]> {
  return db
    .select()
    .from(findings)
    .where(
      and(
        eq(findings.runId, runId),
        eq(findings.phase, phase),
        eq(findings.verdict, 'DECIDE'),
        inArray(findings.status, ['open', 'fixing']),
      ),
    );
}

/**
 * FIX writes patches, batched per source file (A5.2), from findings in the
 * ledger rather than from raw page content (A5.1).
 */
async function fixPhase(
  context: PipelineContext,
  token: string,
  fixable: Finding[],
): Promise<StoredPatch[]> {
  // A restarted run must not propose the same patch twice. Patches already on
  // the ledger are the FIX pass's output; rebuild the in-memory view from them
  // and skip straight to VERIFY.
  const existing = await db
    .select()
    .from(patches)
    .where(and(eq(patches.runId, context.runId), ne(patches.status, 'rejected')));

  if (existing.length > 0) {
    await emitEvent({
      runId: context.runId,
      type: 'log',
      agent: 'FIX',
      summary: `Reused ${existing.length} patch(es) already proposed for this run.`,
      detail: 'Resumed from the ledger rather than repeating the fix pass (A12.2).',
    });

    const criteriaByFinding = new Map(fixable.map((finding) => [finding.id, finding.criterion]));
    return existing.map((patch) => ({
      id: patch.id,
      filePath: patch.filePath,
      diff: patch.diff,
      criteria: [
        ...new Set(
          patch.findingIds
            .map((id) => criteriaByFinding.get(id))
            .filter((value): value is string => Boolean(value)),
        ),
      ],
      findingIds: patch.findingIds,
    }));
  }

  // A5.2: the batching is by file. Findings with no known source path go to the
  // human queue instead of being guessed at.
  const withSource = fixable.filter((finding) => finding.sourcePath);
  const withoutSource = fixable.length - withSource.length;

  if (withoutSource > 0) {
    await emitEvent({
      runId: context.runId,
      type: 'log',
      agent: 'FIX',
      summary: `${withoutSource} finding(s) have no source location and were not batched.`,
      detail: 'A fix needs a file. These stay open for a human.',
    });
  }

  if (withSource.length === 0) return [];

  await db
    .update(findings)
    .set({ status: 'fixing' })
    .where(
      and(
        eq(findings.runId, context.runId),
        inArray(
          findings.id,
          withSource.map((finding) => finding.id),
        ),
      ),
    );

  const files = [...new Set(withSource.map((finding) => finding.sourcePath!))];

  const stored: StoredPatch[] = [];

  await mapLimit(files, 2, async (filePath) => {
    const forFile = withSource.filter((finding) => finding.sourcePath === filePath);

    await runJob(
      { runId: context.runId, phase: 'fix', jobKey: filePath, agent: 'FIX' },
      async ({ attach }) => {
        const outcome = await writePatches({
          runId: context.runId,
          repoFullName: context.repoFullName,
          accessToken: token,
          findings: forFile,
          signal: context.signal,
        });
        await attach({ sessionId: outcome.sessionId ?? null });

        for (const patch of outcome.patches) {
          // A5.5: each patch records which findings it addresses.
          // A5.5: every patch records the findings it addresses. FIX names them
          // when it can; otherwise they are the findings in this file whose
          // criterion the patch claims.
          const covered: string[] =
            patch.findingIds && patch.findingIds.length > 0
              ? [...patch.findingIds]
              : forFile
                  .filter((finding) => patch.criteria.includes(finding.criterion))
                  .map((finding) => finding.id);

          const [row] = await db
            .insert(patches)
            .values({
              runId: context.runId,
              filePath: patch.sourcePath,
              diff: patch.diff,
              findingIds: covered,
              status: 'proposed',
            })
            .returning();

          if (covered.length > 0) {
            await db
              .update(findings)
              .set({ fixId: row.id })
              .where(and(eq(findings.runId, context.runId), inArray(findings.id, covered)));
          }

          stored.push({
            id: row.id,
            filePath: row.filePath,
            diff: row.diff,
            criteria: [...patch.criteria],
            findingIds: covered,
          });

          await emitEvent({
            runId: context.runId,
            type: 'patch',
            agent: 'FIX',
            capability: 'model',
            summary: `Patch proposed for ${patch.sourcePath}.`,
            detail: patch.rationale,
            data: {
              patchId: row.id,
              filePath: patch.sourcePath,
              criteria: patch.criteria,
              findings: covered.length,
              risk: patch.risk ?? null,
            },
          });
        }

        for (const skipped of outcome.skipped ?? []) {
          await emitEvent({
            runId: context.runId,
            type: 'log',
            agent: 'FIX',
            summary: `FIX declined ${skipped.criterion} in ${filePath}.`,
            detail: skipped.reason,
          });
        }

        return { patches: outcome.patches.length };
      },
      { onError: () => ({ patches: 0 }) },
    );
  });

  // Anything FIX did not cover goes back to `open` for the human queue (A5.4).
  const covered = new Set(stored.flatMap((patch) => patch.findingIds));
  const uncovered = withSource
    .filter((finding) => !covered.has(finding.id))
    .map((finding) => finding.id);

  if (uncovered.length > 0) {
    await db
      .update(findings)
      .set({ status: 'open' })
      .where(and(eq(findings.runId, context.runId), inArray(findings.id, uncovered)));
  }

  return stored;
}

/* -------------------------------------------------------------------------- */
/* Phase 5: VERIFY                                                            */
/* -------------------------------------------------------------------------- */

interface VerifyOutcome {
  ok: boolean;
  reason: string;
  criteriaFixed: string[];
  previewUrl: string | null;
}

/**
 * VERIFY gates everything (A6). The repository is built in a 4 CPU / 8 GB
 * sandbox, its own test suite runs, and every fixed criterion is re-checked. A
 * failing suite ends the run before a pull request exists (A6.4).
 */
async function verifyPhase(
  context: PipelineContext,
  token: string,
  proposed: StoredPatch[],
): Promise<VerifyOutcome> {
  // A build in a 4 CPU / 8 GB sandbox is the most expensive thing a run does.
  // If it already succeeded, a resumed run reads the verdict off the job row.
  const previous = await findJob(context.runId, 'verify', context.phase);
  if (previous?.status === 'succeeded' && previous.result) {
    const passed = previous.result.recommendation === 'open-pull-request';
    return {
      ok: passed,
      reason: passed
        ? 'Verification already passed for this run.'
        : 'Verification already failed for this run; no pull request was opened (A6.4).',
      criteriaFixed: Array.isArray(previous.result.criteriaFixed)
        ? (previous.result.criteriaFixed as string[])
        : [],
      previewUrl:
        typeof previous.result.previewUrl === 'string' ? previous.result.previewUrl : null,
    };
  }

  const job = await beginJob({
    runId: context.runId,
    phase: 'verify',
    jobKey: context.phase,
    agent: 'VERIFY',
  });

  try {
    const outcome = await verifyPatches({
      runId: context.runId,
      repoFullName: context.repoFullName,
      accessToken: token,
      patches: proposed.map((patch) => ({
        id: patch.id,
        filePath: patch.filePath,
        diff: patch.diff,
      })),
      signal: context.signal,
    });

    await attachSession(job.id, { sessionId: outcome.sessionId ?? null });

    const passed =
      outcome.buildPassed && outcome.testsPassed && outcome.recommendation === 'open-pull-request';

    const resolved = (outcome.recheck ?? []).filter((entry) => entry.resolved);
    const criteriaFixed = resolved.map((entry) => entry.criterion);

    // A6.5: the verification result is recorded against every finding it covers.
    const patchIds = proposed.map((patch) => patch.id);
    if (patchIds.length > 0) {
      await db
        .update(patches)
        .set({ status: passed ? 'verified' : 'rejected' })
        .where(and(eq(patches.runId, context.runId), inArray(patches.id, patchIds)));
    }

    const coveredFindingIds = proposed.flatMap((patch) => patch.findingIds);
    if (coveredFindingIds.length > 0) {
      await db
        .update(findings)
        .set({ status: passed ? 'verified' : 'open', ...(passed ? {} : { fixId: null }) })
        .where(and(eq(findings.runId, context.runId), inArray(findings.id, coveredFindingIds)));
    }

    await emitEvent({
      runId: context.runId,
      type: 'log',
      agent: 'VERIFY',
      capability: 'sandbox',
      summary: passed
        ? `Build and ${outcome.testCommand} passed; ${criteriaFixed.length} criterion(s) re-checked clean.`
        : `Verification failed: ${outcome.buildPassed ? 'build ok' : 'build failed'}, ${outcome.testsPassed ? 'tests ok' : 'tests failed'}.`,
      detail: outcome.testSummary,
      data: {
        buildPassed: outcome.buildPassed,
        testsPassed: outcome.testsPassed,
        testCommand: outcome.testCommand,
        recommendation: outcome.recommendation,
        recheck: outcome.recheck,
      },
    });

    await completeJob(job.id, {
      result: {
        buildPassed: outcome.buildPassed,
        testsPassed: outcome.testsPassed,
        recommendation: outcome.recommendation,
        criteriaFixed,
        previewUrl: outcome.previewUrl ?? null,
      },
    });

    return {
      ok: passed,
      reason: passed
        ? `Build and ${outcome.testCommand} passed. ${criteriaFixed.length} criterion(s) re-checked clean.`
        : `The target's own test suite did not pass (${outcome.testCommand}), so no pull request was opened (A6.4). ${outcome.testSummary}`,
      criteriaFixed,
      previewUrl: outcome.previewUrl ?? null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await failJob(job.id, reason);

    // Design, "Failure Handling": a repository that will not build leaves the
    // baseline intact and skips FIX and VERIFY with a stated reason.
    return {
      ok: false,
      reason: `Verification could not run: ${reason}. The baseline score stands; no pull request was opened.`,
      criteriaFixed: [],
      previewUrl: null,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Phase 6: pull request and final score                                      */
/* -------------------------------------------------------------------------- */

/**
 * A7.1: the run pauses before pushing a branch and before opening a pull
 * request. The card states the intent, the reason, and the evidence (A7.2).
 *
 * The gate is *recovered*, not re-raised. A restart between the card going up
 * and the PR being opened used to produce a second card over the same decision
 * — and, once approved twice, a second branch and a second pull request on the
 * user's repository. So the fixed `pr`/`approval` job row is the continuation
 * point: it remembers the handoff, and a resumed run re-enters that same wait
 * rather than starting a new conversation (A7.4, A12.2).
 */
async function pullRequestGate(
  context: PipelineContext,
  verificationSummary: string,
): Promise<boolean> {
  const previous = await findJob(context.runId, 'pr', 'approval');

  // The decision was already reached and recorded. Nothing to ask again.
  if (previous?.status === 'succeeded' || previous?.status === 'skipped') {
    const approved = previous.status === 'succeeded';
    await emitEvent({
      runId: context.runId,
      type: 'approval',
      capability: 'approval',
      summary: approved
        ? 'The pull request was already approved for this run.'
        : 'The pull request was already declined for this run.',
      detail: 'Recovered from the ledger rather than asking a second time (A12.2).',
      data: { handoffId: previous.handoffId, resumed: true },
    });
    return approved;
  }

  // A card is already up for this run. Re-enter its wait.
  let handoff = previous?.handoffId ? await loadHandoff(previous.handoffId) : null;
  if (handoff && handoff.runId !== context.runId) handoff = null;

  let jobId = previous?.id ?? null;

  if (!handoff) {
    handoff = await raiseHandoff({
      runId: context.runId,
      kind: 'approval',
      agent: 'APP',
      intent: `Push a branch to ${context.repoFullName} and open a pull request with the accessibility fixes.`,
      reason:
        `${verificationSummary} Pushing a branch and opening a pull request are ` +
        'irreversible actions on your repository, so AccessiFix will not do either ' +
        'without your say-so (A7.1). The pull request is opened with your own GitHub ' +
        'token, not a bot account.',
    });

    const job = await beginJob({
      runId: context.runId,
      phase: 'pr',
      jobKey: 'approval',
      agent: 'APP',
    });
    jobId = job.id;
    await pauseJobForApproval(job.id, { handoffId: handoff.id });
  } else {
    await emitEvent({
      runId: context.runId,
      type: 'approval',
      capability: 'approval',
      summary: 'Re-entered the existing approval for this pull request.',
      detail:
        'A card was already raised for this run before the interruption; the same ' +
        'decision is awaited rather than a second one being asked for (A7.4).',
      data: { handoffId: handoff.id, status: handoff.status, resumed: true },
    });
  }

  // Only pause the run if the answer is not already in. `enterState` rather
  // than `transition`, because a resumed run may still be sitting in
  // `awaiting_approval` and a no-op move is not a legal transition.
  if (handoff.status === 'pending') {
    await enterState(context.runId, 'awaiting_approval', {
      reason: 'Waiting for approval to open a pull request.',
      data: { handoffId: handoff.id },
    });
  }

  // The wait is the `handoffs` row, not this promise: a restart re-enters the
  // same wait and sees the same answer (A7.4).
  const decision = await awaitHandoff(handoff.id, { signal: context.signal });

  await resumeFromPause(context.runId, {
    reason: decision.approved ? 'Pull request approved.' : 'Pull request declined.',
  });

  /*
   * Record the answer on the job row *before* returning, so the durable
   * continuation point is set: a crash between here and `prPhase` re-enters
   * this function, reads `succeeded`, and goes straight to opening the pull
   * request instead of asking again.
   */
  if (jobId) {
    if (decision.approved) await completeJob(jobId, { result: { approved: true } });
    else await skipJob(jobId, decision.response ?? 'Declined by the user.');
  }

  return decision.approved;
}

async function prPhase(
  context: PipelineContext,
  token: string,
  proposed: StoredPatch[],
  criteriaFixed: string[],
): Promise<void> {
  await runJob(
    { runId: context.runId, phase: 'pr', jobKey: 'open', agent: 'APP' },
    async () => {
      const criteria = [...new Set(proposed.flatMap((patch) => patch.criteria))].sort();

      const pr = await openPullRequest({
        runId: context.runId,
        repoFullName: context.repoFullName,
        accessToken: token,
        signal: context.signal,
        branch: `accessifix/run-${context.runId.slice(0, 8)}`,
        title: `Accessibility fixes for ${criteria.length} WCAG 2.2 criteria`,
        // A10.5: the body cites each criterion, which is also what makes the
        // pull request reviewable by Qodo.
        body: buildPullRequestBody(context, proposed, criteria, criteriaFixed),
        patches: proposed.map((patch) => ({ filePath: patch.filePath, diff: patch.diff })),
      });

      await db
        .update(patches)
        .set({ status: 'applied' })
        .where(
          and(
            eq(patches.runId, context.runId),
            inArray(
              patches.id,
              proposed.map((patch) => patch.id),
            ),
          ),
        );

      await emitEvent({
        runId: context.runId,
        type: 'log',
        agent: 'APP',
        capability: 'approval',
        summary: `Pull request #${pr.number} opened against ${context.repoFullName}.`,
        detail: pr.url,
        data: { url: pr.url, number: pr.number, branch: pr.branch },
      });

      return pr;
    },
    {
      toResult: (pr) => ({ url: pr.url, number: pr.number, branch: pr.branch }),
      /*
       * Without this, `runJob`'s reuse path never fires and a resumed run opens
       * a *second* pull request against the user's repository. Opening a PR is
       * the least idempotent thing this pipeline does, so the stored result is
       * the authority: if the row says it was opened, it was opened.
       */
      fromResult: (result) => ({
        url: String(result.url ?? ''),
        number: Number(result.number ?? 0),
        branch: String(result.branch ?? ''),
      }),
    },
  );
}

function buildPullRequestBody(
  context: PipelineContext,
  proposed: StoredPatch[],
  criteria: string[],
  criteriaFixed: string[],
): string {
  const lines = [
    '## Accessibility fixes from AccessiFix',
    '',
    `Audited: ${context.deployedUrl}`,
    '',
    '### Criteria addressed',
    '',
    ...criteria.map((id) => `- WCAG 2.2 ${id}${criteriaFixed.includes(id) ? ' — re-checked clean' : ''}`),
    '',
    '### Files changed',
    '',
    ...proposed.map((patch) => `- \`${patch.filePath}\` (${patch.findingIds.length} finding(s))`),
    '',
    '---',
    '',
    'The repository\'s own test suite passed against these changes before this ' +
      'pull request was opened. This is a count of findings against the 55 WCAG 2.2 ' +
      'Level A and AA success criteria, not a conformance claim.',
  ];
  return lines.join('\n');
}

/**
 * A8.1: after verification passes, the full 55-criterion audit re-runs in
 * `phase = final`. Both phases live under the same run id, so the delta is one
 * grouped query over one table.
 */
async function finalAuditPhase(context: PipelineContext, url: string): Promise<void> {
  await setRunPhase(context.runId, 'final');
  const finalContext: PipelineContext = { ...context, phase: 'final', deployedUrl: url };

  await enterState(context.runId, 'auditing', { reason: 'Re-auditing for the final score.' });
  const crawled = await runJob(
    { runId: context.runId, phase: 'final_audit', jobKey: 'crawl', agent: 'APP' },
    () =>
      crawl(context.runId, url, {
        maxPages: context.options.maxPages ?? MAX_PAGES_PER_CRAWL,
        signal: context.signal,
      }).then((result) => result.pages),
  );

  await auditPhase(finalContext, crawled);

  await enterState(context.runId, 'scoring');
  await scorePhase(finalContext, crawled[0]?.url ?? url);

  const delta = await scoreDelta(context.runId);
  await emitEvent({
    runId: context.runId,
    type: 'score',
    capability: 'ledger',
    summary:
      `Delta: ${delta.criteriaFixed.length} criterion(s) moved to passing, ` +
      `${delta.findingsResolved} finding(s) resolved, ${delta.findingsRemaining} remaining.`,
    detail: delta.disclaimer,
    data: {
      criteriaFixed: delta.criteriaFixed,
      criteriaRegressed: delta.criteriaRegressed,
      findingsResolved: delta.findingsResolved,
      findingsRemaining: delta.findingsRemaining,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * Not `SandboxPool.map`: that governor exists to cap *sandboxes*, and the model
 * lanes here take no sandbox. Borrowing its permits would starve ACT.
 */
async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length || 1));
  let cursor = 0;

  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await fn(items[index], index);
    }
  });

  await Promise.all(workers);
}
