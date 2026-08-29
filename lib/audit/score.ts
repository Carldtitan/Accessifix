/**
 * Scoring (A2.3 - A2.6) and the before/after delta (A8.2).
 *
 * A score is a left join of the findings ledger against the fixed list of 55
 * criteria. Every criterion appears in the output, always, with exactly one
 * verdict — never a subset, never a criterion silently absent because nothing
 * was found for it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO CONFORMANCE CLAIM (A2.6, A8.3)
 *
 * Nothing in this file computes, returns, or can be made to return a
 * conformance level. There is no `level: 'AA'` output, no percentage that could
 * be read as one, and `conformanceClaim` is the literal type `null` so no
 * future edit can quietly put a string there without failing the build.
 *
 * The reason is not caution, it is fact: WCAG conformance is a claim the
 * publisher of a site makes about the whole site in a stated conformance
 * scope, and no certifying body exists to grant or withhold it. An automated
 * audit sees the pages it crawled, in the states it reached, against the
 * checks it can run — a strict subset of what conformance requires. Two of the
 * 55 criteria are out of automated reach entirely and are reported BLOCKED for
 * that reason. "Zero findings" therefore means "nothing was found", which is
 * not the same claim as "conforms", and this file will only ever say the
 * former.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  WCAG_CRITERIA,
  blockedReason,
  getCriterion,
  type AuditAgent,
  type CriterionLevel,
} from '@/lib/db/criteria';
import {
  emptySeverityCounts,
  worstSeverity,
  type AuditFinding,
  type AuditPhase,
  type BlockedCriterionReport,
  type CriterionScore,
  type CriterionState,
  type CriterionTransition,
  type RejectedFinding,
  type RunScore,
  type ScoreDelta,
  type Severity,
} from './types';

/**
 * The sentence every report carries in place of a conformance level.
 * Rendered by the run view and the pull request body alike.
 */
export const NO_CONFORMANCE_CLAIM =
  'This is an audit result, not a conformance claim. AccessiFix reports what it found on the pages it reached; it does not certify WCAG conformance, and no body exists that could.';

/* -------------------------------------------------------------------------- */
/* Validation — the enforcement point for non-negotiable rules 3 and 8        */
/* -------------------------------------------------------------------------- */

/**
 * Why this finding must not enter the ledger, or null when it may.
 *
 *  - Rule 3: no finding without a numbered success criterion, and the number
 *    has to be one of the 55. An agent that invents `2.4.12` is rejected here.
 *  - Rule 8: no finding without an artifact.
 *  - A2.4: the two BLOCKED criteria belong to no lane. A finding claiming one
 *    is a routing bug, not evidence, and reporting it would let a criterion
 *    that must read BLOCKED appear to have been audited.
 */
export function validateFinding(finding: AuditFinding): string | null {
  const criterionId = finding.criterion?.trim() ?? '';
  if (criterionId === '') return 'no success criterion attached';

  const criterion = getCriterion(criterionId);
  if (!criterion) return `"${criterionId}" is not one of the 55 Level A/AA success criteria`;

  if (criterion.verdict === 'BLOCKED') {
    return `${criterion.id} is BLOCKED and belongs to no lane: ${blockedReason(criterion.id) ?? 'out of automated reach'}`;
  }
  if (!finding.evidence || finding.evidence.length === 0) {
    return 'no evidence attached';
  }
  if (!finding.summary || finding.summary.trim() === '') return 'no summary';
  if (!finding.pageUrl || finding.pageUrl.trim() === '') return 'no page URL';
  if (!finding.key || finding.key.trim() === '') return 'no identity key';

  return null;
}

export interface FindingPartition {
  readonly valid: readonly AuditFinding[];
  readonly rejected: readonly RejectedFinding[];
}

/** Split a batch into what may be persisted and what must not, with reasons. */
export function partitionFindings(findings: readonly AuditFinding[]): FindingPartition {
  const valid: AuditFinding[] = [];
  const rejected: RejectedFinding[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    const reason = validateFinding(finding);
    if (reason !== null) {
      rejected.push({
        key: finding.key ?? '',
        criterion: finding.criterion ?? '',
        pageUrl: finding.pageUrl ?? '',
        reason,
      });
      continue;
    }
    // The same violation reported by two lanes is one finding, not two.
    if (seen.has(finding.key)) continue;
    seen.add(finding.key);
    valid.push(finding);
  }

  return { valid, rejected };
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                    */
/* -------------------------------------------------------------------------- */

export interface ScoreOptions {
  /**
   * The pages the run actually audited.
   *
   * Coverage cannot be read off the findings: a page with nothing wrong
   * contributes no finding, so deriving the count from findings drops every
   * clean page and reports an entirely clean crawl as zero pages audited.
   * Hand over the crawl's page list - `audits.map((a) => a.pageUrl)` - and the
   * count is what was measured rather than what happened to fail.
   */
  readonly auditedPageUrls?: Iterable<string>;
  /**
   * The audited page count outright, when the list itself is not to hand.
   * Takes precedence over `auditedPageUrls`.
   */
  readonly pagesAudited?: number;
  /**
   * The criteria a lane actually reached on this run.
   *
   * Omit it and every DECIDE criterion with no findings is reported as passing,
   * which is what a completed full audit means. Supply it for a partial run —
   * TREE alone, say — and the criteria nobody reached come back
   * `not_evaluated` instead of being quietly credited as clean.
   */
  readonly evaluatedCriteria?: Iterable<string>;
  /** Why a criterion was not evaluated, shown on the matrix row. */
  readonly notEvaluatedReasons?: Readonly<Record<string, string>>;
}

/**
 * The A2 score for one phase.
 *
 * Every one of the 55 criteria comes back with exactly one verdict — the
 * verdict fixed in the criteria table — and one derived state. `DECIDE` splits
 * into pass and fail; `FLAG` is always `needs_review`, because A5.4 says a
 * human signs those off and the FIX agent never touches them; `BLOCKED` is
 * always `blocked` with its stated reason, and can never be reported as
 * passing (A2.4).
 */
export function scoreRun(
  findings: readonly AuditFinding[],
  phase: AuditPhase,
  options: ScoreOptions = {},
): RunScore {
  const { valid, rejected } = partitionFindings(findings);

  const byCriterion = new Map<string, AuditFinding[]>();
  const pageUrls = new Set<string>();
  const findingsBySeverity = emptySeverityCounts();
  const findingsByLevel: Record<CriterionLevel, number> = { A: 0, AA: 0 };
  const findingsByAgent: Partial<Record<AuditAgent, number>> = {};

  for (const finding of valid) {
    const bucket = byCriterion.get(finding.criterion);
    if (bucket) bucket.push(finding);
    else byCriterion.set(finding.criterion, [finding]);

    pageUrls.add(finding.pageUrl);
    findingsBySeverity[finding.severity] += 1;

    // Level comes from the criteria table, never from what the finding claimed.
    const criterion = getCriterion(finding.criterion);
    if (criterion) findingsByLevel[criterion.level] += 1;

    findingsByAgent[finding.agent] = (findingsByAgent[finding.agent] ?? 0) + 1;
  }

  const evaluated = options.evaluatedCriteria ? new Set(options.evaluatedCriteria) : null;
  const auditedPages = options.auditedPageUrls ? new Set(options.auditedPageUrls) : null;

  const criteria: CriterionScore[] = WCAG_CRITERIA.map((criterion) => {
    const own = byCriterion.get(criterion.id) ?? [];
    const pages: string[] = [];
    for (const finding of own) {
      if (!pages.includes(finding.pageUrl)) pages.push(finding.pageUrl);
    }

    let state: CriterionState;
    let reason: string | undefined;

    if (criterion.verdict === 'BLOCKED') {
      // A2.4: stated reason, and never passing. `partitionFindings` has already
      // rejected any finding that tried to claim one of these.
      state = 'blocked';
      reason = blockedReason(criterion.id) ?? 'Out of reach for automation.';
    } else if (criterion.verdict === 'FLAG') {
      // A5.4: a human signs off. Not a pass, not a fail.
      state = 'needs_review';
      reason =
        own.length > 0
          ? `${own.length} finding${own.length === 1 ? '' : 's'} awaiting human sign-off.`
          : 'Awaiting human sign-off; this criterion is not decided automatically.';
    } else if (own.length > 0) {
      state = 'fail';
    } else if (evaluated && !evaluated.has(criterion.id)) {
      state = 'not_evaluated';
      reason =
        options.notEvaluatedReasons?.[criterion.id] ??
        'No lane reached this criterion on this run.';
    } else {
      state = 'pass';
    }

    return {
      criterion: criterion.id,
      name: criterion.name,
      level: criterion.level,
      principle: criterion.principle,
      verdict: criterion.verdict,
      state,
      findingCount: own.length,
      worstSeverity: worstSeverity(own.map((f) => f.severity)),
      pages,
      findingKeys: own.map((f) => f.key),
      agent: criterion.agent,
      ...(reason ? { reason } : {}),
    };
  });

  const withState = (state: CriterionState): string[] =>
    criteria.filter((c) => c.state === state).map((c) => c.criterion);

  const failingCriteria = withState('fail');
  const passingCriteria = withState('pass');
  const needsReviewCriteria = withState('needs_review');
  const notEvaluatedCriteria = withState('not_evaluated');

  const blockedCriteria: BlockedCriterionReport[] = criteria
    .filter((c) => c.state === 'blocked')
    .map((c) => ({
      criterion: c.criterion,
      name: c.name,
      reason: c.reason ?? 'Out of reach for automation.',
    }));

  return {
    phase,
    criteria,
    totals: {
      criteria: criteria.length,
      failing: failingCriteria.length,
      passing: passingCriteria.length,
      needsReview: needsReviewCriteria.length,
      blocked: blockedCriteria.length,
      notEvaluated: notEvaluatedCriteria.length,
      findings: valid.length,
    },
    failingCriteria,
    passingCriteria,
    needsReviewCriteria,
    blockedCriteria,
    notEvaluatedCriteria,
    findingsBySeverity,
    findingsByLevel,
    findingsByAgent,
    /*
     * The last fallback is the pages that produced a finding, which is the only
     * thing derivable here and is an undercount whenever a page came back
     * clean. Supply `auditedPageUrls` or `pagesAudited`.
     */
    pagesAudited: options.pagesAudited ?? auditedPages?.size ?? pageUrls.size,
    rejectedFindings: rejected,
    conformanceClaim: null,
    disclaimer: NO_CONFORMANCE_CLAIM,
  };
}

/* -------------------------------------------------------------------------- */
/* Delta (A8.2)                                                               */
/* -------------------------------------------------------------------------- */

function allFindingKeys(score: RunScore): Set<string> {
  const keys = new Set<string>();
  for (const criterion of score.criteria) {
    for (const key of criterion.findingKeys) keys.add(key);
  }
  return keys;
}

/**
 * What the run actually changed.
 *
 * A8.2 asks for three numbers: criteria moved from failing to passing, findings
 * resolved, and findings remaining. All three come out of two `RunScore`s and
 * nothing else, because a `CriterionScore` carries its finding keys — so the
 * delta needs no second pass over the ledger and no database round trip.
 *
 * A8.3: this reports movement in findings and criteria. It does not report a
 * change in conformance level, because it never claimed one.
 */
export function computeDelta(baseline: RunScore, final: RunScore): ScoreDelta {
  const before = new Map(baseline.criteria.map((c) => [c.criterion, c]));
  const after = new Map(final.criteria.map((c) => [c.criterion, c]));

  const criteriaFixed: string[] = [];
  const criteriaRegressed: string[] = [];
  const criteriaStillFailing: string[] = [];
  const transitions: CriterionTransition[] = [];

  for (const criterion of WCAG_CRITERIA) {
    const b = before.get(criterion.id);
    const a = after.get(criterion.id);
    if (!b || !a) continue;

    if (b.state === 'fail' && a.state === 'pass') criteriaFixed.push(criterion.id);
    else if (b.state === 'pass' && a.state === 'fail') criteriaRegressed.push(criterion.id);
    else if (b.state === 'fail' && a.state === 'fail') criteriaStillFailing.push(criterion.id);

    if (b.state !== a.state || b.findingCount !== a.findingCount) {
      transitions.push({
        criterion: criterion.id,
        name: criterion.name,
        level: criterion.level,
        before: b.state,
        after: a.state,
        findingsBefore: b.findingCount,
        findingsAfter: a.findingCount,
      });
    }
  }

  const baselineKeys = allFindingKeys(baseline);
  const finalKeys = allFindingKeys(final);

  const resolvedKeys = [...baselineKeys].filter((k) => !finalKeys.has(k));
  const remainingKeys = [...baselineKeys].filter((k) => finalKeys.has(k));
  const introducedKeys = [...finalKeys].filter((k) => !baselineKeys.has(k));

  const severityDelta = emptySeverityCounts();
  for (const severity of Object.keys(severityDelta) as Severity[]) {
    severityDelta[severity] =
      final.findingsBySeverity[severity] - baseline.findingsBySeverity[severity];
  }

  return {
    criteriaFixed,
    criteriaRegressed,
    criteriaStillFailing,
    transitions,
    findingsResolved: resolvedKeys.length,
    /**
     * Everything still open after the run: findings that survived a fix plus
     * anything the final pass turned up that the baseline had not.
     */
    findingsRemaining: finalKeys.size,
    findingsIntroduced: introducedKeys.length,
    resolvedKeys,
    remainingKeys,
    introducedKeys,
    failingBefore: baseline.totals.failing,
    failingAfter: final.totals.failing,
    findingsBefore: baseline.totals.findings,
    findingsAfter: final.totals.findings,
    severityDelta,
    conformanceClaim: null,
    disclaimer: NO_CONFORMANCE_CLAIM,
  };
}

/** Score both phases and diff them in one call. */
export function scoreDeltaFromFindings(
  baselineFindings: readonly AuditFinding[],
  finalFindings: readonly AuditFinding[],
  options: ScoreOptions = {},
): { baseline: RunScore; final: RunScore; delta: ScoreDelta } {
  const baseline = scoreRun(baselineFindings, 'baseline', options);
  const final = scoreRun(finalFindings, 'final', options);
  return { baseline, final, delta: computeDelta(baseline, final) };
}

/* -------------------------------------------------------------------------- */
/* Small readers the interface layer needs                                    */
/* -------------------------------------------------------------------------- */

/** One criterion's row, for the finding detail screen. */
export function criterionScore(score: RunScore, criterionId: string): CriterionScore | undefined {
  return score.criteria.find((c) => c.criterion === criterionId);
}

/** Findings grouped by criterion, in criteria-table order. */
export function groupByCriterion(
  findings: readonly AuditFinding[],
): Map<string, AuditFinding[]> {
  const grouped = new Map<string, AuditFinding[]>();
  for (const criterion of WCAG_CRITERIA) grouped.set(criterion.id, []);
  for (const finding of findings) {
    const bucket = grouped.get(finding.criterion);
    if (bucket) bucket.push(finding);
  }
  return grouped;
}

/**
 * A one-line headline for the run summary bar.
 *
 * Deliberately phrased as a count, never as a grade. "38 of 55 criteria clean"
 * is a measurement; "AA" would be a claim.
 */
export function scoreHeadline(score: RunScore): string {
  const { passing, failing, needsReview, blocked, notEvaluated, findings } = score.totals;
  const parts = [
    `${failing} criteria failing`,
    `${findings} finding${findings === 1 ? '' : 's'}`,
    `${passing} clean`,
  ];
  if (needsReview > 0) parts.push(`${needsReview} awaiting review`);
  if (notEvaluated > 0) parts.push(`${notEvaluated} not evaluated`);
  if (blocked > 0) parts.push(`${blocked} blocked`);
  return parts.join(', ');
}
