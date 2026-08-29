/**
 * lib/paths - public surface.
 *
 * The interaction path enumeration engine. Three modules, all pure:
 *
 *   enumerate.ts  two sources - the accessibility tree and vision - and the
 *                 diff between them. What vision sees and the tree does not is
 *                 a div-button, and a finding before anything is clicked.
 *   templates.ts  Toggle, Dialog and Form as typed action specs. Depth one.
 *   diff.ts       the analysis: tree moved, did the control say so? Plus the
 *                 confidence scoring that keeps false positives out of the
 *                 FIX agent's hands.
 *
 * Nothing here drives a browser. `lib/browser` executes the specs this module
 * produces and hands the observations back to `analysePathResult`.
 */

export * from './types';

export {
  buildPaths,
  diffSources,
  enumerateFromTree,
  enumerateFromVision,
  enumeratePaths,
  labelSimilarity,
  normaliseLabel,
  DEFAULT_VISION_CONFIDENCE,
  ENUMERATE_PLAIN_LINKS,
  INTERACTIVE_ROLES,
  LABEL_MATCH_THRESHOLD,
  MAX_LABEL_CHARS,
  MAX_PATHS_PER_PAGE,
  MIN_LABEL_CHARS_FOR_CONTAINS,
  PATH_PRIORITY,
  POPUP_HASPOPUP_VALUES,
  SELECTOR_CONFIDENCE,
  STATE_IMPLYING_ROLES,
  VISION_ONLY_BASE_CONFIDENCE,
  type BuildPathsOptions,
  type BuiltPaths,
  type DiffSourcesOptions,
  type EnumerateInput,
  type TreeEnumerationOptions,
  type TreeEnumerationResult,
} from './enumerate';

export {
  ASSERTIONS,
  ASSERTIONS_BY_TEMPLATE,
  buildSpec,
  buildSpecs,
  chooseTemplate,
  dialogTemplate,
  DIALOG_HASPOPUP_VALUES,
  DIALOG_LABEL_PATTERN,
  expectedStateChange,
  formTemplate,
  INTERACTION_DEPTH,
  OBSERVATION_KEYS,
  SUBMIT_LABEL_PATTERN,
  toggleTemplate,
  type TemplateHint,
} from './templates';

export {
  analysePathResult,
  analysePathResults,
  analyseTransition,
  BASE_CONFIDENCE,
  DEFAULT_ANALYSIS_CONFIG,
  diffTreeSnapshots,
  explainConfidence,
  formatTransitionLine,
  LIVE_ROLES,
  makeFinding,
  NON_INTERACTIVE_TAGS,
  POPUP_ROLES,
  resolveConfig,
  scoreConfidence,
  SEVERITY_BY_CRITERION,
  TRACKED_STATE_ATTRIBUTES,
  treeChangeMagnitude,
  verdictForConfidence,
  type AnalyseResultContext,
  type AnalysisConfig,
  type AnalysisConfigInput,
  type MakeFindingInput,
  type ScoredConfidence,
  type TransitionContext,
  type TreeChangeMagnitude,
} from './diff';

import type { AnalysisConfigInput } from './diff';
import { enumeratePaths } from './enumerate';
import type {
  AxTreeSnapshot,
  EnumerationStats,
  InteractionPath,
  PathFinding,
  VisionControlCandidate,
} from './types';

/* -------------------------------------------------------------------------- */
/* Pipeline seam                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A finding in the shape `lib/pipeline/ledger` accepts.
 *
 * Declared structurally rather than imported so this module keeps no dependency
 * on the pipeline. It is assignable to `FindingClaim`.
 */
export interface PathFindingClaim {
  readonly criterion: string;
  readonly severity: string;
  readonly summary: string;
  readonly detail: string;
  readonly selector: string | null;
  readonly pageUrl: string;
  readonly verdict: string;
}

export interface EnumerateInteractionPathsInput {
  readonly runId?: string;
  readonly pageUrl: string;
  /**
   * The page capture. Only `axTree` is read; the rest of the capture belongs to
   * the audit lanes.
   */
  readonly capture?: { readonly axTree?: AxTreeSnapshot | null } | null;
  /**
   * What the VIS agent identified in the screenshot, when it has run.
   *
   * Optional, and its absence is not an error: with no vision list, enumeration
   * falls back to the accessibility tree alone. The tree-only run still finds
   * every stale-state 4.1.2, it just cannot find the div-buttons, because a
   * div-button is by definition what the tree does not contain.
   */
  readonly visionCandidates?: readonly VisionControlCandidate[];
  readonly maxPaths?: number;
  readonly config?: AnalysisConfigInput;
}

export interface EnumerateInteractionPathsResult {
  readonly paths: readonly InteractionPath[];
  /** Ledger-shaped, ready for `recordFindings`. */
  readonly findings: readonly PathFindingClaim[];
  /** The same findings with their full evidence, for artifact attachment (A9.1). */
  readonly pathFindings: readonly PathFinding[];
  readonly stats: EnumerationStats;
  /** No model is called here, so there is no harness session to record. */
  readonly sessionId: string | null;
}

/**
 * The pipeline's entry point into this module.
 *
 * Async only to match the orchestrator's contract - the work is synchronous and
 * pure. No artifact is attached to the claims here: the caller holds the
 * screenshot and the tree snapshot, and `pathFindings[].evidence` carries the
 * numbers each claim was derived from.
 */
export async function enumerateInteractionPaths(
  input: EnumerateInteractionPathsInput,
): Promise<EnumerateInteractionPathsResult> {
  const enumeration = enumeratePaths({
    pageUrl: input.pageUrl,
    tree: input.capture?.axTree ?? {},
    visionCandidates: input.visionCandidates,
    maxPaths: input.maxPaths,
    config: input.config,
  });

  return {
    paths: enumeration.paths,
    findings: enumeration.findings.map((finding) => ({
      criterion: finding.criterion,
      severity: finding.severity,
      summary: finding.summary,
      detail: finding.detail,
      selector: finding.selector.length > 0 ? finding.selector : null,
      pageUrl: input.pageUrl,
      verdict: finding.verdict,
    })),
    pathFindings: enumeration.findings,
    stats: enumeration.stats,
    sessionId: null,
  };
}
