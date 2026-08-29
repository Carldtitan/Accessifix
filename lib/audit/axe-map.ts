/**
 * axe-core rule -> WCAG success criterion.
 *
 * axe carries its criterion in a tag: `wcag143` is 1.4.3, `wcag412` is 4.1.2,
 * `wcag1410` is 1.4.10. The level tags (`wcag2a`, `wcag21aa`, `wcag22aa`) look
 * similar and are not criteria — the parser rejects anything after `wcag` that
 * is not all digits.
 *
 * Three layers, checked in order by `criterionForAxeRule`:
 *
 *   1. `AXE_RULE_OVERRIDES` — hand-written. Rules whose tags are ambiguous
 *      (more than one criterion tag) or absent (axe's `best-practice` rules
 *      carry no `wcag*` tag at all but map cleanly onto a criterion for our
 *      purposes).
 *   2. The tags on the violation itself, parsed live. Survives an axe upgrade
 *      that adds rules this file has never heard of.
 *   3. `AXE_TAG_DERIVED_CRITERIA` — the static table for all 105 rules shipped
 *      in axe-core 4.13.0, derived from those same tags. The fallback for when
 *      a caller has a rule id but no tags.
 *
 * Only the 55 Level A/AA criteria exist here. A rule whose only criterion is
 * AAA (`color-contrast-enhanced` -> 1.4.6) or a criterion WCAG 2.2 removed
 * (`duplicate-id` -> 4.1.1) resolves to `null` and is dropped rather than
 * mis-filed: non-negotiable rule 3 says a finding cites one of the 55 or it is
 * not a finding.
 */

import { getCriterion } from '@/lib/db/criteria';
import type { Severity } from './types';

/* -------------------------------------------------------------------------- */
/* Impact -> severity                                                         */
/* -------------------------------------------------------------------------- */

export const AXE_IMPACTS = ['critical', 'serious', 'moderate', 'minor'] as const;
export type AxeImpact = (typeof AXE_IMPACTS)[number];

/**
 * axe's four impacts happen to be the ledger's four severities, so this is an
 * identity mapping with a guard. It exists as a function because axe types
 * `impact` as `string | null` — a null impact (axe omits it on some
 * `incomplete` results) must not become `undefined` in a NOT NULL column.
 */
export function severityFromAxeImpact(impact: string | null | undefined): Severity {
  switch (impact) {
    case 'critical':
      return 'critical';
    case 'serious':
      return 'serious';
    case 'moderate':
      return 'moderate';
    case 'minor':
      return 'minor';
    default:
      /** Unknown or absent. `moderate` is the middle of the scale, not a guess upward. */
      return 'moderate';
  }
}

/* -------------------------------------------------------------------------- */
/* Tag parsing                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `wcag412` -> `4.1.2`, `wcag1410` -> `1.4.10`, `wcag2411` -> `2.4.11`.
 *
 * The split is unambiguous because WCAG principles are 1-4 and every guideline
 * number is a single digit; only the criterion number reaches two digits. Level
 * tags (`wcag2a`, `wcag21aa`) fail the all-digits test and return null.
 */
export function parseAxeWcagTag(tag: string): string | null {
  const match = /^wcag(\d{3,5})$/.exec(tag.trim());
  if (!match) return null;
  const digits = match[1];
  const principle = digits[0];
  const guideline = digits[1];
  const criterion = digits.slice(2);
  if (principle === '0' || guideline === '0' || criterion.startsWith('0')) return null;
  return `${principle}.${guideline}.${criterion}`;
}

/**
 * Every criterion the tag list names, in tag order, restricted to the 55 and
 * deduplicated. Empty when the tags carry no criterion we track.
 */
export function criteriaFromAxeTags(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  const out: string[] = [];
  for (const tag of tags) {
    const parsed = parseAxeWcagTag(tag);
    if (!parsed) continue;
    if (!getCriterion(parsed)) continue; // AAA, or removed in WCAG 2.2
    if (!out.includes(parsed)) out.push(parsed);
  }
  return out;
}

/**
 * The single criterion a finding should cite, taken from the tags alone.
 *
 * axe lists criterion tags in significance order, so the first in-scope tag is
 * the primary one. Where that ordering is wrong for our lanes the rule appears
 * in `AXE_RULE_OVERRIDES` and `criterionForAxeRule` never reaches this.
 */
export function criterionFromAxeTags(tags: readonly string[] | undefined): string | null {
  return criteriaFromAxeTags(tags)[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Hand-written overrides                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Rules whose tags do not give the right answer on their own.
 *
 * Two kinds live here and nothing else:
 *
 *   (a) Ambiguous — the rule carries two criterion tags and axe's ordering puts
 *       the wrong one first for how AccessiFix routes work.
 *   (b) Untagged — axe's `best-practice` rules have no `wcag*` tag. They still
 *       fire on real, deterministic markup faults, so each is filed under the
 *       criterion it actually evidences, or left `null` where it evidences none.
 *
 * A `null` value is a deliberate decision that the rule maps to no Level A/AA
 * criterion. It suppresses the tag fallback, so it must stay explicit.
 */
export const AXE_RULE_OVERRIDES: Readonly<Record<string, string | null>> = {
  /* -- (a) ambiguous: two criterion tags ---------------------------------- */

  /** Tagged 2.4.4 + 4.1.2. An `<area>` without alt text is missing non-text content first. */
  'area-alt': '1.1.1',
  /** Tagged 1.3.1 + 4.1.2. `aria-hidden` on <body> removes every name and role from AT. */
  'aria-hidden-body': '4.1.2',
  /** Tagged 1.1.1 + 4.1.2. axe's own order is right; pinned so an upgrade cannot flip it. */
  'input-image-alt': '1.1.1',
  /** Tagged 2.1.1 + 2.1.3. 2.1.3 is AAA and outside the 55. */
  'scrollable-region-focusable': '2.1.1',
  /**
   * Tagged 1.1.1. A meter and a progressbar are widgets, not images: the missing
   * accessible name is a name/role/value fault, and 1.1.1 belongs to the VIS
   * lane, which judges whether alternative text is *accurate*.
   */
  'aria-meter-name': '4.1.2',
  'aria-progressbar-name': '4.1.2',

  /* -- (b) best-practice rules with no wcag tag --------------------------- */

  /** Duplicate accesskey values. Not a Level A/AA failure on its own. */
  accesskeys: null,
  /** A role that is not allowed on that element leaves the control mis-announced. */
  'aria-allowed-role': '4.1.2',
  'aria-dialog-name': '4.1.2',
  'aria-treeitem-name': '4.1.2',
  /** `role="text"` swallowing focusable descendants hides their name and role. */
  'aria-text': '4.1.2',
  /** A heading with no accessible name describes nothing. */
  'empty-heading': '2.4.6',
  'empty-table-header': '1.3.1',
  /** Focusable element given a non-focusable role: the role no longer describes it. */
  'focus-order-semantics': '2.4.3',
  /** Infrastructure: axe could not test an iframe. Not a criterion. */
  'frame-tested': null,
  /** Skipped heading levels break the programmatic structure of the page. */
  'heading-order': '1.3.1',
  /** Informational only; axe reports it as `incomplete`, never as a violation. */
  'hidden-content': null,
  /** Alt text repeating adjacent visible text is redundant non-text content. */
  'image-redundant-alt': '1.1.1',
  /** A `title` used as the only label is not a reliable instruction. */
  'label-title-only': '3.3.2',
  'landmark-banner-is-top-level': '1.3.1',
  'landmark-complementary-is-top-level': '1.3.1',
  'landmark-contentinfo-is-top-level': '1.3.1',
  'landmark-main-is-top-level': '1.3.1',
  'landmark-no-duplicate-banner': '1.3.1',
  'landmark-no-duplicate-contentinfo': '1.3.1',
  'landmark-no-duplicate-main': '1.3.1',
  /** No `main` landmark means there is nothing to bypass the repeated blocks to. */
  'landmark-one-main': '2.4.1',
  'landmark-unique': '1.3.1',
  /** A viewport that cannot scale defeats resizing; see AXE_RULE_SECONDARY_CRITERIA. */
  'meta-viewport-large': '1.4.4',
  'page-has-heading-one': '1.3.1',
  /** `role="presentation"` on a focusable element: the role is silently dropped. */
  'presentation-role-conflict': '1.3.1',
  /** Content outside every landmark cannot be skipped past. */
  region: '2.4.1',
  'scope-attr-valid': '1.3.1',
  /** The skip link itself. ACT confirms it moves focus; TREE confirms it exists. */
  'skip-link': '2.4.1',
  /** Positive tabindex forces an order that no longer follows the DOM. */
  tabindex: '2.4.3',
  'table-duplicate-name': '1.3.1',
};

/**
 * Criteria a rule evidences in addition to its primary one.
 *
 * Used for reporting breadth, never to emit a second finding: one violation
 * produces one finding against one criterion, or the score double-counts.
 */
export const AXE_RULE_SECONDARY_CRITERIA: Readonly<Record<string, readonly string[]>> = {
  'area-alt': ['2.4.4', '4.1.2'],
  'aria-hidden-body': ['1.3.1'],
  'input-image-alt': ['4.1.2'],
  /** A link with no accessible name fails both "where does it go" and "what is it". */
  'link-name': ['4.1.2'],
  /** An unlabelled field fails both name/role/value and "fields have real labels". */
  label: ['3.3.2', '1.3.1'],
  /** A viewport locked against zoom also prevents the page reflowing at 320px. */
  'meta-viewport': ['1.4.10'],
  'meta-viewport-large': ['1.4.10'],
  'scrollable-region-focusable': ['2.1.2'],
  'html-xml-lang-mismatch': ['3.1.2'],
};

/* -------------------------------------------------------------------------- */
/* The complete rule table (axe-core 4.13.0, 105 rules)                       */
/* -------------------------------------------------------------------------- */

/**
 * Every rule id axe-core 4.13.0 ships, with the criterion its own tags name.
 *
 * Derived mechanically from `axe._load({...}).rules[].tags` — this table is
 * axe's opinion, not ours. `AXE_RULE_OVERRIDES` above is where ours goes.
 * `null` means axe attaches no Level A/AA criterion from the 55.
 *
 * A trailing `off` note marks a rule axe leaves disabled by default. Two of
 * those matter to AccessiFix: `target-size` (2.5.8) must be enabled explicitly
 * or TREE cannot decide 2.5.8, and `aria-roledescription` (4.1.2).
 */
export const AXE_TAG_DERIVED_CRITERIA: Readonly<Record<string, string | null>> = {
  accesskeys: null, // no wcag tag
  'area-alt': '2.4.4', // tags: 2.4.4 + 4.1.2 -> overridden to 1.1.1
  'aria-allowed-attr': '4.1.2',
  'aria-allowed-role': null, // no wcag tag
  'aria-braille-equivalent': '4.1.2',
  'aria-command-name': '4.1.2',
  'aria-conditional-attr': '4.1.2',
  'aria-deprecated-role': '4.1.2',
  'aria-dialog-name': null, // no wcag tag
  'aria-hidden-body': '1.3.1', // tags: 1.3.1 + 4.1.2 -> overridden to 4.1.2
  'aria-hidden-focus': '4.1.2',
  'aria-input-field-name': '4.1.2',
  'aria-meter-name': '1.1.1', // -> overridden to 4.1.2
  'aria-progressbar-name': '1.1.1', // -> overridden to 4.1.2
  'aria-prohibited-attr': '4.1.2',
  'aria-required-attr': '4.1.2',
  'aria-required-children': '1.3.1',
  'aria-required-parent': '1.3.1',
  'aria-roledescription': '4.1.2', // off by default
  'aria-roles': '4.1.2',
  'aria-tab-name': '4.1.2',
  'aria-text': null, // no wcag tag
  'aria-toggle-field-name': '4.1.2',
  'aria-tooltip-name': '4.1.2',
  'aria-treeitem-name': null, // no wcag tag
  'aria-valid-attr': '4.1.2',
  'aria-valid-attr-value': '4.1.2',
  'audio-caption': '1.2.1', // off by default
  'autocomplete-valid': '1.3.5',
  'avoid-inline-spacing': '1.4.12',
  blink: '2.2.2',
  'button-name': '4.1.2',
  bypass: '2.4.1',
  'color-contrast': '1.4.3',
  'color-contrast-enhanced': null, // 1.4.6 is AAA; off by default
  'css-orientation-lock': '1.3.4',
  'definition-list': '1.3.1',
  dlitem: '1.3.1',
  'document-title': '2.4.2',
  'duplicate-id': null, // 4.1.1, removed in WCAG 2.2; off by default
  'duplicate-id-active': null, // 4.1.1, removed in WCAG 2.2; off by default
  'duplicate-id-aria': '4.1.2',
  'empty-heading': null, // no wcag tag
  'empty-table-header': null, // no wcag tag
  'focus-order-semantics': null, // no wcag tag
  'form-field-multiple-labels': '3.3.2',
  'frame-focusable-content': '2.1.1',
  'frame-tested': null, // no wcag tag
  'frame-title': '4.1.2',
  'frame-title-unique': '4.1.2',
  'heading-order': null, // no wcag tag
  'hidden-content': null, // no wcag tag
  'html-has-lang': '3.1.1',
  'html-lang-valid': '3.1.1',
  'html-xml-lang-mismatch': '3.1.1',
  'identical-links-same-purpose': null, // 2.4.9 is AAA; off by default
  'image-alt': '1.1.1',
  'image-redundant-alt': null, // no wcag tag
  'input-button-name': '4.1.2',
  'input-image-alt': '1.1.1', // tags: 1.1.1 + 4.1.2
  label: '4.1.2',
  'label-content-name-mismatch': '2.5.3',
  'label-title-only': null, // no wcag tag
  'landmark-banner-is-top-level': null, // no wcag tag
  'landmark-complementary-is-top-level': null, // no wcag tag; off by default
  'landmark-contentinfo-is-top-level': null, // no wcag tag
  'landmark-main-is-top-level': null, // no wcag tag
  'landmark-no-duplicate-banner': null, // no wcag tag
  'landmark-no-duplicate-contentinfo': null, // no wcag tag
  'landmark-no-duplicate-main': null, // no wcag tag
  'landmark-one-main': null, // no wcag tag
  'landmark-unique': null, // no wcag tag
  'link-in-text-block': '1.4.1',
  'link-name': '2.4.4', // tags: 2.4.4 + 4.1.2
  list: '1.3.1',
  listitem: '1.3.1',
  marquee: '2.2.2',
  'meta-refresh': '2.2.1',
  'meta-refresh-no-exceptions': null, // 2.2.4 / 3.2.5 are AAA; off by default
  'meta-viewport': '1.4.4',
  'meta-viewport-large': null, // no wcag tag
  'nested-interactive': '4.1.2',
  'no-autoplay-audio': '1.4.2',
  'object-alt': '1.1.1',
  'p-as-heading': '1.3.1',
  'page-has-heading-one': null, // no wcag tag
  'presentation-role-conflict': null, // no wcag tag
  region: null, // no wcag tag
  'role-img-alt': '1.1.1',
  'scope-attr-valid': null, // no wcag tag
  'scrollable-region-focusable': '2.1.1', // tags: 2.1.1 + 2.1.3
  'select-name': '4.1.2',
  'server-side-image-map': '2.1.1',
  'skip-link': null, // no wcag tag
  'summary-name': '4.1.2',
  'svg-img-alt': '1.1.1',
  tabindex: null, // no wcag tag
  'table-duplicate-name': null, // no wcag tag
  'table-fake-caption': '1.3.1',
  'target-size': '2.5.8', // off by default - must be enabled for TREE to decide 2.5.8
  'td-has-header': '1.3.1',
  'td-headers-attr': '1.3.1',
  'th-has-data-cells': '1.3.1',
  'valid-lang': '3.1.2',
  'video-caption': '1.2.2',
};

/** Every rule id this file knows about. */
export const AXE_RULE_IDS: readonly string[] = Object.keys(AXE_TAG_DERIVED_CRITERIA);

/**
 * Rules axe ships disabled. The browser layer must opt them in for the criteria
 * below to be reachable at all; `tree.ts` reports the criterion as inconclusive
 * rather than passing when a required rule never ran.
 */
export const AXE_RULES_OFF_BY_DEFAULT: readonly string[] = [
  'aria-roledescription',
  'audio-caption',
  'color-contrast-enhanced',
  'duplicate-id',
  'duplicate-id-active',
  'identical-links-same-purpose',
  'landmark-complementary-is-top-level',
  'meta-refresh-no-exceptions',
  'target-size',
];

export function isKnownAxeRule(ruleId: string): boolean {
  return Object.prototype.hasOwnProperty.call(AXE_TAG_DERIVED_CRITERIA, ruleId);
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The criterion a violation of `ruleId` should be filed against.
 *
 * Override, then the tags on the result itself, then the static table. Returns
 * null when the rule maps to nothing in the 55 — the caller drops the violation
 * instead of inventing a criterion for it.
 */
export function criterionForAxeRule(
  ruleId: string,
  tags?: readonly string[],
): string | null {
  if (Object.prototype.hasOwnProperty.call(AXE_RULE_OVERRIDES, ruleId)) {
    return AXE_RULE_OVERRIDES[ruleId] ?? null;
  }
  const fromTags = criterionFromAxeTags(tags);
  if (fromTags) return fromTags;
  return AXE_TAG_DERIVED_CRITERIA[ruleId] ?? null;
}

/**
 * Every criterion a violation of `ruleId` touches: the primary one first, then
 * the declared secondaries, then anything else its tags name.
 *
 * For reporting only. The finding cites `criteriaForAxeRule(...)[0]`.
 */
export function criteriaForAxeRule(ruleId: string, tags?: readonly string[]): string[] {
  const out: string[] = [];
  const push = (id: string | null): void => {
    if (!id) return;
    if (!getCriterion(id)) return;
    if (!out.includes(id)) out.push(id);
  };

  push(criterionForAxeRule(ruleId, tags));
  for (const id of AXE_RULE_SECONDARY_CRITERIA[ruleId] ?? []) push(id);
  for (const id of criteriaFromAxeTags(tags)) push(id);
  return out;
}

/** Every axe rule id that resolves to `criterion`. Drives the TREE checks. */
export function axeRulesForCriterion(criterion: string): string[] {
  return AXE_RULE_IDS.filter((id) => criterionForAxeRule(id) === criterion);
}

/**
 * `criterion -> rule ids`, built once. `axeRulesForCriterion` is the readable
 * form; this is the one the per-page hot path uses.
 */
export const AXE_RULES_BY_CRITERION: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const ruleId of AXE_RULE_IDS) {
    const criterion = criterionForAxeRule(ruleId);
    if (!criterion) continue;
    const bucket = map.get(criterion);
    if (bucket) bucket.push(ruleId);
    else map.set(criterion, [ruleId]);
  }
  return map;
})();
