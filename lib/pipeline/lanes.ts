/**
 * The seam between the conductor and the modules it dispatches to.
 *
 * The orchestrator routes work; it does not know how any lane does its job.
 * Every import that crosses out of `lib/pipeline` into an audit lane, the fix
 * pass, verification or GitHub is collected here, so the contract the
 * conductor relies on is stated in one file rather than scattered through it.
 *
 * That matters because those modules are built in parallel with this one. When
 * a signature turns out to differ, the reconciliation is an edit to this file
 * and nothing else — `orchestrate.ts` imports only from here.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT
 *
 * Every audit lane is `(input) => Promise<{ findings, sessionId? }>`:
 *
 *   - `findings` are *claims*, not rows. They are validated and persisted by
 *     `recordFindings()`; a lane never touches the database (A13.6).
 *   - `sessionId` is the TrueForge session the lane ran in, recorded on the job
 *     row so a restart reattaches rather than re-running (A12.1). `null` for
 *     TREE and path enumeration, which call no model.
 *
 * The lanes differ only in what they are given:
 *
 *   TREE   one page's capture. Deterministic, no sandbox, no model (A3.2).
 *   VIS    one page's capture. Reads the screenshot.
 *   ACT    one page's capture plus its interaction paths. Takes browser
 *          sandboxes, capped by the pool (A4.3).
 *   MEDIA  one page's capture. Its own queue; never blocks a browser (A3.4).
 *   CODE   one page's capture.
 *   PAGES  *every* page at once, because its criteria are comparative and it
 *          cannot start until the crawl is complete (A3.5).
 * ---------------------------------------------------------------------------
 */
import type { InteractionPath, PageCapture } from '@/lib/browser/types';
import type { Finding, RunPhase } from '@/lib/db/schema';

import type { FindingClaim } from './ledger';

/* -------------------------------------------------------------------------- */
/* Audit lanes                                                                */
/* -------------------------------------------------------------------------- */

/** What a per-page lane is handed. */
export interface AuditPageInput {
  runId: string;
  phase: RunPhase;
  pageId: string;
  pageUrl: string;
  /** Taken once during the crawl. No lane reopens a page. */
  capture: PageCapture;
}

/** What every lane returns. */
export interface AuditLaneResult {
  findings: readonly FindingClaim[];
  /** A12.1. `null` when the lane called no model. */
  sessionId?: string | null;
}

export type PerPageLane = (input: AuditPageInput) => Promise<AuditLaneResult>;

/** ACT additionally receives the paths enumerated for that page (A4.1). */
export type ActLane = (
  input: AuditPageInput & { paths: readonly InteractionPath[] },
) => Promise<AuditLaneResult>;

/** PAGES receives the whole crawl at once (A3.5). */
export type PagesLane = (input: {
  runId: string;
  phase: RunPhase;
  pages: readonly AuditPageInput[];
}) => Promise<AuditLaneResult>;

/* -------------------------------------------------------------------------- */
/* Vision candidates (A4.2)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One control the VIS model believes it can see in a screenshot.
 *
 * Structurally the shape `lib/paths` diffs against. Declared here rather than
 * imported so the conductor's contract stays readable in one file.
 */
export interface VisionCandidate {
  label: string;
  approxSelector: string;
  /** The model's own word for the shape: `button`, `dropdown`, `tab icon`, ... */
  looksLike: string;
  /** The model's certainty, already damped by how it came by the label. */
  confidence?: number;
}

/**
 * The screenshot pass that gives path enumeration its second source.
 *
 * Path enumeration reads the accessibility tree itself. It cannot read a
 * screenshot, so the list of things a *sighted* user can see has to come from
 * somewhere else, and this is it. Subtracting one from the other is what
 * produces a div-button finding — a control with no counterpart in the tree —
 * and without this call enumeration runs tree-only and cannot produce one at
 * all.
 *
 * Contractually total: it reports failure in `error` and returns an empty list
 * rather than throwing, because a page whose vision pass failed is still worth
 * enumerating from the tree.
 */
export type ExtractVisionCandidates = (input: {
  runId?: string;
  pageUrl: string;
  /** Base64 PNG from the crawl. No page is reopened for this. */
  screenshot: string | null;
  title?: string | null;
  signal?: AbortSignal;
}) => Promise<{
  candidates: readonly VisionCandidate[];
  /** A12.1: recorded on the job row so a restart reattaches rather than re-running. */
  sessionId: string | null;
  /** Set when the pass failed; the caller degrades to tree-only. */
  error: string | null;
  /** Set when the pass was not attempted — no screenshot, or one too large to send. */
  skipped: string | null;
}>;

/* -------------------------------------------------------------------------- */
/* FIX (A5)                                                                   */
/* -------------------------------------------------------------------------- */

export interface ProposedPatch {
  /** Repository-relative path. Patches are batched per file (A5.2). */
  sourcePath: string;
  /** Unified diff against the file as it stands in the target repository. */
  diff: string;
  /** Criterion numbers this patch addresses. Never empty. */
  criteria: readonly string[];
  /** Why this change is correct, in prose a reviewer can check. */
  rationale: string;
  risk?: string | null;
  /** A5.5: the ledger ids this patch covers, when FIX can name them. */
  findingIds?: readonly string[];
}

export type WritePatches = (input: {
  runId: string;
  repoFullName: string;
  /** The user's own GitHub token (A1.4). */
  accessToken: string;
  /** A5.1: findings from the ledger, not raw page content. */
  findings: readonly Finding[];
}) => Promise<{
  patches: readonly ProposedPatch[];
  /** Findings FIX declined to touch, each with a reason. */
  skipped?: readonly { criterion: string; reason: string }[];
  sessionId?: string | null;
}>;

/* -------------------------------------------------------------------------- */
/* VERIFY (A6)                                                                */
/* -------------------------------------------------------------------------- */

export type VerifyPatches = (input: {
  runId: string;
  repoFullName: string;
  accessToken: string;
  patches: readonly { id: string; filePath: string; diff: string }[];
}) => Promise<{
  buildPassed: boolean;
  testsPassed: boolean;
  /** The exact command that was run, e.g. `npm test`. */
  testCommand: string;
  /** Trimmed tail of the output. The full log stays in the sandbox (A9.2). */
  testSummary: string;
  /** A6.3: per-criterion re-check for every criterion a patch claimed. */
  recheck: readonly { criterion: string; resolved: boolean; note: string }[];
  /** A6.4: VERIFY's gate on the pull request. */
  recommendation: 'open-pull-request' | 'reject-patches';
  sessionId?: string | null;
  /** A preview of the patched build, when one was deployed. Audited in `final`. */
  previewUrl?: string | null;
}>;

/* -------------------------------------------------------------------------- */
/* GitHub (A1.4, A10.5)                                                       */
/* -------------------------------------------------------------------------- */

export type OpenPullRequest = (input: {
  runId: string;
  repoFullName: string;
  accessToken: string;
  branch: string;
  title: string;
  body: string;
  patches: readonly { filePath: string; diff: string }[];
}) => Promise<{ url: string; number: number; branch: string }>;

/* -------------------------------------------------------------------------- */
/* Bindings                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * The one place a sibling module is named.
 *
 * Each binding is *annotated* with its contract type rather than re-exported
 * bare. That is deliberate: an implementation whose signature differs fails
 * here, as a single assignment error naming the field that differs, instead of
 * silently degrading to `any` and taking the conductor's type safety with it.
 */
import {
  runTreeLane as treeLane,
  runVisLane as visLane,
  runActLane as actLane,
  runMediaLane as mediaLane,
  runCodeLane as codeLane,
  runPagesLane as pagesLane,
} from '@/lib/audit';
import { enumerateInteractionPaths as enumeratePathsImpl } from '@/lib/paths';
import { extractVisionCandidates as extractVisionCandidatesImpl } from '@/lib/vision';
import { writePatches as writePatchesImpl } from '@/lib/fix';
import { verifyPatches as verifyPatchesImpl } from '@/lib/verify';
import { openPullRequest as openPullRequestImpl } from '@/lib/github';

/** Deterministic: axe-core and the tree, no sandbox and no model (A3.2). */
export const runTreeLane: PerPageLane = treeLane;
export const runVisLane: PerPageLane = visLane;
export const runActLane: ActLane = actLane;
export const runMediaLane: PerPageLane = mediaLane;
export const runCodeLane: PerPageLane = codeLane;
export const runPagesLane: PagesLane = pagesLane;

/**
 * The screenshot pass (A4.2). Runs immediately before enumeration, on the
 * screenshot the crawl already took.
 */
export const extractVisionCandidates: ExtractVisionCandidates =
  extractVisionCandidatesImpl;

/**
 * Path enumeration (A4.1, A4.2).
 *
 * Returns both the paths ACT will drive and the findings the enumeration itself
 * produced — a control vision can see that the accessibility tree cannot is a
 * finding the moment it is noticed, not something ACT has to confirm.
 *
 * `visionCandidates` is what makes that second kind possible. It is optional
 * and its absence is not an error: with no list, enumeration falls back to the
 * tree alone, which still finds every stale-state 4.1.2 but cannot find a
 * div-button, because a div-button is by definition what the tree does not
 * contain. The conductor supplies it from `extractVisionCandidates` above.
 */
export const enumerateInteractionPaths: (input: {
  runId: string;
  pageUrl: string;
  capture: PageCapture;
  visionCandidates?: readonly VisionCandidate[];
}) => Promise<{
  paths: readonly InteractionPath[];
  findings: readonly FindingClaim[];
  sessionId?: string | null;
}> = enumeratePathsImpl;

export const writePatches: WritePatches = writePatchesImpl;
export const verifyPatches: VerifyPatches = verifyPatchesImpl;
export const openPullRequest: OpenPullRequest = openPullRequestImpl;
