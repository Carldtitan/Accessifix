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
import { enumeratePaths, normaliseLabel, INTERACTIVE_ROLES } from './enumerate';
import type {
  AxTreeSnapshot,
  EnumerationStats,
  FindingVerdict,
  InteractionPath,
  PathFinding,
  VisionControlCandidate,
  VisionOnlyControl,
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

/* -------------------------------------------------------------------------- */
/* Vision-only verdict ceiling                                                */
/* -------------------------------------------------------------------------- */

/**
 * The highest verdict a vision-only control may carry, by classification.
 *
 * `orphan-text` is the strong case and earns `DECIDE`: the label is in the
 * accessibility tree, sitting on a node with no interactive role. The words are
 * rendered, the semantics are not, and both halves of that claim were read out
 * of the page. That is a div-button, and it can be stated as one.
 *
 * `absent` caps at `FLAG`, always. The label appears nowhere in the tree - so
 * the *only* evidence for the control existing at all is that a model said it
 * saw one. That is true of a genuinely hidden control and equally true of a
 * model naming an icon it inferred, which is the single largest false-positive
 * risk in this feature. A claim resting entirely on a model's word goes to a
 * human, however confident the arithmetic came out.
 *
 * `diffSources` already keeps `absent` under `decideThreshold` by arithmetic:
 * base 0.50 plus at most +0.16 of stated certainty is 0.66 against a threshold
 * of 0.75. That is a property of today's numbers, not a guarantee - a retuned
 * base, a lowered threshold or a new positive term would silently break it and
 * the tests would still pass. This table is the guarantee, applied after the
 * scoring and independent of it.
 */
export const VISION_ONLY_MAX_VERDICT: Readonly<
  Record<VisionOnlyControl['kind'], FindingVerdict>
> = {
  'orphan-text': 'DECIDE',
  absent: 'FLAG',
};

/* -------------------------------------------------------------------------- */
/* Controls the tree exposes but does not enumerate                           */
/* -------------------------------------------------------------------------- */

/**
 * Accessible names carried by a node the tree exposes as interactive.
 *
 * `diffSources` subtracts vision's list from the *enumerated* tree controls,
 * and enumeration is narrower than the tree on purpose. It drops:
 *
 *   - disabled controls, which cannot be actuated, so there is no transition
 *     to diff;
 *   - roles that carry a value rather than a state - `textbox`, `searchbox`,
 *     `slider` - because clicking one produces nothing worth comparing.
 *
 * Both exclusions are right for building paths and wrong for subtracting
 * sources. A disabled button is still announced to a screen reader. So is a
 * textbox. Vision sees them, they are absent from the enumerated list, and
 * without this they are reported as controls assistive technology cannot
 * reach - which is the opposite of true.
 *
 * Measured on Clearway's application view, this was the whole of the
 * false-positive rate: `Documents` and `Records` (both `button`,
 * `disabled=true`) and `Your answer` (`textbox`) each produced a DECIDE-level
 * 4.1.2 claim against a page that exposes all three correctly.
 *
 * Matching is exact on the normalised label, never fuzzy. Fuzzy matching
 * against the whole tree would start swallowing real div-buttons that happen to
 * read like something else on the page; `diffSources` already does the fuzzy
 * work against the enumerated controls, and this only has to close the gap
 * between "enumerated" and "exposed".
 */
function interactiveNamesInTree(tree: AxTreeSnapshot): ReadonlySet<string> {
  const names = new Set<string>();

  for (const node of Object.values(tree)) {
    if (node.ignored === true) continue;
    const role = (node.role ?? '').toLowerCase().replace(/[^a-z]/g, '');
    if (!INTERACTIVE_ROLES.has(role)) continue;

    const name = normaliseLabel((node.name ?? '').replace(/\s+/g, ' ').trim());
    if (name.length > 0) names.add(name);
  }

  return names;
}

/**
 * Apply the ceiling to one finding.
 *
 * Only touches findings from the source diff (`vision-only-control`); the
 * transition assertions are scored on observed before/after evidence and are
 * not covered by this rule. The classification is read back off the evidence
 * `diffSources` recorded, so the two cannot drift apart.
 */
function capVisionOnlyVerdict(finding: PathFinding): PathFinding {
  if (finding.assertion !== 'vision-only-control') return finding;

  const classification = finding.evidence.classification;
  const kind: VisionOnlyControl['kind'] =
    classification === 'orphan-text' ? 'orphan-text' : 'absent';

  const ceiling = VISION_ONLY_MAX_VERDICT[kind];
  if (ceiling === 'DECIDE' || finding.verdict !== 'DECIDE') return finding;

  return {
    ...finding,
    verdict: ceiling,
    detail:
      `${finding.detail} Capped to FLAG: the label appears nowhere in the accessibility ` +
      `tree, so the only evidence that this control exists is the vision pass itself. ` +
      `A human confirms this one.`,
  };
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
  const tree = input.capture?.axTree ?? {};

  const enumeration = enumeratePaths({
    pageUrl: input.pageUrl,
    tree,
    visionCandidates: input.visionCandidates,
    maxPaths: input.maxPaths,
    config: input.config,
  });

  // Two policies, applied here at the seam rather than inside the scoring,
  // because both are rules about what may be *asserted* rather than terms in an
  // arithmetic. Neither can be expressed as a confidence penalty: one is a
  // ceiling on a verdict, the other is a claim that is simply not true.
  const exposed = interactiveNamesInTree(tree);
  const findings = enumeration.findings
    .filter((finding) => !treeAlreadyExposes(finding, exposed))
    .map(capVisionOnlyVerdict);

  // A path built from a retracted claim is a path ACT would spend a browser
  // sandbox driving for nothing, so the same filter applies to the path list.
  // Only vision-only paths are affected: a `both` or `tree` path was enumerated
  // from the tree in the first place and its claim was never in question.
  const dropped = new Set(
    enumeration.diff.visionOnly
      .filter((entry) => exposed.has(normaliseLabel(entry.vision.label)))
      .map((entry) => entry.vision.approxSelector),
  );
  const paths = enumeration.paths.filter(
    (path) => path.source !== 'vision' || !dropped.has(path.selector),
  );

  return {
    paths,
    findings: findings.map((finding) => ({
      criterion: finding.criterion,
      severity: finding.severity,
      summary: finding.summary,
      detail: finding.detail,
      selector: finding.selector.length > 0 ? finding.selector : null,
      pageUrl: input.pageUrl,
      verdict: finding.verdict,
    })),
    pathFindings: findings,
    stats: {
      ...enumeration.stats,
      visionOnly: enumeration.stats.visionOnly - dropped.size,
      pathsBuilt: paths.length,
      byTemplate: paths.reduce(
        (counts, path) => ({ ...counts, [path.template]: counts[path.template] + 1 }),
        { toggle: 0, dialog: 0, form: 0 },
      ),
    },
    sessionId: null,
  };
}

/**
 * True when a vision-only claim names something the tree does expose.
 *
 * Scoped to `vision-only-control`: it is the only assertion whose whole content
 * is "the tree does not have this", and so the only one this can contradict.
 */
function treeAlreadyExposes(
  finding: PathFinding,
  exposed: ReadonlySet<string>,
): boolean {
  if (finding.assertion !== 'vision-only-control') return false;
  return exposed.has(normaliseLabel(finding.label));
}
