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

/**
 * Cancellation, offered to everything the conductor dispatches.
 *
 * The conductor aborts when the run is cancelled and when it loses its
 * conductor lease to another process. Neither reaches work that never accepted
 * a signal, and until this field existed none of the contracts below did - so a
 * displaced conductor kept writing findings, running builds and opening pull
 * requests beside its successor.
 *
 * Optional, so an implementation that does not yet honour it still satisfies
 * the contract. Honouring it is the difference between the conductor asking
 * work to stop and the work actually stopping; `orchestrate.ts` additionally
 * re-confirms ownership against the database before every durable and external
 * write, which is what bounds the damage until every lane reads this.
 */
export interface Cancellable {
  signal?: AbortSignal;
}

/** What a per-page lane is handed. */
export interface AuditPageInput extends Cancellable {
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
export type PagesLane = (
  input: Cancellable & {
    runId: string;
    phase: RunPhase;
    pages: readonly AuditPageInput[];
  },
) => Promise<AuditLaneResult>;

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

export type WritePatches = (input: Cancellable & {
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

export type VerifyPatches = (input: Cancellable & {
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

export type OpenPullRequest = (input: Cancellable & {
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
 * Path enumeration (A4.1, A4.2).
 *
 * Returns both the paths ACT will drive and the findings the enumeration itself
 * produced — a control vision can see that the accessibility tree cannot is a
 * finding the moment it is noticed, not something ACT has to confirm.
 */
export const enumerateInteractionPaths: (input: Cancellable & {
  runId: string;
  pageUrl: string;
  capture: PageCapture;
}) => Promise<{
  paths: readonly InteractionPath[];
  findings: readonly FindingClaim[];
  sessionId?: string | null;
}> = enumeratePathsImpl;

export const writePatches: WritePatches = writePatchesImpl;
export const verifyPatches: VerifyPatches = verifyPatchesImpl;
export const openPullRequest: OpenPullRequest = openPullRequestImpl;
