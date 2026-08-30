/**
 * Server-side reads for every screen under /app.
 *
 * One rule, the same one the API routes follow: **a query is scoped to the
 * signed-in user or it does not run.** A run id is a UUID, not a capability, so
 * every read joins through `targets.user_id`. An unowned id is `null` here and
 * a 404 at the page, never a 403 — a 403 would confirm the run exists.
 *
 * Server components call these directly rather than fetching their own API
 * routes: the route would re-do the session check, re-serialise, and add a hop
 * for nothing. The client components fetch the routes, because they must.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { demoReady, demoUser } from "@/lib/demo";
import { db } from "@/lib/db";
import { getCriterion } from "@/lib/db/criteria";
import {
  findings,
  handoffs,
  pages,
  patches,
  runs,
  targets,
  type RunPhase,
} from "@/lib/db/schema";
import { AGENT_ROSTER, isAgentName } from "@/lib/harness/agents";
import { screenshotsForRun } from "@/lib/pipeline/artifacts";
import { readRunEvents } from "@/lib/pipeline/events";
import { listJobs } from "@/lib/pipeline/jobs";
import { runForUser } from "@/lib/pipeline/access";
import { scoreRun } from "@/lib/pipeline/score";
import type {
  FindingWire,
  FrameWire,
  HandoffWire,
  JobWire,
  PageWire,
  PatchWire,
  RunEventWire,
  RunListItem,
  RunScoreWire,
  RunStatusWire,
  RunWire,
  TargetListItem,
  TargetWire,
} from "@/components/run-data";

/* -------------------------------------------------------------------------- */
/* Session                                                                    */
/* -------------------------------------------------------------------------- */

export interface SessionUser {
  id: string;
  name: string;
  email: string | null;
  image: string | null;
}

/** The signed-in user, or `null`. */
export async function sessionUser(): Promise<SessionUser | null> {
  // The hosted demo shows the workspace without a sign-in (see `lib/demo.ts`).
  if (demoReady()) return demoUser();

  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  return {
    id,
    name: session.user.name ?? session.user.email ?? "Signed-in user",
    email: session.user.email ?? null,
    image: session.user.image ?? null,
  };
}

/**
 * The signed-in user, or a redirect to GitHub.
 *
 * Every page under /app reads the ledger, and the ledger is per-user. There is
 * nothing honest to render for a visitor with no session.
 */
export async function requireSessionUser(callbackUrl = "/app"): Promise<SessionUser> {
  const user = await sessionUser();
  if (!user) {
    redirect(`/api/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }
  return user;
}

/* -------------------------------------------------------------------------- */
/* Serialisation                                                              */
/* -------------------------------------------------------------------------- */

const iso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
};

/* -------------------------------------------------------------------------- */
/* Targets                                                                    */
/* -------------------------------------------------------------------------- */

export async function listTargets(userId: string): Promise<TargetListItem[]> {
  const rows = await db
    .select({
      id: targets.id,
      repoFullName: targets.repoFullName,
      deployedUrl: targets.deployedUrl,
      createdAt: targets.createdAt,
      runCount: sql<number>`count(${runs.id})::int`,
    })
    .from(targets)
    .leftJoin(runs, eq(runs.targetId, targets.id))
    .where(eq(targets.userId, userId))
    .groupBy(targets.id)
    .orderBy(desc(targets.createdAt));

  if (rows.length === 0) return [];

  // The newest run per target, for the "latest run" link. One query, then
  // first-wins in memory: cheaper than a lateral join for a handful of targets.
  const recent = await db
    .select({ id: runs.id, targetId: runs.targetId })
    .from(runs)
    .where(
      inArray(
        runs.targetId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(desc(runs.createdAt));

  const lastRun = new Map<string, string>();
  for (const run of recent) {
    if (!lastRun.has(run.targetId)) lastRun.set(run.targetId, run.id);
  }

  return rows.map((row) => ({
    id: row.id,
    repoFullName: row.repoFullName,
    deployedUrl: row.deployedUrl,
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    runCount: Number(row.runCount ?? 0),
    lastRunId: lastRun.get(row.id) ?? null,
  }));
}

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

export async function listRuns(userId: string, limit = 50): Promise<RunListItem[]> {
  const rows = await db
    .select({
      id: runs.id,
      targetId: runs.targetId,
      repoFullName: targets.repoFullName,
      deployedUrl: targets.deployedUrl,
      phase: runs.phase,
      status: runs.status,
      failureReason: runs.failureReason,
      createdAt: runs.createdAt,
      startedAt: runs.startedAt,
      completedAt: runs.completedAt,
      findingCount: sql<number>`(
        select count(*)::int from ${findings} where ${findings.runId} = ${runs.id}
      )`,
    })
    .from(runs)
    .innerJoin(targets, eq(runs.targetId, targets.id))
    .where(eq(targets.userId, userId))
    .orderBy(desc(runs.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    targetId: row.targetId,
    repoFullName: row.repoFullName,
    deployedUrl: row.deployedUrl,
    phase: row.phase,
    status: row.status as RunStatusWire,
    failureReason: row.failureReason,
    findingCount: Number(row.findingCount ?? 0),
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
  }));
}

/** The run a demo should open: the newest one the user owns. */
export async function latestRun(userId: string): Promise<RunListItem | null> {
  const [row] = await listRuns(userId, 1);
  return row ?? null;
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

export async function findingsForRun(
  runId: string,
  phase?: RunPhase,
): Promise<FindingWire[]> {
  const clauses = [eq(findings.runId, runId)];
  if (phase) clauses.push(eq(findings.phase, phase));

  const rows = await db
    .select()
    .from(findings)
    .where(and(...clauses))
    .orderBy(desc(findings.createdAt));

  return rows.map((row) => {
    const criterion = getCriterion(row.criterion);
    return {
      id: row.id,
      runId: row.runId,
      phase: row.phase,
      pageUrl: row.pageUrl,
      criterion: row.criterion,
      level: row.level,
      verdict: row.verdict,
      status: row.status,
      severity: row.severity,
      agent: row.agent,
      summary: row.summary,
      detail: row.detail,
      sourcePath: row.sourcePath,
      criterionName: criterion?.name ?? null,
      plainEnglish: criterion?.plainEnglish ?? null,
      createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* One run, everything the run view paints on first load                      */
/* -------------------------------------------------------------------------- */

export interface RunDetail {
  run: RunWire;
  target: TargetWire;
  score: RunScoreWire;
  finalScore: RunScoreWire | null;
  findings: FindingWire[];
  events: RunEventWire[];
  jobs: JobWire[];
  patches: PatchWire[];
  pages: PageWire[];
  /**
   * One captured browser frame per page, as references.
   *
   * Ids only. The PNG bytes stay in the `artifacts` table and reach the browser
   * through `/api/artifacts/{id}`; putting them in a server-component payload
   * would ship megabytes of base64 into the HTML on every render.
   */
  frames: FrameWire[];
  pendingHandoffs: HandoffWire[];
  /** The model behind the lane that spoke most recently, when there was one. */
  activeModel?: string;
}

/**
 * Everything the run view needs, or `null` when the run is not the user's.
 *
 * `null` covers "no such run" and "not yours" alike, deliberately.
 */
export async function runDetail(runId: string, userId: string): Promise<RunDetail | null> {
  const owned = await runForUser(runId, userId);
  if (!owned) return null;

  const [
    score,
    finalScore,
    findingRows,
    eventRows,
    jobRows,
    patchRows,
    pageRows,
    handoffRows,
    frameRows,
  ] =
    await Promise.all([
      scoreRun(runId, "baseline"),
      owned.run.phase === "final" ? scoreRun(runId, "final") : Promise.resolve(null),
      findingsForRun(runId),
      readRunEvents(runId, { limit: 500 }),
      listJobs(runId),
      db.select().from(patches).where(eq(patches.runId, runId)).orderBy(desc(patches.createdAt)),
      db.select().from(pages).where(eq(pages.runId, runId)).orderBy(pages.crawledAt),
      db
        .select()
        .from(handoffs)
        .where(and(eq(handoffs.runId, runId), eq(handoffs.status, "pending")))
        .orderBy(desc(handoffs.createdAt)),
      screenshotsForRun(runId),
    ]);

  return {
    run: {
      id: owned.run.id,
      targetId: owned.run.targetId,
      phase: owned.run.phase,
      status: owned.run.status as RunStatusWire,
      maxSandboxes: owned.run.maxSandboxes,
      sandboxesUsed: owned.run.sandboxesUsed,
      failureReason: owned.run.failureReason,
      startedAt: iso(owned.run.startedAt),
      completedAt: iso(owned.run.completedAt),
      createdAt: iso(owned.run.createdAt) ?? new Date(0).toISOString(),
    },
    target: {
      id: owned.target.id,
      repoFullName: owned.target.repoFullName,
      deployedUrl: owned.target.deployedUrl,
    },
    score: score as RunScoreWire,
    finalScore: (finalScore as RunScoreWire | null) ?? null,
    findings: findingRows,
    events: eventRows.map((event) => ({
      id: event.id,
      runId: event.runId,
      type: event.type,
      agent: event.agent,
      capability: event.capability,
      summary: event.summary,
      detail: event.detail,
      data: event.data,
      timestamp: event.timestamp,
    })),
    jobs: jobRows.map((job) => ({
      id: job.id,
      runId: job.runId,
      phase: job.phase,
      jobKey: job.jobKey,
      agent: job.agent,
      status: job.status,
      error: job.error,
      startedAt: iso(job.startedAt),
      completedAt: iso(job.completedAt),
    })),
    patches: patchRows.map((patch) => ({
      id: patch.id,
      filePath: patch.filePath,
      diff: patch.diff,
      findingIds: patch.findingIds ?? [],
      status: patch.status,
    })),
    pages: pageRows.map((page) => ({ id: page.id, url: page.url, title: page.title })),
    frames: frameRows.map((frame) => ({
      artifactId: frame.artifactId,
      pageUrl: frame.pageUrl,
      capturedAt: frame.capturedAt,
    })),
    pendingHandoffs: handoffRows.map((handoff) => ({
      id: handoff.id,
      kind: handoff.kind,
      intent: handoff.intent,
      reason: handoff.reason,
      status: handoff.status,
      createdAt: iso(handoff.createdAt) ?? new Date(0).toISOString(),
      evidenceIds: handoff.evidenceIds ?? [],
    })),
    ...(modelForEvents(eventRows) ? { activeModel: modelForEvents(eventRows) } : {}),
  };
}

/**
 * The model behind the most recent lane that used one.
 *
 * TREE is deterministic and calls no model, so a run inside the TREE phase
 * reports no active model rather than borrowing the last one that spoke.
 */
function modelForEvents(events: ReadonlyArray<{ agent: string }>): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const name = events[i].agent.toLowerCase();
    if (isAgentName(name)) return AGENT_ROSTER[name].model;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Overview roll-up                                                           */
/* -------------------------------------------------------------------------- */

export interface OverviewData {
  targets: TargetListItem[];
  runs: RunListItem[];
  latest: RunDetail | null;
}

export async function overview(userId: string): Promise<OverviewData> {
  const [targetRows, runRows] = await Promise.all([listTargets(userId), listRuns(userId, 10)]);
  const latest = runRows[0] ? await runDetail(runRows[0].id, userId) : null;
  return { targets: targetRows, runs: runRows, latest };
}
