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
import { operationMismatch, type ApprovalOperation } from '@/lib/fix/gate';
import { locateFindingSourcesDetailed } from '@/lib/fix/locate';
import { normalizeRepoPath } from '@/lib/fix/source';
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
  extractVisionCandidates,
  openPullRequest,
  planPullRequest,
  runActLane,
  runCodeLane,
  runMediaLane,
  runPagesLane,
  runTreeLane,
  runVisLane,
  verifyPatches,
  writePatches,
  type ApprovedWriteOperations,
  type AuditLaneResult,
  type AuditPageInput,
  type OpenPullRequestInput,
  type PullRequestPlan,
} from './lanes';
import type { FixableFinding } from '@/lib/fix/group';
import { emitEvent } from './events';
import { awaitHandoff, loadHandoff, raiseHandoff } from './handoff';
import { claimRun, holdLease, type LeaseHandle } from './lease';
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
    return {
      started: false,
      alreadyRunning: true,
      reason: 'A conductor in this process is already running this run.',
    };
  }

  // The durable half. A lease held by a live conductor in any process refuses
  // the claim; one whose owner died has expired and is taken over here.
  const claim = await claimRun(runId);
  if (!claim.ok) {
    return { started: false, alreadyRunning: true, reason: claim.reason };
  }

  const controller = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true });
  }

  const lease = holdLease(runId, {
    owner: claim.owner,
    onLost: (reason) => controller.abort(new Error(reason)),
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
  return { started: true, alreadyRunning: false, reason: claim.reason };
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
    ownLease = holdLease(runId, {
      owner: claim.owner,
      onLost: (reason) => controller.abort(new Error(reason)),
    });
    signal = controller.signal;
  }

  try {
    await conductRun(runId, { ...options, signal });
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
    if (reached('auditing')) await enterState(runId, 'auditing');
    await auditPhase(context, crawled);

    /* ---- Baseline score ------------------------------------------------ */
    if (reached('scoring')) await enterState(runId, 'scoring');
    await scorePhase(context, crawled[0]?.url ?? context.deployedUrl);

    if (options.baselineOnly) {
      await transition(runId, 'done', { reason: 'Baseline only: fixes were not requested.' });
      return;
    }

    /* ---- 4. Fix -------------------------------------------------------- */
    /*
     * A resumed run must not mistake its own progress for nothing to do.
     *
     * `openDecideFindings` asks for `open` or `fixing`. Once VERIFY has passed,
     * the findings it covered are `verified`, so a run interrupted between
     * verification and the pull request comes back here to an empty list and
     * used to end at "No DECIDE findings to fix" — discarding a completed
     * crawl, audit, fix and verify, and stranding the approval card with no
     * conductor able to act on it. That is not "nothing to fix"; it is a fix
     * already made and not yet delivered.
     *
     * So the patches decide. Findings still open drive a first pass; if there
     * are none but the ledger holds patches, the run carries on to deliver
     * them, and `fixPhase` reuses what is already there rather than paying a
     * model to write it twice.
     */
    const decidable = await openDecideFindings(runId, 'baseline');
    const carried = await patchedFindings(runId, 'baseline');

    if (decidable.length === 0 && carried.length === 0) {
      await transition(runId, 'done', {
        reason: 'No DECIDE findings to fix. FLAG findings stay in the human queue (A5.4).',
      });
      return;
    }

    // What the pull request cites. On a resume the open list is empty and the
    // covered findings are the ones the stored patches name.
    const fixTargets = decidable.length > 0 ? decidable : carried;

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

    if (reached('fixing')) await enterState(runId, 'fixing');
    const fixed = await fixPhase(context, token, fixTargets);
    const proposed = fixed.patches;

    if (proposed.length === 0) {
      await transition(runId, 'done', {
        reason: describeNoPatches(fixed.skipped),
      });
      return;
    }

    /* ---- 5. Verify ----------------------------------------------------- */
    if (reached('verifying')) await enterState(runId, 'verifying');
    const verification = await verifyPhase(context, token, proposed);

    if (!verification.ok) {
      // A6.4 and the design's failure table: patch rejected, findings returned
      // to `open`, no pull request.
      await transition(runId, 'done', { reason: verification.reason });
      return;
    }

    /* ---- 6. Pull request, then the final score -------------------------- */
    /*
     * The plan is worked out before the human is asked, not after. It is what
     * the card describes and what the answer is recorded against: the branch,
     * the base, the title, and the digest of every file's contents. Nothing
     * here writes anything — every GitHub call it makes is a read.
     */
    const seam = pullRequestSeamInput(
      context,
      token,
      proposed,
      verification.criteriaFixed,
      verification.evidence,
      fixTargets,
    );

    let plan: PullRequestPlan;
    try {
      plan = await planPullRequest(seam);
    } catch (error) {
      // Nothing to ask about: the patches no longer apply, or the repository
      // could not be read. Say so rather than raising a card for a write that
      // could not happen.
      await transition(runId, 'done', {
        reason:
          'No pull request could be prepared, so none was proposed: ' +
          (error instanceof Error ? error.message : String(error)),
      });
      return;
    }

    const gate = await pullRequestGate(context, verification.reason, plan);
    if (!gate.approved || !gate.requestId || !gate.operations) {
      await transition(runId, 'done', {
        reason: 'The pull request was declined. Patches are recorded but nothing was pushed.',
      });
      return;
    }

    await prPhase(context, seam, proposed, gate.requestId, gate.operations);
    await finalAuditPhase(context, verification.previewUrl ?? context.deployedUrl);

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
    if (context.signal?.aborted) return;

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
 * Two sources, and the job is only worth doing because there are two.
 *
 * The accessibility tree, enumeration reads for itself: every node whose role
 * implies a state, every node already carrying `aria-expanded` and friends.
 * That list alone is enough to catch a stale-state 4.1.2 — a control whose
 * declared state never moves while the tree beneath it does — because both
 * halves of that comparison live in the tree.
 *
 * The second source is a screenshot, and reading one needs a model. That is
 * `extractVisionCandidates`, called here on the PNG the crawl already took —
 * no page is reopened and no sandbox is taken. Subtracting the tree from what
 * vision saw leaves the controls a sighted user can operate and a screen reader
 * user is never told about: the div-buttons. They are findings the moment they
 * are noticed, before anything has been clicked, and they are the point.
 *
 * The vision pass is best-effort by contract. A page whose screenshot is
 * missing, too large to send, or whose model call failed is enumerated from the
 * tree alone and says so on the timeline. Degrading is correct; failing the
 * page is not.
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
        const vision = await extractVisionCandidates({
          runId: context.runId,
          pageUrl: input.pageUrl,
          screenshot: input.capture.screenshot,
          title: input.capture.title,
        });

        // Attached before enumeration so a crash mid-enumeration still leaves a
        // session the restart can reattach to rather than pay for twice (A12.1).
        await attach({ sessionId: vision.sessionId });
        await reportVisionPass(context.runId, input.pageUrl, vision);

        const enumerated = await enumerateInteractionPaths({
          runId: context.runId,
          pageUrl: input.pageUrl,
          capture: input.capture,
          visionCandidates: vision.candidates,
        });
        // Enumeration itself is pure and calls no model, so the vision pass is
        // the only session this job ever has.

        if (enumerated.findings.length > 0) {
          await recordFindings({
            runId: context.runId,
            phase: context.phase,
            agent: 'VIS',
            pageId: input.pageId,
            sessionId: vision.sessionId,
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

/**
 * Put the screenshot pass on the run timeline (A11.1).
 *
 * Worth an event of its own rather than folding into the enumeration line: the
 * number of candidates is how an operator tells "the tree had nothing to
 * subtract from" apart from "vision found nothing", and a page silently
 * enumerated tree-only is exactly the state that looks like a clean bill of
 * health and is not.
 */
async function reportVisionPass(
  runId: string,
  pageUrl: string,
  vision: Awaited<ReturnType<typeof extractVisionCandidates>>,
): Promise<void> {
  const degraded = vision.error !== null || vision.skipped !== null;
  const why = vision.error ?? vision.skipped ?? '';

  await emitEvent({
    runId,
    type: degraded ? 'log' : 'job',
    agent: 'VIS',
    capability: 'model',
    summary: degraded
      ? `Vision pass produced no candidates for ${pageUrl}; enumerating from the accessibility tree alone.`
      : `Vision identified ${vision.candidates.length} candidate control(s) on ${pageUrl}.`,
    detail: degraded
      ? `${why} Tree-only enumeration still finds stale-state 4.1.2 failures, but cannot find a control the tree does not contain.`
      : null,
    data: {
      pageUrl,
      candidates: vision.candidates.length,
      sessionId: vision.sessionId,
      skipped: vision.skipped,
      error: vision.error,
    },
  });
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

/** One finding the FIX pass did not patch, and the sentence that says why. */
interface SkipNote {
  filePath: string;
  criterion: string;
  reason: string;
}

/**
 * What the FIX pass produced, and what it declined.
 *
 * `skipped` is not diagnostics. It is the other half of the answer: a run that
 * ends without a pull request has to be able to say, finding by finding, why.
 * The pass used to return only the patches, so "FIX produced no patches" was
 * the entire report on a five-minute run — and when the agent was answering in
 * a shape the parser silently discarded, that sentence was also the only
 * symptom. A silent no-op is the failure mode this product exists to
 * eliminate; it must not be ours.
 */
interface FixOutcome {
  patches: StoredPatch[];
  skipped: SkipNote[];
}

/** The closing sentence of a run that patched nothing, with the reasons. */
function describeNoPatches(skipped: readonly SkipNote[]): string {
  const head = 'FIX produced no patches. The findings remain open for a human.';
  if (skipped.length === 0) {
    return (
      `${head} No reason was recorded for any of them, which is itself a defect — ` +
      'the FIX pass is expected to state one per finding.'
    );
  }

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const note of skipped) {
    const key = `${note.filePath}|${note.criterion}|${note.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${note.criterion} in ${note.filePath}: ${note.reason}`);
  }

  const shown = lines.slice(0, 8);
  const rest = lines.length - shown.length;
  return [
    head,
    '',
    ...shown,
    ...(rest > 0 ? [`- and ${rest} more, in the run timeline.`] : []),
  ].join('\n');
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
 * The findings that this run's surviving patches were written for.
 *
 * Read by id from the patch rows rather than by status, because their status is
 * exactly what a resume cannot rely on: a finding covered by a verified patch
 * is `verified`, which every "what is left to do" query excludes.
 */
async function patchedFindings(runId: string, phase: RunPhase): Promise<Finding[]> {
  const rows = await db
    .select()
    .from(patches)
    .where(and(eq(patches.runId, runId), ne(patches.status, 'rejected')));

  const ids = [...new Set(rows.flatMap((row) => row.findingIds))];
  if (ids.length === 0) return [];

  return db
    .select()
    .from(findings)
    .where(
      and(eq(findings.runId, runId), eq(findings.phase, phase), inArray(findings.id, ids)),
    );
}

/**
 * Attach a source file to every finding that does not already have one.
 *
 * The audit lanes that matter most — VIS and ACT — never see the repository.
 * They see a rendered page, so what they can name is an element, not a file.
 * CODE is the only lane that sets `sourcePath` itself, and CODE covers three
 * criteria. Everything else arrives here with `sourcePath: null`, which
 * `groupFindingsForFix` reads as "not patchable" and routes to the human queue.
 *
 * The paths are attached in memory, on the copies handed to FIX. Nothing is
 * written back to the `findings` table: `recordFindings()` stays the only
 * writer, and a located path is an inference about the repository at this
 * commit rather than a fact the audit observed.
 *
 * A failure here is not fatal. The findings simply keep the paths they came
 * with, and the ones without go to the human queue exactly as they did before.
 */
async function locateSources(
  context: PipelineContext,
  token: string,
  fixable: readonly Finding[],
): Promise<Finding[]> {
  const unlocated = fixable.filter((finding) => !finding.sourcePath);
  if (unlocated.length === 0) return [...fixable];

  try {
    const located = await locateFindingSourcesDetailed({
      repoFullName: context.repoFullName,
      accessToken: token,
      // No ref: the locator resolves the repository's default branch, which is
      // the same commit `readRepoFile` and the patch branch are taken from.
      signal: context.signal,
      findings: unlocated.map((finding) => ({
        id: finding.id,
        criterion: finding.criterion,
        summary: finding.summary,
        detail: finding.detail,
        sourcePath: finding.sourcePath,
        pageUrl: finding.pageUrl,
      })),
      onLog: (line) => {
        void emitEvent({ runId: context.runId, type: 'log', agent: 'FIX', summary: line });
      },
    });

    const paths = new Map(located.map((item) => [item.findingId, item.sourcePath]));
    const resolved = located.filter((item) => item.sourcePath !== null);

    await emitEvent({
      runId: context.runId,
      type: 'log',
      agent: 'FIX',
      summary: `Located source files for ${resolved.length} of ${unlocated.length} live-audit finding(s).`,
      detail:
        resolved.length > 0
          ? resolved.map((item) => `${item.sourcePath} — ${item.reason}`).join('\n')
          : 'None could be traced to a file with enough confidence to patch.',
    });

    return fixable.map((finding) =>
      finding.sourcePath ? finding : { ...finding, sourcePath: paths.get(finding.id) ?? null },
    );
  } catch (error) {
    await emitEvent({
      runId: context.runId,
      type: 'log',
      agent: 'FIX',
      summary: 'Source location failed; findings keep whatever path they arrived with.',
      detail: (error as Error).message,
    });
    return [...fixable];
  }
}

/**
 * FIX writes patches, batched per source file (A5.2), from findings in the
 * ledger rather than from raw page content (A5.1).
 */
async function fixPhase(
  context: PipelineContext,
  token: string,
  fixable: Finding[],
): Promise<FixOutcome> {
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
    return {
      patches: existing.map((patch) => ({
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
      })),
      skipped: [],
    };
  }

  // VIS and ACT audited the deployed site, so their findings name an element
  // and a selector but no file. Without this step every one of them falls into
  // the `withSource` filter below as a miss, FIX is handed nothing, and no pull
  // request is ever opened. `locateFindingSources` maps each back to the file
  // that renders it — or to `null`, which is the honest answer and keeps the
  // finding in the human queue rather than pointing FIX at the wrong component.
  const fixableWithPaths = await locateSources(context, token, fixable);

  // A5.2: the batching is by file. Findings with no known source path go to the
  // human queue instead of being guessed at.
  const withSource = fixableWithPaths.filter((finding) => finding.sourcePath);
  const withoutSource = fixableWithPaths.filter((finding) => !finding.sourcePath);

  // Every finding this pass will not patch collects a sentence here, and those
  // sentences travel all the way to the run's closing state event.
  const notes: SkipNote[] = withoutSource.map((finding) => ({
    filePath: '(no source file)',
    criterion: finding.criterion,
    reason:
      'The audit decided this finding, but it could not be mapped to a file in the ' +
      'repository, so there is nothing to patch.',
  }));

  if (withoutSource.length > 0) {
    await emitEvent({
      runId: context.runId,
      type: 'log',
      agent: 'FIX',
      summary: `${withoutSource.length} finding(s) have no source location and were not batched.`,
      detail: 'A fix needs a file. These stay open for a human.',
    });
  }

  if (withSource.length === 0) return { patches: [], skipped: notes };

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
          notes.push({ filePath, criterion: skipped.criterion, reason: skipped.reason });
          await emitEvent({
            runId: context.runId,
            type: 'log',
            agent: 'FIX',
            summary: `FIX declined ${skipped.criterion} in ${filePath}.`,
            detail: skipped.reason,
          });
        }

        // A warning is the parser reporting a repair it had to make — a response
        // in the wrong shape, a path it had to reconcile. It is not a failure, and
        // it is exactly the thing that is invisible until it costs a whole run.
        for (const warning of outcome.warnings ?? []) {
          await emitEvent({
            runId: context.runId,
            type: 'log',
            agent: 'FIX',
            summary: `FIX response for ${filePath} needed repair.`,
            detail: warning,
          });
        }

        if (outcome.patches.length === 0 && (outcome.skipped ?? []).length === 0) {
          const reason =
            `FIX returned nothing usable for ${filePath} and gave no reason. The findings ` +
            'stay open.';
          for (const finding of forFile) {
            notes.push({ filePath, criterion: finding.criterion, reason });
          }
          await emitEvent({
            runId: context.runId,
            type: 'log',
            agent: 'FIX',
            summary: `FIX produced no patch for ${filePath} and no reason.`,
            detail: reason,
          });
        }

        return { patches: outcome.patches.length };
      },
      {
        // `runJob` has already written the failure to the ledger and the
        // timeline. Stepping aside here keeps the other files going, but the
        // findings in this one must still carry a sentence into the run report
        // rather than disappearing into a patch count of zero.
        onError: (error) => {
          const reason =
            `The FIX job for ${filePath} failed: ` +
            (error instanceof Error ? error.message : String(error));
          for (const finding of forFile) {
            notes.push({ filePath, criterion: finding.criterion, reason });
          }
          return { patches: 0 };
        },
      },
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

  return { patches: stored, skipped: notes };
}

/* -------------------------------------------------------------------------- */
/* Phase 5: VERIFY                                                            */
/* -------------------------------------------------------------------------- */

interface VerifyOutcome {
  ok: boolean;
  reason: string;
  criteriaFixed: string[];
  previewUrl: string | null;
  /**
   * The evidence `openVerifiedPullRequest` gates on. Carried explicitly rather
   * than recomputed, because the gates must read what VERIFY actually observed
   * - and because `passed` and `ran` are different facts. A repository with no
   * test suite has not failed; it has proven nothing, and conflating the two
   * would either reject a good patch or open a pull request on no evidence.
   */
  evidence: {
    buildPassed: boolean;
    buildRan: boolean;
    testsPassed: boolean;
    testsRan: boolean;
    testCommand: string;
    testSummary: string;
  };
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
      // Recovered from the job row rather than re-derived. `buildRan`/`testsRan`
      // default true because only a caller that explicitly recorded a step as
      // not-run should get the softer 'unproven' reading (A6.4).
      evidence: {
        buildPassed: Boolean(previous.result.buildPassed),
        buildRan: previous.result.buildRan !== false,
        testsPassed: Boolean(previous.result.testsPassed),
        testsRan: previous.result.testsRan !== false,
        testCommand: String(previous.result.testCommand ?? ''),
        testSummary: String(previous.result.testSummary ?? ''),
      },
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

    // "tests failed" on its own sent a maintainer to read a diff that was fine.
    // The line has to answer the only question they have — *is our change at
    // fault?* — so it names the tests and says whether they were already red.
    await emitEvent({
      runId: context.runId,
      type: 'log',
      agent: 'VERIFY',
      capability: 'sandbox',
      summary: verifySummaryLine(outcome, passed, criteriaFixed.length),
      detail: verifyDetail(outcome),
      data: {
        buildPassed: outcome.buildPassed,
        testsPassed: outcome.testsPassed,
        testCommand: outcome.testCommand,
        recommendation: outcome.recommendation,
        recheck: outcome.recheck,
        failingTests: outcome.failingTests ?? [],
        baseline: outcome.baseline ?? null,
      },
    });

    await completeJob(job.id, {
      result: {
        buildPassed: outcome.buildPassed,
        testsPassed: outcome.testsPassed,
        buildRan: outcome.buildRan ?? outcome.buildPassed,
        testsRan: outcome.testsRan ?? outcome.testsPassed,
        testCommand: outcome.testCommand,
        testSummary: outcome.testSummary,
        recommendation: outcome.recommendation,
        criteriaFixed,
        previewUrl: outcome.previewUrl ?? null,
        failingTests: outcome.failingTests ?? [],
        baseline: outcome.baseline ?? null,
      },
    });

    return {
      ok: passed,
      reason: passed
        ? `Build and ${outcome.testCommand} passed. ${criteriaFixed.length} criterion(s) re-checked clean.` +
          preExistingNote(outcome)
        : `${verifySummaryLine(outcome, passed, criteriaFixed.length)} ${outcome.testSummary}`,
      criteriaFixed,
      previewUrl: outcome.previewUrl ?? null,
      evidence: {
        buildPassed: outcome.buildPassed,
        buildRan: outcome.buildRan ?? outcome.buildPassed,
        testsPassed: outcome.testsPassed,
        testsRan: outcome.testsRan ?? outcome.testsPassed,
        testCommand: outcome.testCommand,
        testSummary: outcome.testSummary,
      },
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
      evidence: {
        buildPassed: false,
        buildRan: false,
        testsPassed: false,
        testsRan: false,
        testCommand: '',
        testSummary: '',
      },
    };
  }
}

/** The shape the verify seam hands back, narrowed to what the timeline reads. */
type VerifySeamOutcome = Awaited<ReturnType<typeof verifyPatches>>;

/**
 * The one line a maintainer sees in the timeline.
 *
 * "Verification failed: build ok, tests failed" told them nothing they could
 * act on — not which tests, and above all not whether the change was at fault.
 * Every branch below answers that, because reading it is how a maintainer
 * decides whether to look at the diff or at their own `main`.
 */
function verifySummaryLine(
  outcome: VerifySeamOutcome,
  passed: boolean,
  criteriaCount: number,
): string {
  const baseline = outcome.baseline;
  const command = outcome.testCommand || 'the test suite';

  if (passed) {
    const preExisting = baseline?.preExisting.length ?? 0;
    return preExisting > 0
      ? `Build passed and ${command} regressed nothing; ` +
          `${preExisting} test(s) were already failing on the base branch. ` +
          `${criteriaCount} criterion(s) re-checked clean.`
      : `Build and ${command} passed; ${criteriaCount} criterion(s) re-checked clean.`;
  }

  const broke = [...(baseline?.regressions ?? []), ...(baseline?.introduced ?? [])];
  if (broke.length > 0) {
    return (
      `Verification failed: this change broke ${broke.length} test(s) that passed on the ` +
      `base branch — ${broke.slice(0, 3).map((test) => test.id).join(', ')}` +
      `${broke.length > 3 ? `, and ${broke.length - 3} more` : ''}.`
    );
  }
  if (!outcome.buildPassed) {
    return `Verification failed: the patched tree did not build (${command} not reached, or reached and separate).`;
  }
  if (baseline && !baseline.comparable && !outcome.testsPassed) {
    return (
      `Verification failed: ${command} failed and no baseline comparison was possible, so ` +
      'every failure is counted against this change.'
    );
  }
  return `Verification failed: build ok, ${command} did not clear the gate.`;
}

/** The paragraph under that line: the comparison, then the runner's own words. */
function verifyDetail(outcome: VerifySeamOutcome): string {
  const baseline = outcome.baseline;
  const parts: string[] = [];
  if (baseline) {
    parts.push(baseline.ran ? baseline.reason : `No baseline run: ${baseline.reason}`);
  }
  if (outcome.testSummary) parts.push(outcome.testSummary);
  const failing = outcome.failingTests ?? [];
  if (failing.length > 0) {
    parts.push(
      'Failing now: ' +
        failing
          .slice(0, 10)
          .map((test) => `${test.id}${test.message ? ` — ${test.message}` : ''}`)
          .join('; ') +
        (failing.length > 10 ? `; and ${failing.length - 10} more` : ''),
    );
  }
  return parts.join('\n\n');
}

/** A pass that carried somebody else's broken tests past should say so. */
function preExistingNote(outcome: VerifySeamOutcome): string {
  const preExisting = outcome.baseline?.preExisting.length ?? 0;
  if (preExisting === 0) return '';
  return (
    ` ${preExisting} test(s) were already failing on the base branch before this change and ` +
    'still are; none of them are this change\'s doing.'
  );
}

/* -------------------------------------------------------------------------- */
/* Phase 6: pull request and final score                                      */
/* -------------------------------------------------------------------------- */

/**
 * The seam's flat input, built once and used for both the plan and the write.
 *
 * The title, the body and the branch name have to be identical on both sides:
 * `composePullRequest` derives the title the approval binds to from them, so a
 * second, separately-built input would show the human one operation and run
 * another.
 */
function pullRequestSeamInput(
  context: PipelineContext,
  token: string,
  proposed: StoredPatch[],
  criteriaFixed: string[],
  evidence: VerifyOutcome['evidence'],
  findings: readonly FixableFinding[],
): Omit<OpenPullRequestInput, 'approval'> {
  const criteria = [...new Set(proposed.flatMap((patch) => patch.criteria))].sort();
  return {
    runId: context.runId,
    repoFullName: context.repoFullName,
    accessToken: token,
    branch: `accessifix/run-${context.runId.slice(0, 8)}`,
    title: `Accessibility fixes for ${criteria.length} WCAG 2.2 criteria`,
    // A10.5: the body cites each criterion, which is also what makes the
    // pull request reviewable by Qodo.
    body: buildPullRequestBody(context, proposed, criteria, criteriaFixed),
    // The criteria and finding ids travel with the diff: `composeTitle` and the
    // body cite them, and a patch stripped to bytes produces a pull request
    // that claims nothing it actually fixed.
    patches: proposed.map((patch) => ({
      filePath: patch.filePath,
      diff: patch.diff,
      criteria: patch.criteria,
      findingIds: patch.findingIds,
    })),
    // The ledger rows behind those ids, so the title can count them and the
    // body can quote what was wrong before.
    findings,
    // The gates read this rather than taking the conductor's word (A6.4).
    verification: evidence,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  };
}

/** The file list a person can actually check, one line each. */
function describeApprovedFiles(plan: PullRequestPlan): string {
  return plan.patches
    .map(
      (patch) =>
        `  - ${patch.filePath} (+${patch.stats.linesAdded}/-${patch.stats.linesRemoved}` +
        `, SC ${patch.criteria.join(', ')})`,
    )
    .join('\n');
}

/**
 * Read back the operations recorded against a decision.
 *
 * Deliberately strict, and deliberately returns null rather than repairing what
 * it finds. A row written before the operations existed, or one that lost them,
 * is a recorded yes that names no operation — and a yes that names no operation
 * is exactly the thing the gate is for.
 */
function approvedOperationsFrom(
  result: Record<string, unknown> | null,
): ApprovedWriteOperations | null {
  const operations = result?.['operations'];
  if (!operations || typeof operations !== 'object') return null;
  const { branch, pullRequest } = operations as Record<string, unknown>;
  if (!isApprovalOperation(branch) || !isApprovalOperation(pullRequest)) return null;
  return { branch, pullRequest };
}

function isApprovalOperation(value: unknown): value is ApprovalOperation {
  if (!value || typeof value !== 'object') return false;
  const operation = value as Record<string, unknown>;
  return (
    typeof operation['action'] === 'string' &&
    typeof operation['repoFullName'] === 'string' &&
    Array.isArray(operation['files']) &&
    operation['files'].every((file) => typeof file === 'string')
  );
}

/**
 * A7.1: the run pauses before pushing a branch and before opening a pull
 * request. The card states the intent, the reason, and the evidence (A7.2).
 *
 * What the human is asked is the *plan* — this repository, this branch, cut
 * from this base, with this title, writing these files, whose contents are
 * digested into the operation recorded against their answer. That recording is
 * the point. A card that said only "push a branch and open a pull request"
 * would leave the write path with nothing to compare against except the payload
 * it was already holding, and comparing a payload to itself authorises every
 * payload.
 *
 * The gate is *recovered*, not re-raised. A restart between the card going up
 * and the PR being opened used to produce a second card over the same decision
 * — and, once approved twice, a second branch and a second pull request on the
 * user's repository. So the fixed `pr`/`approval` job row is the continuation
 * point: it remembers the handoff and the operations it authorised, and a
 * resumed run re-enters that same wait rather than starting a new conversation
 * (A7.4, A12.2).
 */
async function pullRequestGate(
  context: PipelineContext,
  verificationSummary: string,
  plan: PullRequestPlan,
): Promise<{
  approved: boolean;
  requestId: string | null;
  operations: ApprovedWriteOperations | null;
}> {
  const previous = await findJob(context.runId, 'pr', 'approval');

  // The decision was already reached and recorded. Nothing to ask again.
  if (previous?.status === 'succeeded' || previous?.status === 'skipped') {
    const approved = previous.status === 'succeeded';
    const operations = approved ? approvedOperationsFrom(previous.result) : null;

    if (approved && !operations) {
      /*
       * A yes is on the ledger, but not what it was a yes to. That can only be
       * a row from before the operations were recorded, and there is no honest
       * way to reconstruct it: rebuilding the operation from the current plan
       * would put this run's own bytes in the place of the human's answer. So
       * the run stops and says why, rather than pushing on a consent nobody can
       * now read.
       */
      await emitEvent({
        runId: context.runId,
        type: 'approval',
        capability: 'approval',
        summary: 'The recorded approval does not name the operation it authorised.',
        detail:
          'This run was approved before the decision recorded the repository, branch, title ' +
          'and file digests it covered, so nothing can be written under it (A7.1). Start the ' +
          'run again to be asked afresh.',
        data: { handoffId: previous.handoffId, resumed: true },
      });
      return { approved: false, requestId: previous.handoffId ?? null, operations: null };
    }

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
    return { approved, requestId: previous.handoffId ?? null, operations };
  }

  // A card is already up for this run. Re-enter its wait.
  let handoff = previous?.handoffId ? await loadHandoff(previous.handoffId) : null;
  if (handoff && handoff.runId !== context.runId) handoff = null;

  let jobId = previous?.id ?? null;

  /*
   * The operations this decision is about. For a fresh card that is the plan
   * just made; for a card already up it is the plan the card was raised for,
   * read back off the job row.
   *
   * They are not the same thing, and the difference matters: a run that
   * restarts between the card going up and the answer coming in recomputes its
   * plan against a repository that may have moved. Binding the human's answer
   * to the *recomputed* plan would authorise bytes the card never described,
   * which is the tautology this gate exists to prevent, just displaced by a
   * restart. So the recorded operations win, and a plan that no longer matches
   * them stops the run instead.
   */
  let asked: ApprovedWriteOperations = plan.operations;

  if (!handoff) {
    handoff = await raiseHandoff({
      runId: context.runId,
      kind: 'approval',
      agent: 'APP',
      intent:
        `Create the branch \`${plan.composition.branch}\` in ${context.repoFullName}, cut from ` +
        `\`${plan.base}\`, commit ${plan.patches.length} file(s) to it, and open a pull request ` +
        `into \`${plan.base}\` titled "${plan.composition.title}".\n\n` +
        `${describeApprovedFiles(plan)}\n` +
        (plan.resumeFromSha
          ? `\nThe branch already exists at ${plan.resumeFromSha.slice(0, 7)}, ahead of ` +
            `\`${plan.base}\`. Approving this accepts those existing commits into the pull ` +
            'request as well.\n'
          : ''),
      reason:
        `${verificationSummary} Pushing a branch and opening a pull request are ` +
        'irreversible actions on your repository, so AccessiFix will not do either ' +
        'without your say-so (A7.1). The pull request is opened with your own GitHub ' +
        'token, not a bot account. Your answer is recorded against these exact files and ' +
        'their exact contents: if anything in the repository moves between now and the ' +
        'push, the write is refused rather than carried out on something you did not see.',
    });

    const job = await beginJob({
      runId: context.runId,
      phase: 'pr',
      jobKey: 'approval',
      agent: 'APP',
    });
    jobId = job.id;
    await pauseJobForApproval(job.id, {
      handoffId: handoff.id,
      // Written now, not on the answer: this is what the card in front of the
      // human describes, and a resumed run has to be able to check that.
      result: { operations: plan.operations },
    });
  } else {
    const recorded = approvedOperationsFrom(previous?.result ?? null);
    const drift =
      recorded === null
        ? 'the card was raised without recording which operations it covers'
        : (operationMismatch(recorded.branch, plan.operations.branch) ??
          operationMismatch(recorded.pullRequest, plan.operations.pullRequest));

    if (drift) {
      await emitEvent({
        runId: context.runId,
        type: 'approval',
        capability: 'approval',
        summary: 'The pull request changed while its approval was still open.',
        detail:
          `The card already up for this run no longer describes what would be written — ${drift}. ` +
          'Answering it would approve something other than what it shows, so nothing is ' +
          'written and the run stops here (A7.1).',
        data: { handoffId: handoff.id, status: handoff.status, resumed: true },
      });
      return { approved: false, requestId: handoff.id, operations: null };
    }

    asked = recorded as ApprovedWriteOperations;

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
   *
   * The operations go down with it. They are what the yes was a yes to, and
   * without them on the row a resumed run has an approval it cannot check.
   */
  if (jobId) {
    if (decision.approved) {
      await completeJob(jobId, {
        result: {
          approved: true,
          operations: { branch: asked.branch, pullRequest: asked.pullRequest },
        },
      });
    } else {
      await skipJob(jobId, decision.response ?? 'Declined by the user.');
    }
  }

  return {
    approved: decision.approved,
    requestId: handoff.id,
    operations: decision.approved ? asked : null,
  };
}

async function prPhase(
  context: PipelineContext,
  seam: Omit<OpenPullRequestInput, 'approval'>,
  proposed: StoredPatch[],
  approvalRequestId: string,
  operations: ApprovedWriteOperations,
): Promise<void> {
  await runJob(
    { runId: context.runId, phase: 'pr', jobKey: 'open', agent: 'APP' },
    async () => {
      const pr = await openPullRequest({
        ...seam,
        // A7.1: the human decision, and the operations it was a decision about.
        // The id alone would authorise nothing; the operations are what the
        // write is compared against, field by field and digest by digest.
        approval: { requestId: approvalRequestId, approved: true, operations },
      });

      /*
       * `applied` is a claim about bytes on a branch, so it is written from
       * what the write returned rather than from what this phase proposed.
       * `openPullRequest` is all-or-nothing — a patch that no longer applies
       * stops the run before the card goes up — so the two lists agree today.
       * Deriving the ledger from the commit anyway is what keeps them agreeing:
       * a row says `applied` only if its file is in the pull request.
       */
      const committed = new Set(pr.files.map(normalizeRepoPath));
      const appliedIds = proposed
        .filter((patch) => committed.has(normalizeRepoPath(patch.filePath)))
        .map((patch) => patch.id);

      if (appliedIds.length > 0) {
        await db
          .update(patches)
          .set({ status: 'applied' })
          .where(and(eq(patches.runId, context.runId), inArray(patches.id, appliedIds)));
      }

      if (appliedIds.length !== proposed.length) {
        // Unreachable while the write stays atomic; reported rather than
        // swallowed if it ever is not. The pull request exists by now, so
        // failing the run would be worse — but silence would leave the ledger
        // claiming a fix the branch does not carry.
        await emitEvent({
          runId: context.runId,
          type: 'log',
          agent: 'APP',
          capability: 'approval',
          summary:
            `${proposed.length - appliedIds.length} proposed patch(es) are not in pull request ` +
            `#${pr.number}, so they are not recorded as applied.`,
          detail: proposed
            .filter((patch) => !committed.has(normalizeRepoPath(patch.filePath)))
            .map((patch) => patch.filePath)
            .join(', '),
        });
      }

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
      // `files` goes down with the row: on the reuse path below it is the only
      // record of what the pull request actually contains.
      toResult: (pr) => ({
        url: pr.url,
        number: pr.number,
        branch: pr.branch,
        files: [...pr.files],
      }),
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
        files: Array.isArray(result.files) ? result.files.map((file) => String(file)) : [],
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
