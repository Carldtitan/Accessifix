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
  /**
   * Repairs the response parser had to make on the way — a reply in the wrong
   * shape, a path it had to reconcile. Not failures, but the run timeline wants
   * them: contract drift between this seam and the saved agent manifest is
   * invisible until it costs a whole run.
   */
  warnings?: readonly string[];
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
  /**
   * Whether a build command actually ran. `buildPassed` cannot carry this on
   * its own: a repository with no build script fails nothing and compiles
   * nothing, and "unproven" has to stay distinguishable from "failed" all the
   * way to the pull-request gate, which treats the two differently.
   */
  buildRan: boolean;
  /**
   * Whether the suite is a reason to refuse — not whether every test is green.
   *
   * VERIFY runs the suite on the base tree as well as the patched one, so a
   * test that was already failing before the change is reported rather than
   * treated as a failure of this patch. A test the patch *broke* always sets
   * this false; `baseline` below says which is which.
   */
  testsPassed: boolean;
  /** Whether any test actually ran. A missing suite is unproven, never a pass. */
  testsRan: boolean;
  /** The exact command that was run, e.g. `npm test`. */
  testCommand: string;
  /** Trimmed tail of the output. The full log stays in the sandbox (A9.2). */
  testSummary: string;
  /** Every test failing on the patched tree, whoever's fault it is (A6.4). */
  failingTests?: readonly {
    id: string;
    file: string;
    name: string;
    message: string | null;
  }[];
  /**
   * A6.4: the base-tree run, and what comparing it against the patched run
   * showed. This is what tells a maintainer whether the change is at fault.
   */
  baseline?: {
    ran: boolean;
    comparable: boolean;
    reason: string;
    preExisting: readonly { id: string; message: string | null }[];
    regressions: readonly { id: string; message: string | null }[];
    introduced: readonly { id: string; message: string | null }[];
    fixed: readonly { id: string; message: string | null }[];
  };
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

export interface OpenPullRequestInput {
  runId: string;
  repoFullName: string;
  accessToken: string;
  branch: string;
  title: string;
  body: string;
  patches: readonly { filePath: string; diff: string }[];
  /**
   * Verification evidence. The gates in `openVerifiedPullRequest` read this
   * rather than taking the conductor's word: a failing suite is a hard stop,
   * and an unproven build plus an unproven suite is no evidence at all.
   */
  verification?: {
    buildPassed: boolean;
    /**
     * False when no build script ran. Omitted, it is inferred from
     * `buildPassed`, which cannot tell an absent build from a failed one — so a
     * caller with the fact should say so and let the gate read it correctly.
     */
    buildRan?: boolean;
    testsPassed: boolean;
    /** False when no suite ran, or one ran and found nothing. Unproven, not a pass. */
    testsRan?: boolean;
    testCommand?: string;
    testSummary?: string;
  };
  /**
   * A7.1: the human decision. Absent or unapproved means refuse, and so does an
   * approval carrying no `operations` — the id names the card that was clicked
   * and nothing about the repository, branch, title or bytes it authorised.
   * `operations` is what `planPullRequest` produced before the card went up and
   * what the conductor recorded against the answer.
   */
  approval?: {
    requestId: string;
    approved: boolean;
    operations?: ApprovedWriteOperations;
  };
  signal?: AbortSignal;
}

export type OpenPullRequest = (input: OpenPullRequestInput) => Promise<OpenedPullRequestForRun>;

/**
 * Everything the write would do, worked out without doing any of it (A7.1).
 *
 * The conductor calls this *before* raising the approval card, so the card can
 * name the branch, the base, the title and every file by its digest, and so the
 * operations the human answered can be recorded alongside their decision. Every
 * GitHub call it makes is a read.
 */
export type PlanPullRequest = (
  input: Omit<OpenPullRequestInput, 'approval'>,
) => Promise<PullRequestPlan>;

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
import {
  openPullRequestForRun as openPullRequestImpl,
  planPullRequestForRun as planPullRequestImpl,
  type ApprovedWriteOperations,
  type OpenedPullRequestForRun,
  type PullRequestPlan,
} from '@/lib/github/open-pr';

/**
 * Deterministic: axe-core and the tree, no sandbox and no model (A3.2).
 *
 * TREE takes `axeRan` as its own argument because a `PageCapture` alone cannot
 * answer it in general — the browser result schema defaults `axeViolations` to
 * `[]`, so a page axe swept clean and a page axe never reached arrive looking
 * identical, and reading the second as the first is how contrast came to pass
 * untested. The capture the crawl produces *does* carry the answer: the browser
 * script reports whether `axe.run` actually completed, and `capturePage` puts
 * that boolean on the capture.
 *
 * So the seam forwards that recorded fact and invents nothing. `axeRan` stays
 * true only on positive evidence: an outage, a blocked injection or a capture
 * predating the flag all leave it false, which sends every axe-dependent
 * criterion to inconclusive — the honest answer — rather than to a pass.
 */
export const runTreeLane: PerPageLane = (input) =>
  treeLane({
    pageUrl: input.pageUrl,
    capture: input.capture,
    axeRan: input.capture.axeRan === true,
  });
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
export const planPullRequest: PlanPullRequest = planPullRequestImpl;
export const openPullRequest: OpenPullRequest = openPullRequestImpl;

export type { ApprovedWriteOperations, OpenedPullRequestForRun, PullRequestPlan };
