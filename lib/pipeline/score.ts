/**
 * The score (A2.5) and the delta (A8.2).
 *
 * Both are queries over the findings ledger. Nothing is stored: the ledger is
 * the product, and a stored score is a second source of truth waiting to drift
 * from the first.
 *
 * A2.6 and A8.3: this reports counts. It never claims a conformance level or a
 * conformance-level change, because no certifying body exists and AccessiFix is
 * not one.
 */
import { and, eq } from 'drizzle-orm';

import { WCAG_CRITERIA, blockedReason } from '@/lib/db/criteria';
import { db } from '@/lib/db';
import {
  findings,
  SEVERITIES,
  type RunPhase,
  type Severity,
  type Verdict,
} from '@/lib/db/schema';

export interface CriterionScore {
  criterion: string;
  name: string;
  level: 'A' | 'AA';
  verdict: Verdict;
  /** How many findings cite this criterion in this phase. */
  findings: number;
  /** Findings not yet fixed or dismissed. */
  open: number;
  /** `blocked` outranks everything: A2.4 forbids reporting it as passing. */
  state: 'passing' | 'failing' | 'flagged' | 'blocked';
  reason?: string;
}

export interface RunScore {
  phase: RunPhase;
  /** Always 55. The report is a left join against the fixed list. */
  totalCriteria: number;
  failingCriteria: number;
  flaggedCriteria: number;
  blockedCriteria: number;
  passingCriteria: number;
  totalFindings: number;
  openFindings: number;
  bySeverity: Record<Severity, number>;
  criteria: CriterionScore[];
  /**
   * A2.6. Rendered verbatim next to any score so nobody mistakes a count for a
   * certification.
   */
  disclaimer: string;
}

export const NO_CONFORMANCE_CLAIM =
  'This is a count of findings against the 55 WCAG 2.2 Level A and AA success ' +
  'criteria. It is not a conformance claim: no certifying body exists, and ' +
  'AccessiFix does not act as one.';

/** The score for one phase of one run. */
export async function scoreRun(runId: string, phase: RunPhase): Promise<RunScore> {
  const rows = await db
    .select({
      criterion: findings.criterion,
      severity: findings.severity,
      status: findings.status,
      verdict: findings.verdict,
    })
    .from(findings)
    .where(and(eq(findings.runId, runId), eq(findings.phase, phase)));

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const counts = new Map<string, { total: number; open: number }>();
  let openFindings = 0;

  for (const row of rows) {
    bySeverity[row.severity] += 1;

    const entry = counts.get(row.criterion) ?? { total: 0, open: 0 };
    entry.total += 1;
    if (row.status !== 'fixed' && row.status !== 'verified' && row.status !== 'dismissed') {
      entry.open += 1;
      openFindings += 1;
    }
    counts.set(row.criterion, entry);
  }

  // Left join against the fixed list of 55, so a criterion with no findings is
  // reported as passing rather than silently absent.
  const criteria: CriterionScore[] = WCAG_CRITERIA.map((criterion) => {
    const entry = counts.get(criterion.id) ?? { total: 0, open: 0 };

    const state: CriterionScore['state'] =
      criterion.verdict === 'BLOCKED'
        ? 'blocked'
        : entry.open === 0
          ? 'passing'
          : criterion.verdict === 'FLAG'
            ? 'flagged'
            : 'failing';

    return {
      criterion: criterion.id,
      name: criterion.name,
      level: criterion.level,
      verdict: criterion.verdict,
      findings: entry.total,
      open: entry.open,
      state,
      ...(state === 'blocked' ? { reason: blockedReason(criterion.id) } : {}),
    };
  });

  return {
    phase,
    totalCriteria: WCAG_CRITERIA.length,
    failingCriteria: criteria.filter((c) => c.state === 'failing').length,
    flaggedCriteria: criteria.filter((c) => c.state === 'flagged').length,
    blockedCriteria: criteria.filter((c) => c.state === 'blocked').length,
    passingCriteria: criteria.filter((c) => c.state === 'passing').length,
    totalFindings: rows.length,
    openFindings,
    bySeverity,
    criteria,
    disclaimer: NO_CONFORMANCE_CLAIM,
  };
}

export interface RunDelta {
  baseline: RunScore;
  final: RunScore;
  /** Criteria that were failing or flagged at baseline and are clean at final. */
  criteriaFixed: string[];
  /** Criteria clean at baseline that are not clean at final. A regression. */
  criteriaRegressed: string[];
  findingsResolved: number;
  findingsRemaining: number;
  disclaimer: string;
}

/**
 * The before and after (A8.2).
 *
 * Both phases live under the same run id, so this is one query over one table
 * grouped two ways — exactly what the ledger design promised.
 */
export async function scoreDelta(runId: string): Promise<RunDelta> {
  const [baseline, final] = await Promise.all([
    scoreRun(runId, 'baseline'),
    scoreRun(runId, 'final'),
  ]);

  const finalByCriterion = new Map(final.criteria.map((c) => [c.criterion, c]));
  const criteriaFixed: string[] = [];
  const criteriaRegressed: string[] = [];

  for (const before of baseline.criteria) {
    const after = finalByCriterion.get(before.criterion);
    if (!after || before.state === 'blocked') continue;

    const wasClean = before.state === 'passing';
    const isClean = after.state === 'passing';

    if (!wasClean && isClean) criteriaFixed.push(before.criterion);
    if (wasClean && !isClean) criteriaRegressed.push(before.criterion);
  }

  return {
    baseline,
    final,
    criteriaFixed,
    criteriaRegressed,
    findingsResolved: Math.max(0, baseline.openFindings - final.openFindings),
    findingsRemaining: final.openFindings,
    // A8.3: the delta is a count of criteria and findings, not a level change.
    disclaimer: NO_CONFORMANCE_CLAIM,
  };
}
