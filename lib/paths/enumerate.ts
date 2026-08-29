/**
 * lib/paths/enumerate - interaction path enumeration from two sources (A4.1).
 *
 * Two lists are built for every page:
 *
 *   1. From the accessibility tree - every node whose role implies a state,
 *      plus anything carrying `aria-expanded`, `aria-checked`, `aria-selected`
 *      or `aria-pressed`. This is what assistive technology can reach.
 *   2. From vision - the controls the VIS agent named in a screenshot. This is
 *      what a sighted user can reach.
 *
 * `diffSources` subtracts the first from the second. What survives is the set
 * of controls a sighted user can operate and a screen reader user cannot: the
 * div-button. Each one is a finding before any interaction has been run
 * (A4.2), and that is the highest-value output in this file.
 *
 * The layer is pure. It reads a tree snapshot and a list of vision candidates
 * and returns paths and findings. It opens nothing.
 *
 * Depth is one (A4.6). Paths are capped per page (`MAX_PATHS_PER_PAGE`) after
 * a priority sort, so that when the cap bites it discards navigation links
 * rather than the disclosure control that was the point of the run.
 */

import {
  DEFAULT_ANALYSIS_CONFIG,
  labelSimilarity,
  makeFinding,
  normaliseLabel,
  resolveConfig,
  type AnalysisConfig,
  type AnalysisConfigInput,
} from './diff';
import { chooseTemplate, expectedStateChange, INTERACTION_DEPTH } from './templates';
import {
  ENUMERABLE_STATE_PROPS,
  type AxNodeSnapshot,
  type AxTreeSnapshot,
  type ControlSource,
  type EnumerableStateProp,
  type EnumerationStats,
  type InteractionPath,
  type PathEnumeration,
  type PathFinding,
  type PathTemplate,
  type SourceDiff,
  type SourceMatch,
  type TreeControl,
  type VisionControlCandidate,
  type VisionOnlyControl,
} from './types';

/* ========================================================================== */
/* Tunables - every threshold in this file lives here                         */
/* ========================================================================== */

/**
 * A4.6. Hard cap on paths per page.
 *
 * Forty is roughly one browser sandbox for ninety seconds at a two-second
 * settle, which is the unit of work the sandbox budget is planned around. The
 * cap is applied after the priority sort, so raising it buys more low-value
 * probes and never rescues a high-value one that was dropped.
 */
export const MAX_PATHS_PER_PAGE = 40;

/**
 * Ordering weights. Higher survives the cap. The gaps are wide on purpose:
 * these are bands, not a continuum, and nothing should tip a vision-only
 * control below an expandable one.
 */
export const PATH_PRIORITY = {
  /** A control assistive technology cannot see. Nothing outranks this. */
  visionOnly: 100,
  /** `aria-haspopup` - the author told us it opens something. */
  hasPopup: 80,
  /** Already carries `aria-expanded`. The clean before/after comparison. */
  expandable: 70,
  /** A submit-shaped control inside a form. Pays for three criteria at once. */
  formSubmit: 60,
  /** checkbox, radio, switch, tab, option - a state the control must report. */
  statefulControl: 50,
  /** menuitem, treeitem - usually inside something already probed. */
  menuItem: 30,
  /** A plain button with no declared state. Common, and often the culprit. */
  button: 25,
  /** A link that declared a popup. Plain links are not enumerated at all. */
  linkWithPopup: 20,
} as const;

/**
 * Roles whose semantics include a state the control is obliged to report.
 * `textbox` and `searchbox` are absent deliberately: they carry a *value*, not
 * a state, and clicking one produces nothing worth diffing.
 */
export const STATE_IMPLYING_ROLES: ReadonlySet<string> = new Set([
  'button',
  'togglebutton',
  'popupbutton',
  'menubutton',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'option',
  'combobox',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
  'disclosuretriangle',
  'details',
  'summary',
]);

/**
 * Roles that count as "assistive technology can operate this".
 *
 * Used only by the orphan-text test in `diffSources`: if a vision label lands
 * on a tree node whose role is not in this set, the text is rendered but the
 * semantics are not, and that is a div-button.
 */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  ...STATE_IMPLYING_ROLES,
  'link',
  'textbox',
  'searchbox',
  'slider',
  'spinbutton',
  'scrollbar',
  'menuitem',
  'gridcell',
  'columnheader',
  'rowheader',
]);

/**
 * Plain links are NOT enumerated. Only links that declared a popup are.
 *
 * This is the single most important false-positive guard in the file. A link
 * that navigates replaces the whole accessibility tree, which reads exactly
 * like "the tree changed and the control's state attribute did not" - the
 * 4.1.2 signature. Enumerating navigation links would bury the real findings
 * under one false 4.1.2 per link on the page.
 */
export const ENUMERATE_PLAIN_LINKS = false;

/** `aria-haspopup` values that mark a link or button as opening a surface. */
export const POPUP_HASPOPUP_VALUES: ReadonlySet<string> = new Set([
  'true',
  'menu',
  'dialog',
  'listbox',
  'tree',
  'grid',
]);

/**
 * Vision candidates arrive without a stated certainty more often than not.
 * This is what they are assumed to carry, and the midpoint the certainty term
 * in the confidence score is measured against.
 */
export const DEFAULT_VISION_CONFIDENCE = 0.6;

/**
 * Dice bigram similarity at or above which a vision label and a tree control
 * name are taken to be the same control.
 *
 * 0.72 was chosen to accept "Sign in" / "Sign In", "EnglishEN" / "English EN"
 * and "Apply now" / "Apply Now >" while rejecting "Save" / "Cancel" (0.0) and
 * "Next" / "Next step" (0.63). Lowering it hides real div-buttons behind
 * coincidental matches; raising it invents them. This is the dial to turn
 * first if the vision-only list looks wrong.
 */
export const LABEL_MATCH_THRESHOLD = 0.72;

/**
 * Substring matching is only allowed once a label is this long. Below it,
 * "OK" would match "BOOKMARK" and every two-letter label would vanish into
 * some longer one.
 */
export const MIN_LABEL_CHARS_FOR_CONTAINS = 4;

/**
 * Labels longer than this get a positional selector instead of a name-based
 * one: a 200-character "name" is a mislabelled container, and matching it
 * exactly will fail in the browser.
 */
export const MAX_LABEL_CHARS = 120;

/** Selector confidence by how the selector was built. */
export const SELECTOR_CONFIDENCE = {
  /** `role=button[name="Sign in"]` - resolves or it does not. */
  namedRole: 0.95,
  /** `role=button >> nth=7` - AX order and DOM order can disagree. */
  positional: 0.4,
  /** Whatever the VIS agent guessed. It has not been resolved against the DOM. */
  visionApprox: 0.5,
} as const;

/** Words in `looksLike` that mean the label was probably read off an image. */
export const INFERRED_LABEL_HINTS: ReadonlySet<string> = new Set([
  'icon',
  'image',
  'graphic',
  'glyph',
  'avatar',
  'logo',
]);

/** Base confidence for a vision-only control, by how it was classified. */
export const VISION_ONLY_BASE_CONFIDENCE = {
  /**
   * The label is in the tree, on a node with no interactive role. The text is
   * rendered; the semantics are not. This is the strong case.
   */
  orphanText: 0.86,
  /**
   * The label is nowhere in the tree. Could be `aria-hidden`, could be an icon
   * with no text, could be the model reading a word off a picture. Never
   * reaches DECIDE on this evidence alone.
   */
  absent: 0.5,
} as const;

/* ========================================================================== */
/* Small pure helpers                                                         */
/* ========================================================================== */

/** Chrome writes roles as `StaticText`, `GenericContainer`, `button`, ... */
function normaliseRole(role: string | null | undefined): string {
  return (role ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

/*
 * `normaliseLabel` and `labelSimilarity` live in diff.ts - the module with no
 * dependency on the others - because both the source diff here and the
 * transition diff there need them. Re-exported so callers of this module do
 * not have to know that.
 */
export { labelSimilarity, normaliseLabel };

/** FNV-1a. Deterministic path ids, so a re-run correlates to the same rows. */
function stableId(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `p_${hash.toString(36)}`;
}

/** Escape a name for a Playwright `role=` selector's quoted attribute. */
function escapeSelectorName(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The state properties this node actually exposes. Empty is itself a signal. */
function exposedStateProps(node: AxNodeSnapshot): EnumerableStateProp[] {
  return ENUMERABLE_STATE_PROPS.filter((prop) => node.props[prop] !== null);
}

/* ========================================================================== */
/* Source 1: the accessibility tree                                           */
/* ========================================================================== */

export interface TreeEnumerationOptions {
  /**
   * Include controls with no accessible name, addressed positionally.
   * Default true: a nameless icon button is exactly the kind of control this
   * product exists to catch. They carry `SELECTOR_CONFIDENCE.positional`, and
   * every finding they produce inherits that penalty.
   */
  readonly includeUnnamed?: boolean;
}

export interface TreeEnumerationResult {
  readonly controls: readonly TreeControl[];
  readonly skippedDisabled: number;
  readonly skippedIgnored: number;
  readonly skippedUnnamed: number;
  readonly nodeCount: number;
}

/** Build `nodeId -> parentId` so form ancestry can be resolved. */
function parentMap(tree: AxTreeSnapshot): Map<string, string> {
  const parents = new Map<string, string>();
  for (const [id, node] of Object.entries(tree)) {
    for (const child of node.childIds ?? []) {
      if (!parents.has(child)) parents.set(child, id);
    }
  }
  return parents;
}

/** Walk up looking for a `form`. Depth-capped: AX trees can contain cycles. */
function hasFormAncestor(
  tree: AxTreeSnapshot,
  parents: Map<string, string>,
  nodeId: string,
): boolean {
  let current = parents.get(nodeId);
  for (let depth = 0; depth < 64 && current !== undefined; depth += 1) {
    const node = tree[current];
    if (!node) return false;
    const role = normaliseRole(node.role);
    if (role === 'form' || role === 'search') return true;
    current = parents.get(current);
  }
  return false;
}

/**
 * Every control the accessibility tree exposes that is worth interacting with.
 *
 * Inclusion rules, in order:
 *   - the node carries `aria-expanded`, `aria-checked`, `aria-selected` or
 *     `aria-pressed` - always enumerated, whatever its role;
 *   - or its role is in `STATE_IMPLYING_ROLES`;
 *   - or it is a link that declared `aria-haspopup`.
 *
 * Exclusion rules:
 *   - `ignored` nodes: assistive technology cannot reach them, so there is no
 *     path to drive;
 *   - `disabled` controls: nothing to actuate;
 *   - plain links: see `ENUMERATE_PLAIN_LINKS`.
 */
export function enumerateFromTree(
  tree: AxTreeSnapshot,
  options: TreeEnumerationOptions = {},
): TreeEnumerationResult {
  const includeUnnamed = options.includeUnnamed ?? true;
  const parents = parentMap(tree);

  const controls: TreeControl[] = [];
  const roleCounters = new Map<string, number>();
  let skippedDisabled = 0;
  let skippedIgnored = 0;
  let skippedUnnamed = 0;
  let order = 0;

  for (const [nodeId, node] of Object.entries(tree)) {
    const role = normaliseRole(node.role);
    if (role === '' || role === 'rootwebarea') continue;

    /*
     * Positional index is counted over every node of this role that we walked,
     * before any filtering, so the `nth=` it produces lines up with the DOM
     * ordering the browser will see as closely as an AX walk can.
     */
    const positional = roleCounters.get(role) ?? 0;
    roleCounters.set(role, positional + 1);

    const stateProps = exposedStateProps(node);
    const haspopup = (node.haspopup ?? null) === null ? null : String(node.haspopup);
    const popupish = haspopup !== null && POPUP_HASPOPUP_VALUES.has(haspopup.toLowerCase());

    let reason: string;
    if (stateProps.length > 0) {
      reason = `carries aria-${stateProps.join(', aria-')}`;
    } else if (STATE_IMPLYING_ROLES.has(role)) {
      reason = `role "${role}" implies a state`;
    } else if (role === 'link' && popupish) {
      reason = `link declaring aria-haspopup="${haspopup ?? ''}"`;
    } else if (role === 'link' && ENUMERATE_PLAIN_LINKS) {
      reason = 'link';
    } else {
      continue;
    }

    if (node.ignored === true) {
      skippedIgnored += 1;
      continue;
    }
    if (node.props.disabled === 'true') {
      skippedDisabled += 1;
      continue;
    }

    const name = collapse(node.name ?? '');
    const named = name.length > 0 && name.length <= MAX_LABEL_CHARS;
    if (!named && !includeUnnamed) {
      skippedUnnamed += 1;
      continue;
    }
    if (!named) skippedUnnamed += 1;

    const selector = named
      ? `role=${role}[name="${escapeSelectorName(name)}"]`
      : `role=${role} >> nth=${positional}`;

    controls.push({
      nodeId,
      role,
      name,
      selector,
      selectorConfidence: named
        ? SELECTOR_CONFIDENCE.namedRole
        : SELECTOR_CONFIDENCE.positional,
      stateProps,
      haspopup,
      inForm: hasFormAncestor(tree, parents, nodeId),
      order: order++,
      reason,
    });
  }

  return {
    controls,
    skippedDisabled,
    skippedIgnored,
    skippedUnnamed,
    nodeCount: Object.keys(tree).length,
  };
}

/* ========================================================================== */
/* Source 2: vision                                                           */
/* ========================================================================== */

/**
 * Normalise what the VIS agent returned: drop unlabelled and duplicate
 * candidates, clamp the model's certainty, trim the strings.
 *
 * Nothing here judges the candidate. That happens in `diffSources`.
 */
export function enumerateFromVision(
  candidates: readonly VisionControlCandidate[],
): readonly VisionControlCandidate[] {
  const seen = new Set<string>();
  const out: VisionControlCandidate[] = [];

  for (const candidate of candidates) {
    const label = collapse(candidate.label ?? '');
    const approxSelector = collapse(candidate.approxSelector ?? '');
    if (label.length === 0 && approxSelector.length === 0) continue;

    const key = `${normaliseLabel(label)}|${approxSelector}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      label,
      approxSelector,
      looksLike: collapse(candidate.looksLike ?? '').toLowerCase(),
      confidence:
        typeof candidate.confidence === 'number' && Number.isFinite(candidate.confidence)
          ? Math.min(1, Math.max(0, candidate.confidence))
          : DEFAULT_VISION_CONFIDENCE,
      ...(candidate.box ? { box: candidate.box } : {}),
    });
  }

  return out;
}

/** Map the VIS agent's word for a control onto an ARIA role, when it maps. */
function roleFromLooksLike(looksLike: string): string | null {
  const text = looksLike.toLowerCase();
  if (text.includes('checkbox')) return 'checkbox';
  if (text.includes('switch') || text.includes('toggle')) return 'switch';
  if (text.includes('radio')) return 'radio';
  if (text.includes('tab')) return 'tab';
  if (text.includes('menu')) return 'menuitem';
  if (text.includes('dropdown') || text.includes('select') || text.includes('combo')) {
    return 'combobox';
  }
  if (text.includes('button')) return 'button';
  if (text.includes('link')) return 'link';
  if (text.includes('field') || text.includes('input') || text.includes('textbox')) {
    return 'textbox';
  }
  return null;
}

/* ========================================================================== */
/* The diff - the highest-value output in this file (A4.2)                    */
/* ========================================================================== */

interface NearestMatch {
  readonly control: TreeControl | null;
  readonly similarity: number;
  readonly how: SourceMatch['how'];
}

function nearestTreeControl(
  candidate: VisionControlCandidate,
  controls: readonly TreeControl[],
): NearestMatch {
  const label = normaliseLabel(candidate.label);
  let best: TreeControl | null = null;
  let bestScore = 0;
  let bestHow: SourceMatch['how'] = 'fuzzy';

  for (const control of controls) {
    if (candidate.approxSelector.length > 0 && candidate.approxSelector === control.selector) {
      return { control, similarity: 1, how: 'selector' };
    }

    const name = normaliseLabel(control.name);
    if (name.length === 0) continue;

    if (name === label) return { control, similarity: 1, how: 'exact-label' };

    const longEnough =
      label.length >= MIN_LABEL_CHARS_FOR_CONTAINS && name.length >= MIN_LABEL_CHARS_FOR_CONTAINS;
    if (longEnough && (name.includes(label) || label.includes(name))) {
      const score = Math.max(LABEL_MATCH_THRESHOLD, labelSimilarity(label, name));
      if (score > bestScore) {
        best = control;
        bestScore = score;
        bestHow = 'contains';
      }
      continue;
    }

    const score = labelSimilarity(label, name);
    if (score > bestScore) {
      best = control;
      bestScore = score;
      bestHow = 'fuzzy';
    }
  }

  return { control: best, similarity: bestScore, how: bestHow };
}

/**
 * A node that carries the label but is not interactive.
 *
 * Finding one turns "vision saw something the tree did not" into "the text is
 * in the tree, with no role on it" - which is a far stronger claim, and the
 * difference between DECIDE and FLAG.
 */
function findOrphanTextNode(
  tree: AxTreeSnapshot,
  label: string,
): AxNodeSnapshot | null {
  const target = normaliseLabel(label);
  if (target.length === 0) return null;

  let fallback: AxNodeSnapshot | null = null;

  for (const node of Object.values(tree)) {
    const role = normaliseRole(node.role);
    if (INTERACTIVE_ROLES.has(role)) continue;

    const name = normaliseLabel(collapse(node.name ?? ''));
    if (name.length === 0) continue;

    if (name === target) return node;
    if (
      fallback === null &&
      target.length >= MIN_LABEL_CHARS_FOR_CONTAINS &&
      name.length >= MIN_LABEL_CHARS_FOR_CONTAINS &&
      (name.includes(target) || target.includes(name))
    ) {
      fallback = node;
    }
  }

  return fallback;
}

export interface DiffSourcesOptions {
  readonly pageUrl?: string;
  readonly config?: AnalysisConfigInput;
  /**
   * The tree, used to tell an orphan-text div-button from a label that appears
   * nowhere at all. Optional - without it every vision-only control is
   * classified `absent` and none of them can reach DECIDE.
   */
  readonly tree?: AxTreeSnapshot;
}

/**
 * Subtract the tree's controls from vision's, and turn the remainder into
 * findings (A4.2).
 *
 * Confidence, term by term:
 *
 *   base            0.86 orphan-text | 0.50 absent
 *   vision certainty  (stated - 0.6) x 0.4        - the model's own hedge
 *   near miss         -0.15 when the closest tree control scored within 0.12
 *                     of the match threshold - probably the same control under
 *                     a different accessible name
 *   short label       -0.20 below three characters
 *   inferred label    -0.12 when `looksLike` says icon or image
 *   leaf text node    +0.04 when the orphan node is a bare StaticText
 */
export function diffSources(
  treeControls: readonly TreeControl[],
  visionControls: readonly VisionControlCandidate[],
  options: DiffSourcesOptions = {},
): SourceDiff {
  const config = resolveConfig(options.config);
  const pageUrl = options.pageUrl ?? null;

  const matched: SourceMatch[] = [];
  const visionOnly: VisionOnlyControl[] = [];
  const findings: PathFinding[] = [];
  const matchedTreeIds = new Set<string>();

  for (const candidate of visionControls) {
    const nearest = nearestTreeControl(candidate, treeControls);

    if (nearest.control !== null && nearest.similarity >= LABEL_MATCH_THRESHOLD) {
      matched.push({
        vision: candidate,
        tree: nearest.control,
        similarity: nearest.similarity,
        how: nearest.how,
      });
      matchedTreeIds.add(nearest.control.nodeId);
      continue;
    }

    const orphan = options.tree ? findOrphanTextNode(options.tree, candidate.label) : null;
    const kind: VisionOnlyControl['kind'] = orphan ? 'orphan-text' : 'absent';

    const terms: { delta: number; because: string }[] = [];
    const base =
      kind === 'orphan-text'
        ? VISION_ONLY_BASE_CONFIDENCE.orphanText
        : VISION_ONLY_BASE_CONFIDENCE.absent;

    const stated = candidate.confidence ?? DEFAULT_VISION_CONFIDENCE;
    if (Math.abs(stated - DEFAULT_VISION_CONFIDENCE) > 0.01) {
      terms.push({
        delta: (stated - DEFAULT_VISION_CONFIDENCE) * 0.4,
        because: `the vision agent stated its own certainty at ${stated.toFixed(2)}`,
      });
    }

    if (nearest.control !== null && nearest.similarity >= LABEL_MATCH_THRESHOLD - 0.12) {
      terms.push({
        delta: -0.15,
        because: `the tree control "${nearest.control.name}" scored ${nearest.similarity.toFixed(2)}, just under the ${LABEL_MATCH_THRESHOLD} match threshold - this may be the same control under a different accessible name`,
      });
    }

    const normalised = normaliseLabel(candidate.label);
    if (normalised.length < 3) {
      terms.push({
        delta: -0.2,
        because: `the label "${candidate.label}" is too short to match reliably`,
      });
    }

    const looksLikeWords = candidate.looksLike.split(/\s+/);
    if (looksLikeWords.some((word) => INFERRED_LABEL_HINTS.has(word))) {
      terms.push({
        delta: -0.12,
        because: `the vision agent described it as "${candidate.looksLike}", so the label may have been read off an image rather than text`,
      });
    }

    if (orphan && (orphan.childIds ?? []).length === 0) {
      terms.push({
        delta: 0.04,
        because: 'the node carrying the label is a leaf text node, not a container',
      });
    }

    const confidence = clamp(base + terms.reduce((sum, term) => sum + term.delta, 0));

    const entry: VisionOnlyControl = {
      vision: candidate,
      kind,
      orphanNode: orphan,
      nearestTreeLabel: nearest.control?.name ?? null,
      nearestSimilarity: nearest.similarity,
      confidence,
    };
    visionOnly.push(entry);

    if (confidence < config.minReportConfidence) continue;

    findings.push(
      makeFinding({
        criterion: '4.1.2',
        assertion: 'vision-only-control',
        confidence,
        confidenceTerms: [{ delta: base, because: baseReason(kind) }, ...terms],
        config,
        pageUrl,
        pathId: null,
        selector: candidate.approxSelector,
        label: candidate.label,
        template: null,
        source: 'vision',
        severity: 'serious',
        summary: `Vision identified a control labelled "${candidate.label}" that the accessibility tree does not expose as interactive.`,
        detail: visionOnlyDetail(entry),
        evidence: {
          visionLabel: candidate.label,
          visionLooksLike: candidate.looksLike,
          visionApproxSelector: candidate.approxSelector,
          visionStatedConfidence: stated,
          classification: kind,
          orphanNodeRole: orphan?.role ?? null,
          orphanNodeId: orphan?.nodeId ?? null,
          nearestTreeControl: nearest.control?.name ?? null,
          nearestSimilarity: Number(nearest.similarity.toFixed(3)),
          matchThreshold: LABEL_MATCH_THRESHOLD,
          ...(candidate.box ? { box: candidate.box } : {}),
        },
      }),
    );
  }

  return {
    matched,
    visionOnly,
    treeOnly: treeControls.filter((control) => !matchedTreeIds.has(control.nodeId)),
    findings,
  };
}

function baseReason(kind: VisionOnlyControl['kind']): string {
  return kind === 'orphan-text'
    ? 'the label is present in the accessibility tree on a node with no interactive role'
    : 'the label does not appear in the accessibility tree at all';
}

function visionOnlyDetail(entry: VisionOnlyControl): string {
  const { vision } = entry;
  const parts: string[] = [];

  parts.push(
    `The vision pass identified "${vision.label}" in the screenshot and described it as ${vision.looksLike || 'interactive'}.`,
  );

  if (entry.kind === 'orphan-text' && entry.orphanNode) {
    parts.push(
      `The accessibility tree contains that text on node ${entry.orphanNode.nodeId} with role "${entry.orphanNode.role ?? 'none'}", which assistive technology cannot operate. No node with an interactive role carries this name.`,
    );
    parts.push(
      'A screen reader user is read the words and given no way to activate them. A keyboard user cannot reach the control by tabbing.',
    );
  } else {
    parts.push(
      'No node in the accessibility tree carries this name, interactive or otherwise. The control may be hidden from assistive technology entirely, or the label may have been rendered as an image.',
    );
  }

  if (entry.nearestTreeLabel !== null) {
    parts.push(
      `The closest accessible name in the tree is "${entry.nearestTreeLabel}", scoring ${entry.nearestSimilarity.toFixed(2)} against a match threshold of ${LABEL_MATCH_THRESHOLD}.`,
    );
  }

  return parts.join(' ');
}

function clamp(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/* ========================================================================== */
/* Path construction                                                          */
/* ========================================================================== */

function priorityFor(control: TreeControl, template: PathTemplate): number {
  if (control.haspopup !== null && POPUP_HASPOPUP_VALUES.has(control.haspopup.toLowerCase())) {
    return control.role === 'link' ? PATH_PRIORITY.linkWithPopup : PATH_PRIORITY.hasPopup;
  }
  if (control.stateProps.includes('expanded')) return PATH_PRIORITY.expandable;
  if (template === 'form') return PATH_PRIORITY.formSubmit;
  if (control.stateProps.length > 0) return PATH_PRIORITY.statefulControl;
  if (STATE_IMPLYING_ROLES.has(control.role) && control.role !== 'button') {
    return control.role === 'menuitem' || control.role === 'treeitem'
      ? PATH_PRIORITY.menuItem
      : PATH_PRIORITY.statefulControl;
  }
  if (control.role === 'link') return PATH_PRIORITY.linkWithPopup;
  return PATH_PRIORITY.button;
}

function pathFromTreeControl(control: TreeControl, source: ControlSource): InteractionPath {
  const template = chooseTemplate({
    role: control.role,
    name: control.name,
    haspopup: control.haspopup,
    inForm: control.inForm,
  });

  return {
    id: stableId(`${control.selector}|click|${template}`),
    selector: control.selector,
    label: control.name.length > 0 ? control.name : `<unnamed ${control.role}>`,
    action: 'click',
    template,
    source,
    role: control.role,
    stateProps: control.stateProps,
    expectedStateChange: expectedStateChange(template, control.stateProps),
    selectorConfidence: control.selectorConfidence,
    priority: priorityFor(control, template),
    reason: control.reason,
  };
}

function pathFromVisionOnly(entry: VisionOnlyControl): InteractionPath | null {
  const selector = entry.vision.approxSelector;
  if (selector.length === 0) return null;

  const role = roleFromLooksLike(entry.vision.looksLike);
  const template = chooseTemplate({ role, name: entry.vision.label });

  return {
    id: stableId(`${selector}|click|${template}`),
    selector,
    label: entry.vision.label,
    action: 'click',
    template,
    source: 'vision',
    role,
    stateProps: [],
    expectedStateChange: expectedStateChange(template, []),
    selectorConfidence: SELECTOR_CONFIDENCE.visionApprox,
    priority: PATH_PRIORITY.visionOnly,
    reason:
      entry.kind === 'orphan-text'
        ? 'vision saw it, the tree carries the text with no interactive role'
        : 'vision saw it, the tree does not contain it',
  };
}

export interface BuildPathsOptions {
  /** Defaults to `MAX_PATHS_PER_PAGE`. Lower it to fit a tighter budget. */
  readonly maxPaths?: number;
}

export interface BuiltPaths {
  readonly paths: readonly InteractionPath[];
  readonly dropped: number;
}

/**
 * Turn controls into paths, deduplicate, sort by value, and apply the cap.
 *
 * The sort is what makes the cap safe: when a page has 300 controls and the
 * budget is 40, what survives is every vision-only control, then everything
 * that declared a popup, then everything carrying `aria-expanded`, then form
 * submits - and the plain buttons are what gets cut.
 */
export function buildPaths(
  treeControls: readonly TreeControl[],
  visionOnly: readonly VisionOnlyControl[],
  matchedTreeIds: ReadonlySet<string> = new Set<string>(),
  options: BuildPathsOptions = {},
): BuiltPaths {
  const maxPaths = Math.max(0, options.maxPaths ?? MAX_PATHS_PER_PAGE);
  const bySelector = new Map<string, InteractionPath>();
  const orderOf = new Map<string, number>();
  let sequence = 0;

  const consider = (path: InteractionPath | null): void => {
    if (path === null) return;
    const existing = bySelector.get(path.selector);
    if (existing !== undefined && existing.priority >= path.priority) return;
    if (existing === undefined) orderOf.set(path.selector, sequence++);
    bySelector.set(path.selector, path);
  };

  for (const entry of visionOnly) consider(pathFromVisionOnly(entry));
  for (const control of treeControls) {
    consider(pathFromTreeControl(control, matchedTreeIds.has(control.nodeId) ? 'both' : 'tree'));
  }

  const all = [...bySelector.values()].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return (orderOf.get(a.selector) ?? 0) - (orderOf.get(b.selector) ?? 0);
  });

  return { paths: all.slice(0, maxPaths), dropped: Math.max(0, all.length - maxPaths) };
}

/* ========================================================================== */
/* Entry point                                                                */
/* ========================================================================== */

export interface EnumerateInput {
  readonly pageUrl: string;
  /** The accessibility tree captured for this page, before any interaction. */
  readonly tree: AxTreeSnapshot;
  /** What the VIS agent identified in the screenshot. Optional. */
  readonly visionCandidates?: readonly VisionControlCandidate[];
  readonly maxPaths?: number;
  readonly includeUnnamed?: boolean;
  readonly config?: AnalysisConfigInput;
}

/**
 * Enumerate one page: both sources, the diff between them, and the capped,
 * prioritised path list.
 *
 * The `findings` on the result exist *before any interaction has run*. They are
 * the div-buttons. Everything else in the pipeline has to earn its findings by
 * driving the interface; these were free.
 */
export function enumeratePaths(input: EnumerateInput): PathEnumeration {
  const config: AnalysisConfig = resolveConfig(input.config);

  const tree = enumerateFromTree(input.tree, { includeUnnamed: input.includeUnnamed });
  const vision = enumerateFromVision(input.visionCandidates ?? []);

  const diff = diffSources(tree.controls, vision, {
    pageUrl: input.pageUrl,
    tree: input.tree,
    config,
  });

  const matchedTreeIds = new Set(diff.matched.map((match) => match.tree.nodeId));
  const built = buildPaths(tree.controls, diff.visionOnly, matchedTreeIds, {
    maxPaths: input.maxPaths,
  });

  const byTemplate: Record<PathTemplate, number> = { toggle: 0, dialog: 0, form: 0 };
  for (const path of built.paths) byTemplate[path.template] += 1;

  const stats: EnumerationStats = {
    treeNodes: tree.nodeCount,
    treeControls: tree.controls.length,
    visionCandidates: vision.length,
    matched: diff.matched.length,
    visionOnly: diff.visionOnly.length,
    pathsBuilt: built.paths.length,
    pathsDropped: built.dropped,
    skippedDisabled: tree.skippedDisabled,
    skippedIgnored: tree.skippedIgnored,
    skippedUnnamed: tree.skippedUnnamed,
    byTemplate,
    depth: INTERACTION_DEPTH,
  };

  return {
    pageUrl: input.pageUrl,
    paths: built.paths,
    findings: diff.findings,
    diff,
    stats,
  };
}

export { DEFAULT_ANALYSIS_CONFIG };
