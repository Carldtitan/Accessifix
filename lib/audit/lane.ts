/**
 * The TREE lane, in the shape `lib/pipeline/lanes.ts` dispatches.
 *
 * Everything above this file is pure. This is the thin adapter that turns a
 * `PageAudit` into the claim shape the ledger validates and persists — the lane
 * itself still writes nothing (A13.6), calls no model, and takes no sandbox
 * (A3.2), which is why `sessionId` is always null.
 *
 * The pipeline's contract types are matched structurally rather than imported:
 * `lib/pipeline/lanes.ts` already imports from `@/lib/audit`, and importing
 * back would tie the deterministic gate to the conductor for no gain. The
 * annotation in `lanes.ts` is what proves the two agree.
 */

import type { ArtifactKind } from '@/lib/db/schema';
import { auditPage, type TreePageInput } from './tree';
import type { AuditFinding, AuditPhase, FindingEvidence, PageAudit, Severity } from './types';

/** The ledger's evidence shape (`FindingEvidence` in `lib/pipeline/ledger.ts`). */
export interface LedgerEvidence {
  kind: ArtifactKind;
  mimeType?: string;
  data?: string | null;
  storagePath?: string | null;
}

/** The ledger's claim shape (`FindingClaim` in `lib/pipeline/ledger.ts`). */
export interface TreeFindingClaim {
  criterion: string;
  severity: Severity;
  summary: string;
  detail?: string | null;
  selector?: string | null;
  sourcePath?: string | null;
  pageUrl: string;
  verdict?: string | null;
  evidence?: LedgerEvidence[];
}

export interface TreeLaneInput {
  pageUrl: string;
  /** A `PageCapture` from `lib/browser` satisfies this. */
  capture: TreePageInput;
  /**
   * Whether axe-core actually executed on this page. Required, and required
   * here rather than left to the capture, because a `PageCapture` cannot answer
   * it: the browser result schema defaults `axeViolations` to `[]`, so a clean
   * run and a run that never happened arrive looking identical.
   *
   * TREE will not read an empty violation list as proof of execution — that is
   * how contrast came to pass untested — so without this every axe-dependent
   * criterion goes to inconclusive and the page carries a warning saying axe did
   * not run. On a page that axe swept clean, that is wrong in the other
   * direction, and a caller that simply forgot would never notice.
   *
   * The dispatcher is the only layer that knows: it chose `job.axe`, and it saw
   * whether the worker got as far as running it. So it has to say, in one
   * boolean, every time. `true` means axe executed and returned; `false` means
   * it was switched off, never reached, or failed — all of which leave the
   * axe-dependent criteria honestly inconclusive.
   *
   * Passing `axeRan`, `axePasses` or `axeIncomplete` on the capture itself still
   * works and takes precedence; this is the answer for the ordinary path, where
   * the capture carries none of them.
   */
  axeRan: boolean;
  phase?: AuditPhase;
}

export interface TreeLaneResult {
  findings: TreeFindingClaim[];
  /** Always null: TREE calls no model, so there is no session to resume (A12.1). */
  sessionId: null;
  /** The full per-page result, for the run view and the coverage roll-up. */
  audit: PageAudit;
}

/**
 * The accessibility tree and axe result are already artifacts; the finding
 * needs a pointer to the part of them the claim rests on, not a second copy of
 * the page. `kind` maps onto the ledger's four artifact kinds.
 */
const ARTIFACT_KIND_BY_EVIDENCE: Readonly<Record<FindingEvidence['kind'], ArtifactKind>> = {
  axe: 'log',
  axtree: 'axtree',
  dom: 'log',
  document: 'log',
};

function toBase64(text: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64');
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toLedgerEvidence(evidence: FindingEvidence): LedgerEvidence {
  return {
    kind: ARTIFACT_KIND_BY_EVIDENCE[evidence.kind] ?? 'log',
    mimeType: 'application/json',
    data: toBase64(JSON.stringify(evidence)),
    storagePath: null,
  };
}

/**
 * One `AuditFinding` as the ledger wants it.
 *
 * `selector` is only filled from evidence whose targets really are CSS
 * selectors. An `axtree` target is a CDP AXNodeId, which would be worse than
 * null in that column: it looks like a selector, resolves to nothing, and
 * changes on the next capture.
 */
export function toClaim(finding: AuditFinding): TreeFindingClaim {
  const selector =
    finding.evidence.filter((e) => e.kind !== 'axtree').flatMap((e) => e.targets)[0] ?? null;
  return {
    criterion: finding.criterion,
    severity: finding.severity,
    summary: finding.summary,
    detail: finding.detail ?? null,
    selector,
    sourcePath: finding.sourcePath ?? null,
    pageUrl: finding.pageUrl,
    verdict: finding.verdict,
    evidence: finding.evidence.map(toLedgerEvidence),
  };
}

/**
 * Run the deterministic gate over one page.
 *
 * The axe execution signal is folded in here, at the one place that has both
 * the capture and the dispatcher's knowledge of what the browser job actually
 * did. It is still positive evidence and nothing else: `false` leaves the
 * axe-dependent criteria inconclusive, exactly as an absent signal would.
 *
 * `async` only because every lane in the roster is; nothing here awaits.
 */
export async function runTreeLane(input: TreeLaneInput): Promise<TreeLaneResult> {
  const audit = auditPage({
    ...input.capture,
    url: input.capture.url || input.pageUrl,
    axeRan: input.capture.axeRan ?? input.axeRan,
  });
  return {
    findings: audit.findings.map(toClaim),
    sessionId: null,
    audit,
  };
}
