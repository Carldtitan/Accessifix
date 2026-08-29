/**
 * lib/paths - types
 *
 * This layer is pure. It takes accessibility-tree snapshots that somebody else
 * captured and returns findings. It never opens a browser, never touches the
 * database, never calls a model.
 *
 * Every input shape below is declared locally rather than imported from
 * `lib/browser`, for two reasons:
 *
 *   1. `lib/browser/runner.ts` reaches into the Daytona SDK. Importing from it
 *      would drag a sandbox client into a layer that must stay pure enough to
 *      unit-test with a JSON fixture.
 *   2. This layer is owned separately from the browser layer.
 *
 * The shapes are nonetheless *structurally compatible* with the browser layer's
 * zod-derived types, deliberately and by inspection: a `PathResult` from
 * `lib/browser/types` is assignable to `TransitionResult` here, and an
 * `InteractionPath` here is assignable to the browser layer's. Optional fields
 * and `readonly` modifiers are used wherever that assignability needed help.
 * If the browser layer's schema changes, that seam breaks at compile time
 * rather than in a run.
 */

/* -------------------------------------------------------------------------- */
/* Accessibility tree (input)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The six CDP state properties captured per node.
 *
 * Values stay as strings - `'true'`, `'false'`, `'mixed'` - or `null`. `null`
 * means *the property is absent*, and that distinction is the whole product:
 * on clearway-kappa.vercel.app the "EnglishEN" control added 98 tree nodes on
 * click while `expanded` was `null` on both sides. Absent is not `'false'`.
 */
export const AX_STATE_PROPS = [
  'expanded',
  'checked',
  'selected',
  'pressed',
  'focused',
  'disabled',
] as const;

export type AxStateProp = (typeof AX_STATE_PROPS)[number];

/**
 * The four properties that make a node worth *enumerating* as a path.
 *
 * `focused` and `disabled` are excluded: every focusable node can carry
 * `focused`, and `disabled` describes availability rather than a state the
 * control is supposed to report back after an interaction.
 */
export const ENUMERABLE_STATE_PROPS = ['expanded', 'checked', 'selected', 'pressed'] as const;

export type EnumerableStateProp = (typeof ENUMERABLE_STATE_PROPS)[number];

export type AxStateProps = { readonly [K in AxStateProp]: string | null };

export interface AxNodeSnapshot {
  /** CDP AXNodeId. Unique within one `Accessibility.getFullAXTree` call. */
  readonly nodeId: string;
  /** Computed role. Case is normalised by this layer before it is matched. */
  readonly role: string | null;
  /** Computed accessible name. */
  readonly name: string | null;
  /** Chrome marks nodes assistive technology cannot reach as ignored. */
  readonly ignored?: boolean;
  readonly backendDomNodeId?: number | null;
  readonly childIds?: readonly string[];
  readonly props: AxStateProps;
  /**
   * `aria-haspopup`, when the capture layer supplies it. Optional because the
   * current browser capture does not, and this layer must degrade to role and
   * label heuristics without it rather than refuse to run.
   */
  readonly haspopup?: string | null;
}

/** The normalised tree: nodeId -> node. */
export type AxTreeSnapshot = Readonly<Record<string, AxNodeSnapshot>>;

/* -------------------------------------------------------------------------- */
/* The control's own attributes (input)                                       */
/* -------------------------------------------------------------------------- */

/**
 * What the author actually wrote on the element, read before and after.
 *
 * The accessibility tree says what assistive technology perceives. This says
 * what the source claims. A 4.1.2 finding needs both, because "the tree moved"
 * is only half the story - the other half is "and this control said nothing".
 */
export interface ElementSnapshot {
  readonly present: boolean;
  readonly tagName: string | null;
  /** The literal `role` attribute, not the computed role. */
  readonly role: string | null;
  readonly text?: string | null;
  /** `aria-expanded`, `aria-pressed`, `aria-haspopup`, `disabled`, `href`, ... */
  readonly attributes: Readonly<Record<string, string | null>>;
}

/** The active element, as described by the capture layer after an action. */
export interface FocusSnapshot {
  readonly present: boolean;
  readonly tagName: string | null;
  readonly role: string | null;
  readonly text?: string | null;
  /** True when the active element is inside a `[role=dialog]` or `<dialog>`. */
  readonly insideDialog: boolean;
  /** True when focus is on the control that opened the thing. */
  readonly isTrigger: boolean;
}

/** What the capture layer found after submitting a form empty. */
export interface FormErrorObservation {
  /** `[role=alert]`, `[aria-live=polite|assertive]` elements present. */
  readonly liveRegionCount: number;
  /** Their text content. Empty means nothing was announced. */
  readonly announcedMessages: readonly string[];
  /** `[aria-invalid=true]` plus `:invalid` matches. */
  readonly invalidCount: number;
  /** How many of those point at an explanation via `aria-describedby`. */
  readonly invalidWithDescription: number;
}

/* -------------------------------------------------------------------------- */
/* Interaction paths                                                          */
/* -------------------------------------------------------------------------- */

export type InteractionAction = 'click' | 'hover' | 'focus' | 'key';

/** The three templates of A4.5. Depth is always one (A4.6). */
export type PathTemplate = 'toggle' | 'dialog' | 'form';

/** Where the control came from. `vision` alone is already a finding. */
export type ControlSource = 'tree' | 'vision' | 'both';

/**
 * The minimum a transition result must name so its findings can be attributed.
 *
 * Deliberately loose - every field the browser layer marks optional is optional
 * here too, so a `PathResult` captured by somebody else drops straight in.
 */
export interface TransitionSubject {
  readonly id?: string;
  readonly selector: string;
  readonly label?: string;
  readonly action?: InteractionAction;
  readonly template: PathTemplate;
  readonly source?: ControlSource;
}

/**
 * One element, one action, one expected state change (the glossary definition).
 *
 * Assignable to the browser layer's `InteractionPath`, so the ACT agent can
 * hand these straight to the runner.
 */
export interface InteractionPath extends TransitionSubject {
  readonly id: string;
  readonly selector: string;
  readonly label: string;
  readonly action: InteractionAction;
  /** Only meaningful when `action` is `'key'`. */
  readonly key?: string;
  readonly template: PathTemplate;
  readonly source: ControlSource;

  /* ---- provenance, used to score the findings this path produces ---- */

  /** Computed role from the tree, or the VIS agent's guess for a vision path. */
  readonly role: string | null;
  /** State properties the control already exposes. Empty is itself a signal. */
  readonly stateProps: readonly EnumerableStateProp[];
  /** What ought to change if this control behaves. Prose, for the run view. */
  readonly expectedStateChange: string;
  /**
   * How sure the enumerator is that this selector resolves to this control,
   * 0..1. A positional `nth=` selector for a nameless icon button scores low;
   * `role=button[name="Sign in"]` scores high. Findings inherit the penalty.
   */
  readonly selectorConfidence: number;
  /** Ordering weight for the per-page cap. Higher survives. */
  readonly priority: number;
  /** Why the enumerator picked this control. Shown in the run view. */
  readonly reason: string;
}

/* -------------------------------------------------------------------------- */
/* Enumeration inputs and outputs                                             */
/* -------------------------------------------------------------------------- */

/** A control the accessibility tree exposes. */
export interface TreeControl {
  readonly nodeId: string;
  readonly role: string;
  readonly name: string;
  /** Playwright selector. `role=button[name="..."]`, or positional if unnamed. */
  readonly selector: string;
  readonly selectorConfidence: number;
  readonly stateProps: readonly EnumerableStateProp[];
  readonly haspopup: string | null;
  /** True when a `form` role sits above this node in the tree. */
  readonly inForm: boolean;
  /** Document order within the tree capture. Used as a stable tie-break. */
  readonly order: number;
  readonly reason: string;
}

/**
 * A control the VIS agent believes it can see in a screenshot.
 *
 * Exactly the shape A4.2 specifies, plus two optional fields the VIS agent may
 * supply and this layer will use if present.
 */
export interface VisionControlCandidate {
  readonly label: string;
  readonly approxSelector: string;
  /** The model's own word for it: `button`, `link`, `tab`, `icon`, ... */
  readonly looksLike: string;
  /** The model's own certainty, 0..1. Defaults to a configured value. */
  readonly confidence?: number;
  /** Optional viewport-relative box, carried through to the evidence. */
  readonly box?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

/** One vision candidate paired with the tree control it was matched against. */
export interface SourceMatch {
  readonly vision: VisionControlCandidate;
  readonly tree: TreeControl;
  /** 0..1 label similarity that justified the match. */
  readonly similarity: number;
  readonly how: 'exact-label' | 'contains' | 'fuzzy' | 'selector';
}

/** A vision candidate with no counterpart in the tree, and why we believe it. */
export interface VisionOnlyControl {
  readonly vision: VisionControlCandidate;
  /**
   * `orphan-text` - the label exists in the tree but on a node with no
   * interactive role. The strongest form: the text is rendered, the semantics
   * are not. This is a div-button.
   *
   * `absent` - the label appears nowhere in the tree. Could be a genuinely
   * hidden control, could be an icon with no text, could be the model reading a
   * label off an image. Reported, but never at DECIDE confidence on its own.
   */
  readonly kind: 'orphan-text' | 'absent';
  /** The non-interactive node carrying the label, when `kind` is `orphan-text`. */
  readonly orphanNode: AxNodeSnapshot | null;
  /** The closest tree control considered, for the evidence trail. */
  readonly nearestTreeLabel: string | null;
  readonly nearestSimilarity: number;
  readonly confidence: number;
}

/**
 * The output of `diffSources`.
 *
 * `visionOnly` is the highest-value list in the product: controls a sighted
 * user can see and operate that assistive technology is not told about.
 */
export interface SourceDiff {
  readonly matched: readonly SourceMatch[];
  readonly visionOnly: readonly VisionOnlyControl[];
  /** Tree controls no vision candidate corresponded to. Not a finding. */
  readonly treeOnly: readonly TreeControl[];
  /** One finding per entry in `visionOnly`. */
  readonly findings: readonly PathFinding[];
}

/** Everything one page's enumeration produced. */
export interface PathEnumeration {
  readonly pageUrl: string;
  readonly paths: readonly InteractionPath[];
  /** Findings that exist before any interaction runs: the vision-only controls. */
  readonly findings: readonly PathFinding[];
  readonly diff: SourceDiff;
  readonly stats: EnumerationStats;
}

export interface EnumerationStats {
  readonly treeNodes: number;
  readonly treeControls: number;
  readonly visionCandidates: number;
  readonly matched: number;
  readonly visionOnly: number;
  readonly pathsBuilt: number;
  /** Paths discarded by the per-page cap (A4.6). */
  readonly pathsDropped: number;
  readonly skippedDisabled: number;
  readonly skippedIgnored: number;
  readonly skippedUnnamed: number;
  readonly byTemplate: Readonly<Record<PathTemplate, number>>;
  /** Always 1. Stated explicitly so the cap is auditable from the output. */
  readonly depth: 1;
}

/* -------------------------------------------------------------------------- */
/* Template specs                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One step the executor should perform. This layer emits the plan; the browser
 * layer performs it. Nothing here executes.
 */
export type PathStepKind =
  | 'reload'
  | 'snapshot-tree'
  | 'read-element-state'
  | 'mark-trigger'
  | 'act'
  | 'settle'
  | 'press-key'
  | 'read-focus'
  | 'count-dialogs'
  | 'collect-form-errors'
  | 'screenshot';

export interface PathStep {
  readonly kind: PathStepKind;
  /** Human-readable, for the agent timeline. */
  readonly describe: string;
  /** Key to press when `kind` is `'press-key'`. */
  readonly key?: string;
  /**
   * Where the executor should file the result. Matches the observation keys the
   * browser layer already writes, so a spec describes what it does rather than
   * inventing a second protocol.
   */
  readonly records?: string;
}

/** Named check ids. `analyseTransition` reports against exactly these. */
export type AssertionId =
  | 'tree-changed-state-frozen'
  | 'tree-changed-no-state-attribute'
  | 'focus-moved-into-dialog'
  | 'focus-returned-on-escape'
  | 'escape-dismisses-dialog'
  | 'focus-visible-after-open'
  | 'error-in-text'
  | 'error-suggests-fix'
  | 'error-announced'
  | 'focus-moves-to-error';

export interface PathAssertion {
  readonly id: AssertionId;
  /** What passing looks like, in one sentence. */
  readonly describe: string;
  /** The criteria a failure of this assertion is reported against. */
  readonly criteria: readonly string[];
}

/** A typed plan of actions. Not the execution - that is `lib/browser`. */
export interface PathSpec {
  readonly path: InteractionPath;
  readonly template: PathTemplate;
  /** A4.6: always 1. Encoded in the type so it cannot drift. */
  readonly depth: 1;
  readonly steps: readonly PathStep[];
  readonly assertions: readonly PathAssertion[];
  /** Every criterion this path can produce a finding against. */
  readonly criteria: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Transition results (input to the analysis)                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the executor observed on both sides of one interaction.
 *
 * A browser-layer `PathResult` is assignable to this.
 */
export interface TransitionResult {
  readonly path: TransitionSubject;
  /** False when the selector missed or the action threw. Never fatal. */
  readonly ok: boolean;
  readonly error?: string | null;
  readonly treeBefore: AxTreeSnapshot;
  readonly treeAfter: AxTreeSnapshot;
  readonly stateBefore?: ElementSnapshot | null;
  readonly stateAfter?: ElementSnapshot | null;
  /** Template-specific evidence. Keys documented in `OBSERVATION_KEYS`. */
  readonly observations?: Readonly<Record<string, unknown>>;
}

/** One state property that moved between the two trees. */
export interface ChangedTreeProp {
  readonly nodeId: string;
  readonly role: string | null;
  readonly name: string | null;
  readonly prop: AxStateProp;
  readonly before: string | null;
  readonly after: string | null;
}

/** The measurement `analyseTransition` reasons over. */
export interface TreeDelta {
  readonly nodesAdded: readonly AxNodeSnapshot[];
  readonly nodesRemoved: readonly AxNodeSnapshot[];
  readonly changedProps: readonly ChangedTreeProp[];
  readonly addedCount: number;
  readonly removedCount: number;
  readonly changedCount: number;
  /** `after.size - before.size`. The headline number: +98 on Clearway. */
  readonly sizeDelta: number;
  /** Absolute movement, `added + removed`. Survives id churn better than size. */
  readonly churn: number;
  /**
   * Fraction of before-ids still present after, 0..1. CDP reassigns AXNodeIds
   * when a subtree is rebuilt, so a low value means the add/remove lists
   * overstate the real change and confidence must be docked.
   */
  readonly idStability: number;
  /** Added nodes whose role belongs to a popup surface: menu, dialog, listbox. */
  readonly popupRolesAdded: readonly string[];
  /** Added node names that read like a validation error. */
  readonly errorTextAdded: readonly string[];
  /** Added nodes carrying `alert` or `status`. Evidence for 4.1.3. */
  readonly liveRolesAdded: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

export type FindingVerdict = 'DECIDE' | 'FLAG';
export type FindingSeverity = 'critical' | 'serious' | 'moderate' | 'minor';

/** One term in the confidence arithmetic, kept so the score can be explained. */
export interface ConfidenceTerm {
  readonly delta: number;
  readonly because: string;
}

/**
 * One violation of one criterion, observed across one state transition.
 *
 * Maps onto the `findings` ledger row: `criterion`, `level`, `verdict`,
 * `severity`, `agent`, `summary`, `detail`. The application persists it; this
 * layer never touches the database (A13.6).
 */
export interface PathFinding {
  /** One of the 55. Validated against `lib/db/criteria` before construction. */
  readonly criterion: string;
  readonly level: 'A' | 'AA';
  readonly verdict: FindingVerdict;
  readonly severity: FindingSeverity;
  /** The lane that claimed it. Always `ACT` from this layer. */
  readonly agent: 'ACT';
  /** 0..1. Below `decideThreshold` the verdict is forced to `FLAG`. */
  readonly confidence: number;
  /** The check that failed, so a finding can be traced back to a rule. */
  readonly assertion: AssertionId | 'vision-only-control';
  readonly pageUrl: string | null;
  readonly pathId: string | null;
  readonly selector: string;
  readonly label: string;
  readonly template: PathTemplate | null;
  readonly source: ControlSource;
  /** One sentence. Goes in `findings.summary`. */
  readonly summary: string;
  /**
   * Exactly what was observed, in prose a human can check against the evidence.
   * Goes in `findings.detail`. Never a restatement of the criterion.
   */
  readonly detail: string;
  /** The arithmetic behind `confidence`, term by term. */
  readonly confidenceTerms: readonly ConfidenceTerm[];
  /** The numbers themselves, for the before/after tree view of A9.3. */
  readonly evidence: Readonly<Record<string, unknown>>;
}
