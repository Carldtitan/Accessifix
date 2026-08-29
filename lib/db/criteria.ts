/**
 * The authoritative list of all 55 WCAG 2.2 Level A and AA success criteria.
 *
 * Source of truth: `Do not push/WCAG-Agent.md` - the verdict, capability lane
 * and plain-English description below are taken from it verbatim. Success
 * criterion titles are the official W3C WCAG 2.2 titles.
 *
 * Composition, asserted at module load:
 *   55 criteria - 31 Level A, 24 Level AA
 *   43 DECIDE, 10 FLAG, 2 BLOCKED
 *   12 state-dependent (only observable by driving the UI through a transition)
 *
 * This file has no dependencies. It is imported by the router, the seed script,
 * the agent Skills loader and the criterion matrix alike.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** The six audit capability lanes. FIX and VERIFY do not own criteria. */
export const AUDIT_AGENTS = ['TREE', 'VIS', 'ACT', 'PAGES', 'MEDIA', 'CODE'] as const;
export type AuditAgent = (typeof AUDIT_AGENTS)[number];

export type CriterionLevel = 'A' | 'AA';

/** `DECIDE` the agent rules, `FLAG` a human signs off, `BLOCKED` out of reach. */
export type CriterionVerdict = 'DECIDE' | 'FLAG' | 'BLOCKED';

export type CriterionPrinciple = 'Perceivable' | 'Operable' | 'Understandable' | 'Robust';

export interface Criterion {
  /** The WCAG number, e.g. `4.1.2`. Primary key everywhere in the product. */
  readonly id: string;
  /** Official W3C success criterion title. */
  readonly name: string;
  readonly level: CriterionLevel;
  readonly principle: CriterionPrinciple;
  /** One line a non-specialist can act on. */
  readonly plainEnglish: string;
  readonly verdict: CriterionVerdict;
  /**
   * The lane that owns the check and writes the finding. `null` only for the
   * two `BLOCKED` criteria, which no lane can reach - a null here is what stops
   * the router dispatching them.
   */
  readonly agent: AuditAgent | null;
  /** Every lane the check needs, primary lane first. Empty when BLOCKED. */
  readonly capabilities: readonly AuditAgent[];
  /** True for the 12 criteria observable only across a state transition. */
  readonly stateDependent: boolean;
}

/* -------------------------------------------------------------------------- */
/* The 55                                                                     */
/* -------------------------------------------------------------------------- */

export const WCAG_CRITERIA: readonly Criterion[] = [
  /* --- 1. Perceivable ---------------------------------------------------- */
  {
    id: '1.1.1',
    name: 'Non-text Content',
    level: 'A',
    principle: 'Perceivable',
    plainEnglish: 'Images have accurate text descriptions',
    verdict: 'DECIDE',
    agent: 'VIS',
    capabilities: ['VIS'],
    stateDependent: false,
  },
  {
    id: '1.2.1',
    name: 'Audio-only and Video-only (Prerecorded)',
    level: 'A',
    principle: 'Perceivable',
    plainEnglish: 'Audio-only or video-only has an equivalent transcript',
    verdict: 'FLAG',
    agent: 'MEDIA',
    capabilities: ['MEDIA', 'VIS'],
    stateDependent: false,
  },
  {
    id: '1.2.2',
    name: 'Captions (Prerecorded)',
    level: 'A',
    principle: 'Perceivable',
    plainEnglish: 'Captions match what is actually said',
    verdict: 'DECIDE',
    agent: 'MEDIA',
    capabilities: ['MEDIA'],
    stateDependent: false,
  },
  {
    id: '1.2.3',
    name: 'Audio Description or Media Alternative (Prerecorded)',
    level: 'A',
    principle: 'Perceivable',
    plainEnglish: 'Blind users get what is shown on screen',
    verdict: 'FLAG',
    agent: 'MEDIA',
    capabilities: ['MEDIA', 'VIS'],
    stateDependent: false,
  },
  {
    id: '1.2.4',
    name: 'Captions (Live)',
    level: 'AA',
    principle: 'Perceivable',
    plainEnglish: 'Live video has live captions',
    verdict: 'BLOCKED',
    agent: null,
    capabilities: [],
    stateDependent: false,
  },
  {
    id: '1.2.5',
    name: 'Audio Description (Prerecorded)',
    level: 'AA',
    principle: 'Perceivable',
    plainEnglish: 'Prerecorded video has description',
    verdict: 'FLAG',
    agent: 'MEDIA',
    capabilities: ['MEDIA', 'VIS'],
    stateDependent: false,
  },
  {
    id: '1.3.1',
    name: 'Info and Relationships',
    level: 'A',
    principle: 'Perceivable',
    plainEnglish: 'Visual structure is also in the markup',
    verdict: 'DECIDE',
    agent: 'VIS',
    capabilities: ['VIS', 'TREE'],
    stateDependent: false,
  },
  {
    id: '1.3.2',
    name: 'Meaningful Sequence',
    level: 'A',
    principle: 'Perceivable',
    plainEnglish: 'Reading order matches visual order',
    verdict: 'DECIDE',
    agent: 'VIS',
    capabilities: ['VIS', 'TREE'],
    stateDependent: false,
  },
  {
    id: '1.3.3',
    name: 'Sensory Characteristics',
    level: 'A',
    principle: 'Perceivable',
    plainEnglish: 'No "the round button on the right"',
    verdict: 'DECIDE',
    agent: 'TREE',
    capabilities: ['TREE'],
    stateDependent: false,
  },
  {
    id: '1.3.4',
    name: 'Orientation',
    level: 'AA',
    principle: 'Perceivable',
    plainEnglish: 'Works portrait and landscape',
    verdict: 'DECIDE',
    agent: 'ACT',
    capabilities: ['ACT', 'VIS'],
    stateDependent: false,
  },
  {
    id: '1.3.5',
    name: 'Identify Input Purpose',
    level: 'AA',
    principle: 'Perceivable',
    plainEnglish: 'Fields declare what they collect',
    verdict: 'DECIDE',
    agent: 'TREE',
    capabilities: ['TREE'],
    stateDependent: false,
  },
  {
    id: '1.4.1',
    name: 'Use of Color',
    level: 'A',
    principle: 'Perceivable',
    plainEnglish: 'Colour is not the only cue',
    verdict: 'DECIDE',
    agent: 'VIS',
    capabilities: ['VIS'],
    stateDependent: false,
  },
  {
    id: '1.4.2',
    name: 'Audio Control',
    level: 'A',
    principle: 'Perceivable',
    plainEnglish: 'Autoplaying sound can be stopped',
    verdict: 'DECIDE',
    agent: 'ACT',
    capabilities: ['ACT'],
    stateDependent: false,
  },
  {
    id: '1.4.3',
    name: 'Contrast (Minimum)',
    level: 'AA',
    principle: 'Perceivable',
    plainEnglish: 'Text contrast ratio',
    verdict: 'DECIDE',
    agent: 'TREE',
    capabilities: ['TREE'],
    stateDependent: false,
  },
  {
    id: '1.4.4',
    name: 'Resize Text',
    level: 'AA',
    principle: 'Perceivable',
    plainEnglish: '200% zoom without breakage',
    verdict: 'DECIDE',
    agent: 'ACT',
    capabilities: ['ACT', 'VIS'],
    stateDependent: false,
  },
  {
    id: '1.4.5',
    name: 'Images of Text',
    level: 'AA',
    principle: 'Perceivable',
    plainEnglish: 'No text baked into pictures',
    verdict: 'DECIDE',
    agent: 'VIS',
    capabilities: ['VIS'],
    stateDependent: false,
  },
  {
    id: '1.4.10',
    name: 'Reflow',
    level: 'AA',
    principle: 'Perceivable',
    plainEnglish: '320px with no sideways scroll',
    verdict: 'DECIDE',
    agent: 'ACT',
    capabilities: ['ACT', 'VIS'],
    stateDependent: false,
  },
  {
    id: '1.4.11',
    name: 'Non-text Contrast',
    level: 'AA',
    principle: 'Perceivable',
    plainEnglish: 'Buttons and icons have contrast',
    verdict: 'DECIDE',
    agent: 'VIS',
    capabilities: ['VIS', 'TREE'],
    stateDependent: false,
  },
  {
    id: '1.4.12',
    name: 'Text Spacing',
    level: 'AA',
    principle: 'Perceivable',
    plainEnglish: 'Nothing clips when spacing increases',
    verdict: 'DECIDE',
    agent: 'ACT',
    capabilities: ['ACT', 'VIS'],
    stateDependent: false,
  },
  {
    id: '1.4.13',
    name: 'Content on Hover or Focus',
    level: 'AA',
    principle: 'Perceivable',
    plainEnglish: 'Tooltips dismissable and persistent',
    verdict: 'DECIDE',
    agent: 'ACT',
    capabilities: ['ACT', 'VIS'],
    stateDependent: true,
  },

  /* --- 2. Operable ------------------------------------------------------- */
  {
    id: '2.1.1',
    name: 'Keyboard',
    level: 'A',
    principle: 'Operable',
    plainEnglish: 'Everything works without a mouse',
    verdict: 'DECIDE',
    agent: 'ACT',
    capabilities: ['ACT', 'VIS'],
    stateDependent: true,
  },
  {
    id: '2.1.2',
    name: 'No Keyboard Trap',
    level: 'A',
    principle: 'Operable',
    plainEnglish: 'You can always Tab back out',
    verdict: 'DECIDE',
    agent: 'ACT',
    capabilities: ['ACT'],
    stateDependent: true,
  },
  {
    id: '2.1.4',
    name: 'Character Key Shortcuts',
    level: 'A',
    principle: 'Operable',
    plainEnglish: 'Single-key shortcuts can be disabled',
    verdict: 'FLAG',
    agent: 'ACT',
    capabilities: ['ACT'],
    stateDependent: false,
  },
  {
    id: '2.2.1',
    name: 'Timing Adjustable',
    level: 'A',
    principle: 'Operable',
    plainEnglish: 'Time limits can be extended',
    verdict: 'FLAG',
    agent: 'ACT',
    capabilities: ['ACT'],
    stateDependent: false,
  },
  {
    id: '2.2.2',
    name: 'Pause, Stop, Hide',
    level: 'A',
    principle: 'Operable',
    plainEnglish: 'Motion can be paused',
    verdict: 'DECIDE',
    agent: 'VIS',
    capabilities: ['VIS', 'ACT'],
    stateDependent: false,
  },
  {
    id: '2.3.1',
    name: 'Three Flashes or Below Threshold',
    level: 'A',
    principle: 'Operable',
    plainEnglish: 'No seizure-triggering flashing',
    verdict: 'DECIDE',
    agent: 'VIS',
    capabilities: ['VIS'],
    stateDependent: false,
  },
  {
    id: '2.4.1',
    name: 'Bypass Blocks',
    level: 'A',
    principle: 'Operable',
    plainEnglish: 'Skip-to-content exists and works',
    verdict: 'DECIDE',
    agent: 'ACT',
    capabilities: ['ACT'],
    stateDependent: false,
  },
  {
    id: '2.4.2',
    name: 'Page Titled',
    level: 'A',
    principle: 'Operable',
    plainEnglish: 'Page has a meaningful title',
    verdict: 'DECIDE',
    agent: 'TREE',
    capabilities: ['TREE'],
    stateDependent: false,
  },
  {
    id: '2.4.3',
    name: 'Focus Order',
    level: 'A',
    principle: 'Operable',
    plainEnglish: 'Tab order matches visual order',
    verdict: 'DECIDE',
    agent: 'ACT',
    capabilities: ['ACT', 'VIS'],
    stateDependent: true,
  },
  {
    id: '2.4.4',
    name: 'Link Purpose (In Context)',
    level: 'A',
    principle: 'Operable',
    plainEnglish: 'Links say where they go',
    verdict: 'DECIDE',
    agent: 'TREE',
    capabilities: ['TREE'],
    stateDependent: false,
  },
  {
    id: '2.4.5',
    name: 'Multiple Ways',
    level: 'AA',
    principle: 'Operable',
    plainEnglish: 'More than one route to each page',
    verdict: 'DECIDE',
    agent: 'PAGES',
    capabilities: ['PAGES'],
    stateDependent: false,
  },
  {
    id: '2.4.6',
    name: 'Headings and Labels',
    level: 'AA',
    principle: 'Operable',
    plainEnglish: 'Headings describe their content',
    verdict: 'DECIDE',
    agent: 'TREE',
    capabilities: ['TREE'],
    stateDependent: false,
  },
  {
    id: '2.4.7',
    name: 'Focus Visible',
    level: 'AA',
    principle: 'Operable',
    plainEnglish: 'You can SEE where focus is',
    verdict: 'DECIDE',
    agent: 'ACT',
    capabilities: ['ACT', 'VIS'],
    stateDependent: true,
  },
  {
    id: '2.4.11',
    name: 'Focus Not Obscured (Minimum)',
    level: 'AA',
    principle: 'Operable',
    plainEnglish: 'Focus not hidden behind sticky UI',
    verdict: 'DECIDE',
    agent: 'ACT',
    capabilities: ['ACT', 'VIS'],
    stateDependent: true,
  },
  {
    id: '2.5.1',
    name: 'Pointer Gestures',
    level: 'A',
    principle: 'Operable',
    plainEnglish: 'Complex gestures have alternatives',
    verdict: 'FLAG',
    agent: 'CODE',
    capabilities: ['CODE', 'ACT'],
    stateDependent: false,
  },
  {
    id: '2.5.2',
    name: 'Pointer Cancellation',
    level: 'A',
    principle: 'Operable',
    plainEnglish: 'Slide off to cancel',
    verdict: 'FLAG',
    agent: 'ACT',
    capabilities: ['ACT'],
    stateDependent: false,
  },
  {
    id: '2.5.3',
    name: 'Label in Name',
    level: 'A',
    principle: 'Operable',
    plainEnglish: 'Visible text matches spoken name',
    verdict: 'DECIDE',
    agent: 'VIS',
    capabilities: ['VIS', 'TREE'],
    stateDependent: false,
  },
  {
    id: '2.5.4',
    name: 'Motion Actuation',
    level: 'A',
    principle: 'Operable',
    plainEnglish: 'Shake gestures have a button too',
    verdict: 'FLAG',
    agent: 'CODE',
    capabilities: ['CODE'],
    stateDependent: false,
  },
  {
    id: '2.5.7',
    name: 'Dragging Movements',
    level: 'AA',
    principle: 'Operable',
    plainEnglish: 'Drag has a click alternative',
    verdict: 'FLAG',
    agent: 'ACT',
    capabilities: ['ACT', 'CODE'],
    stateDependent: false,
  },
  {
    id: '2.5.8',
    name: 'Target Size (Minimum)',
    level: 'AA',
    principle: 'Operable',
    plainEnglish: 'Targets at least 24x24',
    verdict: 'DECIDE',
    agent: 'TREE',
    capabilities: ['TREE'],
    stateDependent: false,
  },

  /* --- 3. Understandable ------------------------------------------------- */
  {
    id: '3.1.1',
    name: 'Language of Page',
    level: 'A',
    principle: 'Understandable',
    plainEnglish: 'Page declares its language',
    verdict: 'DECIDE',
    agent: 'TREE',
    capabilities: ['TREE'],
    stateDependent: false,
  },
  {
    id: '3.1.2',
    name: 'Language of Parts',
    level: 'AA',
    principle: 'Understandable',
    plainEnglish: 'Foreign phrases marked',
    verdict: 'DECIDE',
    agent: 'TREE',
    capabilities: ['TREE'],
    stateDependent: false,
  },
  {
    id: '3.2.1',
    name: 'On Focus',
    level: 'A',
    principle: 'Understandable',
    plainEnglish: 'Focusing does not jump you elsewhere',
    verdict: 'DECIDE',
    agent: 'ACT',
    capabilities: ['ACT'],
    stateDependent: true,
  },
  {
    id: '3.2.2',
    name: 'On Input',
    level: 'A',
    principle: 'Understandable',
    plainEnglish: 'Typing does not change context',
    verdict: 'DECIDE',
    agent: 'ACT',
    capabilities: ['ACT'],
    stateDependent: true,
  },
  {
    id: '3.2.3',
    name: 'Consistent Navigation',
    level: 'AA',
    principle: 'Understandable',
    plainEnglish: 'Nav order stable across pages',
    verdict: 'DECIDE',
    agent: 'PAGES',
    capabilities: ['PAGES', 'VIS'],
    stateDependent: false,
  },
  {
    id: '3.2.4',
    name: 'Consistent Identification',
    level: 'AA',
    principle: 'Understandable',
    plainEnglish: 'Same icon means the same thing',
    verdict: 'DECIDE',
    agent: 'PAGES',
    capabilities: ['PAGES', 'VIS'],
    stateDependent: false,
  },
  {
    id: '3.2.6',
    name: 'Consistent Help',
    level: 'A',
    principle: 'Understandable',
    plainEnglish: 'Help in the same place everywhere',
    verdict: 'DECIDE',
    agent: 'PAGES',
    capabilities: ['PAGES', 'VIS'],
    stateDependent: false,
  },
  {
    id: '3.3.1',
    name: 'Error Identification',
    level: 'A',
    principle: 'Understandable',
    plainEnglish: 'Errors described in words',
    verdict: 'DECIDE',
    agent: 'ACT',
    capabilities: ['ACT', 'VIS'],
    stateDependent: true,
  },
  {
    id: '3.3.2',
    name: 'Labels or Instructions',
    level: 'A',
    principle: 'Understandable',
    plainEnglish: 'Fields have real labels',
    verdict: 'DECIDE',
    agent: 'VIS',
    capabilities: ['VIS', 'TREE'],
    stateDependent: false,
  },
  {
    id: '3.3.3',
    name: 'Error Suggestion',
    level: 'AA',
    principle: 'Understandable',
    plainEnglish: 'Errors say how to fix them',
    verdict: 'DECIDE',
    agent: 'ACT',
    capabilities: ['ACT'],
    stateDependent: true,
  },
  {
    id: '3.3.4',
    name: 'Error Prevention (Legal, Financial, Data)',
    level: 'AA',
    principle: 'Understandable',
    plainEnglish: 'Legal/financial actions reversible',
    verdict: 'BLOCKED',
    agent: null,
    capabilities: [],
    stateDependent: false,
  },
  {
    id: '3.3.7',
    name: 'Redundant Entry',
    level: 'A',
    principle: 'Understandable',
    plainEnglish: 'Not asked for the same info twice',
    verdict: 'FLAG',
    agent: 'ACT',
    capabilities: ['ACT', 'PAGES'],
    stateDependent: false,
  },
  {
    id: '3.3.8',
    name: 'Accessible Authentication (Minimum)',
    level: 'AA',
    principle: 'Understandable',
    plainEnglish: 'Login needs no cognitive puzzle',
    verdict: 'DECIDE',
    agent: 'VIS',
    capabilities: ['VIS', 'ACT'],
    stateDependent: false,
  },

  /* --- 4. Robust --------------------------------------------------------- */
  {
    id: '4.1.2',
    name: 'Name, Role, Value',
    level: 'A',
    principle: 'Robust',
    plainEnglish: 'Controls expose name/role/state AND announce changes',
    verdict: 'DECIDE',
    agent: 'ACT',
    capabilities: ['ACT', 'TREE'],
    stateDependent: true,
  },
  {
    id: '4.1.3',
    name: 'Status Messages',
    level: 'AA',
    principle: 'Robust',
    plainEnglish: 'Status announced without stealing focus',
    verdict: 'DECIDE',
    agent: 'ACT',
    capabilities: ['ACT', 'TREE'],
    stateDependent: true,
  },
] as const;

/* -------------------------------------------------------------------------- */
/* Why the two BLOCKED criteria are blocked (A2.4 requires a stated reason)    */
/* -------------------------------------------------------------------------- */

export const BLOCKED_REASONS: Readonly<Record<string, string>> = {
  '1.2.4': 'Cannot audit a live stream that is not running.',
  '3.3.4':
    'Would require completing a real legal or financial transaction. Approval-gate territory, not automation.',
};

/* -------------------------------------------------------------------------- */
/* Integrity assertion - runs at module load                                  */
/* -------------------------------------------------------------------------- */

/** Expected composition. A change here must be a deliberate, reviewed change. */
export const CRITERIA_TOTALS = {
  total: 55,
  levelA: 31,
  levelAA: 24,
  decide: 43,
  flag: 10,
  blocked: 2,
  stateDependent: 12,
} as const;

function assertCriteriaIntegrity(list: readonly Criterion[]): void {
  const problems: string[] = [];
  const count = (predicate: (c: Criterion) => boolean): number => list.filter(predicate).length;

  const actual = {
    total: list.length,
    levelA: count((c) => c.level === 'A'),
    levelAA: count((c) => c.level === 'AA'),
    decide: count((c) => c.verdict === 'DECIDE'),
    flag: count((c) => c.verdict === 'FLAG'),
    blocked: count((c) => c.verdict === 'BLOCKED'),
    stateDependent: count((c) => c.stateDependent),
  };

  for (const key of Object.keys(CRITERIA_TOTALS) as (keyof typeof CRITERIA_TOTALS)[]) {
    if (actual[key] !== CRITERIA_TOTALS[key]) {
      problems.push(`${key}: expected ${CRITERIA_TOTALS[key]}, got ${actual[key]}`);
    }
  }

  const seen = new Set<string>();
  for (const criterion of list) {
    if (seen.has(criterion.id)) problems.push(`duplicate criterion id ${criterion.id}`);
    seen.add(criterion.id);

    if (!/^\d+\.\d+\.\d+$/.test(criterion.id)) {
      problems.push(`malformed criterion id ${criterion.id}`);
    }
    if (criterion.verdict === 'BLOCKED') {
      if (criterion.agent !== null || criterion.capabilities.length > 0) {
        problems.push(`${criterion.id} is BLOCKED but claims a capability lane`);
      }
      if (!BLOCKED_REASONS[criterion.id]) {
        problems.push(`${criterion.id} is BLOCKED with no stated reason (A2.4)`);
      }
    } else if (criterion.agent === null || criterion.capabilities[0] !== criterion.agent) {
      problems.push(`${criterion.id} must list its owning agent first in capabilities`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`WCAG criteria table is invalid:\n  - ${problems.join('\n  - ')}`);
  }
}

assertCriteriaIntegrity(WCAG_CRITERIA);

/* -------------------------------------------------------------------------- */
/* Lookups                                                                    */
/* -------------------------------------------------------------------------- */

const BY_ID: ReadonlyMap<string, Criterion> = new Map(WCAG_CRITERIA.map((c) => [c.id, c]));

/**
 * Resolve a criterion number. Returns `undefined` for anything not in the 55,
 * which is how the application rejects a finding an agent invented
 * (non-negotiable rule 3, A13.6).
 */
export function getCriterion(id: string): Criterion | undefined {
  return BY_ID.get(id.trim());
}

/** Throwing form, for paths where an unknown criterion is a programming error. */
export function requireCriterion(id: string): Criterion {
  const criterion = getCriterion(id);
  if (!criterion) {
    throw new Error(`Unknown WCAG success criterion "${id}". Findings must cite one of the 55.`);
  }
  return criterion;
}

/**
 * Every criterion this agent's capability is needed for. Matches the roster in
 * the design document: TREE 16, VIS 27, ACT 26, PAGES 5, MEDIA 4, CODE 3.
 * Use this to decide which Skills an agent mounts (A13.2).
 */
export function criteriaForAgent(agent: AuditAgent): readonly Criterion[] {
  return WCAG_CRITERIA.filter((c) => c.capabilities.includes(agent));
}

/**
 * Only the criteria this agent owns outright and writes findings for. Disjoint
 * across agents, and the two BLOCKED criteria belong to nobody. Use this to
 * dispatch (A3.1).
 */
export function criteriaOwnedBy(agent: AuditAgent): readonly Criterion[] {
  return WCAG_CRITERIA.filter((c) => c.agent === agent);
}

/** The 12 criteria observable only by driving the UI through a transition. */
export function stateCriteria(): readonly Criterion[] {
  return WCAG_CRITERIA.filter((c) => c.stateDependent);
}

export function criteriaByLevel(level: CriterionLevel): readonly Criterion[] {
  return WCAG_CRITERIA.filter((c) => c.level === level);
}

export function criteriaByVerdict(verdict: CriterionVerdict): readonly Criterion[] {
  return WCAG_CRITERIA.filter((c) => c.verdict === verdict);
}

/** The stated reason a criterion is out of reach, for the A2.4 report line. */
export function blockedReason(id: string): string | undefined {
  return BLOCKED_REASONS[id];
}
