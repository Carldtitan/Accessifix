/**
 * TREE - the deterministic gate.
 *
 * Design principle 2: cheap gates before expensive ones. TREE runs first, on
 * every page, without a sandbox build and without a model. It reads two things
 * the browser layer already captured - the CDP accessibility tree and the
 * axe-core result - plus any cheap DOM measurements the harness took, and turns
 * them into findings. Nothing here calls a provider, opens a socket, or touches
 * the database, so the whole file is testable with a literal object.
 *
 * What TREE can and cannot conclude is stated explicitly, because the honest
 * distinction is the point:
 *
 *   TREE_DECIDES     - a clean page really is a pass. These are exactly the
 *                      nine criteria `criteriaOwnedBy('TREE')` assigns to this
 *                      lane, so the two lists cannot drift.
 *   TREE_CONTRIBUTES - TREE can fail the criterion on hard evidence but cannot
 *                      pass it alone: something must still be observed across a
 *                      state transition (4.1.2), rendered at 320 CSS px
 *                      (1.4.10), driven by keyboard (2.4.1), or judged for
 *                      accuracy rather than presence (1.1.1). A clean page is
 *                      reported as inconclusive with the reason, never as a
 *                      pass.
 *
 * Sixteen criteria in total, which is the TREE row of the agent roster.
 *
 * Every finding carries a criterion id. There is no code path in this file that
 * constructs a finding without one: `buildFinding` resolves the criterion
 * against the table of 55 and returns null if it is not there.
 */

import {
  criteriaOwnedBy,
  getCriterion,
  requireCriterion,
  type Criterion,
} from '@/lib/db/criteria';
import {
  AXE_RULES_OFF_BY_DEFAULT,
  criterionForAxeRule,
  severityFromAxeImpact,
} from './axe-map';
import {
  emptySeverityCounts,
  type AuditFinding,
  type FindingEvidence,
  type InconclusiveCriterion,
  type PageAudit,
  type Severity,
} from './types';

/* -------------------------------------------------------------------------- */
/* Input shapes                                                               */
/* -------------------------------------------------------------------------- */

/*
 * These are structurally compatible with `lib/browser/types.ts` on purpose but
 * are not imported from it: `lib/audit` must stay buildable and testable with
 * no browser layer present, and every field the browser cannot supply is
 * optional so a partial capture degrades into "inconclusive" rather than into a
 * wrong answer. A `PageCapture` can be passed straight to `auditPage`.
 */

export interface AxeNodeLike {
  readonly target?: readonly string[];
  readonly html?: string;
  readonly failureSummary?: string | null;
}

export interface AxeViolationLike {
  readonly id: string;
  readonly impact?: string | null;
  readonly help?: string;
  readonly description?: string;
  readonly helpUrl?: string;
  readonly tags?: readonly string[];
  readonly nodes?: readonly AxeNodeLike[];
}

export interface AxNodePropsLike {
  readonly expanded?: string | null;
  readonly checked?: string | null;
  readonly selected?: string | null;
  readonly pressed?: string | null;
  readonly focused?: string | null;
  readonly disabled?: string | null;
}

export interface AxNodeLike {
  readonly nodeId: string;
  readonly role?: string | null;
  readonly name?: string | null;
  readonly ignored?: boolean;
  readonly backendDomNodeId?: number | null;
  readonly childIds?: readonly string[];
  readonly props?: AxNodePropsLike;
}

export type AxTreeLike = Readonly<Record<string, AxNodeLike>>;

/** A skip link and whether its fragment resolves to something on the page. */
export interface SkipLinkFact {
  readonly selector?: string;
  readonly text: string;
  readonly href: string;
  readonly targetExists: boolean;
}

export interface HeadingFact {
  readonly selector?: string;
  readonly level: number;
  readonly text: string;
}

/** One form control, as the DOM actually declares it. */
export interface FormFieldFact {
  readonly selector: string;
  readonly tagName?: string;
  /** The `type` attribute for inputs. */
  readonly type?: string | null;
  readonly name?: string | null;
  readonly id?: string | null;
  readonly label?: string | null;
  readonly placeholder?: string | null;
  readonly autocomplete?: string | null;
  readonly required?: boolean;
}

/** A measured pointer target, in CSS pixels. */
export interface TargetFact {
  readonly selector: string;
  readonly role?: string | null;
  readonly name?: string | null;
  readonly width: number;
  readonly height: number;
  /** Distance to the nearest neighbouring target, when measured. */
  readonly spacing?: number | null;
  /** True for a target inline in a sentence - a 2.5.8 exception. */
  readonly inline?: boolean;
  /** True when the harness determined a documented 2.5.8 exception applies. */
  readonly exempt?: boolean;
}

/** Visible label text against the computed accessible name, for 2.5.3. */
export interface LabelledControlFact {
  readonly selector: string;
  readonly role?: string | null;
  readonly visibleText: string;
  readonly accessibleName: string;
}

export interface LinkFact {
  readonly selector?: string;
  readonly name: string;
  readonly href: string;
}

/** An element carrying a `lang` attribute somewhere inside the document. */
export interface LangPartFact {
  readonly selector: string;
  readonly lang: string;
}

/**
 * Cheap DOM facts the browser layer can collect in the same evaluate() call as
 * the tree. All optional. A check that needs a fact it did not get reports the
 * criterion inconclusive with that reason rather than guessing.
 */
export interface DocumentFacts {
  readonly lang?: string | null;
  readonly xmlLang?: string | null;
  readonly title?: string | null;
  /** The `content` of `<meta name="viewport">`, or null when there is none. */
  readonly metaViewport?: string | null;
  /** True when the document scrolls sideways in a 320 CSS px viewport (1.4.10). */
  readonly horizontalScrollAt320?: boolean | null;
  readonly scrollWidthAt320?: number | null;
  readonly skipLinks?: readonly SkipLinkFact[];
  readonly landmarkRoles?: readonly string[];
  readonly headings?: readonly HeadingFact[];
  readonly formFields?: readonly FormFieldFact[];
  readonly targets?: readonly TargetFact[];
  readonly labelledControls?: readonly LabelledControlFact[];
  readonly links?: readonly LinkFact[];
  readonly langParts?: readonly LangPartFact[];
}

/** One page's worth of deterministic input. Field names match `PageCapture`. */
export interface TreePageInput {
  readonly url: string;
  readonly finalUrl?: string;
  readonly title?: string | null;
  readonly axTree?: AxTreeLike;
  readonly axeViolations?: readonly AxeViolationLike[];
  /** axe results the engine could not settle. Turns a pass into inconclusive. */
  readonly axeIncomplete?: readonly AxeViolationLike[];
  /** axe results that passed. When supplied, TREE knows exactly which rules ran. */
  readonly axePasses?: readonly AxeViolationLike[];
  readonly document?: DocumentFacts;
  readonly warnings?: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* What TREE owns                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The nine criteria TREE can settle outright.
 *
 * Derived from the criteria table rather than retyped, so adding a criterion to
 * the TREE lane there automatically requires a check here (the assertion at the
 * bottom of this file fails the build otherwise).
 */
export const TREE_DECIDES: readonly string[] = criteriaOwnedBy('TREE').map((c) => c.id);

/**
 * The seven criteria TREE can fail on hard evidence but must not pass alone,
 * each with the reason the pass belongs to somebody else.
 */
export const TREE_CONTRIBUTES: Readonly<Record<string, string>> = {
  '1.1.1':
    'TREE detects missing alternative text. Whether the text that is there is accurate is a VIS judgement.',
  '1.3.1':
    'TREE detects broken list, table and landmark structure. Whether the visual structure is present in the markup at all is a VIS judgement.',
  '1.4.10':
    'TREE detects a locked or absent viewport. Confirming the page reflows needs it rendered at 320 CSS px, which is an ACT check.',
  '2.4.1':
    'TREE detects a missing skip mechanism. Confirming the skip link actually moves focus needs a keyboard, which is an ACT check.',
  '2.5.3':
    'TREE compares visible text to the accessible name where both were captured. Reading the visible label off the rendered page is a VIS check.',
  '3.3.2':
    'TREE detects fields with no accessible name. Whether the label and instructions are adequate is a VIS judgement.',
  '4.1.2':
    'TREE detects malformed markup and controls with no name or no state property. Whether state changes are announced needs a transition, which is an ACT check.',
};

/** The sixteen criteria TREE touches. The TREE row of the agent roster. */
export const TREE_CRITERIA: readonly string[] = [
  ...TREE_DECIDES,
  ...Object.keys(TREE_CONTRIBUTES),
].sort(compareCriterionId);

/* -------------------------------------------------------------------------- */
/* Tuning constants                                                           */
/* -------------------------------------------------------------------------- */

/** Per rule, per page. A page with 400 contrast failures needs a fix, not 400 rows. */
const MAX_NODES_PER_RULE = 20;
/** Structural checks that walk the whole tree cap out at the same place. */
const MAX_STRUCTURAL_FINDINGS = 20;
/** Evidence is a pointer, not a payload (A9.2). */
const MAX_HTML_CHARS = 400;
const MAX_TEXT_CHARS = 300;

/* -------------------------------------------------------------------------- */
/* Word lists and patterns                                                    */
/* -------------------------------------------------------------------------- */

/** Titles that name no page. Exact match after trimming and lowercasing. */
const PLACEHOLDER_TITLES: ReadonlySet<string> = new Set([
  'document',
  'untitled',
  'untitled document',
  'untitled page',
  'new page',
  'title',
  'page title',
  'create next app',
  'create react app',
  'react app',
  'next.js',
  'next app',
  'nuxt app',
  'vite app',
  'vite + react',
  'vite + vue',
  'svelte app',
  'my app',
  'my website',
  'website',
  'hello world',
  'lorem ipsum',
  'test',
  'tbd',
  'todo',
  'placeholder',
]);

/** Headings that describe nothing. */
const PLACEHOLDER_HEADINGS: ReadonlySet<string> = new Set([
  'heading',
  'title',
  'untitled',
  'section',
  'lorem ipsum',
  'placeholder',
  'todo',
  'tbd',
  'text',
]);

/** Link names that do not say where the link goes (WCAG technique F63/G91). */
const GENERIC_LINK_NAMES: ReadonlySet<string> = new Set([
  'click here',
  'click',
  'here',
  'read more',
  'more',
  'learn more',
  'more info',
  'more information',
  'see more',
  'details',
  'this link',
  'link',
  'go',
  'continue reading',
  '>>',
  '>',
  '...',
]);

/**
 * Instructions that rely on shape, size or position alone (1.3.3).
 *
 * Each requires an instruction verb AND a sensory word in the same clause. A
 * bare "below" is not a failure, so the patterns never match one on its own.
 */
const SENSORY_PATTERNS: readonly { readonly id: string; readonly re: RegExp }[] = [
  {
    id: 'position',
    re: /\b(click|tap|press|select|choose|use|see|refer to|check)\b[^.!?]{0,60}?\b(on|to|at|in|from)\s+the\s+(left|right|top|bottom|upper|lower)\b/i,
  },
  {
    id: 'shape',
    re: /\b(click|tap|press|select|choose|use|see)\b[^.!?]{0,40}?\bthe\s+(round|circular|square|rectangular|triangular|star[- ]shaped|oval)\s+(button|icon|link|control|shape)\b/i,
  },
  {
    id: 'colour',
    re: /\b(click|tap|press|select|choose|see)\b[^.!?]{0,40}?\bthe\s+(red|green|blue|yellow|orange|purple|pink|grey|gray|black|white)\s+(button|link|icon|box|field|text|area)\b/i,
  },
  {
    id: 'direction-only',
    re: /\b(the\s+)?(button|link|icon|menu|field|option|form)\s+(above|below|to the (left|right))\b\s*(to|and)?\s*\b(continue|proceed|submit|start|begin|apply)\b/i,
  },
];

/** BCP 47: a primary language subtag, optionally followed by subtags. */
const BCP47 = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

/**
 * `name`/`id`/`label` fragment -> the HTML autocomplete token it should carry.
 * WCAG 1.3.5 only requires this for fields collecting information about the
 * user, which is exactly what these patterns match.
 */
const INPUT_PURPOSES: readonly { readonly re: RegExp; readonly token: string; readonly label: string }[] = [
  { re: /\b(e[-_]?mail)\b|email/i, token: 'email', label: 'an email address' },
  { re: /\b(tel|phone|mobile|cell)\b/i, token: 'tel', label: 'a telephone number' },
  { re: /\b(first|given|fore)[-_ ]?name\b|\bfname\b/i, token: 'given-name', label: 'a given name' },
  { re: /\b(last|family|sur)[-_ ]?name\b|\blname\b/i, token: 'family-name', label: 'a family name' },
  { re: /\b(full[-_ ]?name)\b|^name$/i, token: 'name', label: "the user's name" },
  { re: /\b(address[-_ ]?(1|line[-_ ]?1)?|street)\b/i, token: 'address-line1', label: 'a street address' },
  { re: /\b(city|town|locality)\b/i, token: 'address-level2', label: 'a city' },
  { re: /\b(state|province|region|county)\b/i, token: 'address-level1', label: 'a state or region' },
  { re: /\b(zip|postal|postcode)\b/i, token: 'postal-code', label: 'a postal code' },
  { re: /\bcountry\b/i, token: 'country-name', label: 'a country' },
  { re: /\b(cc|card)[-_ ]?(number|num)\b/i, token: 'cc-number', label: 'a payment card number' },
  { re: /\b(cc|card)[-_ ]?exp/i, token: 'cc-exp', label: 'a card expiry date' },
  { re: /\b(cvc|cvv|security[-_ ]?code)\b/i, token: 'cc-csc', label: 'a card security code' },
  { re: /\b(username|user[-_ ]?id|login)\b/i, token: 'username', label: 'a username' },
  { re: /\b(birth|dob|date[-_ ]?of[-_ ]?birth)\b/i, token: 'bday', label: 'a date of birth' },
  { re: /\b(organi[sz]ation|company|employer)\b/i, token: 'organization', label: 'an organisation name' },
  { re: /\b(website|homepage|url)\b/i, token: 'url', label: 'a URL' },
];

/** Input `type` values that declare their own purpose. */
const TYPE_PURPOSES: Readonly<Record<string, { token: string; label: string }>> = {
  email: { token: 'email', label: 'an email address' },
  tel: { token: 'tel', label: 'a telephone number' },
  url: { token: 'url', label: 'a URL' },
  password: { token: 'current-password', label: 'a password' },
};

/**
 * Chrome's AX role names, normalised onto ARIA role names.
 *
 * `Accessibility.getFullAXTree` returns mostly ARIA role names but keeps some
 * internal PascalCase ones. Only the roles the checks below branch on are
 * listed; anything else falls through as its own lowercased name.
 */
const ROLE_ALIASES: Readonly<Record<string, string>> = {
  radiobutton: 'radio',
  togglebutton: 'button',
  disclosuretriangle: 'button',
  popupbutton: 'combobox',
  comboboxgrouping: 'combobox',
  comboboxselect: 'combobox',
  comboboxlist: 'combobox',
  textfieldwithcombobox: 'combobox',
  textfield: 'textbox',
  listboxoption: 'option',
  menulistoption: 'option',
  menulistpopup: 'listbox',
  statictext: 'text',
  rootwebarea: 'document',
  webarea: 'document',
  imagemaplink: 'link',
  genericcontainer: 'generic',
  image: 'img',
};

/** Roles whose accessible name is a 4.1.2 concern - commands and widgets. */
const COMMAND_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'treeitem',
  'option',
  'switch',
]);

/** Roles whose accessible name is a 3.3.2 concern - fields the user fills in. */
const FORM_FIELD_ROLES: ReadonlySet<string> = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'spinbutton',
  'slider',
  'checkbox',
  'radio',
]);

/**
 * Roles that cannot be announced correctly without a state property.
 *
 * Deliberately conservative: a plain `button` is not here, because a button
 * only needs `expanded` when it controls a disclosure, and TREE cannot tell
 * without driving it. That case is ACT's, across a transition.
 */
const REQUIRED_STATE_BY_ROLE: Readonly<Record<string, 'checked' | 'selected' | 'expanded'>> = {
  checkbox: 'checked',
  radio: 'checked',
  switch: 'checked',
  menuitemcheckbox: 'checked',
  menuitemradio: 'checked',
  tab: 'selected',
  combobox: 'expanded',
};

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** `1.4.10` sorts after `1.4.3`, not before. */
function compareCriterionId(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * A page URL reduced to what identifies the page across runs.
 *
 * The A8 delta matches baseline findings to final findings by key, and a key
 * embeds this. A fragment or a trailing slash must not split one page in two.
 */
export function normalisePageUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return trimmed.replace(/#.*$/, '').replace(/\/+$/, '');
  }
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  const clean = collapse(text);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Lowercased, punctuation-stripped, whitespace-collapsed. For text comparison.
 *
 * The punctuation class is written out rather than using `\p{P}`, which needs
 * an ES2018 target; letters outside ASCII are left alone so accented labels
 * still compare correctly.
 */
const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~…–—«»¿¡]+/g;

function normaliseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(PUNCTUATION, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseRole(role: string | null | undefined): string {
  if (!role) return '';
  const key = role.toLowerCase().replace(/[^a-z]/g, '');
  return ROLE_ALIASES[key] ?? key;
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || collapse(value) === '';
}

/**
 * A target string for a node that has no name and no selector.
 *
 * CDP AXNodeIds churn between captures, so an ordinal within the page's own
 * traversal order is the most stable identity available: it holds as long as
 * the number of unnamed controls of that role does not change, which is
 * precisely the thing a fix is supposed to change.
 */
function ordinalTarget(counters: Map<string, number>, role: string, name?: string | null): string {
  const label = collapse(name ?? '');
  if (label !== '') return `${role}:${label}`;
  const next = (counters.get(role) ?? 0) + 1;
  counters.set(role, next);
  return `${role}[${next}]`;
}

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

interface TreeNode {
  readonly nodeId: string;
  /** Canonical, lowercased role. Empty when the node declares none. */
  readonly role: string;
  readonly rawRole: string | null;
  readonly name: string | null;
  readonly ignored: boolean;
  readonly props: AxNodePropsLike;
}

/**
 * Everything a check reads, indexed once per page.
 *
 * Exported with `buildContext` so a single check can be exercised on a literal
 * without running the whole engine.
 */
export interface TreeContext {
  readonly input: TreePageInput;
  readonly pageUrl: string;
  readonly finalUrl: string;
  readonly title: string | null;
  readonly axeRan: boolean;
  readonly violationsByRule: ReadonlyMap<string, AxeViolationLike>;
  readonly violationsByCriterion: ReadonlyMap<string, readonly AxeViolationLike[]>;
  readonly incompleteRules: ReadonlySet<string>;
  /** Null when the caller supplied only violations, so "did it run" is inferred. */
  readonly ranRules: ReadonlySet<string> | null;
  readonly nodes: readonly TreeNode[];
  readonly hasTree: boolean;
  readonly doc: DocumentFacts;
  readonly hasDoc: boolean;
  readonly unmappedRules: string[];
  readonly warnings: string[];
}

export function buildContext(input: TreePageInput): TreeContext {
  const violationsByRule = new Map<string, AxeViolationLike>();
  const violationsByCriterion = new Map<string, AxeViolationLike[]>();
  const unmappedRules: string[] = [];
  const warnings: string[] = [...(input.warnings ?? [])];

  for (const violation of input.axeViolations ?? []) {
    violationsByRule.set(violation.id, violation);
    const criterion = criterionForAxeRule(violation.id, violation.tags);
    if (!criterion || !getCriterion(criterion)) {
      if (!unmappedRules.includes(violation.id)) unmappedRules.push(violation.id);
      continue;
    }
    const bucket = violationsByCriterion.get(criterion);
    if (bucket) bucket.push(violation);
    else violationsByCriterion.set(criterion, [violation]);
  }

  const incompleteRules = new Set((input.axeIncomplete ?? []).map((v) => v.id));

  let ranRules: Set<string> | null = null;
  if (input.axePasses) {
    ranRules = new Set<string>();
    for (const v of input.axePasses) ranRules.add(v.id);
    for (const id of violationsByRule.keys()) ranRules.add(id);
    for (const id of incompleteRules) ranRules.add(id);
  }

  const rawTree = input.axTree ?? {};
  const nodes: TreeNode[] = Object.values(rawTree).map((node) => ({
    nodeId: node.nodeId,
    role: normaliseRole(node.role),
    rawRole: node.role ?? null,
    name: node.name ?? null,
    ignored: node.ignored === true,
    props: node.props ?? {},
  }));

  return {
    input,
    pageUrl: input.url,
    finalUrl: input.finalUrl ?? input.url,
    title: input.title ?? input.document?.title ?? null,
    axeRan: input.axeViolations !== undefined,
    violationsByRule,
    violationsByCriterion,
    incompleteRules,
    ranRules,
    nodes,
    hasTree: nodes.length > 0,
    doc: input.document ?? {},
    hasDoc: input.document !== undefined,
    unmappedRules,
    warnings,
  };
}

/** Did this axe rule actually execute on this page? */
function axeRuleRan(ctx: TreeContext, ruleId: string): boolean {
  if (!ctx.axeRan) return false;
  if (ctx.ranRules) return ctx.ranRules.has(ruleId);
  return !AXE_RULES_OFF_BY_DEFAULT.includes(ruleId);
}

function axeRuleFired(ctx: TreeContext, ruleId: string): boolean {
  return ctx.violationsByRule.has(ruleId);
}

/* -------------------------------------------------------------------------- */
/* Finding construction                                                       */
/* -------------------------------------------------------------------------- */

interface FindingDraft {
  readonly criterion: string;
  readonly severity: Severity;
  /** `axe:color-contrast` or `tree:page-title`. Part of the identity key. */
  readonly rule: string;
  readonly summary: string;
  readonly detail?: string;
  readonly evidence: readonly FindingEvidence[];
  /**
   * Distinguishes several findings from one rule on one page, and must be the
   * same string on the baseline run and the final run for the A8 delta to match
   * them up. A CSS selector or a piece of visible text qualifies. A CDP
   * AXNodeId does not — Chrome reassigns those on every capture — so no check
   * in this file uses one as a target.
   */
  readonly target?: string;
  readonly needsConfirmation?: boolean;
  readonly sourcePath?: string;
}

/**
 * The only place a finding is constructed.
 *
 * Returns null - never a finding - when the criterion is not one of the 55, or
 * when there is no evidence. Non-negotiable rules 3 and 8 are enforced here so
 * no caller can bypass them.
 */
function buildFinding(pageUrl: string, draft: FindingDraft): AuditFinding | null {
  const criterion: Criterion | undefined = getCriterion(draft.criterion);
  if (!criterion) return null;
  if (draft.evidence.length === 0) return null;

  const target = draft.target ? collapse(draft.target).toLowerCase().slice(0, 160) : '';
  const key = `${criterion.id}|${normalisePageUrl(pageUrl)}|${draft.rule}|${target}`;

  return {
    key,
    criterion: criterion.id,
    criterionName: criterion.name,
    level: criterion.level,
    verdict: criterion.verdict,
    severity: draft.severity,
    agent: 'TREE',
    pageUrl,
    rule: draft.rule,
    summary: draft.summary,
    ...(draft.detail ? { detail: draft.detail } : {}),
    ...(draft.sourcePath ? { sourcePath: draft.sourcePath } : {}),
    evidence: draft.evidence,
    ...(draft.needsConfirmation ? { needsConfirmation: true } : {}),
  };
}

function axeEvidence(
  violation: AxeViolationLike,
  node: AxeNodeLike,
  extra?: Readonly<Record<string, string | number | boolean | null>>,
): FindingEvidence {
  return {
    kind: 'axe',
    source: violation.id,
    targets: [...(node.target ?? [])],
    ...(node.html ? { html: truncate(node.html, MAX_HTML_CHARS) } : {}),
    ...(node.failureSummary ? { failureSummary: truncate(node.failureSummary, 500) } : {}),
    ...(violation.helpUrl ? { helpUrl: violation.helpUrl } : {}),
    data: {
      rule: violation.id,
      impact: violation.impact ?? null,
      ...(extra ?? {}),
    },
  };
}

/** `Element has insufficient color contrast of 2.53 (...)` -> 2.53. */
function parseContrastRatio(summary: string | null | undefined): number | null {
  if (!summary) return null;
  const match = /contrast (?:ratio )?of ([\d.]+)/i.exec(summary);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Turn every axe violation filed under one criterion into findings.
 *
 * One finding per offending node, capped. The cap is recorded on the evidence
 * so a report can say "20 of 340 shown" rather than silently understating.
 */
function axeFindingsFor(
  ctx: TreeContext,
  criterion: string,
  options?: {
    readonly severityOverride?: Severity;
    readonly needsConfirmation?: boolean;
    readonly extra?: (violation: AxeViolationLike, node: AxeNodeLike) => Readonly<Record<string, string | number | boolean | null>>;
  },
): AuditFinding[] {
  const violations = ctx.violationsByCriterion.get(criterion) ?? [];
  const out: AuditFinding[] = [];

  for (const violation of violations) {
    const nodes = violation.nodes ?? [];
    const total = nodes.length;
    const shown = nodes.slice(0, MAX_NODES_PER_RULE);
    const severity = options?.severityOverride ?? severityFromAxeImpact(violation.impact);
    const help = collapse(violation.help ?? violation.description ?? violation.id);

    if (total === 0) {
      // A violation with no nodes is document-level (document-title, html-has-lang).
      const finding = buildFinding(ctx.pageUrl, {
        criterion,
        severity,
        rule: `axe:${violation.id}`,
        summary: help || `axe-core rule ${violation.id} failed`,
        detail: collapse(violation.description ?? ''),
        evidence: [
          {
            kind: 'axe',
            source: violation.id,
            targets: [],
            ...(violation.helpUrl ? { helpUrl: violation.helpUrl } : {}),
            data: { rule: violation.id, impact: violation.impact ?? null, occurrences: 0 },
          },
        ],
        ...(options?.needsConfirmation ? { needsConfirmation: true } : {}),
      });
      if (finding) out.push(finding);
      continue;
    }

    for (const node of shown) {
      const selector = node.target?.join(' ') ?? '';
      const finding = buildFinding(ctx.pageUrl, {
        criterion,
        severity,
        rule: `axe:${violation.id}`,
        summary: help || `axe-core rule ${violation.id} failed`,
        detail: collapse(node.failureSummary ?? violation.description ?? ''),
        target: selector,
        evidence: [
          axeEvidence(violation, node, {
            occurrences: total,
            truncated: total > shown.length,
            ...(options?.extra?.(violation, node) ?? {}),
          }),
        ],
        ...(options?.needsConfirmation ? { needsConfirmation: true } : {}),
      });
      if (finding) out.push(finding);
    }
  }

  return out;
}

export interface CheckResult {
  readonly findings: readonly AuditFinding[];
  /** Set when the check could not gather the evidence it needed. */
  readonly inconclusive?: string;
}

/* -------------------------------------------------------------------------- */
/* 1.1.1 Non-text Content - contributes                                       */
/* -------------------------------------------------------------------------- */

export function checkNonTextContent(ctx: TreeContext): CheckResult {
  if (!ctx.axeRan) {
    return { findings: [], inconclusive: 'axe-core did not run on this page.' };
  }
  return { findings: axeFindingsFor(ctx, '1.1.1', { needsConfirmation: true }) };
}

/* -------------------------------------------------------------------------- */
/* 1.3.1 Info and Relationships - contributes                                 */
/* -------------------------------------------------------------------------- */

export function checkInfoAndRelationships(ctx: TreeContext): CheckResult {
  if (!ctx.axeRan) {
    return { findings: [], inconclusive: 'axe-core did not run on this page.' };
  }
  return { findings: axeFindingsFor(ctx, '1.3.1', { needsConfirmation: true }) };
}

/* -------------------------------------------------------------------------- */
/* 1.3.3 Sensory Characteristics - decides                                    */
/* -------------------------------------------------------------------------- */

/**
 * "Click the round button on the right."
 *
 * Text is read off the accessibility tree, which is exactly the text a screen
 * reader user gets - the population the criterion protects. Each pattern needs
 * an instruction verb and a sensory word in the same clause, so ordinary prose
 * containing "below" does not fire.
 */
export function checkSensoryCharacteristics(ctx: TreeContext): CheckResult {
  if (!ctx.hasTree) {
    return {
      findings: [],
      inconclusive: 'No accessibility tree was captured, so no page text could be read.',
    };
  }

  const findings: AuditFinding[] = [];
  const seen = new Set<string>();

  for (const node of ctx.nodes) {
    if (node.ignored || isBlank(node.name)) continue;
    const text = collapse(node.name ?? '');
    if (text.length < 8 || text.length > MAX_TEXT_CHARS) continue;
    if (seen.has(text)) continue;

    for (const pattern of SENSORY_PATTERNS) {
      if (!pattern.re.test(text)) continue;
      seen.add(text);
      const finding = buildFinding(ctx.pageUrl, {
        criterion: '1.3.3',
        severity: 'moderate',
        rule: 'tree:sensory-characteristics',
        summary: 'An instruction identifies a control only by its shape, colour or position.',
        detail: `"${truncate(text, 160)}" relies on a ${pattern.id} cue. Name the control instead, so the instruction works when the layout changes or the page is read aloud.`,
        target: text,
        evidence: [
          {
            kind: 'axtree',
            source: 'tree:sensory-characteristics',
            targets: [node.nodeId],
            data: {
              text: truncate(text, MAX_TEXT_CHARS),
              cue: pattern.id,
              role: node.rawRole,
            },
          },
        ],
      });
      if (finding) findings.push(finding);
      break;
    }
    if (findings.length >= MAX_STRUCTURAL_FINDINGS) break;
  }

  return { findings };
}

/* -------------------------------------------------------------------------- */
/* 1.3.5 Identify Input Purpose - decides                                     */
/* -------------------------------------------------------------------------- */

function inferPurpose(field: FormFieldFact): { token: string; label: string } | null {
  const type = (field.type ?? '').toLowerCase();
  const byType = TYPE_PURPOSES[type];
  if (byType) return byType;

  const haystack = [field.name, field.id, field.label, field.placeholder]
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .join(' ');
  if (!haystack) return null;

  for (const purpose of INPUT_PURPOSES) {
    if (purpose.re.test(haystack)) return { token: purpose.token, label: purpose.label };
  }
  return null;
}

export function checkInputPurpose(ctx: TreeContext): CheckResult {
  const findings: AuditFinding[] = [...axeFindingsFor(ctx, '1.3.5')];

  const fields = ctx.doc.formFields;
  if (!fields) {
    const hasFieldsInTree = ctx.nodes.some((n) => !n.ignored && FORM_FIELD_ROLES.has(n.role));
    if (hasFieldsInTree) {
      return {
        findings,
        inconclusive:
          'The page exposes form fields but no field metadata was captured, so a missing autocomplete token cannot be seen. Capture `document.formFields`.',
      };
    }
    if (!axeRuleRan(ctx, 'autocomplete-valid')) {
      return { findings, inconclusive: 'axe-core rule `autocomplete-valid` did not run.' };
    }
    return { findings };
  }

  for (const field of fields) {
    if (findings.length >= MAX_STRUCTURAL_FINDINGS) break;
    const purpose = inferPurpose(field);
    if (!purpose) continue;

    const declared = collapse(field.autocomplete ?? '').toLowerCase();
    if (declared === '' || declared === 'off') {
      const finding = buildFinding(ctx.pageUrl, {
        criterion: '1.3.5',
        severity: 'moderate',
        rule: 'tree:input-purpose-missing',
        summary: `A field that collects ${purpose.label} does not declare its purpose.`,
        detail: `Add \`autocomplete="${purpose.token}"\` so assistive technology and the browser can fill or relabel it.${declared === 'off' ? ' `autocomplete="off"` does not satisfy 1.3.5.' : ''}`,
        target: field.selector,
        evidence: [
          {
            kind: 'dom',
            source: 'tree:input-purpose-missing',
            targets: [field.selector],
            data: {
              expected: purpose.token,
              declared: field.autocomplete ?? null,
              type: field.type ?? null,
              name: field.name ?? null,
              label: field.label ?? null,
            },
          },
        ],
      });
      if (finding) findings.push(finding);
      continue;
    }

    const tokens = declared.split(/\s+/);
    if (!tokens.includes(purpose.token)) {
      const finding = buildFinding(ctx.pageUrl, {
        criterion: '1.3.5',
        severity: 'minor',
        rule: 'tree:input-purpose-mismatch',
        summary: `A field that collects ${purpose.label} declares a different autocomplete purpose.`,
        detail: `Declared \`${declared}\`, expected \`${purpose.token}\`.`,
        target: field.selector,
        evidence: [
          {
            kind: 'dom',
            source: 'tree:input-purpose-mismatch',
            targets: [field.selector],
            data: { expected: purpose.token, declared, name: field.name ?? null },
          },
        ],
      });
      if (finding) findings.push(finding);
    }
  }

  return { findings };
}

/* -------------------------------------------------------------------------- */
/* 1.4.3 Contrast (Minimum) - decides                                         */
/* -------------------------------------------------------------------------- */

export function checkContrast(ctx: TreeContext): CheckResult {
  if (!axeRuleRan(ctx, 'color-contrast')) {
    return {
      findings: [],
      inconclusive:
        'axe-core rule `color-contrast` did not run on this page, so no contrast ratio was measured.',
    };
  }

  const findings = axeFindingsFor(ctx, '1.4.3', {
    extra: (_violation, node) => ({ measuredRatio: parseContrastRatio(node.failureSummary) }),
  });

  if (findings.length === 0 && ctx.incompleteRules.has('color-contrast')) {
    return {
      findings,
      inconclusive:
        'axe-core could not resolve the background behind some text - an image, gradient or canvas. Those elements need a VIS judgement before 1.4.3 can pass.',
    };
  }

  return { findings };
}

/* -------------------------------------------------------------------------- */
/* 1.4.10 Reflow - contributes                                                */
/* -------------------------------------------------------------------------- */

/** `width=1024, initial-scale=1, user-scalable=no` -> a lookup table. */
function parseViewportMeta(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of content.split(',')) {
    const [rawKey, rawValue] = part.split('=');
    if (rawKey === undefined || rawValue === undefined) continue;
    out[rawKey.trim().toLowerCase()] = rawValue.trim().toLowerCase();
  }
  return out;
}

export function checkReflow(ctx: TreeContext): CheckResult {
  const findings: AuditFinding[] = [];

  // Hard evidence first: the page was rendered narrow and scrolled sideways.
  if (ctx.doc.horizontalScrollAt320 === true) {
    const finding = buildFinding(ctx.pageUrl, {
      criterion: '1.4.10',
      severity: 'serious',
      rule: 'tree:reflow-horizontal-scroll',
      summary: 'The page scrolls sideways in a 320 CSS pixel viewport.',
      detail:
        'Content must reflow into a single column at 320px without two-dimensional scrolling. Measured document width: ' +
        `${ctx.doc.scrollWidthAt320 ?? 'unknown'}px.`,
      target: 'document',
      evidence: [
        {
          kind: 'dom',
          source: 'tree:reflow-horizontal-scroll',
          targets: ['html'],
          data: {
            viewportWidth: 320,
            scrollWidth: ctx.doc.scrollWidthAt320 ?? null,
          },
        },
      ],
    });
    if (finding) findings.push(finding);
  }

  const metaKnown = ctx.doc.metaViewport !== undefined;
  const meta = ctx.doc.metaViewport ?? null;

  if (metaKnown && meta === null) {
    const finding = buildFinding(ctx.pageUrl, {
      criterion: '1.4.10',
      severity: 'moderate',
      rule: 'tree:reflow-no-viewport-meta',
      summary: 'The page declares no viewport, so it renders at desktop width on a small screen.',
      detail:
        'Without `<meta name="viewport" content="width=device-width, initial-scale=1">` a mobile browser lays the page out at around 980px and scales it down, which is exactly the two-dimensional scrolling 1.4.10 forbids.',
      target: 'meta[name=viewport]',
      evidence: [
        {
          kind: 'document',
          source: 'tree:reflow-no-viewport-meta',
          targets: ['head'],
          data: { metaViewport: null },
        },
      ],
    });
    if (finding) findings.push(finding);
  } else if (meta) {
    const parsed = parseViewportMeta(meta);
    const width = parsed.width;
    const fixedWidth = width && width !== 'device-width' ? Number.parseInt(width, 10) : NaN;
    const maximumScale = Number.parseFloat(parsed['maximum-scale'] ?? '');
    const scalingLocked =
      parsed['user-scalable'] === 'no' ||
      parsed['user-scalable'] === '0' ||
      (Number.isFinite(maximumScale) && maximumScale < 2);

    if (Number.isFinite(fixedWidth) && fixedWidth > 320) {
      const finding = buildFinding(ctx.pageUrl, {
        criterion: '1.4.10',
        severity: 'serious',
        rule: 'tree:reflow-fixed-viewport-width',
        summary: `The viewport is pinned to ${fixedWidth}px, so the page cannot reflow to 320px.`,
        detail: 'Use `width=device-width` instead of a fixed pixel width.',
        target: 'meta[name=viewport]',
        evidence: [
          {
            kind: 'document',
            source: 'tree:reflow-fixed-viewport-width',
            targets: ['meta[name=viewport]'],
            data: { metaViewport: meta, width: fixedWidth },
          },
        ],
      });
      if (finding) findings.push(finding);
    }

    if (scalingLocked) {
      const finding = buildFinding(ctx.pageUrl, {
        criterion: '1.4.10',
        severity: 'serious',
        rule: 'tree:reflow-scaling-locked',
        summary: 'The viewport blocks zooming, which prevents the page reflowing.',
        detail:
          'Remove `user-scalable=no` and any `maximum-scale` below 2. The same declaration also fails 1.4.4 Resize Text, which axe reports separately.',
        target: 'meta[name=viewport]',
        evidence: [
          {
            kind: 'document',
            source: 'tree:reflow-scaling-locked',
            targets: ['meta[name=viewport]'],
            data: {
              metaViewport: meta,
              userScalable: parsed['user-scalable'] ?? null,
              maximumScale: parsed['maximum-scale'] ?? null,
            },
          },
        ],
      });
      if (finding) findings.push(finding);
    }
  } else if (axeRuleFired(ctx, 'meta-viewport')) {
    // No document facts, but axe already proved the viewport is locked. That is
    // enough to fail reflow; axe files the same node under 1.4.4 itself.
    const violation = ctx.violationsByRule.get('meta-viewport');
    const node = violation?.nodes?.[0];
    if (violation && node) {
      const finding = buildFinding(ctx.pageUrl, {
        criterion: '1.4.10',
        severity: 'serious',
        rule: 'tree:reflow-scaling-locked',
        summary: 'The viewport blocks zooming, which prevents the page reflowing.',
        detail: collapse(node.failureSummary ?? violation.help ?? ''),
        target: 'meta[name=viewport]',
        evidence: [axeEvidence(violation, node, { secondaryCriterion: '1.4.10' })],
      });
      if (finding) findings.push(finding);
    }
  }

  if (findings.length === 0 && ctx.doc.horizontalScrollAt320 == null) {
    return {
      findings,
      inconclusive:
        'TREE found no viewport lock. Confirming the page reflows needs it rendered at 320 CSS px, which is an ACT check.',
    };
  }

  return { findings };
}

/* -------------------------------------------------------------------------- */
/* 2.4.1 Bypass Blocks - contributes                                          */
/* -------------------------------------------------------------------------- */

export function checkBypassBlocks(ctx: TreeContext): CheckResult {
  const findings: AuditFinding[] = [
    ...axeFindingsFor(ctx, '2.4.1', { needsConfirmation: true }),
  ];

  const landmarkRoles = ctx.doc.landmarkRoles;
  const hasMain =
    (landmarkRoles ? landmarkRoles.some((r) => normaliseRole(r) === 'main') : false) ||
    ctx.nodes.some((n) => !n.ignored && n.role === 'main');

  const skipLinks = ctx.doc.skipLinks;
  const hasWorkingSkipLink = skipLinks ? skipLinks.some((l) => l.targetExists) : false;

  // Only speak where axe stayed silent, so one fault is not counted twice.
  if (!hasMain && !axeRuleFired(ctx, 'landmark-one-main') && !axeRuleFired(ctx, 'bypass')) {
    if (ctx.hasTree || landmarkRoles) {
      const finding = buildFinding(ctx.pageUrl, {
        criterion: '2.4.1',
        severity: 'serious',
        rule: 'tree:bypass-no-main',
        summary: 'The page exposes no `main` landmark to skip the repeated blocks to.',
        detail:
          'Wrap the page content in a `<main>` element. A landmark is the mechanism most screen reader users actually use to bypass a header and navigation.',
        target: 'document',
        evidence: [
          {
            kind: 'axtree',
            source: 'tree:bypass-no-main',
            targets: [],
            data: {
              landmarkRoles: (landmarkRoles ?? []).join(',') || null,
              treeNodes: ctx.nodes.length,
            },
          },
        ],
        needsConfirmation: true,
      });
      if (finding) findings.push(finding);
    }
  }

  if (skipLinks && skipLinks.length > 0 && !hasWorkingSkipLink) {
    const broken = skipLinks[0];
    const finding = buildFinding(ctx.pageUrl, {
      criterion: '2.4.1',
      severity: 'serious',
      rule: 'tree:bypass-skip-link-target-missing',
      summary: 'The skip link points at a target that does not exist on the page.',
      detail: `"${truncate(broken.text, 80)}" links to \`${broken.href}\`, which resolves to nothing. The link is announced but does nothing.`,
      target: broken.selector ?? broken.href,
      evidence: [
        {
          kind: 'dom',
          source: 'tree:bypass-skip-link-target-missing',
          targets: [broken.selector ?? broken.href],
          data: { text: truncate(broken.text, 80), href: broken.href, targetExists: false },
        },
      ],
      needsConfirmation: true,
    });
    if (finding) findings.push(finding);
  }

  return { findings };
}

/* -------------------------------------------------------------------------- */
/* 2.4.2 Page Titled - decides                                                */
/* -------------------------------------------------------------------------- */

export function checkPageTitle(ctx: TreeContext): CheckResult {
  const findings: AuditFinding[] = [...axeFindingsFor(ctx, '2.4.2')];
  const title = ctx.title;

  if (title === null) {
    if (axeRuleRan(ctx, 'document-title')) return { findings };
    return { findings, inconclusive: 'No page title was captured and axe did not run.' };
  }

  const trimmed = collapse(title);

  if (trimmed === '') {
    if (!axeRuleFired(ctx, 'document-title')) {
      const finding = buildFinding(ctx.pageUrl, {
        criterion: '2.4.2',
        severity: 'serious',
        rule: 'tree:page-title-empty',
        summary: 'The page has no title.',
        detail:
          'The title is the first thing announced on load and the only label a user has in a tab list or a history entry.',
        target: 'title',
        evidence: [
          {
            kind: 'document',
            source: 'tree:page-title-empty',
            targets: ['title'],
            data: { title: '' },
          },
        ],
      });
      if (finding) findings.push(finding);
    }
    return { findings };
  }

  if (PLACEHOLDER_TITLES.has(trimmed.toLowerCase())) {
    const finding = buildFinding(ctx.pageUrl, {
      criterion: '2.4.2',
      severity: 'serious',
      rule: 'tree:page-title-placeholder',
      summary: `The page title is a placeholder: "${truncate(trimmed, 60)}".`,
      detail:
        'A title has to describe this page. A framework default tells the user nothing and is identical on every page of the site.',
      target: 'title',
      evidence: [
        {
          kind: 'document',
          source: 'tree:page-title-placeholder',
          targets: ['title'],
          data: { title: truncate(trimmed, 120) },
        },
      ],
    });
    if (finding) findings.push(finding);
    return { findings };
  }

  if (trimmed.length < 3) {
    const finding = buildFinding(ctx.pageUrl, {
      criterion: '2.4.2',
      severity: 'minor',
      rule: 'tree:page-title-too-short',
      summary: `The page title "${trimmed}" is too short to describe the page.`,
      target: 'title',
      evidence: [
        {
          kind: 'document',
          source: 'tree:page-title-too-short',
          targets: ['title'],
          data: { title: trimmed, length: trimmed.length },
        },
      ],
    });
    if (finding) findings.push(finding);
  }

  return { findings };
}

/* -------------------------------------------------------------------------- */
/* 2.4.4 Link Purpose (In Context) - decides                                  */
/* -------------------------------------------------------------------------- */

export function checkLinkPurpose(ctx: TreeContext): CheckResult {
  const findings: AuditFinding[] = [...axeFindingsFor(ctx, '2.4.4')];

  if (ctx.hasTree) {
    for (const node of ctx.nodes) {
      if (findings.length >= MAX_STRUCTURAL_FINDINGS) break;
      if (node.ignored || node.role !== 'link') continue;
      const name = collapse(node.name ?? '');
      if (name === '') continue; // a nameless link is `axe:link-name`, already filed
      if (!GENERIC_LINK_NAMES.has(name.toLowerCase().replace(/[.…]+$/, ''))) continue;

      const finding = buildFinding(ctx.pageUrl, {
        criterion: '2.4.4',
        severity: 'moderate',
        rule: 'tree:link-purpose-generic',
        summary: `A link is announced only as "${truncate(name, 40)}".`,
        detail:
          'Screen reader users routinely pull up a list of every link on the page, where surrounding text is gone. Put the destination in the link text.',
        target: `link:${name}`,
        evidence: [
          {
            kind: 'axtree',
            source: 'tree:link-purpose-generic',
            targets: [node.nodeId],
            data: { accessibleName: truncate(name, 120), role: node.rawRole },
          },
        ],
      });
      if (finding) findings.push(finding);
    }
  }

  const links = ctx.doc.links;
  if (links) {
    const byName = new Map<string, Set<string>>();
    for (const link of links) {
      const name = normaliseText(link.name);
      if (name === '') continue;
      const bucket = byName.get(name) ?? new Set<string>();
      bucket.add(link.href);
      byName.set(name, bucket);
    }
    for (const [name, hrefs] of byName) {
      if (hrefs.size < 2) continue;
      if (findings.length >= MAX_STRUCTURAL_FINDINGS) break;
      const finding = buildFinding(ctx.pageUrl, {
        criterion: '2.4.4',
        severity: 'moderate',
        rule: 'tree:link-purpose-ambiguous',
        summary: `${hrefs.size} links share the name "${truncate(name, 40)}" but go to different places.`,
        detail: `Destinations: ${[...hrefs].slice(0, 5).join(', ')}.`,
        target: name,
        evidence: [
          {
            kind: 'dom',
            source: 'tree:link-purpose-ambiguous',
            targets: [...hrefs].slice(0, 5),
            data: { accessibleName: name, destinations: hrefs.size },
          },
        ],
      });
      if (finding) findings.push(finding);
    }
  }

  if (!ctx.hasTree && !links && !axeRuleRan(ctx, 'link-name')) {
    return { findings, inconclusive: 'No accessibility tree, link list or axe result was captured.' };
  }

  return { findings };
}

/* -------------------------------------------------------------------------- */
/* 2.4.6 Headings and Labels - decides                                        */
/* -------------------------------------------------------------------------- */

export function checkHeadingsAndLabels(ctx: TreeContext): CheckResult {
  const findings: AuditFinding[] = [...axeFindingsFor(ctx, '2.4.6')];

  const emptyHeadingFired = axeRuleFired(ctx, 'empty-heading');
  const counters = new Map<string, number>();

  if (ctx.hasTree) {
    for (const node of ctx.nodes) {
      if (findings.length >= MAX_STRUCTURAL_FINDINGS) break;
      if (node.ignored || node.role !== 'heading') continue;
      const name = collapse(node.name ?? '');

      if (name === '' && !emptyHeadingFired) {
        const finding = buildFinding(ctx.pageUrl, {
          criterion: '2.4.6',
          severity: 'moderate',
          rule: 'tree:heading-empty',
          summary: 'A heading has no accessible name.',
          detail:
            'An empty heading still appears in the heading list a screen reader user navigates by, as a blank entry.',
          target: ordinalTarget(counters, 'heading'),
          evidence: [
            {
              kind: 'axtree',
              source: 'tree:heading-empty',
              targets: [node.nodeId],
              data: { role: node.rawRole, accessibleName: null },
            },
          ],
        });
        if (finding) findings.push(finding);
        continue;
      }

      if (name !== '' && PLACEHOLDER_HEADINGS.has(name.toLowerCase())) {
        const finding = buildFinding(ctx.pageUrl, {
          criterion: '2.4.6',
          severity: 'minor',
          rule: 'tree:heading-placeholder',
          summary: `A heading reads "${truncate(name, 40)}", which describes nothing.`,
          target: `heading:${name}`,
          evidence: [
            {
              kind: 'axtree',
              source: 'tree:heading-placeholder',
              targets: [node.nodeId],
              data: { accessibleName: truncate(name, 120) },
            },
          ],
        });
        if (finding) findings.push(finding);
      }
    }
  }

  const headings = ctx.doc.headings;
  if (headings) {
    for (const heading of headings) {
      if (findings.length >= MAX_STRUCTURAL_FINDINGS) break;
      const text = collapse(heading.text);
      if (text !== '' && !PLACEHOLDER_HEADINGS.has(text.toLowerCase())) continue;
      const finding = buildFinding(ctx.pageUrl, {
        criterion: '2.4.6',
        severity: text === '' ? 'moderate' : 'minor',
        rule: text === '' ? 'tree:heading-empty' : 'tree:heading-placeholder',
        summary:
          text === ''
            ? `An h${heading.level} has no text.`
            : `An h${heading.level} reads "${truncate(text, 40)}", which describes nothing.`,
        target: heading.selector ?? `h${heading.level}:${text}`,
        evidence: [
          {
            kind: 'dom',
            source: 'tree:heading-text',
            targets: [heading.selector ?? `h${heading.level}`],
            data: { level: heading.level, text: truncate(text, 120) },
          },
        ],
      });
      if (finding) findings.push(finding);
    }
  }

  if (!ctx.hasTree && !headings && !ctx.axeRan) {
    return { findings, inconclusive: 'No accessibility tree, heading list or axe result was captured.' };
  }

  return { findings };
}

/* -------------------------------------------------------------------------- */
/* 2.5.3 Label in Name - contributes                                          */
/* -------------------------------------------------------------------------- */

export function checkLabelInName(ctx: TreeContext): CheckResult {
  const findings: AuditFinding[] = [
    ...axeFindingsFor(ctx, '2.5.3', { needsConfirmation: true }),
  ];

  const controls = ctx.doc.labelledControls;
  if (controls) {
    for (const control of controls) {
      if (findings.length >= MAX_STRUCTURAL_FINDINGS) break;
      const visible = normaliseText(control.visibleText);
      const spoken = normaliseText(control.accessibleName);
      if (visible === '' || spoken === '') continue;
      if (spoken.includes(visible)) continue;

      const finding = buildFinding(ctx.pageUrl, {
        criterion: '2.5.3',
        severity: 'serious',
        rule: 'tree:label-in-name',
        summary: `A control reads "${truncate(control.visibleText, 40)}" but is announced as "${truncate(control.accessibleName, 40)}".`,
        detail:
          'A speech-input user says what they can see. When the accessible name does not contain the visible label, the command does not reach the control.',
        target: control.selector,
        evidence: [
          {
            kind: 'dom',
            source: 'tree:label-in-name',
            targets: [control.selector],
            data: {
              visibleText: truncate(control.visibleText, 120),
              accessibleName: truncate(control.accessibleName, 120),
              role: control.role ?? null,
            },
          },
        ],
        needsConfirmation: true,
      });
      if (finding) findings.push(finding);
    }
  } else if (!axeRuleRan(ctx, 'label-content-name-mismatch')) {
    return {
      findings,
      inconclusive:
        'Neither axe `label-content-name-mismatch` nor captured visible-text pairs were available.',
    };
  }

  return { findings };
}

/* -------------------------------------------------------------------------- */
/* 2.5.8 Target Size (Minimum) - decides                                      */
/* -------------------------------------------------------------------------- */

const MIN_TARGET_PX = 24;

export function checkTargetSize(ctx: TreeContext): CheckResult {
  const findings: AuditFinding[] = [...axeFindingsFor(ctx, '2.5.8')];

  const targets = ctx.doc.targets;
  if (targets) {
    for (const target of targets) {
      if (findings.length >= MAX_STRUCTURAL_FINDINGS) break;
      if (target.exempt || target.inline) continue;
      const tooSmall = target.width < MIN_TARGET_PX || target.height < MIN_TARGET_PX;
      if (!tooSmall) continue;
      // Spacing exception: an undersized target passes when a 24px circle
      // centred on it overlaps no other target.
      if (typeof target.spacing === 'number' && target.spacing >= MIN_TARGET_PX) continue;

      const finding = buildFinding(ctx.pageUrl, {
        criterion: '2.5.8',
        severity: 'serious',
        rule: 'tree:target-size',
        summary: `A pointer target is ${Math.round(target.width)}x${Math.round(target.height)} CSS pixels, under the 24x24 minimum.`,
        detail: `${target.name ? `"${truncate(target.name, 40)}" ` : ''}Enlarge the target, add padding, or leave at least 24px of clear space around it.`,
        target: target.selector,
        evidence: [
          {
            kind: 'dom',
            source: 'tree:target-size',
            targets: [target.selector],
            data: {
              width: Math.round(target.width),
              height: Math.round(target.height),
              minimum: MIN_TARGET_PX,
              spacing: target.spacing ?? null,
              role: target.role ?? null,
            },
          },
        ],
      });
      if (finding) findings.push(finding);
    }
    return { findings };
  }

  if (!axeRuleRan(ctx, 'target-size')) {
    return {
      findings,
      inconclusive:
        'axe-core ships `target-size` disabled by default and no target measurements were captured, so no target was measured. Enable the rule in the axe run, or capture `document.targets`.',
    };
  }

  return { findings };
}

/* -------------------------------------------------------------------------- */
/* 3.1.1 Language of Page - decides                                           */
/* -------------------------------------------------------------------------- */

export function checkPageLanguage(ctx: TreeContext): CheckResult {
  const findings: AuditFinding[] = [...axeFindingsFor(ctx, '3.1.1')];
  const lang = ctx.doc.lang;

  if (lang === undefined) {
    if (axeRuleRan(ctx, 'html-has-lang')) return { findings };
    return {
      findings,
      inconclusive: 'The `<html lang>` attribute was not captured and axe did not run.',
    };
  }

  const declared = collapse(lang ?? '');

  if (declared === '' && !axeRuleFired(ctx, 'html-has-lang')) {
    const finding = buildFinding(ctx.pageUrl, {
      criterion: '3.1.1',
      severity: 'serious',
      rule: 'tree:page-language-missing',
      summary: 'The `<html>` element declares no language.',
      detail:
        'Without a language a screen reader reads the page in whatever voice it happens to be set to, which makes ordinary text unintelligible.',
      target: 'html',
      evidence: [
        {
          kind: 'document',
          source: 'tree:page-language-missing',
          targets: ['html'],
          data: { lang: null },
        },
      ],
    });
    if (finding) findings.push(finding);
    return { findings };
  }

  if (declared !== '' && !BCP47.test(declared) && !axeRuleFired(ctx, 'html-lang-valid')) {
    const finding = buildFinding(ctx.pageUrl, {
      criterion: '3.1.1',
      severity: 'serious',
      rule: 'tree:page-language-invalid',
      summary: `The page declares \`lang="${truncate(declared, 40)}"\`, which is not a valid language tag.`,
      detail: 'Use a BCP 47 tag such as `en`, `en-GB` or `es-419`.',
      target: 'html',
      evidence: [
        {
          kind: 'document',
          source: 'tree:page-language-invalid',
          targets: ['html'],
          data: { lang: truncate(declared, 40) },
        },
      ],
    });
    if (finding) findings.push(finding);
  }

  const xmlLang = collapse(ctx.doc.xmlLang ?? '');
  if (
    declared !== '' &&
    xmlLang !== '' &&
    declared.split('-')[0].toLowerCase() !== xmlLang.split('-')[0].toLowerCase() &&
    !axeRuleFired(ctx, 'html-xml-lang-mismatch')
  ) {
    const finding = buildFinding(ctx.pageUrl, {
      criterion: '3.1.1',
      severity: 'moderate',
      rule: 'tree:page-language-mismatch',
      summary: `\`lang="${declared}"\` and \`xml:lang="${xmlLang}"\` name different languages.`,
      target: 'html',
      evidence: [
        {
          kind: 'document',
          source: 'tree:page-language-mismatch',
          targets: ['html'],
          data: { lang: declared, xmlLang },
        },
      ],
    });
    if (finding) findings.push(finding);
  }

  return { findings };
}

/* -------------------------------------------------------------------------- */
/* 3.1.2 Language of Parts - decides                                          */
/* -------------------------------------------------------------------------- */

/**
 * TREE checks that every `lang` attribute inside the document is well formed.
 *
 * It cannot detect a foreign phrase that carries no `lang` at all - that needs
 * language identification over the page text, which is not deterministic. A
 * pass here therefore means "no malformed language markup", and the audit
 * records that caveat as a page warning rather than overstating the result.
 */
export function checkLanguageOfParts(ctx: TreeContext): CheckResult {
  const findings: AuditFinding[] = [...axeFindingsFor(ctx, '3.1.2')];

  const parts = ctx.doc.langParts;
  if (parts) {
    for (const part of parts) {
      if (findings.length >= MAX_STRUCTURAL_FINDINGS) break;
      const value = collapse(part.lang);
      if (value !== '' && BCP47.test(value)) continue;
      const finding = buildFinding(ctx.pageUrl, {
        criterion: '3.1.2',
        severity: 'moderate',
        rule: 'tree:language-of-parts-invalid',
        summary: `An element declares \`lang="${truncate(value, 40)}"\`, which is not a valid language tag.`,
        target: part.selector,
        evidence: [
          {
            kind: 'dom',
            source: 'tree:language-of-parts-invalid',
            targets: [part.selector],
            data: { lang: truncate(value, 40) },
          },
        ],
      });
      if (finding) findings.push(finding);
    }
    return { findings };
  }

  if (!axeRuleRan(ctx, 'valid-lang')) {
    return { findings, inconclusive: 'axe-core rule `valid-lang` did not run.' };
  }

  return { findings };
}

/* -------------------------------------------------------------------------- */
/* 3.3.2 Labels or Instructions - contributes                                 */
/* -------------------------------------------------------------------------- */

export function checkLabelsOrInstructions(ctx: TreeContext): CheckResult {
  const findings: AuditFinding[] = [
    ...axeFindingsFor(ctx, '3.3.2', { needsConfirmation: true }),
  ];

  if (!ctx.hasTree) {
    if (!ctx.axeRan) {
      return { findings, inconclusive: 'No accessibility tree and no axe result were captured.' };
    }
    return { findings };
  }

  // axe `label` files under 4.1.2; the tree check catches fields axe cannot
  // reach, such as a custom widget with role="combobox" and no native input.
  const labelFired = axeRuleFired(ctx, 'label') || axeRuleFired(ctx, 'select-name');
  if (labelFired) return { findings };

  const counters = new Map<string, number>();

  for (const node of ctx.nodes) {
    if (findings.length >= MAX_STRUCTURAL_FINDINGS) break;
    if (node.ignored || !FORM_FIELD_ROLES.has(node.role)) continue;
    if (!isBlank(node.name)) continue;

    const finding = buildFinding(ctx.pageUrl, {
      criterion: '3.3.2',
      severity: 'critical',
      rule: 'tree:field-unlabelled',
      summary: `A \`${node.role}\` field has no accessible name.`,
      detail:
        'The field is announced only as its role, so the user is told there is something to fill in but not what.',
      target: ordinalTarget(counters, node.role),
      evidence: [
        {
          kind: 'axtree',
          source: 'tree:field-unlabelled',
          targets: [node.nodeId],
          data: { role: node.rawRole, accessibleName: null },
        },
      ],
      needsConfirmation: true,
    });
    if (finding) findings.push(finding);
  }

  return { findings };
}

/* -------------------------------------------------------------------------- */
/* 4.1.2 Name, Role, Value - malformed markup - contributes                   */
/* -------------------------------------------------------------------------- */

/**
 * The half of 4.1.2 that is visible without touching anything.
 *
 * Three sources:
 *   - every axe rule that resolves to 4.1.2 (invalid ARIA attributes and
 *     values, nameless buttons, nested interactives, unlabelled frames);
 *   - a command role in the tree with no accessible name;
 *   - a role that cannot be announced without a state property where that
 *     property is absent entirely - a checkbox that is neither checked nor
 *     unchecked, a tab that is neither selected nor not.
 *
 * The other half of 4.1.2 - a control that changes the page without changing
 * its own state attribute - only exists across a transition and belongs to ACT.
 */
export function checkMarkup(ctx: TreeContext): CheckResult {
  const findings: AuditFinding[] = [
    ...axeFindingsFor(ctx, '4.1.2', { needsConfirmation: true }),
  ];

  if (!ctx.hasTree) {
    if (!ctx.axeRan) {
      return { findings, inconclusive: 'No accessibility tree and no axe result were captured.' };
    }
    return { findings };
  }

  const nameRuleFired =
    axeRuleFired(ctx, 'button-name') ||
    axeRuleFired(ctx, 'link-name') ||
    axeRuleFired(ctx, 'aria-command-name') ||
    axeRuleFired(ctx, 'aria-toggle-field-name');

  const counters = new Map<string, number>();
  let structural = 0;

  for (const node of ctx.nodes) {
    if (structural >= MAX_STRUCTURAL_FINDINGS) break;
    if (node.ignored) continue;

    if (COMMAND_ROLES.has(node.role) && isBlank(node.name) && !nameRuleFired) {
      const finding = buildFinding(ctx.pageUrl, {
        criterion: '4.1.2',
        severity: 'critical',
        rule: 'tree:control-unnamed',
        summary: `A \`${node.role}\` exposes no accessible name.`,
        detail:
          'Assistive technology announces the role and nothing else, so the control is reachable but unidentifiable.',
        target: ordinalTarget(counters, node.role),
        evidence: [
          {
            kind: 'axtree',
            source: 'tree:control-unnamed',
            targets: [node.nodeId],
            data: { role: node.rawRole, accessibleName: null },
          },
        ],
        needsConfirmation: true,
      });
      if (finding) {
        findings.push(finding);
        structural++;
      }
      continue;
    }

    const requiredState = REQUIRED_STATE_BY_ROLE[node.role];
    if (requiredState) {
      const value = node.props[requiredState];
      if (value === null || value === undefined) {
        const finding = buildFinding(ctx.pageUrl, {
          criterion: '4.1.2',
          severity: 'serious',
          rule: 'tree:control-state-absent',
          summary: `A \`${node.role}\` exposes no \`${requiredState}\` state.`,
          detail: `${node.name ? `"${truncate(node.name, 40)}" ` : ''}The role promises a state that assistive technology can read, and the property is absent rather than false. The control cannot report what it is doing.`,
          target: ordinalTarget(counters, `${node.role}-${requiredState}`, node.name),
          evidence: [
            {
              kind: 'axtree',
              source: 'tree:control-state-absent',
              targets: [node.nodeId],
              data: {
                role: node.rawRole,
                accessibleName: node.name ? truncate(node.name, 120) : null,
                missingState: requiredState,
              },
            },
          ],
          needsConfirmation: true,
        });
        if (finding) {
          findings.push(finding);
          structural++;
        }
      }
    }
  }

  return { findings };
}

/* -------------------------------------------------------------------------- */
/* Findings for criteria other lanes own                                      */
/* -------------------------------------------------------------------------- */

/**
 * An axe violation is hard evidence whoever owns the criterion.
 *
 * Discarding a proven 2.1.1 or 1.4.4 failure because TREE is not the owning
 * lane would lose a real finding. These are emitted with `needsConfirmation`
 * set, so the owning lane can add detail without the score double-counting -
 * the identity key is the same one that lane would produce for the same node.
 */
function axePassthrough(ctx: TreeContext): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const [criterion] of ctx.violationsByCriterion) {
    if (TREE_CRITERIA.includes(criterion)) continue;
    out.push(...axeFindingsFor(ctx, criterion, { needsConfirmation: true }));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The engine                                                                 */
/* -------------------------------------------------------------------------- */

type Check = (ctx: TreeContext) => CheckResult;

/** Criterion -> check. Every criterion in `TREE_CRITERIA` appears exactly once. */
const CHECKS: ReadonlyArray<readonly [string, Check]> = [
  ['1.1.1', checkNonTextContent],
  ['1.3.1', checkInfoAndRelationships],
  ['1.3.3', checkSensoryCharacteristics],
  ['1.3.5', checkInputPurpose],
  ['1.4.3', checkContrast],
  ['1.4.10', checkReflow],
  ['2.4.1', checkBypassBlocks],
  ['2.4.2', checkPageTitle],
  ['2.4.4', checkLinkPurpose],
  ['2.4.6', checkHeadingsAndLabels],
  ['2.5.3', checkLabelInName],
  ['2.5.8', checkTargetSize],
  ['3.1.1', checkPageLanguage],
  ['3.1.2', checkLanguageOfParts],
  ['3.3.2', checkLabelsOrInstructions],
  ['4.1.2', checkMarkup],
];

/**
 * Run the deterministic gate over one page.
 *
 * Pure: same input, same output, no clock, no network, no database. A
 * `PageCapture` from `lib/browser` can be handed straight in.
 */
export function auditPage(input: TreePageInput): PageAudit {
  const ctx = buildContext(input);

  const findings: AuditFinding[] = [];
  const passed: string[] = [];
  const failed: string[] = [];
  const inconclusive: InconclusiveCriterion[] = [];

  for (const [criterion, check] of CHECKS) {
    const result = check(ctx);
    findings.push(...result.findings);

    if (result.findings.length > 0) {
      failed.push(criterion);
      continue;
    }
    if (result.inconclusive) {
      inconclusive.push({ criterion, reason: result.inconclusive });
      continue;
    }
    const contributesReason = TREE_CONTRIBUTES[criterion];
    if (contributesReason) {
      inconclusive.push({ criterion, reason: contributesReason });
      continue;
    }
    passed.push(criterion);
  }

  findings.push(...axePassthrough(ctx));

  // Two checks can reach the same node by different routes; the key makes that
  // visible and this makes it harmless.
  const deduped: AuditFinding[] = [];
  const seenKeys = new Set<string>();
  for (const finding of findings) {
    if (seenKeys.has(finding.key)) continue;
    seenKeys.add(finding.key);
    deduped.push(finding);
  }

  const bySeverity = emptySeverityCounts();
  for (const finding of deduped) bySeverity[finding.severity] += 1;

  const warnings = [...ctx.warnings];
  if (passed.includes('3.1.2')) {
    warnings.push(
      '3.1.2 passed on markup validity only. An unmarked foreign-language phrase needs language identification, which is not a deterministic check.',
    );
  }
  if (!ctx.axeRan) {
    warnings.push('No axe-core result was supplied; TREE decided only what the tree and DOM facts showed.');
  }
  if (!ctx.hasTree) {
    warnings.push('No accessibility tree was supplied; the structural checks did not run.');
  }

  return {
    pageUrl: ctx.pageUrl,
    finalUrl: ctx.finalUrl,
    title: ctx.title,
    findings: deduped,
    passed: passed.sort(compareCriterionId),
    failed: failed.sort(compareCriterionId),
    inconclusive: inconclusive.sort((a, b) => compareCriterionId(a.criterion, b.criterion)),
    findingsBySeverity: bySeverity,
    unmappedAxeRules: ctx.unmappedRules,
    warnings,
  };
}

/** The whole crawl. Order in, order out. */
export function auditPages(inputs: readonly TreePageInput[]): PageAudit[] {
  return inputs.map(auditPage);
}

/** Every finding from every page, flattened, ready for the ledger. */
export function treeFindings(inputs: readonly TreePageInput[]): AuditFinding[] {
  return auditPages(inputs).flatMap((page) => [...page.findings]);
}

/**
 * Criteria TREE settled across the whole crawl.
 *
 * A criterion passes only when every page passed it. One inconclusive page is
 * enough to withhold the pass - the run must not report a criterion clean on
 * the strength of the pages that happened to be measurable.
 */
export function treeCoverage(audits: readonly PageAudit[]): {
  passed: string[];
  failed: string[];
  inconclusive: InconclusiveCriterion[];
} {
  const failed = new Set<string>();
  const inconclusive = new Map<string, string>();
  const passed = new Set<string>();

  for (const audit of audits) {
    for (const c of audit.failed) failed.add(c);
    for (const c of audit.inconclusive) if (!inconclusive.has(c.criterion)) inconclusive.set(c.criterion, c.reason);
    for (const c of audit.passed) passed.add(c);
  }

  for (const c of failed) {
    passed.delete(c);
    inconclusive.delete(c);
  }
  for (const c of inconclusive.keys()) passed.delete(c);

  return {
    passed: [...passed].sort(compareCriterionId),
    failed: [...failed].sort(compareCriterionId),
    inconclusive: [...inconclusive]
      .map(([criterion, reason]) => ({ criterion, reason }))
      .sort((a, b) => compareCriterionId(a.criterion, b.criterion)),
  };
}

/* -------------------------------------------------------------------------- */
/* Integrity assertion - runs at module load                                  */
/* -------------------------------------------------------------------------- */

/**
 * The check table and the criteria table must not drift.
 *
 * If someone assigns a tenth criterion to the TREE lane in criteria.ts without
 * writing a check for it here, the build fails rather than the run silently
 * reporting that criterion as never evaluated.
 */
(function assertTreeCoverage(): void {
  const problems: string[] = [];
  const covered = new Set(CHECKS.map(([criterion]) => criterion));

  if (covered.size !== CHECKS.length) problems.push('duplicate criterion in the check table');

  for (const criterion of TREE_DECIDES) {
    if (!covered.has(criterion)) {
      problems.push(`${criterion} is owned by the TREE lane but has no check`);
    }
    if (TREE_CONTRIBUTES[criterion]) {
      problems.push(`${criterion} is listed as both decided and contributed`);
    }
  }

  for (const criterion of Object.keys(TREE_CONTRIBUTES)) {
    if (!covered.has(criterion)) problems.push(`${criterion} is contributed to but has no check`);
  }

  for (const criterion of covered) {
    requireCriterion(criterion); // throws if it is not one of the 55
    if (!TREE_CRITERIA.includes(criterion)) {
      problems.push(`${criterion} has a check but is in neither TREE list`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`TREE check table is invalid:\n  - ${problems.join('\n  - ')}`);
  }
})();
