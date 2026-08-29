/**
 * lib/paths/diff - the analysis (A4.3, A4.4).
 *
 * Everything here is pure. It receives two accessibility-tree snapshots, the
 * control's own attributes on both sides, and whatever the executor observed,
 * and it returns findings. It never opens a browser and never writes a row.
 *
 * ## The thesis, in one function
 *
 * `analyseTransition` asks one question the rest of the industry does not: the
 * accessibility tree moved - did the control that moved it say so?
 *
 * On clearway-kappa.vercel.app, verified 2026-08-29:
 *
 *     CLICK "EnglishEN"   aria-expanded null -> null   |   tree delta +98 nodes
 *
 * Ninety-eight nodes appeared. The control exposed no state at all, before or
 * after. A screen reader user is told nothing happened. That is WCAG 4.1.2, and
 * no single-state scanner can see it.
 *
 * ## False positives are the risk, not false negatives
 *
 * A tool that cries wolf gets switched off, and this one writes pull requests.
 * So every rule here is written to be *quiet by default*:
 *
 *   - A tree delta below `noiseNodeDelta` is not a finding. A tooltip moves one
 *     or two nodes; a menu moves ninety-eight.
 *   - Navigation suppresses the toggle rules entirely. A link that navigates
 *     replaces the whole tree, which looks exactly like the 4.1.2 signature.
 *     Detected four ways, so that suppression never depends on any one of them
 *     arriving: the caller, the executor, the URL, and a document title change
 *     alongside a rebuilt tree - the last two being what catch button-driven
 *     routing, which no `<a href>` heuristic can see.
 *   - A control only answers for what *it* changed. Every reading taken after
 *     the action has a baseline taken before it, and a dialog that was already
 *     on the page, or a live region that always said "Welcome back", belongs to
 *     nobody's interaction.
 *   - The toggle rules run only for the templates that declared them. A form
 *     submit has no state to report, so 4.1.2 is not a statement about it, and
 *     neither is it a statement about a conforming dialog trigger - the dialog
 *     pattern's contract lives on the dialog.
 *   - When the control vanished after the action, no state comparison is
 *     possible, so none is reported.
 *   - When the tree reports the state change on some other node with the same
 *     name, the state *is* being exposed and the finding is dropped.
 *   - When a template's precondition did not hold - no dialog opened, no
 *     submission was rejected - that template's assertions are skipped rather
 *     than failed.
 *   - Everything else carries a confidence with a term-by-term derivation, and
 *     anything below `decideThreshold` is `FLAG`, for a human, not `DECIDE`.
 */

import { requireCriterion } from '@/lib/db/criteria';

import { ASSERTIONS_BY_TEMPLATE, OBSERVATION_KEYS } from './templates';
import {
  AX_STATE_PROPS,
  type AssertionId,
  type AxNodeSnapshot,
  type AxTreeSnapshot,
  type ChangedTreeProp,
  type ConfidenceTerm,
  type ControlSource,
  type ElementSnapshot,
  type FindingSeverity,
  type FindingVerdict,
  type FocusSnapshot,
  type FormErrorObservation,
  type PathFinding,
  type PathTemplate,
  type TransitionResult,
  type TreeDelta,
} from './types';

/* ========================================================================== */
/* Tunables - every threshold and heuristic in this file lives here           */
/* ========================================================================== */

export interface AnalysisConfig {
  /**
   * Tree movement at or below this many nodes is noise, and produces no
   * finding at all.
   *
   * Two, because that is what a tooltip, a focus ring, a single validation
   * message or a re-rendered text node costs. The Clearway menu cost 98. The
   * gap between those two numbers is the whole reason this threshold can be
   * this blunt and still work.
   */
  readonly noiseNodeDelta: number;

  /**
   * At or above this many nodes the control clearly opened a surface rather
   * than nudging the page. Findings above this line gain confidence.
   *
   * Eight: smaller than any real menu, listbox or dialog observed, larger than
   * any incidental re-render observed.
   */
  readonly significantNodeDelta: number;

  /**
   * A change this large is unambiguous. The Clearway case is +98.
   * Adds a further confidence term on top of `significantNodeDelta`.
   */
  readonly hugeNodeDelta: number;

  /**
   * Minimum fraction of before-node-ids still present after the action for the
   * added/removed lists to be trusted.
   *
   * CDP reassigns AXNodeIds whenever a subtree is rebuilt, so a React re-render
   * can churn every id on the page while nothing meaningful changed. Below this
   * value the analysis falls back to `sizeDelta` alone and docks confidence.
   */
  readonly minIdStability: number;

  /**
   * At or above this confidence a finding is `DECIDE` and the FIX agent may act
   * on it. Below it the finding is `FLAG` and goes to the human queue (A5.3,
   * A5.4). This is the single most important number in the product: raise it
   * and the agent proposes fewer patches, lower it and it proposes wrong ones.
   */
  readonly decideThreshold: number;

  /**
   * Below this confidence nothing is emitted at all. A finding nobody would
   * act on is noise in the ledger.
   */
  readonly minReportConfidence: number;

  /**
   * Suppress the toggle rules when the action navigated the page. Leave this
   * on. A navigation replaces the entire accessibility tree, which is
   * indistinguishable from "this control changed everything and said nothing".
   */
  readonly suppressOnNavigation: boolean;

  /** Text that reads like a validation error. */
  readonly errorTextPattern: RegExp;

  /** Text that reads like it tells the user how to fix the input (3.3.3). */
  readonly suggestionPattern: RegExp;
}

export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  noiseNodeDelta: 2,
  significantNodeDelta: 8,
  hugeNodeDelta: 40,
  minIdStability: 0.6,
  decideThreshold: 0.75,
  minReportConfidence: 0.35,
  suppressOnNavigation: true,
  errorTextPattern:
    /\b(required|invalid|must|please|error|cannot|missing|too short|too long|at least|not valid|is not|enter a|select a|choose a)\b/i,
  suggestionPattern:
    /\b(must|should|enter|use|select|choose|try|format|example|e\.g\.|at least|at most|between|include|minimum|maximum|characters|digits|letters)\b/i,
};

export type AnalysisConfigInput = Partial<AnalysisConfig>;

export function resolveConfig(input?: AnalysisConfigInput): AnalysisConfig {
  if (!input) return DEFAULT_ANALYSIS_CONFIG;
  return { ...DEFAULT_ANALYSIS_CONFIG, ...input };
}

/**
 * The element attributes that constitute "this control's own state".
 *
 * `aria-current` and `open` are included because a `<details>` and a nav item
 * report state without any `aria-*` toggle attribute, and calling those 4.1.2
 * failures would be wrong.
 */
export const TRACKED_STATE_ATTRIBUTES = [
  'aria-expanded',
  'aria-checked',
  'aria-selected',
  'aria-pressed',
  'aria-current',
  'open',
] as const;

export type TrackedStateAttribute = (typeof TRACKED_STATE_ATTRIBUTES)[number];

/** Roles that only appear when a popup surface opened. Strong 4.1.2 evidence. */
export const POPUP_ROLES: ReadonlySet<string> = new Set([
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'dialog',
  'alertdialog',
  'listbox',
  'option',
  'tree',
  'treeitem',
  'tooltip',
  'tabpanel',
  'grid',
]);

/** Roles that announce without stealing focus. Their presence satisfies 4.1.3. */
export const LIVE_ROLES: ReadonlySet<string> = new Set(['alert', 'status', 'log']);

/**
 * Roles that only exist while a dialog surface is on screen.
 *
 * Counted on both sides of the interaction, so "a dialog is visible" can be
 * told apart from "this control opened one" without trusting a single
 * post-action number.
 */
export const DIALOG_ROLES: ReadonlySet<string> = new Set(['dialog', 'alertdialog']);

/**
 * Tags that are not interactive elements. A control built from one of these,
 * with no `role`, is a div-button - and that is the strongest available
 * evidence for the "no state attribute at all" rule.
 */
export const NON_INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  'div',
  'span',
  'p',
  'li',
  'td',
  'section',
  'article',
  'header',
  'footer',
  'nav',
  'label',
  'img',
  'svg',
  'i',
  'b',
  'strong',
  'em',
]);

/** Base confidences. Each is the score before any adjusting term is applied. */
export const BASE_CONFIDENCE = {
  /** The control declares a state attribute, the tree moved, the value did not. */
  stateFrozen: 0.9,
  /** No state attribute, tree moved, and the control is a div or a span. */
  noStateDivButton: 0.85,
  /** No state attribute, tree moved, and a popup role appeared. */
  noStatePopupAppeared: 0.8,
  /** No state attribute, tree moved, native element, nothing else to go on. */
  noStateAmbiguous: 0.45,
  /** A dialog opened and focus stayed outside it. */
  focusNotInDialog: 0.85,
  /** The dialog closed and focus did not come back to the trigger. */
  focusNotReturned: 0.8,
  /** Escape did not dismiss the dialog. Suggestive of a trap, not proof of one. */
  escapeDidNotDismiss: 0.55,
  /** Focus is on nothing after opening. Needs vision to confirm the ring. */
  focusOnNothing: 0.5,
  /** A submission was rejected and no error text appeared anywhere. */
  errorNotInText: 0.7,
  /** Error text exists and no live region carries it. */
  errorNotAnnounced: 0.8,
  /** Error text exists and does not say how to fix the input. Judgement call. */
  errorWithoutSuggestion: 0.5,
  /** Errors exist, nothing was announced, and focus stayed on the submit. */
  focusStayedOnSubmit: 0.55,
} as const;

/** Severity per criterion. Kept here so the ledger's severity is one decision. */
export const SEVERITY_BY_CRITERION: Readonly<Record<string, FindingSeverity>> = {
  '2.1.2': 'critical',
  '2.4.3': 'serious',
  '2.4.7': 'serious',
  '3.3.1': 'serious',
  '3.3.3': 'moderate',
  '4.1.2': 'serious',
  '4.1.3': 'moderate',
};

/* ========================================================================== */
/* Shared text comparison                                                     */
/* ========================================================================== */
/*
 * These live here rather than in enumerate.ts because both the source diff and
 * the transition diff need them, and diff.ts is the module with no dependency
 * on the others. enumerate.ts re-exports them.
 */

/**
 * Fold a label to something comparable across sources.
 *
 * NFKD, lower-case, strip to `[a-z0-9 ]`. If that empties the string - a label
 * written entirely in a non-Latin script - fall back to the trimmed lower-case
 * original so those labels still compare against each other.
 */
export function normaliseLabel(raw: string): string {
  const lowered = raw.normalize('NFKD').toLowerCase();
  const stripped = lowered.replace(/[^a-z0-9]+/g, ' ').trim();
  if (stripped.length > 0) return stripped;
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Dice coefficient over character bigrams. 1 is identical, 0 shares nothing. */
export function labelSimilarity(a: string, b: string): number {
  const left = normaliseLabel(a).replace(/\s+/g, '');
  const right = normaliseLabel(b).replace(/\s+/g, '');
  if (left.length === 0 || right.length === 0) return 0;
  if (left === right) return 1;
  if (left.length === 1 || right.length === 1) return 0;

  const bigrams = new Map<string, number>();
  for (let i = 0; i < left.length - 1; i += 1) {
    const gram = left.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }

  let hits = 0;
  for (let i = 0; i < right.length - 1; i += 1) {
    const gram = right.slice(i, i + 2);
    const remaining = bigrams.get(gram) ?? 0;
    if (remaining > 0) {
      bigrams.set(gram, remaining - 1);
      hits += 1;
    }
  }

  return (2 * hits) / (left.length - 1 + (right.length - 1));
}

/* ========================================================================== */
/* Confidence arithmetic                                                      */
/* ========================================================================== */

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export interface ScoredConfidence {
  readonly confidence: number;
  readonly terms: readonly ConfidenceTerm[];
}

/**
 * Sum a base and its adjusting terms, keeping every term so the number can be
 * explained to a human rather than asserted at them.
 */
export function scoreConfidence(
  base: number,
  baseReason: string,
  adjustments: readonly ConfidenceTerm[],
): ScoredConfidence {
  const terms: ConfidenceTerm[] = [{ delta: base, because: baseReason }, ...adjustments];
  const total = terms.reduce((sum, term) => sum + term.delta, 0);
  return { confidence: clamp(total), terms };
}

/** One line of prose covering the whole score. Goes into `findings.detail`. */
export function explainConfidence(
  confidence: number,
  terms: readonly ConfidenceTerm[],
  config: AnalysisConfig = DEFAULT_ANALYSIS_CONFIG,
): string {
  const verdict = confidence >= config.decideThreshold ? 'DECIDE' : 'FLAG';
  const parts = terms.map((term) => {
    const sign = term.delta >= 0 ? '+' : '-';
    return `${sign}${Math.abs(term.delta).toFixed(2)} ${term.because}`;
  });
  return `Confidence ${confidence.toFixed(2)} (${verdict}; threshold ${config.decideThreshold}): ${parts.join('; ')}.`;
}

export function verdictForConfidence(
  confidence: number,
  config: AnalysisConfig = DEFAULT_ANALYSIS_CONFIG,
): FindingVerdict {
  return confidence >= config.decideThreshold ? 'DECIDE' : 'FLAG';
}

/* ========================================================================== */
/* Finding factory                                                            */
/* ========================================================================== */

export interface MakeFindingInput {
  readonly criterion: string;
  readonly assertion: AssertionId | 'vision-only-control';
  readonly confidence: number;
  readonly confidenceTerms: readonly ConfidenceTerm[];
  readonly config: AnalysisConfig;
  readonly pageUrl: string | null;
  readonly pathId: string | null;
  readonly selector: string;
  readonly label: string;
  readonly template: PathTemplate | null;
  readonly source: ControlSource;
  readonly severity?: FindingSeverity;
  readonly summary: string;
  readonly detail: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

/**
 * Build one finding.
 *
 * `requireCriterion` is the gate: a criterion number this layer invented throws
 * here rather than reaching the ledger (non-negotiable rule 3, A13.6). The
 * criterion table also decides the ceiling - a criterion the table marks `FLAG`
 * can never be emitted as `DECIDE`, however confident this layer is.
 */
export function makeFinding(input: MakeFindingInput): PathFinding {
  const criterion = requireCriterion(input.criterion);
  const confidence = clamp(input.confidence);
  const scored = verdictForConfidence(confidence, input.config);
  const verdict: FindingVerdict = criterion.verdict === 'DECIDE' ? scored : 'FLAG';

  return {
    criterion: criterion.id,
    level: criterion.level,
    verdict,
    severity: input.severity ?? SEVERITY_BY_CRITERION[criterion.id] ?? 'moderate',
    agent: 'ACT',
    confidence,
    assertion: input.assertion,
    pageUrl: input.pageUrl,
    pathId: input.pathId,
    selector: input.selector,
    label: input.label,
    template: input.template,
    source: input.source,
    summary: input.summary,
    detail: `${input.detail} ${explainConfidence(confidence, input.confidenceTerms, input.config)}`,
    confidenceTerms: input.confidenceTerms,
    evidence: input.evidence,
  };
}

/* ========================================================================== */
/* Tree diffing                                                               */
/* ========================================================================== */

function normaliseRole(role: string | null | undefined): string {
  return (role ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Diff two accessibility-tree snapshots.
 *
 * Reimplemented here rather than imported from `lib/browser/runner`, which
 * pulls in the Daytona SDK; this layer stays testable from a JSON fixture. The
 * two must agree, and `sizeDelta` is the field they agree on most robustly.
 */
export function diffTreeSnapshots(
  before: AxTreeSnapshot,
  after: AxTreeSnapshot,
  config: AnalysisConfig = DEFAULT_ANALYSIS_CONFIG,
): TreeDelta {
  const beforeIds = Object.keys(before);
  const afterIds = Object.keys(after);

  const nodesAdded: AxNodeSnapshot[] = [];
  const nodesRemoved: AxNodeSnapshot[] = [];
  const changedProps: ChangedTreeProp[] = [];
  const popupRolesAdded: string[] = [];
  const errorTextAdded: string[] = [];
  const liveRolesAdded: string[] = [];
  let retained = 0;
  let dialogNodesBefore = 0;
  let dialogNodesAfter = 0;
  let documentNameBefore: string | null = null;
  let documentNameAfter: string | null = null;

  for (const id of beforeIds) {
    const node = before[id];
    if (!node) continue;
    const role = normaliseRole(node.role);
    if (DIALOG_ROLES.has(role)) dialogNodesBefore += 1;
    if (role === 'rootwebarea' && documentNameBefore === null) documentNameBefore = node.name ?? '';
  }

  for (const id of afterIds) {
    const node = after[id];
    if (!node) continue;
    const role = normaliseRole(node.role);
    if (DIALOG_ROLES.has(role)) dialogNodesAfter += 1;
    if (role === 'rootwebarea' && documentNameAfter === null) documentNameAfter = node.name ?? '';
  }

  for (const id of afterIds) {
    if (id in before) continue;
    const node = after[id];
    if (!node) continue;
    nodesAdded.push(node);

    const role = normaliseRole(node.role);
    if (POPUP_ROLES.has(role)) popupRolesAdded.push(role);
    if (LIVE_ROLES.has(role)) liveRolesAdded.push(role);

    const name = (node.name ?? '').trim();
    if (name.length > 0 && config.errorTextPattern.test(name)) errorTextAdded.push(name);
  }

  for (const id of beforeIds) {
    const previous = before[id];
    const next = after[id];
    if (!previous) continue;
    if (!next) {
      nodesRemoved.push(previous);
      continue;
    }
    retained += 1;
    for (const prop of AX_STATE_PROPS) {
      const from = previous.props[prop] ?? null;
      const to = next.props[prop] ?? null;
      if (from === to) continue;
      changedProps.push({
        nodeId: id,
        role: next.role ?? previous.role,
        name: next.name ?? previous.name,
        prop,
        before: from,
        after: to,
      });
    }

    /*
     * Validation text does not have to arrive on a new node.
     *
     * The common React form renders its error container up front and empty, and
     * fills it in on submit. The node is retained, so an added-nodes-only scan
     * sees nothing, the form precondition finds neither text nor material tree
     * movement, and every validation assertion is skipped on the one page they
     * exist for. A retained node whose name *became* error-shaped is exactly as
     * much new text as a node that arrived carrying it.
     *
     * The "and was not one before" half is what keeps this from re-reporting a
     * message that was on the page all along.
     */
    const previousName = (previous.name ?? '').trim();
    const nextName = (next.name ?? '').trim();
    if (
      nextName.length > 0 &&
      nextName !== previousName &&
      config.errorTextPattern.test(nextName) &&
      !config.errorTextPattern.test(previousName)
    ) {
      errorTextAdded.push(nextName);
    }
  }

  const idStability = beforeIds.length === 0 ? 1 : retained / beforeIds.length;

  /*
   * Navigation, measured from the trees alone.
   *
   * The title changing says the document is a different one; id stability
   * collapsing says the tree was rebuilt wholesale rather than extended. Either
   * on its own is too weak - a live region can rewrite the title, and a big
   * React re-render churns every id - so both are required. Together they are
   * the shape of a navigation, and the toggle rules must never fire on one.
   */
  const documentReplaced =
    documentNameBefore !== null &&
    documentNameAfter !== null &&
    documentNameBefore !== documentNameAfter &&
    idStability < config.minIdStability;

  return {
    nodesAdded,
    nodesRemoved,
    changedProps,
    addedCount: nodesAdded.length,
    removedCount: nodesRemoved.length,
    changedCount: changedProps.length,
    sizeDelta: afterIds.length - beforeIds.length,
    churn: nodesAdded.length + nodesRemoved.length,
    idStability,
    popupRolesAdded,
    errorTextAdded,
    liveRolesAdded,
    dialogNodesBefore,
    dialogNodesAfter,
    documentNameBefore,
    documentNameAfter,
    documentReplaced,
  };
}

export type TreeChangeMagnitude = 'none' | 'noise' | 'material' | 'large';

/**
 * How much the tree actually moved, in one word.
 *
 * When node ids churned below `minIdStability` the added and removed lists are
 * untrustworthy - a rebuilt subtree looks like a hundred additions - so only
 * `sizeDelta` is consulted.
 */
export function treeChangeMagnitude(
  delta: TreeDelta,
  config: AnalysisConfig = DEFAULT_ANALYSIS_CONFIG,
): { magnitude: TreeChangeMagnitude; size: number; idsChurned: boolean } {
  const idsChurned = delta.idStability < config.minIdStability;
  const size = idsChurned
    ? Math.abs(delta.sizeDelta)
    : Math.max(Math.abs(delta.sizeDelta), delta.addedCount, delta.removedCount);

  if (size === 0 && delta.changedCount === 0) {
    return { magnitude: 'none', size, idsChurned };
  }
  if (size <= config.noiseNodeDelta) return { magnitude: 'noise', size, idsChurned };
  if (size < config.significantNodeDelta) return { magnitude: 'material', size, idsChurned };
  return { magnitude: 'large', size, idsChurned };
}

/* ========================================================================== */
/* Element state helpers                                                      */
/* ========================================================================== */

export interface StateAttributeReading {
  /** Attributes present on the control, with their values. */
  readonly declared: Readonly<Record<string, string | null>>;
  readonly names: readonly string[];
}

function readStateAttributes(element: ElementSnapshot | null | undefined): StateAttributeReading {
  const declared: Record<string, string | null> = {};
  const names: string[] = [];
  if (!element || !element.present) return { declared, names };

  for (const attribute of TRACKED_STATE_ATTRIBUTES) {
    const value = element.attributes[attribute] ?? null;
    if (value === null) continue;
    declared[attribute] = value;
    names.push(attribute);
  }
  return { declared, names };
}

function changedStateAttributes(
  before: ElementSnapshot | null | undefined,
  after: ElementSnapshot | null | undefined,
): string[] {
  const changed: string[] = [];
  for (const attribute of TRACKED_STATE_ATTRIBUTES) {
    const from = before?.attributes[attribute] ?? null;
    const to = after?.attributes[attribute] ?? null;
    if (from !== to) changed.push(attribute);
  }
  return changed;
}

/** True when the element is an anchor that will navigate rather than toggle. */
function isNavigatingAnchor(element: ElementSnapshot | null | undefined): boolean {
  if (!element || !element.present) return false;
  if ((element.tagName ?? '').toLowerCase() !== 'a') return false;
  const href = (element.attributes['href'] ?? '').trim();
  if (href.length === 0) return false;
  if (href === '#' || href.startsWith('#')) return false;
  if (href.toLowerCase().startsWith('javascript:')) return false;
  return true;
}

/** True when the control is a plain container with no role - a div-button. */
function looksLikeDivButton(element: ElementSnapshot | null | undefined): boolean {
  if (!element || !element.present) return false;
  const tag = (element.tagName ?? '').toLowerCase();
  if (!NON_INTERACTIVE_TAGS.has(tag)) return false;
  const role = (element.role ?? '').trim().toLowerCase();
  return role === '' || role === 'presentation' || role === 'none';
}

/**
 * The state changed somewhere in the tree, on a node with this control's name.
 *
 * A real false-positive guard: some component libraries put `aria-expanded` on
 * an inner element rather than the one the selector resolved to. The state IS
 * exposed; we were reading the wrong node. Do not report 4.1.2 in that case.
 */
function stateReportedElsewhereInTree(delta: TreeDelta, label: string): ChangedTreeProp | null {
  const target = normaliseLabel(label);
  if (target.length < 2) return null;

  for (const changed of delta.changedProps) {
    if (changed.prop === 'focused' || changed.prop === 'disabled') continue;
    const name = normaliseLabel(changed.name ?? '');
    if (name.length === 0) continue;
    if (name === target || (target.length >= 4 && (name.includes(target) || target.includes(name)))) {
      return changed;
    }
  }
  return null;
}

/* ========================================================================== */
/* Observation coercion - the executor's output is untrusted                  */
/* ========================================================================== */

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asFocus(value: unknown): FocusSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  return {
    present: record['present'] === true,
    tagName: asString(record['tagName']),
    role: asString(record['role']),
    text: asString(record['text']),
    insideDialog: record['insideDialog'] === true,
    isTrigger: record['isTrigger'] === true,
  };
}

function asFormErrors(value: unknown): FormErrorObservation | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const messages = Array.isArray(record['announcedMessages'])
    ? record['announcedMessages'].filter((item): item is string => typeof item === 'string')
    : [];
  return {
    liveRegionCount: asNumber(record['liveRegionCount']) ?? 0,
    announcedMessages: messages,
    invalidCount: asNumber(record['invalidCount']) ?? 0,
    invalidWithDescription: asNumber(record['invalidWithDescription']) ?? 0,
  };
}

/* ========================================================================== */
/* Preconditions shared by more than one rule                                 */
/* ========================================================================== */

export interface DialogOpening {
  /** True only when *this* interaction put a dialog on screen. */
  readonly opened: boolean;
  readonly visibleBefore: number | null;
  readonly visibleAfter: number | null;
  /** How `opened` was decided, for the evidence trail. */
  readonly via: 'counts' | 'tree' | 'none';
}

/**
 * Did this interaction open a dialog?
 *
 * The Dialog template is chosen from a label heuristic as often as from
 * `aria-haspopup`, so it is frequently pointed at a control that opens nothing.
 * Worse, a page can load with a cookie banner, a login modal or a consent sheet
 * already visible - and then a post-action count of one is true of every
 * control on the page, so focus, Escape and focus-return findings all land on
 * whichever control happened to be probed.
 *
 * Two readings, preferred in this order:
 *
 *   1. the executor's own before/after visible-dialog counts;
 *   2. dialog-role nodes counted across the two trees, which this layer always
 *      has. A banner that was already open is in `before` too, so the count
 *      does not rise - and unlike a single post-action number, that holds even
 *      when CDP reassigned every node id.
 *
 * Anything else is not an opening, and an unanswerable assertion is skipped,
 * never failed.
 */
export function dialogOpening(
  delta: TreeDelta,
  observations: Readonly<Record<string, unknown>>,
): DialogOpening {
  const visibleBefore = asNumber(observations[OBSERVATION_KEYS.dialogsVisibleBefore]);
  const visibleAfter = asNumber(observations[OBSERVATION_KEYS.dialogsVisibleAfterOpen]);

  if (visibleAfter === null || visibleAfter < 1) {
    return { opened: false, visibleBefore, visibleAfter, via: 'none' };
  }
  if (visibleBefore !== null) {
    return { opened: visibleAfter > visibleBefore, visibleBefore, visibleAfter, via: 'counts' };
  }
  return {
    opened: delta.dialogNodesAfter > delta.dialogNodesBefore,
    visibleBefore,
    visibleAfter,
    via: 'tree',
  };
}

/**
 * Two URLs that address the same document.
 *
 * The fragment is ignored: `#main` moves the viewport, it does not replace the
 * tree. Anything else - path, query, origin - is treated as a navigation, which
 * only ever makes this layer quieter.
 */
function sameDocumentUrl(before: string, after: string): boolean {
  const strip = (url: string): string => {
    const hash = url.indexOf('#');
    return (hash === -1 ? url : url.slice(0, hash)).replace(/\/+$/, '');
  };
  return strip(before) === strip(after);
}

/**
 * Did the action navigate?
 *
 * Four independent readings, because suppressing navigation is the single most
 * important false-positive guard in the 4.1.2 rules and it must not rest on any
 * one of them arriving:
 *
 *   - the caller said so;
 *   - the executor filed `observations.navigated`;
 *   - the URL moved to a different document;
 *   - the document title changed while the whole tree was rebuilt.
 *
 * The last two are what cover button-driven routing and scripted redirects,
 * which no amount of looking at `<a href>` on the trigger can catch.
 */
function actionNavigated(
  delta: TreeDelta,
  observations: Readonly<Record<string, unknown>>,
  context: TransitionContext,
): boolean {
  if (context.navigated === true) return true;
  if (asBoolean(observations[OBSERVATION_KEYS.navigated]) === true) return true;

  const urlBefore = asString(observations[OBSERVATION_KEYS.urlBefore]);
  const urlAfter = asString(observations[OBSERVATION_KEYS.urlAfter]);
  if (urlBefore !== null && urlAfter !== null && !sameDocumentUrl(urlBefore, urlAfter)) return true;

  return delta.documentReplaced;
}

/* ========================================================================== */
/* The analysis                                                               */
/* ========================================================================== */

export interface TransitionContext {
  readonly config?: AnalysisConfigInput;
  readonly pageUrl?: string | null;
  readonly pathId?: string | null;
  readonly selector?: string;
  readonly label?: string;
  readonly source?: ControlSource;
  /** How sure the enumerator was that the selector resolved to this control. */
  readonly selectorConfidence?: number;
  /** What the executor filed. Keys are `OBSERVATION_KEYS`. */
  readonly observations?: Readonly<Record<string, unknown>>;
  /**
   * Set when the action navigated. Suppresses the toggle rules entirely - see
   * `suppressOnNavigation`. Prefer setting this explicitly over letting the
   * analysis guess.
   */
  readonly navigated?: boolean;
}

/**
 * Analyse one interaction. The core of the product.
 *
 * @param before          Accessibility tree before the action.
 * @param after           Accessibility tree after the action.
 * @param stateAttrBefore The control's own attributes before.
 * @param stateAttrAfter  The control's own attributes after.
 * @param template        Which template drove the interaction.
 * @param context         Path identity, executor observations, config.
 */
export function analyseTransition(
  before: AxTreeSnapshot,
  after: AxTreeSnapshot,
  stateAttrBefore: ElementSnapshot | null,
  stateAttrAfter: ElementSnapshot | null,
  template: PathTemplate,
  context: TransitionContext = {},
): PathFinding[] {
  const config = resolveConfig(context.config);
  const delta = diffTreeSnapshots(before, after, config);
  const observations = context.observations ?? {};

  const identity: Identity = {
    config,
    pageUrl: context.pageUrl ?? null,
    pathId: context.pathId ?? null,
    selector: context.selector ?? '',
    label: context.label ?? context.selector ?? 'this control',
    template,
    source: context.source ?? 'tree',
  };

  const selectorPenalty: ConfidenceTerm[] = [];
  const selectorConfidence = context.selectorConfidence;
  if (typeof selectorConfidence === 'number' && selectorConfidence < 0.9) {
    selectorPenalty.push({
      delta: (selectorConfidence - 0.95) * 0.4,
      because: `the selector "${identity.selector}" resolved to this control with only ${selectorConfidence.toFixed(2)} certainty`,
    });
  }
  if (asBoolean(observations[OBSERVATION_KEYS.triggerMarked]) === false) {
    selectorPenalty.push({
      delta: -0.1,
      because: 'the control could not be stamped before the action, so the after-reading may be a different DOM node',
    });
  } else if (asString(observations[OBSERVATION_KEYS.stateAfterReadVia]) === 'selector') {
    selectorPenalty.push({
      delta: -0.08,
      because: 'the after-state was re-read by selector rather than by the stamp',
    });
  }

  const findings: PathFinding[] = [];
  const opening = dialogOpening(delta, observations);

  /*
   * The toggle rules run only for templates that declared them.
   *
   * `ASSERTIONS_BY_TEMPLATE` already says which checks each template makes, and
   * the Form list deliberately excludes both toggle assertions: a submit button
   * has no state to report, so "the tree moved and this control's aria-expanded
   * did not" is not a statement about it. Running them anyway handed a 4.1.2 to
   * every form submit that re-rendered its page. Reading the answer out of the
   * declared assertion set rather than restating it here means the two cannot
   * drift apart.
   */
  const toggleRulesApply = ASSERTIONS_BY_TEMPLATE[template].some(
    (id) => id === 'tree-changed-state-frozen' || id === 'tree-changed-no-state-attribute',
  );

  if (toggleRulesApply) {
    findings.push(
      ...analyseToggle(
        delta,
        stateAttrBefore,
        stateAttrAfter,
        identity,
        selectorPenalty,
        context,
        opening,
      ),
    );
  }

  if (template === 'dialog') {
    findings.push(...analyseDialog(delta, observations, identity, selectorPenalty, opening));
  }
  if (template === 'form') {
    findings.push(...analyseForm(delta, observations, identity, selectorPenalty, before));
  }

  return findings.filter((finding) => finding.confidence >= config.minReportConfidence);
}

type Identity = {
  readonly config: AnalysisConfig;
  readonly pageUrl: string | null;
  readonly pathId: string | null;
  readonly selector: string;
  readonly label: string;
  readonly template: PathTemplate;
  readonly source: ControlSource;
};

function evidenceFor(delta: TreeDelta, identity: Identity): Record<string, unknown> {
  return {
    selector: identity.selector,
    label: identity.label,
    template: identity.template,
    treeSizeDelta: delta.sizeDelta,
    nodesAdded: delta.addedCount,
    nodesRemoved: delta.removedCount,
    statePropsChangedInTree: delta.changedCount,
    idStability: Number(delta.idStability.toFixed(3)),
    popupRolesAdded: delta.popupRolesAdded,
    liveRolesAdded: delta.liveRolesAdded,
    errorTextAdded: delta.errorTextAdded,
  };
}

/* -------------------------------------------------------------------------- */
/* Toggle: the 4.1.2 rules (A4.4)                                             */
/* -------------------------------------------------------------------------- */

function analyseToggle(
  delta: TreeDelta,
  stateAttrBefore: ElementSnapshot | null,
  stateAttrAfter: ElementSnapshot | null,
  identity: Identity,
  selectorPenalty: readonly ConfidenceTerm[],
  context: TransitionContext,
  opening: DialogOpening,
): PathFinding[] {
  const config = identity.config;
  const navigated = actionNavigated(delta, context.observations ?? {}, context);

  /* Guard 1: navigation replaces the whole tree. Never a 4.1.2 on its own. */
  if (navigated && config.suppressOnNavigation) return [];
  if (isNavigatingAnchor(stateAttrBefore) && config.suppressOnNavigation) return [];

  /* Guard 2: the movement is noise, or there was none. */
  const change = treeChangeMagnitude(delta, config);
  if (change.magnitude === 'none' || change.magnitude === 'noise') return [];

  /* Guard 3: the control is gone, so its state cannot be compared. */
  if (!stateAttrAfter || !stateAttrAfter.present) return [];

  /* Guard 4: the state IS reported, just not on the node we read. */
  const elsewhere = stateReportedElsewhereInTree(delta, identity.label);
  if (elsewhere !== null) return [];

  const beforeAttrs = readStateAttributes(stateAttrBefore);
  const afterAttrs = readStateAttributes(stateAttrAfter);
  const declared = [...new Set([...beforeAttrs.names, ...afterAttrs.names])];
  const changed = changedStateAttributes(stateAttrBefore, stateAttrAfter);

  /* The control said something. Nothing to report. */
  if (changed.length > 0) return [];

  const magnitudeTerms: ConfidenceTerm[] = [];
  if (change.magnitude === 'material') {
    magnitudeTerms.push({
      delta: -0.15,
      because: `the tree moved by only ${change.size} nodes, above the noise floor of ${config.noiseNodeDelta} but below the ${config.significantNodeDelta} that marks an opened surface`,
    });
  }
  if (change.size >= config.hugeNodeDelta) {
    magnitudeTerms.push({
      delta: 0.05,
      because: `the tree moved by ${change.size} nodes, far past the ${config.hugeNodeDelta} that makes the change unambiguous`,
    });
  }
  if (change.idsChurned) {
    magnitudeTerms.push({
      delta: -0.2,
      because: `only ${(delta.idStability * 100).toFixed(0)}% of node ids survived the interaction, so the page was re-rendered and the added/removed counts overstate the change`,
    });
  }
  if (delta.popupRolesAdded.length > 0) {
    magnitudeTerms.push({
      delta: 0.05,
      because: `${delta.popupRolesAdded.length} node(s) with popup roles (${[...new Set(delta.popupRolesAdded)].join(', ')}) appeared, so a surface was opened`,
    });
  }

  const shared = [...magnitudeTerms, ...selectorPenalty];
  const evidence = {
    ...evidenceFor(delta, identity),
    stateAttributesDeclared: declared,
    stateAttributesBefore: beforeAttrs.declared,
    stateAttributesAfter: afterAttrs.declared,
    elementTagBefore: stateAttrBefore?.tagName ?? null,
    elementRoleAttribute: stateAttrBefore?.role ?? null,
    transitionLine: formatLine(identity.label, declared[0] ?? 'aria-expanded', beforeAttrs.declared[declared[0] ?? ''] ?? null, afterAttrs.declared[declared[0] ?? ''] ?? null, delta.sizeDelta),
  };

  /* ---- Rule A: the control declares a state, and it did not move. -------- */
  if (declared.length > 0) {
    const scored = scoreConfidence(
      BASE_CONFIDENCE.stateFrozen,
      `the control declares ${declared.join(', ')} and the value was identical before and after while the accessibility tree changed`,
      shared,
    );

    return [
      makeFinding({
        ...identity,
        criterion: '4.1.2',
        assertion: 'tree-changed-state-frozen',
        confidence: scored.confidence,
        confidenceTerms: scored.terms,
        summary: `"${identity.label}" changed the accessibility tree by ${signed(delta.sizeDelta)} nodes without changing its own ${declared.join(' or ')}.`,
        detail: frozenStateDetail(identity, delta, change.size, declared, beforeAttrs, afterAttrs),
        evidence,
      }),
    ];
  }

  /*
   * Guard 5: this control opened a dialog, and the Dialog template is already
   * holding it to the right contract.
   *
   * Rule B below reads "no state attribute, and a popup role appeared" as
   * strong 4.1.2 evidence, and a dialog role is a popup role - so a perfectly
   * conforming dialog trigger scores 0.80 and goes out as DECIDE. But the APG
   * dialog pattern puts the contract on the *dialog*: its role, its accessible
   * name, aria-modal, initial focus, Escape, focus return. A button that opens
   * one is under no obligation to carry aria-expanded, and telling an author to
   * add one is telling them to do the wrong thing.
   *
   * Nothing is lost by staying quiet here: `analyseDialog` checks every one of
   * those obligations on this same interaction, so a dialog trigger that really
   * is broken is still reported - against the criterion it actually failed.
   *
   * Rule A above still applies. A control that *does* declare aria-expanded and
   * then freezes it is lying about its own state, dialog or no dialog.
   */
  if (identity.template === 'dialog' && opening.opened) return [];

  /* ---- Rule B: the control declares no state at all. --------------------- */
  const divButton = looksLikeDivButton(stateAttrBefore);
  const popupAppeared = delta.popupRolesAdded.length > 0;

  let base: number;
  let baseReason: string;
  if (divButton) {
    base = BASE_CONFIDENCE.noStateDivButton;
    baseReason = `the control is a <${(stateAttrBefore?.tagName ?? 'div')}> with no role attribute and no state attribute, and it changed the accessibility tree`;
  } else if (popupAppeared) {
    base = BASE_CONFIDENCE.noStatePopupAppeared;
    baseReason = `the control exposes no state attribute and opened a surface carrying ${[...new Set(delta.popupRolesAdded)].join(', ')}`;
  } else {
    base = BASE_CONFIDENCE.noStateAmbiguous;
    baseReason =
      'the control exposes no state attribute and the accessibility tree changed, but no popup role appeared, so the change may be an ordinary re-render';
  }

  const scored = scoreConfidence(base, baseReason, shared);

  return [
    makeFinding({
      ...identity,
      criterion: '4.1.2',
      assertion: 'tree-changed-no-state-attribute',
      confidence: scored.confidence,
      confidenceTerms: scored.terms,
      summary: `"${identity.label}" changed the accessibility tree by ${signed(delta.sizeDelta)} nodes while exposing no state at all.`,
      detail: noStateDetail(identity, delta, change.size, stateAttrBefore, divButton),
      evidence,
    }),
  ];
}

function frozenStateDetail(
  identity: Identity,
  delta: TreeDelta,
  size: number,
  declared: readonly string[],
  before: StateAttributeReading,
  after: StateAttributeReading,
): string {
  const readings = declared
    .map((name) => `${name} ${String(before.declared[name] ?? 'absent')} -> ${String(after.declared[name] ?? 'absent')}`)
    .join(', ');

  const popup =
    delta.popupRolesAdded.length > 0
      ? ` Among the added nodes were ${delta.popupRolesAdded.length} carrying popup roles (${[...new Set(delta.popupRolesAdded)].join(', ')}).`
      : '';

  return (
    `Clicking "${identity.label}" added ${delta.addedCount} and removed ${delta.removedCount} accessibility tree nodes, ` +
    `a net change of ${signed(delta.sizeDelta)} (${size} nodes of movement).${popup} ` +
    `The control's own state did not move: ${readings}. ` +
    `A screen reader reads the same name, role and state before and after, so the user is not told that anything happened.`
  );
}

function noStateDetail(
  identity: Identity,
  delta: TreeDelta,
  size: number,
  element: ElementSnapshot | null,
  divButton: boolean,
): string {
  const tag = element?.tagName ?? 'unknown element';
  const roleAttribute = element?.role ?? null;
  const popup =
    delta.popupRolesAdded.length > 0
      ? ` The added nodes include ${[...new Set(delta.popupRolesAdded)].join(', ')}, so a menu, listbox or dialog was opened.`
      : '';

  const shape = divButton
    ? `The control is a <${tag}> with ${roleAttribute ? `role="${roleAttribute}"` : 'no role attribute'}, so assistive technology is not told it is a control at all.`
    : `The control is a <${tag}>${roleAttribute ? ` with role="${roleAttribute}"` : ''}, but it carries none of aria-expanded, aria-checked, aria-selected or aria-pressed.`;

  return (
    `Clicking "${identity.label}" added ${delta.addedCount} and removed ${delta.removedCount} accessibility tree nodes, ` +
    `a net change of ${signed(delta.sizeDelta)} (${size} nodes of movement).${popup} ` +
    `${shape} There is no state for a screen reader to announce, before or after.`
  );
}

/* -------------------------------------------------------------------------- */
/* Dialog: 2.4.3, 2.1.2, 2.4.7                                                */
/* -------------------------------------------------------------------------- */

function analyseDialog(
  delta: TreeDelta,
  observations: Readonly<Record<string, unknown>>,
  identity: Identity,
  selectorPenalty: readonly ConfidenceTerm[],
  opening: DialogOpening,
): PathFinding[] {
  /*
   * Precondition: *this control* opened a dialog.
   *
   * Not "a dialog is visible". The Dialog template is chosen from a label
   * heuristic as often as from aria-haspopup, so it is frequently pointed at a
   * control that opens nothing - and a page that loads with a cookie banner,
   * a login modal or a consent sheet already on screen satisfies "a dialog is
   * visible" for every control on it. Every assertion below would then be
   * answered against a surface this control never touched.
   *
   * `dialogOpening` requires the count to have *risen*, reading the executor's
   * before/after counts when it filed them and falling back to dialog-role
   * nodes across the two trees when it did not. When nothing opened, every
   * assertion here is unanswerable, and an unanswerable assertion is skipped,
   * not failed.
   */
  if (!opening.opened) return [];

  const dialogsOpen = opening.visibleAfter ?? delta.dialogNodesAfter;
  const dialogsAfterEscape = asNumber(observations[OBSERVATION_KEYS.dialogsVisibleAfterEscape]);
  const focusAfterOpen = asFocus(observations[OBSERVATION_KEYS.focusAfterOpen]);
  const focusAfterEscape = asFocus(observations[OBSERVATION_KEYS.focusAfterEscape]);
  const focusReturned = asBoolean(observations[OBSERVATION_KEYS.focusReturnedToTrigger]);

  const findings: PathFinding[] = [];
  const evidence = {
    ...evidenceFor(delta, identity),
    dialogsVisibleBefore: opening.visibleBefore,
    dialogsVisibleAfterOpen: dialogsOpen,
    dialogOpenedVia: opening.via,
    dialogNodesBefore: delta.dialogNodesBefore,
    dialogNodesAfter: delta.dialogNodesAfter,
    dialogsVisibleAfterEscape: dialogsAfterEscape,
    focusAfterOpen,
    focusAfterEscape,
    focusReturnedToTrigger: focusReturned,
  };

  /* ---- Focus did not move into the dialog (2.4.3) ------------------------ */
  if (focusAfterOpen !== null && focusAfterOpen.insideDialog === false) {
    const terms: ConfidenceTerm[] = [...selectorPenalty];
    if (!focusAfterOpen.present) {
      terms.push({
        delta: 0.05,
        because: 'focus was on the document body, not merely on the wrong element',
      });
    }
    const scored = scoreConfidence(
      BASE_CONFIDENCE.focusNotInDialog,
      `${dialogsOpen} dialog(s) became visible and the focused element was outside every one of them`,
      terms,
    );
    findings.push(
      makeFinding({
        ...identity,
        criterion: '2.4.3',
        assertion: 'focus-moved-into-dialog',
        confidence: scored.confidence,
        confidenceTerms: scored.terms,
        summary: `Opening "${identity.label}" showed a dialog but left keyboard focus outside it.`,
        detail:
          `"${identity.label}" made ${dialogsOpen} dialog visible. Focus stayed on ` +
          `${describeFocus(focusAfterOpen)}, outside the dialog. A keyboard or screen reader user has to ` +
          `tab through the rest of the page to reach content that visually appeared on top of it.`,
        evidence,
      }),
    );

    /* Focus on nothing at all is also a 2.4.7 concern - vision must confirm. */
    if (!focusAfterOpen.present) {
      const focusScore = scoreConfidence(
        BASE_CONFIDENCE.focusOnNothing,
        'after the dialog opened, the active element was the document body, so there is no focus indicator anywhere on screen',
        [
          {
            delta: -0.05,
            because: 'the visible focus ring itself cannot be confirmed from the accessibility tree and needs the vision pass',
          },
          ...selectorPenalty,
        ],
      );
      findings.push(
        makeFinding({
          ...identity,
          criterion: '2.4.7',
          assertion: 'focus-visible-after-open',
          confidence: focusScore.confidence,
          confidenceTerms: focusScore.terms,
          summary: `After "${identity.label}" opened a dialog, focus was on nothing, so no focus indicator is visible.`,
          detail:
            `The active element after the interaction was the document body. There is no element for a focus ` +
            `indicator to be drawn on, so a keyboard user cannot see where they are. Confirm against the screenshot ` +
            `before acting: this is inferred from the active element, not from a rendered outline.`,
          evidence,
        }),
      );
    }
  }

  /* ---- Escape did not dismiss (2.1.2) ------------------------------------ */
  const escapeDismissed = dialogsAfterEscape !== null && dialogsAfterEscape < dialogsOpen;
  if (dialogsAfterEscape !== null && !escapeDismissed) {
    const scored = scoreConfidence(
      BASE_CONFIDENCE.escapeDidNotDismiss,
      `${dialogsOpen} dialog(s) were visible before Escape and ${dialogsAfterEscape} after, so Escape did nothing`,
      [
        {
          delta:
            focusAfterEscape !== null && focusAfterEscape.insideDialog ? 0.05 : -0.05,
          because:
            focusAfterEscape !== null && focusAfterEscape.insideDialog
              ? 'focus remained inside the undismissed dialog'
              : 'only Escape was tested; a close button reachable by Tab would still satisfy 2.1.2',
        },
        ...selectorPenalty,
      ],
    );
    findings.push(
      makeFinding({
        ...identity,
        criterion: '2.1.2',
        assertion: 'escape-dismisses-dialog',
        confidence: scored.confidence,
        confidenceTerms: scored.terms,
        summary: `Escape did not dismiss the dialog opened by "${identity.label}".`,
        detail:
          `${dialogsOpen} dialog(s) were visible after the interaction and ${dialogsAfterEscape} after Escape was ` +
          `pressed. Escape is the expected exit and it did nothing. This is reported for review rather than as a ` +
          `settled keyboard trap: an exit via a Tab-reachable close button was not tested, and would satisfy 2.1.2.`,
        evidence,
      }),
    );
  }

  /* ---- Focus did not return to the trigger (2.4.3) ----------------------- */
  if (escapeDismissed && focusReturned === false) {
    const terms: ConfidenceTerm[] = [...selectorPenalty];
    if (focusAfterEscape !== null && !focusAfterEscape.present) {
      terms.push({
        delta: 0.05,
        because: 'focus was reset to the document body, so the user is returned to the top of the page',
      });
    }
    const scored = scoreConfidence(
      BASE_CONFIDENCE.focusNotReturned,
      'the dialog was dismissed by Escape and focus did not return to the control that opened it',
      terms,
    );
    findings.push(
      makeFinding({
        ...identity,
        criterion: '2.4.3',
        assertion: 'focus-returned-on-escape',
        confidence: scored.confidence,
        confidenceTerms: scored.terms,
        summary: `Closing the dialog opened by "${identity.label}" did not return focus to it.`,
        detail:
          `Escape dismissed the dialog (${dialogsOpen} visible before, ${String(dialogsAfterEscape)} after). Focus ` +
          `then rested on ${describeFocus(focusAfterEscape)} rather than on "${identity.label}". A keyboard user is ` +
          `dropped back at an unrelated point in the tab order and has to find their place again.`,
        evidence,
      }),
    );
  }

  return findings;
}

function describeFocus(focus: FocusSnapshot | null): string {
  if (focus === null) return 'an element the run could not describe';
  if (!focus.present) return 'the document body (nothing focused)';
  const tag = focus.tagName ?? 'element';
  const role = focus.role ? ` role="${focus.role}"` : '';
  const text = focus.text ? ` "${focus.text}"` : '';
  return `<${tag}>${role}${text}`;
}

/* -------------------------------------------------------------------------- */
/* Form: 3.3.1, 3.3.3, 4.1.3, 2.4.3                                           */
/* -------------------------------------------------------------------------- */

/**
 * Keep only the live-region messages this submission actually produced.
 *
 * The executor reads every `[role=alert]` and `[aria-live]` on the page after
 * submitting, and a great many pages carry one permanently: "Welcome back", a
 * cart total, a cookie notice, a "3 results" counter. Counting those as
 * validation output does two kinds of damage. The obvious one is a 3.3.3
 * finding that the error does not say how to fix an error that does not exist.
 * The worse one is upstream: any message at all satisfies `submissionRejected`,
 * so a submit button that did nothing at all still gets its form assertions
 * evaluated as though it had been rejected.
 *
 * Two baselines, preferred in this order:
 *
 *   1. the executor's pre-submit capture of the same live regions;
 *   2. the before-tree's node names, which this layer always has. A message
 *      rendered on the page before the click is in that tree, by definition.
 *
 * Containment as well as equality, because a live region's text content is the
 * concatenation of its children and the tree carries them one name at a time.
 */
function newlyAnnounced(
  after: readonly string[],
  before: FormErrorObservation | null,
  beforeTree: AxTreeSnapshot,
): string[] {
  if (before !== null) {
    const seen = new Set(before.announcedMessages.map((message) => normaliseLabel(message)));
    return after.filter((message) => !seen.has(normaliseLabel(message)));
  }

  const namesBefore = new Set<string>();
  for (const node of Object.values(beforeTree)) {
    const name = normaliseLabel((node.name ?? '').trim());
    if (name.length > 0) namesBefore.add(name);
  }

  return after.filter((message) => {
    const normalised = normaliseLabel(message);
    if (normalised.length === 0) return false;
    for (const name of namesBefore) {
      if (name === normalised) return false;
      if (normalised.length >= 8 && name.includes(normalised)) return false;
    }
    return true;
  });
}

function analyseForm(
  delta: TreeDelta,
  observations: Readonly<Record<string, unknown>>,
  identity: Identity,
  selectorPenalty: readonly ConfidenceTerm[],
  beforeTree: AxTreeSnapshot,
): PathFinding[] {
  const config = identity.config;
  const errors = asFormErrors(observations[OBSERVATION_KEYS.formErrors]);
  if (errors === null) return [];

  const focusAfterSubmit = asFocus(observations[OBSERVATION_KEYS.focusAfterSubmit]);
  const change = treeChangeMagnitude(delta, config);

  const errorsBefore = asFormErrors(observations[OBSERVATION_KEYS.formErrorsBefore]);
  const announcedAfter = errors.announcedMessages.filter((message) => message.trim().length > 0);
  const announced = newlyAnnounced(announcedAfter, errorsBefore, beforeTree);
  const carriedOver = announcedAfter.length - announced.length;
  const errorTextInTree = delta.errorTextAdded;
  const hasErrorText = announced.length > 0 || errorTextInTree.length > 0;

  /*
   * Precondition. `invalidCount` alone proves nothing: `:invalid` matches a
   * required empty field the moment the page loads, before anything is
   * submitted. Neither does a live region with words in it, unless those words
   * are *new* - see `newlyAnnounced`. A submission was only *rejected* if
   * something actually happened: the tree moved, or text appeared that was not
   * there before. Without that, every rule below would be guessing, so none of
   * them run.
   */
  const submissionRejected =
    hasErrorText || change.magnitude === 'material' || change.magnitude === 'large';
  if (!submissionRejected) return [];

  const findings: PathFinding[] = [];
  const evidence = {
    ...evidenceFor(delta, identity),
    liveRegionCount: errors.liveRegionCount,
    announcedMessages: announced,
    announcedMessagesCarriedOverFromBeforeSubmit: carriedOver,
    announcedBaselineVia: errorsBefore !== null ? 'pre-submit capture' : 'before-tree node names',
    invalidCount: errors.invalidCount,
    invalidWithDescription: errors.invalidWithDescription,
    focusAfterSubmit,
  };

  /* ---- The error is not in text (3.3.1) ---------------------------------- */
  if (!hasErrorText) {
    const terms: ConfidenceTerm[] = [...selectorPenalty];
    if (errors.invalidCount === 0) {
      terms.push({
        delta: -0.2,
        because: 'no field was marked invalid either, so the submission may have succeeded rather than been rejected',
      });
    }
    if (errors.invalidWithDescription > 0) {
      terms.push({
        delta: -0.15,
        because: `${errors.invalidWithDescription} invalid field(s) carry aria-describedby, so an explanation may exist in text the capture did not collect`,
      });
    }
    const scored = scoreConfidence(
      BASE_CONFIDENCE.errorNotInText,
      `submitting empty moved the accessibility tree by ${change.size} nodes and ${errors.invalidCount} field(s) are marked invalid, but no error-shaped text appeared anywhere`,
      terms,
    );
    findings.push(
      makeFinding({
        ...identity,
        criterion: '3.3.1',
        assertion: 'error-in-text',
        confidence: scored.confidence,
        confidenceTerms: scored.terms,
        summary: `Submitting the form at "${identity.label}" empty produced no error described in text.`,
        detail:
          `The empty submission was rejected - the accessibility tree moved by ${signed(delta.sizeDelta)} nodes and ` +
          `${errors.invalidCount} field(s) are marked invalid - but no live region carried a message and no added node ` +
          `read as an error. The only signal available to a screen reader user is the invalid state itself, with no ` +
          `words saying what is wrong.`,
        evidence,
      }),
    );
  }

  /* ---- The error is not announced (4.1.3) -------------------------------- */
  if (hasErrorText && errors.liveRegionCount === 0 && delta.liveRolesAdded.length === 0) {
    const terms: ConfidenceTerm[] = [...selectorPenalty];
    const focusMoved = focusAfterSubmit !== null && focusAfterSubmit.present && !focusAfterSubmit.isTrigger;
    if (focusMoved) {
      terms.push({
        delta: -0.3,
        because: 'focus moved off the submit control, so the error may be read on focus even without a live region',
      });
    }
    const scored = scoreConfidence(
      BASE_CONFIDENCE.errorNotAnnounced,
      `error text appeared (${quoteFirst(announced, errorTextInTree)}) and no element carried role="alert", role="status" or aria-live`,
      terms,
    );
    findings.push(
      makeFinding({
        ...identity,
        criterion: '4.1.3',
        assertion: 'error-announced',
        confidence: scored.confidence,
        confidenceTerms: scored.terms,
        summary: `The validation error after "${identity.label}" is shown but never announced.`,
        detail:
          `Submitting empty produced error text (${quoteFirst(announced, errorTextInTree)}) with no live region on the ` +
          `page: role="alert", role="status" and aria-live were all absent, and no node with those roles was added. ` +
          `A sighted user sees the message appear; a screen reader user is told nothing until they happen to navigate ` +
          `back over it.`,
        evidence,
      }),
    );
  }

  /* ---- The error does not say how to fix it (3.3.3) ---------------------- */
  if (hasErrorText) {
    const messages = announced.length > 0 ? announced : errorTextInTree;
    const helpful = messages.some((message) => config.suggestionPattern.test(message));
    if (!helpful) {
      const scored = scoreConfidence(
        BASE_CONFIDENCE.errorWithoutSuggestion,
        `the error text (${messages.map(quote).join(', ')}) names the problem but matches no pattern that suggests a correction`,
        [
          {
            delta: -0.05,
            because: 'whether a message is a sufficient suggestion is a judgement a human should make, so this is never auto-fixed',
          },
          ...selectorPenalty,
        ],
      );
      findings.push(
        makeFinding({
          ...identity,
          criterion: '3.3.3',
          assertion: 'error-suggests-fix',
          confidence: scored.confidence,
          confidenceTerms: scored.terms,
          summary: `The validation error after "${identity.label}" says what is wrong but not how to fix it.`,
          detail:
            `The messages produced were ${messages.map(quote).join(', ')}. None of them names a format, a range, an ` +
            `example or an action the user could take. Review before changing: some fields genuinely have nothing to ` +
            `suggest beyond "this is required".`,
          evidence,
        }),
      );
    }
  }

  /* ---- Focus stayed on the submit control (2.4.3) ------------------------ */
  if (
    hasErrorText &&
    errors.liveRegionCount === 0 &&
    delta.liveRolesAdded.length === 0 &&
    focusAfterSubmit !== null &&
    focusAfterSubmit.isTrigger
  ) {
    const scored = scoreConfidence(
      BASE_CONFIDENCE.focusStayedOnSubmit,
      'errors appeared, nothing announced them, and focus stayed on the submit control',
      [
        {
          delta: -0.05,
          because: 'WCAG does not require focus to move to an error, only that the error is perceivable; this is a review item',
        },
        ...selectorPenalty,
      ],
    );
    findings.push(
      makeFinding({
        ...identity,
        criterion: '2.4.3',
        assertion: 'focus-moves-to-error',
        confidence: scored.confidence,
        confidenceTerms: scored.terms,
        summary: `After a rejected submission, focus stayed on "${identity.label}" with nothing announcing the error.`,
        detail:
          `Errors appeared, no live region carried them, and focus remained on the submit control. Nothing directs a ` +
          `screen reader user to the problem. Either move focus to the first invalid field or announce the summary ` +
          `through a live region.`,
        evidence,
      }),
    );
  }

  return findings;
}

function quote(text: string): string {
  return `"${text.length > 90 ? `${text.slice(0, 87)}...` : text}"`;
}

function quoteFirst(a: readonly string[], b: readonly string[]): string {
  const first = a[0] ?? b[0];
  return first === undefined ? 'no message' : quote(first);
}

/* ========================================================================== */
/* Convenience wrappers                                                       */
/* ========================================================================== */

export interface AnalyseResultContext {
  readonly config?: AnalysisConfigInput;
  readonly pageUrl?: string | null;
  readonly selectorConfidence?: number;
  readonly navigated?: boolean;
}

/**
 * Analyse a whole transition result, as the executor produced it.
 *
 * A failed path (`ok === false`) yields nothing: a selector that missed is a
 * run problem, not an accessibility problem, and inventing a finding from one
 * is exactly the failure mode this layer is built to avoid.
 */
export function analysePathResult(
  result: TransitionResult,
  context: AnalyseResultContext = {},
): PathFinding[] {
  if (!result.ok) return [];

  return analyseTransition(
    result.treeBefore,
    result.treeAfter,
    result.stateBefore ?? null,
    result.stateAfter ?? null,
    result.path.template,
    {
      config: context.config,
      pageUrl: context.pageUrl ?? null,
      pathId: result.path.id ?? null,
      selector: result.path.selector,
      label: result.path.label ?? result.path.selector,
      source: result.path.source ?? 'tree',
      selectorConfidence: context.selectorConfidence,
      observations: result.observations,
      navigated: context.navigated,
    },
  );
}

/** Analyse a page's worth of results. */
export function analysePathResults(
  results: readonly TransitionResult[],
  context: AnalyseResultContext = {},
): PathFinding[] {
  return results.flatMap((result) => analysePathResult(result, context));
}

/* ========================================================================== */
/* The demo line                                                              */
/* ========================================================================== */

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function formatLine(
  label: string,
  attribute: string,
  before: string | null,
  after: string | null,
  sizeDelta: number,
): string {
  return `CLICK "${label}"   ${attribute} ${before ?? 'null'} -> ${after ?? 'null'}   |   tree delta ${signed(sizeDelta)} nodes`;
}

/**
 * The one-line rendering of a transition, as verified on Clearway:
 *
 *     CLICK "EnglishEN"   aria-expanded null -> null   |   tree delta +98 nodes
 *
 * Used by the agent timeline and by the finding detail view. Pure formatting.
 */
export function formatTransitionLine(result: TransitionResult): string {
  const delta = diffTreeSnapshots(result.treeBefore, result.treeAfter);
  const before = result.stateBefore ?? null;
  const after = result.stateAfter ?? null;

  const attribute =
    TRACKED_STATE_ATTRIBUTES.find(
      (name) => (before?.attributes[name] ?? null) !== null || (after?.attributes[name] ?? null) !== null,
    ) ?? 'aria-expanded';

  const action = (result.path.action ?? 'click').toUpperCase();
  const label = result.path.label ?? result.path.selector;

  return formatLine(label, attribute, before?.attributes[attribute] ?? null, after?.attributes[attribute] ?? null, delta.sizeDelta)
    .replace(/^CLICK/, action);
}
