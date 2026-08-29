/**
 * Shared types for the audit layer.
 *
 * Nothing in `lib/audit` touches a browser, a sandbox or a database. TREE is a
 * library inside the application (design, "High-Level Architecture"), so every
 * shape here is plain data: a `PageCapture` from `lib/browser` goes in, an
 * `AuditFinding[]` comes out, and `lib/pipeline` decides what to persist.
 *
 * The unions below are declared locally rather than imported from the Drizzle
 * schema so this module stays free of `drizzle-orm`, but a compile-time
 * equivalence check at the bottom of this section fails the build if they ever
 * drift from the ledger's enums.
 */

import type {
  AuditAgent,
  CriterionLevel,
  CriterionPrinciple,
  CriterionVerdict,
} from '@/lib/db/criteria';
import type { RunPhase as LedgerRunPhase, Severity as LedgerSeverity } from '@/lib/db/schema';

/* -------------------------------------------------------------------------- */
/* Enumerations                                                               */
/* -------------------------------------------------------------------------- */

/** Worst first. `compareSeverity` and `worstSeverity` rely on this order. */
export const SEVERITY_ORDER = ['critical', 'serious', 'moderate', 'minor'] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

export const AUDIT_PHASES = ['baseline', 'final'] as const;
export type AuditPhase = (typeof AUDIT_PHASES)[number];

/**
 * What the run can say about one criterion once every lane has reported.
 *
 * This is deliberately NOT a verdict. A2.3 gives each criterion exactly one
 * verdict — `DECIDE`, `FLAG` or `BLOCKED` — and that verdict is a fixed
 * property of the criterion, decided in `lib/db/criteria.ts`. The state below
 * is the *outcome* of applying that verdict to the findings actually collected.
 */
export const CRITERION_STATES = [
  /** DECIDE, evaluated, no findings. */
  'pass',
  /** DECIDE, evaluated, at least one finding. */
  'fail',
  /** FLAG. A human signs off; the FIX agent must not touch it (A5.4). */
  'needs_review',
  /** BLOCKED. Out of reach, with a stated reason. Never reported as passing (A2.4). */
  'blocked',
  /** DECIDE, but no lane reached it on this run. Not the same as a pass. */
  'not_evaluated',
] as const;
export type CriterionState = (typeof CRITERION_STATES)[number];

export const EVIDENCE_KINDS = [
  /** An axe-core violation node. */
  'axe',
  /** An excerpt of the CDP accessibility tree. */
  'axtree',
  /** A measured DOM fact: a target box, a computed autocomplete token. */
  'dom',
  /** A document-level fact: `<html lang>`, `<title>`, the viewport meta. */
  'document',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/* -- Compile-time proof the local unions still match the ledger ------------- */

type Equivalent<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

/** Fails the build if `Severity` drifts from the ledger's `severity` enum. */
export type SeverityMatchesLedger = Expect<Equivalent<Severity, LedgerSeverity>>;
/** Fails the build if `AuditPhase` drifts from the ledger's `run_phase` enum. */
export type AuditPhaseMatchesLedger = Expect<Equivalent<AuditPhase, LedgerRunPhase>>;

/* -------------------------------------------------------------------------- */
/* Evidence (A9.1)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One artifact reference backing a finding.
 *
 * A9.1: no finding without at least one of these. A9.2: nothing large lives
 * here — `html` is truncated and screenshots are referenced by the pipeline,
 * never inlined, so an artifact never enters model context.
 */
export interface FindingEvidence {
  readonly kind: EvidenceKind;
  /** The producer: an axe rule id (`color-contrast`) or a TREE check id (`tree:page-title`). */
  readonly source: string;
  /** CSS selectors, or CDP AXNode ids when the claim is about the tree. */
  readonly targets: readonly string[];
  /** Outer HTML excerpt, truncated. Empty when the claim is document-level. */
  readonly html?: string;
  /** axe's own failure summary, verbatim, when there is one. */
  readonly failureSummary?: string;
  readonly helpUrl?: string;
  /** Measured values: contrast ratio, target size in px, the offending token. */
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One violation of one criterion on one page.
 *
 * Maps onto a row of the findings ledger. `criterion` is never blank and is
 * always one of the 55 (non-negotiable rule 3) — `validateFinding` in
 * `score.ts` is the enforcement point before anything is persisted.
 */
export interface AuditFinding {
  /**
   * Stable identity across runs: same violation, same page, same key. The A8
   * delta is a set difference over these, so a key must not embed anything
   * that changes between the baseline and the final pass (no timestamps, no
   * row ids, no ordinals).
   */
  readonly key: string;
  /** The WCAG number. Never empty. Always one of the 55. */
  readonly criterion: string;
  /** Official criterion title, denormalised so a report needs no join. */
  readonly criterionName: string;
  readonly level: CriterionLevel;
  /** Copied from the criteria table, not invented per finding. */
  readonly verdict: CriterionVerdict;
  readonly severity: Severity;
  /** The lane that claimed it. Everything `tree.ts` emits is `TREE`. */
  readonly agent: AuditAgent;
  readonly pageUrl: string;
  /** The rule that fired: `axe:color-contrast`, `tree:page-title`. */
  readonly rule: string;
  /** One sentence, in plain English. */
  readonly summary: string;
  readonly detail?: string;
  /** File and line when known. Groups the FIX pass per file (A5.2). */
  readonly sourcePath?: string;
  /** At least one. A finding with no artifact is not a finding (A9.1). */
  readonly evidence: readonly FindingEvidence[];
  /**
   * True when a later lane must confirm before this is treated as settled —
   * TREE contributing hard evidence on a criterion it does not own, for
   * example a 4.1.2 markup failure that ACT will re-check across a transition.
   */
  readonly needsConfirmation?: boolean;
}

/** A finding rejected before it reached the ledger, with the reason why. */
export interface RejectedFinding {
  readonly key: string;
  readonly criterion: string;
  readonly pageUrl: string;
  readonly reason: string;
}

/* -------------------------------------------------------------------------- */
/* Per-page result                                                            */
/* -------------------------------------------------------------------------- */

/** A criterion TREE looked at but could not settle, and why. */
export interface InconclusiveCriterion {
  readonly criterion: string;
  readonly reason: string;
}

/** Everything the deterministic gate concluded about one page. */
export interface PageAudit {
  readonly pageUrl: string;
  readonly finalUrl: string;
  readonly title: string | null;
  readonly findings: readonly AuditFinding[];
  /** Criteria TREE evaluated here and found clean. Only ever `TREE_DECIDES`. */
  readonly passed: readonly string[];
  /** Criteria TREE found at least one violation for. */
  readonly failed: readonly string[];
  /** Criteria TREE reached for but could not settle, each with a stated reason. */
  readonly inconclusive: readonly InconclusiveCriterion[];
  readonly findingsBySeverity: Readonly<Record<Severity, number>>;
  /** axe rule ids seen whose criterion could not be resolved. Feeds the map's upkeep. */
  readonly unmappedAxeRules: readonly string[];
  readonly warnings: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                    */
/* -------------------------------------------------------------------------- */

/** One of the 55 rows of the criterion matrix. */
export interface CriterionScore {
  readonly criterion: string;
  readonly name: string;
  readonly level: CriterionLevel;
  readonly principle: CriterionPrinciple;
  /** Exactly one, from the criteria table (A2.3). */
  readonly verdict: CriterionVerdict;
  readonly state: CriterionState;
  readonly findingCount: number;
  readonly worstSeverity: Severity | null;
  /** Pages this criterion failed on, deduplicated, in first-seen order. */
  readonly pages: readonly string[];
  /** Finding keys, so `computeDelta` needs nothing but two `RunScore`s. */
  readonly findingKeys: readonly string[];
  /** Owning lane. Null only for the two BLOCKED criteria. */
  readonly agent: AuditAgent | null;
  /** Stated reason for `blocked` (A2.4) and `not_evaluated`. */
  readonly reason?: string;
}

export interface BlockedCriterionReport {
  readonly criterion: string;
  readonly name: string;
  readonly reason: string;
}

/** The A2.5 score for one phase of one run. */
export interface RunScore {
  readonly phase: AuditPhase;
  /** All 55, in criteria-table order. Never a subset. */
  readonly criteria: readonly CriterionScore[];
  readonly totals: {
    readonly criteria: number;
    readonly failing: number;
    readonly passing: number;
    readonly needsReview: number;
    readonly blocked: number;
    readonly notEvaluated: number;
    readonly findings: number;
  };
  readonly failingCriteria: readonly string[];
  readonly passingCriteria: readonly string[];
  readonly needsReviewCriteria: readonly string[];
  /** The two BLOCKED criteria, always present, always with a reason (A2.4). */
  readonly blockedCriteria: readonly BlockedCriterionReport[];
  readonly notEvaluatedCriteria: readonly string[];
  readonly findingsBySeverity: Readonly<Record<Severity, number>>;
  readonly findingsByLevel: Readonly<Record<CriterionLevel, number>>;
  readonly findingsByAgent: Readonly<Partial<Record<AuditAgent, number>>>;
  readonly pagesAudited: number;
  /** Findings dropped for citing a criterion outside the 55, or for missing evidence. */
  readonly rejectedFindings: readonly RejectedFinding[];
  /**
   * Always `null`. AccessiFix does not claim a conformance level (A2.6).
   * See `NO_CONFORMANCE_CLAIM` in `score.ts` for the reason.
   */
  readonly conformanceClaim: null;
  readonly disclaimer: string;
}

/** One criterion's movement between the baseline and the final pass. */
export interface CriterionTransition {
  readonly criterion: string;
  readonly name: string;
  readonly level: CriterionLevel;
  readonly before: CriterionState;
  readonly after: CriterionState;
  readonly findingsBefore: number;
  readonly findingsAfter: number;
}

/** The A8.2 delta. Never a conformance-level change (A8.3). */
export interface ScoreDelta {
  /** Criteria that were failing at baseline and are passing now. */
  readonly criteriaFixed: readonly string[];
  /** Criteria that were passing at baseline and are failing now. */
  readonly criteriaRegressed: readonly string[];
  /** Failing in both phases. */
  readonly criteriaStillFailing: readonly string[];
  /** Every criterion whose state changed, in criteria-table order. */
  readonly transitions: readonly CriterionTransition[];
  readonly findingsResolved: number;
  readonly findingsRemaining: number;
  readonly findingsIntroduced: number;
  readonly resolvedKeys: readonly string[];
  readonly remainingKeys: readonly string[];
  readonly introducedKeys: readonly string[];
  readonly failingBefore: number;
  readonly failingAfter: number;
  readonly findingsBefore: number;
  readonly findingsAfter: number;
  /** Per-severity change in open findings. Negative means fewer than before. */
  readonly severityDelta: Readonly<Record<Severity, number>>;
  /** Always `null`. A8.3 forbids claiming a conformance-level change. */
  readonly conformanceClaim: null;
  readonly disclaimer: string;
}

/* -------------------------------------------------------------------------- */
/* Small shared helpers                                                       */
/* -------------------------------------------------------------------------- */

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
};

/** Negative when `a` is worse than `b`. Sorts worst-first. */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

/** The worst severity in a list, or null when the list is empty. */
export function worstSeverity(severities: readonly Severity[]): Severity | null {
  let worst: Severity | null = null;
  for (const s of severities) {
    if (worst === null || compareSeverity(s, worst) < 0) worst = s;
  }
  return worst;
}

/** A zeroed severity histogram. Every bucket present, so a report never has holes. */
export function emptySeverityCounts(): Record<Severity, number> {
  return { critical: 0, serious: 0, moderate: 0, minor: 0 };
}

export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITY_ORDER as readonly string[]).includes(value);
}
