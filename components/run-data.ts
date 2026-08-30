/* =====================================================================
   The wire shapes the pipeline actually returns, and the pure mappers
   that turn them into what the presentational components render.

   This file replaces components/sample-data.ts. Nothing here invents a
   value: every field is either present in the ledger or omitted, and a
   count this view cannot obtain is reported as unknown rather than as
   zero.

   Deliberately free of `lib/db` and of React, so a server component and
   a client component can both import it.
   ===================================================================== */

import type { TimelineEvent, HarnessCapability } from "./AgentTimeline";
import type { CriterionCell, CriterionLevel, CriterionRow } from "./CriterionMatrix";
import type { BrowserEnvironment, EnvironmentState, PathTemplate } from "./EnvironmentGrid";
import type { AuditAgent, Finding, FindingSeverity, FindingStatus } from "./FindingCard";
import type { Patch } from "./DiffCard";
import type { RunPhase, RunSummary } from "./RunSummaryBar";
import type { StatusValue } from "./StatusLabel";

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* -------------------------------------------------------------------------- */

export type RunStatusWire =
  | "queued"
  | "crawling"
  | "auditing"
  | "scoring"
  | "fixing"
  | "verifying"
  | "awaiting_approval"
  | "done"
  | "failed";

export interface RunWire {
  id: string;
  targetId: string;
  phase: "baseline" | "final";
  status: RunStatusWire;
  /** The pipeline state machine's own label. Equal to `status` in practice. */
  state?: string;
  /** Present only while paused: the state the run returns to (A7.4). */
  pausedFrom?: string | null;
  inFlight?: boolean;
  maxSandboxes: number;
  sandboxesUsed: number;
  failureReason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface TargetWire {
  id: string;
  repoFullName: string;
  deployedUrl: string;
}

export interface CriterionScoreWire {
  criterion: string;
  name: string;
  level: CriterionLevel;
  verdict: "DECIDE" | "FLAG" | "BLOCKED";
  findings: number;
  open: number;
  state: "passing" | "failing" | "flagged" | "blocked" | "not_evaluated";
  reason?: string;
}

export interface RunScoreWire {
  phase: "baseline" | "final";
  totalCriteria: number;
  failingCriteria: number;
  flaggedCriteria: number;
  blockedCriteria: number;
  passingCriteria: number;
  notEvaluatedCriteria?: number;
  totalFindings: number;
  openFindings: number;
  bySeverity: Record<string, number>;
  criteria: CriterionScoreWire[];
  disclaimer: string;
}

export interface FindingWire {
  id: string;
  runId: string;
  phase: string;
  pageUrl: string;
  criterion: string;
  level: CriterionLevel;
  verdict: "DECIDE" | "FLAG" | "BLOCKED";
  status: string;
  severity: string;
  agent: string;
  summary: string;
  detail: string | null;
  sourcePath: string | null;
  criterionName?: string | null;
  plainEnglish?: string | null;
  createdAt: string;
  evidence?: ReadonlyArray<{ id: string; kind: string; mimeType: string }>;
}

export interface JobWire {
  id: string;
  runId: string;
  phase: string;
  jobKey: string;
  agent: string | null;
  status: string;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PatchWire {
  id: string;
  filePath: string;
  diff: string;
  findingIds: string[];
  status: string;
}

export interface HandoffWire {
  id: string;
  kind: string;
  intent: string;
  reason: string;
  status: string;
  createdAt: string;
  evidenceIds?: string[];
}

export interface PageWire {
  id: string;
  url: string;
  title: string | null;
}

/**
 * One captured browser frame, as a reference rather than as bytes.
 *
 * A full-page PNG is measured in megabytes. It is never put on the SSE stream
 * and never put in a React prop; the wire carries the artifact id, and the
 * `<img>` fetches `/api/artifacts/{id}` like any other image.
 */
export interface FrameWire {
  artifactId: string;
  /** The page URL the frame depicts. Matches `pages.url`. */
  pageUrl: string;
  capturedAt: string;
}

export interface RunEventWire {
  id: number;
  runId: string;
  type: string;
  agent: string;
  capability: string | null;
  summary: string;
  detail: string | null;
  data: Record<string, unknown>;
  timestamp: string;
}

/** Exactly the body of `GET /api/runs/{runId}?jobs=true`. */
export interface RunDetailWire {
  run: RunWire;
  target: TargetWire;
  score: RunScoreWire;
  finalScore: RunScoreWire | null;
  pages: PageWire[];
  /** The browser frames this run captured, one per page. */
  frames: FrameWire[];
  patches: PatchWire[];
  pendingHandoffs: HandoffWire[];
  jobs?: JobWire[];
}

/** One row in the runs list. */
export interface RunListItem {
  id: string;
  targetId: string;
  repoFullName: string;
  deployedUrl: string;
  phase: "baseline" | "final";
  status: RunStatusWire;
  failureReason: string | null;
  findingCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface TargetListItem {
  id: string;
  repoFullName: string;
  deployedUrl: string;
  createdAt: string;
  runCount: number;
  lastRunId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A fixed locale and UTC, so the server and the client render byte-identical
 * text. A relative "2s ago" cannot do that without a hydration mismatch.
 */
export function formatUtcTime(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  }).format(date);
  return time + " UTC";
}

export function formatUtcDate(iso: string | null | undefined): string {
  if (!iso) return "not started";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "not started";
  const stamp = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
  return stamp + " UTC";
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return hours + "h " + minutes + "m";
  if (minutes > 0) return minutes + "m " + seconds + "s";
  return seconds + "s";
}

/** Elapsed wall time for a run, against `now`. Undefined when unknowable. */
export function runElapsed(run: RunWire, now: number): string | undefined {
  const startIso = run.startedAt ?? run.createdAt;
  if (!startIso) return undefined;
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return undefined;
  const end = run.completedAt ? new Date(run.completedAt).getTime() : now;
  if (Number.isNaN(end)) return undefined;
  return formatDuration(end - start);
}

/* -------------------------------------------------------------------------- */
/* Run status                                                                 */
/* -------------------------------------------------------------------------- */

const RUN_STATUS_LABELS: Record<RunStatusWire, StatusValue> = {
  queued: "queued",
  crawling: "crawling",
  auditing: "auditing",
  scoring: "scoring",
  fixing: "fixing",
  verifying: "verifying",
  awaiting_approval: "awaiting_approval",
  done: "complete",
  failed: "failed",
};

export function runStatusLabel(status: string): StatusValue {
  return RUN_STATUS_LABELS[status as RunStatusWire] ?? "queued";
}

const TERMINAL: ReadonlySet<string> = new Set(["done", "failed"]);

export function runIsTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

/** The run summary bar's props. `activeModel` and `elapsed` stay optional. */
export function toRunSummary(
  run: RunWire,
  extra: { activeModel?: string; elapsed?: string } = {},
): RunSummary {
  return {
    status: runStatusLabel(run.status),
    phase: run.phase as RunPhase,
    sandboxesUsed: run.sandboxesUsed,
    maxSandboxes: run.maxSandboxes,
    ...(extra.activeModel ? { activeModel: extra.activeModel } : {}),
    ...(extra.elapsed ? { elapsed: extra.elapsed } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Environments, from pipeline_jobs                                           */
/* -------------------------------------------------------------------------- */

const PHASE_TEMPLATE: Record<string, PathTemplate> = {
  crawl: "Crawl",
  tree: "Tree",
  paths: "Paths",
  vis: "Vision",
  act: "Actions",
  media: "Media",
  pages: "Pages",
  code: "Code",
  score: "Score",
  fix: "Fix",
  verify: "Verify",
  pr: "Pull request",
  final_audit: "Final audit",
};

const JOB_STATE: Record<string, EnvironmentState> = {
  pending: "queued",
  running: "live",
  awaiting_approval: "queued",
  succeeded: "done",
  failed: "failed",
  skipped: "done",
};

/** Which phases actually drive a browser. The rest run in a build sandbox. */
const BROWSER_PHASES: ReadonlySet<string> = new Set([
  "crawl",
  "tree",
  "paths",
  "vis",
  "act",
  "media",
  "pages",
  "final_audit",
]);

/** Viewport from lib/browser/script.ts, which launches Chromium at 1280x900. */
const BROWSER_ENGINE = "Chromium 1280x900";
const BUILD_ENGINE = "Node 22 build sandbox";
const LEDGER_ENGINE = "Ledger query";

function engineFor(phase: string): string {
  if (BROWSER_PHASES.has(phase)) return BROWSER_ENGINE;
  if (phase === "score") return LEDGER_ENGINE;
  return BUILD_ENGINE;
}

const PHASE_VERB: Record<string, string> = {
  tree: "Accessibility tree and axe-core on",
  vis: "Screenshot pass over",
  act: "Interaction paths on",
  media: "Media check on",
  pages: "Page-level checks on",
  code: "Source read for",
  fix: "Patch",
  verify: "Verify",
};

/**
 * The page URL inside a job key.
 *
 * `pipeline_jobs` keys a page-scoped job as `${runPhase}:${pageUrl}` —
 * `baseline:https://example.com/` — so that the baseline and the final audit of
 * one page are two rows rather than one. Anything joining a job to a page has
 * to strip that prefix first; a lookup on the raw key silently misses every
 * time, which is why the cards reported no finding counts.
 *
 * A key that carries no phase prefix (`crawl`, `score`, a source path) comes
 * back unchanged.
 */
export function pageKeyOf(jobKey: string): string {
  return jobKey.replace(/^(?:baseline|final):/, "");
}

/** Where a stored artifact's bytes are served from. */
export function artifactUrl(artifactId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}`;
}

/**
 * Frames arranged for lookup by job key.
 *
 * `landing` is the first frame the run captured — the deployed URL itself,
 * because the crawl is breadth-first from there. It is what the crawl card
 * shows, that card being keyed by its phase rather than by a page.
 */
export interface FrameIndex {
  byPage: ReadonlyMap<string, string>;
  landing?: string;
}

export function indexFrames(frames: ReadonlyArray<FrameWire>): FrameIndex {
  const byPage = new Map<string, string>();

  for (const frame of frames) {
    const href = artifactUrl(frame.artifactId);
    byPage.set(frame.pageUrl, href);
    // A job key spells a page with or without its trailing slash; index both.
    const alt = frame.pageUrl.endsWith("/") ? frame.pageUrl.slice(0, -1) : frame.pageUrl + "/";
    if (!byPage.has(alt)) byPage.set(alt, href);
  }

  return {
    byPage,
    ...(frames[0] ? { landing: artifactUrl(frames[0].artifactId) } : {}),
  };
}

/**
 * The frame to show on one card, or `undefined` for the honest placeholder.
 *
 * Only a phase that actually drove a browser can have one. A build-sandbox or
 * ledger job is left with the placeholder even when its key happens to be a
 * page URL — CODE reads source, and dressing its card with a browser frame
 * would claim a capture that phase never made.
 */
function frameFor(job: JobWire, frames: FrameIndex): string | undefined {
  if (!BROWSER_PHASES.has(job.phase)) return undefined;

  const direct = frames.byPage.get(pageKeyOf(job.jobKey));
  if (direct) return direct;

  // The crawl job is keyed by its phase, not by a page, because it opened all
  // of them. Its card shows the first frame it took: the deployed URL.
  if (job.phase === "crawl" || job.phase === "final_audit") return frames.landing;

  return undefined;
}

/** A URL's path, or the whole string when it is not a URL. */
function shortKey(key: string): string {
  try {
    return new URL(key).pathname;
  } catch {
    return key;
  }
}

function describeJob(phase: string, jobKey: string): string {
  switch (phase) {
    case "crawl":
      return "Crawl same-origin routes";
    case "paths":
      return "Enumerate interaction paths on " + shortKey(jobKey);
    case "score":
      return "Score the ledger against all 55 criteria";
    case "pr":
      return "Open a pull request";
    case "final_audit":
      return "Re-audit after the fix";
    default: {
      const verb = PHASE_VERB[phase];
      return verb ? verb + " " + shortKey(jobKey) : phase + " · " + shortKey(jobKey);
    }
  }
}

/**
 * One `pipeline_jobs` row is one environment card.
 *
 * `laneFindings` lets each card report the findings *its own agent* recorded,
 * on its own page, in its own run phase. A job that records no findings at all
 * reports no count rather than zero, because "none found" and "not counted
 * here" are different claims.
 *
 * `frames` is the run's captured screenshots, by page. A card gets one only if
 * a browser phase actually captured that page; everything else keeps the
 * placeholder, which says truthfully that no frame exists.
 */
export function jobsToEnvironments(
  jobs: ReadonlyArray<JobWire>,
  laneFindings: LaneFindingCounts = { byPage: new Map(), byPhase: new Map() },
  frames: ReadonlyArray<FrameWire> = [],
): BrowserEnvironment[] {
  const frameIndex = indexFrames(frames);

  const rank = (job: JobWire): number => {
    const state = JOB_STATE[job.status] ?? "queued";
    return state === "live" ? 0 : state === "failed" ? 1 : state === "queued" ? 2 : 3;
  };

  return [...jobs]
    .sort((a, b) => rank(a) - rank(b) || a.phase.localeCompare(b.phase))
    .map((job) => {
      const state = JOB_STATE[job.status] ?? "queued";
      const findings = laneFindingCount(job, laneFindings, state);
      const captured = formatUtcTime(job.completedAt ?? job.startedAt);
      const screenshotUrl = frameFor(job, frameIndex);
      const environment: BrowserEnvironment = {
        id: job.id,
        engine: engineFor(job.phase),
        pathLabel: describeJob(job.phase, job.jobKey),
        pathTemplate: PHASE_TEMPLATE[job.phase] ?? "Crawl",
        state,
        ...(findings === undefined ? {} : { findings }),
        ...(captured ? { capturedAt: captured } : {}),
        ...(screenshotUrl ? { screenshotUrl } : {}),
      };
      return environment;
    });
}

/* -------------------------------------------------------------------------- */
/* Timeline, from run_events                                                  */
/* -------------------------------------------------------------------------- */

const CAPABILITIES: ReadonlySet<string> = new Set([
  "sandbox",
  "subagent",
  "approval",
  "skill",
  "model",
  "ledger",
]);

export function eventsToTimeline(events: ReadonlyArray<RunEventWire>): TimelineEvent[] {
  return events.map((event) => ({
    id: String(event.id),
    agent: event.agent,
    summary: event.summary,
    timestamp: event.timestamp,
    ...(event.capability && CAPABILITIES.has(event.capability)
      ? { capability: event.capability as HarnessCapability }
      : {}),
    ...(event.detail ? { detail: event.detail } : {}),
  }));
}

/* -------------------------------------------------------------------------- */
/* The criterion matrix, from the score                                       */
/* -------------------------------------------------------------------------- */

/**
 * All 55, baseline against final.
 *
 * The cell reports the run's *outcome* for the criterion — passing, failing,
 * flagged, blocked — not the criterion's routing verdict, because "DECIDE"
 * says how a finding would be handled, not whether one exists.
 */
export function scoreToMatrixRows(
  baseline: RunScoreWire | null,
  final: RunScoreWire | null,
): CriterionRow[] {
  if (!baseline) return [];
  const finalByCriterion = new Map((final?.criteria ?? []).map((c) => [c.criterion, c]));

  return baseline.criteria.map((criterion) => {
    const after = finalByCriterion.get(criterion.criterion);
    return {
      id: criterion.criterion,
      name: criterion.name,
      level: criterion.level,
      baseline: criterion.state as CriterionCell,
      final: after ? (after.state as CriterionCell) : null,
      findings: criterion.findings,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

const SEVERITIES: ReadonlySet<string> = new Set(["critical", "serious", "moderate", "minor"]);

const STATUSES: ReadonlySet<string> = new Set([
  "open",
  "fixing",
  "fixed",
  "verified",
  "dismissed",
]);

const AGENTS: ReadonlySet<string> = new Set([
  "TREE",
  "VIS",
  "ACT",
  "PAGES",
  "MEDIA",
  "CODE",
  "FIX",
  "VERIFY",
]);

export function toFindingCard(row: FindingWire): Finding {
  return {
    id: row.id,
    criterion: row.criterion,
    criterionName: row.criterionName ?? row.criterion,
    level: row.level,
    verdict: row.verdict,
    severity: (SEVERITIES.has(row.severity) ? row.severity : "minor") as FindingSeverity,
    status: (STATUSES.has(row.status) ? row.status : "open") as FindingStatus,
    pageUrl: row.pageUrl,
    summary: row.summary,
    agent: (AGENTS.has(row.agent) ? row.agent : "TREE") as AuditAgent,
    ...(row.sourcePath ? { sourcePath: row.sourcePath } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
  };
}

export function toFindingCards(rows: ReadonlyArray<FindingWire>): Finding[] {
  return rows.map(toFindingCard);
}

/**
 * How many findings each *lane* produced, for the environment cards.
 *
 * Not by page. A page-keyed count gives every lane that visited a page the
 * page's whole total, so a run where ACT found three and VIS found two showed
 * "7 findings" on all six cards — including MEDIA, which found none. The card
 * names one agent, so the number beside it has to be that agent's.
 *
 * Keyed by run phase as well, because the final audit re-walks the same pages
 * with the same lanes and its findings are a separate set from the baseline's.
 *
 * `byPhase` exists for PAGES, whose job is one singleton per phase rather than
 * one per page (it is comparative, so it cannot be), while its findings are
 * still recorded against individual pages.
 */
export interface LaneFindingCounts {
  /** `phase   agent   pageUrl` */
  readonly byPage: ReadonlyMap<string, number>;
  /** `phase   agent`, summed over every page. */
  readonly byPhase: ReadonlyMap<string, number>;
}

const SEP = " ";

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

export function findingsByLane(rows: ReadonlyArray<FindingWire>): LaneFindingCounts {
  const byPage = new Map<string, number>();
  const byPhase = new Map<string, number>();
  for (const row of rows) {
    const lane = `${row.phase}${SEP}${row.agent}`;
    bump(byPhase, lane);

    const url = row.pageUrl;
    bump(byPage, `${lane}${SEP}${url}`);
    // A job keys a page with or without its trailing slash; index both
    // spellings as aliases of the one finding.
    const alt = url.endsWith("/") ? url.slice(0, -1) : url + "/";
    if (alt !== url) bump(byPage, `${lane}${SEP}${alt}`);
  }
  return { byPage, byPhase };
}

/**
 * The run phase and page a job's key refers to.
 *
 * `null` for a key that names neither — `crawl`, `score`, a source path under
 * `fix`. Those jobs record no findings, and a count of zero beside them would
 * be a claim about accessibility rather than a statement that this job does
 * not count findings.
 */
function laneKeyOf(jobKey: string): { phase: string; page: string | null } | null {
  const scoped = /^(baseline|final):(.+)$/.exec(jobKey);
  if (scoped) return { phase: scoped[1], page: scoped[2] };
  if (jobKey === "baseline" || jobKey === "final") return { phase: jobKey, page: null };
  return null;
}

/**
 * The number for one card, or `undefined` to print nothing.
 *
 * A lane that finished is reported even at zero: "MEDIA found nothing" is a
 * result, and the honest one. A lane still running or failed is reported only
 * when it has something, because zero there means "not finished", which is a
 * different claim and the one that has bitten this UI before.
 */
export function laneFindingCount(
  job: JobWire,
  counts: LaneFindingCounts,
  state: EnvironmentState,
): number | undefined {
  if (!job.agent) return undefined;
  const key = laneKeyOf(job.jobKey);
  if (!key) return undefined;

  const lane = `${key.phase}${SEP}${job.agent}`;
  const found =
    key.page === null ? counts.byPhase.get(lane) : counts.byPage.get(`${lane}${SEP}${key.page}`);

  if (state === "done") return found ?? 0;
  return found !== undefined && found > 0 ? found : undefined;
}

export interface CriterionGroup {
  criterion: string;
  name: string;
  level: CriterionLevel;
  verdict: "DECIDE" | "FLAG" | "BLOCKED";
  /** Worst severity in the group, which is what orders it. */
  severity: FindingSeverity;
  findings: Finding[];
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
};

/** Findings grouped by the criterion they cite, worst severity first. */
export function groupByCriterion(rows: ReadonlyArray<FindingWire>): CriterionGroup[] {
  const groups = new Map<string, CriterionGroup>();

  for (const row of rows) {
    const card = toFindingCard(row);
    const existing = groups.get(row.criterion);
    if (existing) {
      existing.findings.push(card);
      if (SEVERITY_RANK[card.severity] < SEVERITY_RANK[existing.severity]) {
        existing.severity = card.severity;
      }
      continue;
    }
    groups.set(row.criterion, {
      criterion: row.criterion,
      name: card.criterionName,
      level: card.level,
      verdict: card.verdict,
      severity: card.severity,
      findings: [card],
    });
  }

  return [...groups.values()].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.findings.length - a.findings.length ||
      a.criterion.localeCompare(b.criterion),
  );
}

/* -------------------------------------------------------------------------- */
/* Patches                                                                    */
/* -------------------------------------------------------------------------- */

/** A patch card, its covered criteria resolved from the findings it cites. */
export function toPatchCards(
  patches: ReadonlyArray<PatchWire>,
  findings: ReadonlyArray<FindingWire>,
): Patch[] {
  const criterionById = new Map(findings.map((row) => [row.id, row.criterion]));

  return patches.map((patch) => {
    const covers = [
      ...new Set(
        (patch.findingIds ?? [])
          .map((id) => criterionById.get(id))
          .filter((value): value is string => Boolean(value)),
      ),
    ].sort();
    return { id: patch.id, path: patch.filePath, covers, diff: patch.diff };
  });
}
