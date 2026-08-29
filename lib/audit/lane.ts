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
   * Whether axe-core actually executed on this page.
   *
   * The distinction this answers is the one the product turns on: the browser
   * result schema defaults `axeViolations` to `[]`, so a page axe swept clean
   * and a page axe never ran on arrive looking identical, and reading the second
   * as the first is how contrast came to pass untested.
   *
   * **The capture is the authority, and this is the fallback.** A `PageCapture`
   * from `lib/browser` always carries `axeRan` — the worker sets it from what it
   * actually did, and `capturePage` copies it through — so on the ordinary path
   * `capture.axeRan` answers the question and this field is not needed. It stays
   * here for a caller holding a capture shape that predates the field, or one
   * assembling `TreePageInput` by hand.
   *
   * Optional, because the pipeline's `AuditPageInput` carries only the capture,
   * and requiring a boolean the dispatcher would have to copy off the capture it
   * is already passing buys nothing but a chance to copy it wrongly.
   *
   * Optional does **not** weaken the invariant, because absence resolves to
   * `false` and not to a shrug: `runTreeLane` reads
   * `capture.axeRan ?? this ?? false`, so axe is believed to have run only on
   * positive evidence from one of the two. `false` — set, or defaulted — leaves
   * every axe-dependent criterion inconclusive with a warning on the page, which
   * is exactly what an absent signal must mean. An empty violations array from a
   * page where axe never ran can never read as a pass.
   */
  axeRan?: boolean;
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
 * did. It is still positive evidence and nothing else: the capture answers when
 * it can, the caller's `axeRan` answers when the capture cannot, and when
 * neither says yes the answer is `false`. `false` leaves the axe-dependent
 * criteria inconclusive, exactly as an absent signal must.
 *
 * `async` only because every lane in the roster is; nothing here awaits.
 */
export async function runTreeLane(input: TreeLaneInput): Promise<TreeLaneResult> {
  const audit = auditPage({
    ...input.capture,
    url: input.capture.url || input.pageUrl,
    axeRan: input.capture.axeRan ?? input.axeRan ?? false,
  });
  return {
    findings: audit.findings.map(toClaim),
    sessionId: null,
    audit,
  };
}
