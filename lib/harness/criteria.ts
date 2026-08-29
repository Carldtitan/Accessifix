/**
 * The 55 WCAG 2.2 Level A + AA success criteria, with the capability each one
 * needs and the verdict class it can reach.
 *
 * This is roster data, not criterion knowledge. It holds numbers, names, one
 * line of plain English, and the routing decision — never the normative text.
 * The full criterion text lives in git-backed Skills and loads by progressive
 * disclosure inside the agent (requirement A13.1 / A13.3), so no agent ever
 * carries all 55 in context.
 *
 * Source of truth: `Do not push/WCAG-Agent.md`.
 * Verified totals: 43 DECIDE, 10 FLAG, 2 BLOCKED, 12 state-dependent.
 */

/** WCAG conformance level. AccessiFix audits A and AA only. */
export type WcagLevel = "A" | "AA";

/** The four WCAG principles. */
export type WcagPrinciple = "Perceivable" | "Operable" | "Understandable" | "Robust";

/**
 * `DECIDE` — the agent returns pass/fail on its own authority.
 * `FLAG`   — the agent forms an opinion, a human signs it off.
 * `BLOCKED` — genuinely out of reach; reported as blocked, never as passing (A2.4).
 */
export type Verdict = "DECIDE" | "FLAG" | "BLOCKED";

/**
 * The capability a criterion needs, which is what routing keys off (A3.1).
 * `TREE` is a library inside the application, not a TrueForge agent.
 */
export type Capability = "VIS" | "ACT" | "TREE" | "CODE" | "PAGES" | "MEDIA";

export interface WcagCriterion {
  /** Dotted criterion number, e.g. `4.1.2`. Never null on a finding (A9). */
  readonly id: string;
  /** Official criterion name. */
  readonly name: string;
  readonly level: WcagLevel;
  readonly principle: WcagPrinciple;
  /** One line, for prompts and the criterion matrix. */
  readonly plainEnglish: string;
  readonly verdict: Verdict;
  /** Every lane capable of judging it. Criteria may need more than one. */
  readonly capabilities: readonly Capability[];
  /** True when the criterion is only observable across a state transition. */
  readonly stateDependent: boolean;
  /** Why it is out of reach. Present only when `verdict` is `BLOCKED`. */
  readonly blockedReason?: string;
}

export const WCAG_CRITERIA: readonly WcagCriterion[] = [
  // ---- 1. Perceivable ----------------------------------------------------
  {
    id: "1.1.1",
    name: "Non-text Content",
    level: "A",
    principle: "Perceivable",
    plainEnglish: "Images have accurate text descriptions.",
    verdict: "DECIDE",
    capabilities: ["VIS"],
    stateDependent: false,
  },
  {
    id: "1.2.1",
    name: "Audio-only and Video-only (Prerecorded)",
    level: "A",
    principle: "Perceivable",
    plainEnglish: "Audio-only or video-only content has an equivalent transcript.",
    verdict: "FLAG",
    capabilities: ["MEDIA", "VIS"],
    stateDependent: false,
  },
  {
    id: "1.2.2",
    name: "Captions (Prerecorded)",
    level: "A",
    principle: "Perceivable",
    plainEnglish: "Captions match what is actually said.",
    verdict: "DECIDE",
    capabilities: ["MEDIA"],
    stateDependent: false,
  },
  {
    id: "1.2.3",
    name: "Audio Description or Media Alternative (Prerecorded)",
    level: "A",
    principle: "Perceivable",
    plainEnglish: "Blind users get what is shown on screen.",
    verdict: "FLAG",
    capabilities: ["MEDIA", "VIS"],
    stateDependent: false,
  },
  {
    id: "1.3.1",
    name: "Info and Relationships",
    level: "A",
    principle: "Perceivable",
    plainEnglish: "Visual structure is also present in the markup.",
    verdict: "DECIDE",
    capabilities: ["VIS", "TREE"],
    stateDependent: false,
  },
  {
    id: "1.3.2",
    name: "Meaningful Sequence",
    level: "A",
    principle: "Perceivable",
    plainEnglish: "Reading order matches visual order.",
    verdict: "DECIDE",
    capabilities: ["VIS", "TREE"],
    stateDependent: false,
  },
  {
    id: "1.3.3",
    name: "Sensory Characteristics",
    level: "A",
    principle: "Perceivable",
    plainEnglish: 'No instructions like "the round button on the right".',
    verdict: "DECIDE",
    capabilities: ["TREE"],
    stateDependent: false,
  },
  {
    id: "1.4.1",
    name: "Use of Color",
    level: "A",
    principle: "Perceivable",
    plainEnglish: "Colour is not the only cue.",
    verdict: "DECIDE",
    capabilities: ["VIS"],
    stateDependent: false,
  },
  {
    id: "1.4.2",
    name: "Audio Control",
    level: "A",
    principle: "Perceivable",
    plainEnglish: "Autoplaying sound can be stopped.",
    verdict: "DECIDE",
    capabilities: ["ACT"],
    stateDependent: false,
  },
  {
    id: "1.2.4",
    name: "Captions (Live)",
    level: "AA",
    principle: "Perceivable",
    plainEnglish: "Live video has live captions.",
    verdict: "BLOCKED",
    capabilities: [],
    stateDependent: false,
    blockedReason: "A live stream that is not running cannot be audited.",
  },
  {
    id: "1.2.5",
    name: "Audio Description (Prerecorded)",
    level: "AA",
    principle: "Perceivable",
    plainEnglish: "Prerecorded video carries an audio description.",
    verdict: "FLAG",
    capabilities: ["MEDIA", "VIS"],
    stateDependent: false,
  },
  {
    id: "1.3.4",
    name: "Orientation",
    level: "AA",
    principle: "Perceivable",
    plainEnglish: "Works in portrait and landscape.",
    verdict: "DECIDE",
    capabilities: ["ACT", "VIS"],
    stateDependent: false,
  },
  {
    id: "1.3.5",
    name: "Identify Input Purpose",
    level: "AA",
    principle: "Perceivable",
    plainEnglish: "Fields declare what they collect.",
    verdict: "DECIDE",
    capabilities: ["TREE"],
    stateDependent: false,
  },
  {
    id: "1.4.3",
    name: "Contrast (Minimum)",
    level: "AA",
    principle: "Perceivable",
    plainEnglish: "Text meets its contrast ratio.",
    verdict: "DECIDE",
    capabilities: ["TREE"],
    stateDependent: false,
  },
  {
    id: "1.4.4",
    name: "Resize Text",
    level: "AA",
    principle: "Perceivable",
    plainEnglish: "200% zoom without breakage.",
    verdict: "DECIDE",
    capabilities: ["ACT", "VIS"],
    stateDependent: false,
  },
  {
    id: "1.4.5",
    name: "Images of Text",
    level: "AA",
    principle: "Perceivable",
    plainEnglish: "No text baked into pictures.",
    verdict: "DECIDE",
    capabilities: ["VIS"],
    stateDependent: false,
  },
  {
    id: "1.4.10",
    name: "Reflow",
    level: "AA",
    principle: "Perceivable",
    plainEnglish: "320px wide with no sideways scroll.",
    verdict: "DECIDE",
    capabilities: ["ACT", "VIS"],
    stateDependent: false,
  },
  {
    id: "1.4.11",
    name: "Non-text Contrast",
    level: "AA",
    principle: "Perceivable",
    plainEnglish: "Buttons, icons and focus indicators have contrast.",
    verdict: "DECIDE",
    capabilities: ["VIS", "TREE"],
    stateDependent: false,
  },
  {
    id: "1.4.12",
    name: "Text Spacing",
    level: "AA",
    principle: "Perceivable",
    plainEnglish: "Nothing clips when text spacing increases.",
    verdict: "DECIDE",
    capabilities: ["ACT", "VIS"],
    stateDependent: false,
  },
  {
    id: "1.4.13",
    name: "Content on Hover or Focus",
    level: "AA",
    principle: "Perceivable",
    plainEnglish: "Tooltips are dismissable, hoverable and persistent.",
    verdict: "DECIDE",
    capabilities: ["ACT", "VIS"],
    stateDependent: true,
  },

  // ---- 2. Operable -------------------------------------------------------
  {
    id: "2.1.1",
    name: "Keyboard",
    level: "A",
    principle: "Operable",
    plainEnglish: "Everything works without a mouse.",
    verdict: "DECIDE",
    capabilities: ["ACT", "VIS"],
    stateDependent: true,
  },
  {
    id: "2.1.2",
    name: "No Keyboard Trap",
    level: "A",
    principle: "Operable",
    plainEnglish: "You can always Tab back out.",
    verdict: "DECIDE",
    capabilities: ["ACT"],
    stateDependent: true,
  },
  {
    id: "2.1.4",
    name: "Character Key Shortcuts",
    level: "A",
    principle: "Operable",
    plainEnglish: "Single-key shortcuts can be turned off or remapped.",
    verdict: "FLAG",
    capabilities: ["ACT"],
    stateDependent: false,
  },
  {
    id: "2.2.1",
    name: "Timing Adjustable",
    level: "A",
    principle: "Operable",
    plainEnglish: "Time limits can be extended.",
    verdict: "FLAG",
    capabilities: ["ACT"],
    stateDependent: false,
  },
  {
    id: "2.2.2",
    name: "Pause, Stop, Hide",
    level: "A",
    principle: "Operable",
    plainEnglish: "Motion and auto-updating content can be paused.",
    verdict: "DECIDE",
    capabilities: ["VIS", "ACT"],
    stateDependent: false,
  },
  {
    id: "2.3.1",
    name: "Three Flashes or Below Threshold",
    level: "A",
    principle: "Operable",
    plainEnglish: "Nothing flashes at a seizure-triggering rate.",
    verdict: "DECIDE",
    capabilities: ["VIS"],
    stateDependent: false,
  },
  {
    id: "2.4.1",
    name: "Bypass Blocks",
    level: "A",
    principle: "Operable",
    plainEnglish: "A skip-to-content mechanism exists and works.",
    verdict: "DECIDE",
    capabilities: ["ACT"],
    stateDependent: false,
  },
  {
    id: "2.4.2",
    name: "Page Titled",
    level: "A",
    principle: "Operable",
    plainEnglish: "The page has a meaningful title.",
    verdict: "DECIDE",
    capabilities: ["TREE"],
    stateDependent: false,
  },
  {
    id: "2.4.3",
    name: "Focus Order",
    level: "A",
    principle: "Operable",
    plainEnglish: "Tab order matches visual order.",
    verdict: "DECIDE",
    capabilities: ["ACT", "VIS"],
    stateDependent: true,
  },
  {
    id: "2.4.4",
    name: "Link Purpose (In Context)",
    level: "A",
    principle: "Operable",
    plainEnglish: "Links say where they go.",
    verdict: "DECIDE",
    capabilities: ["TREE"],
    stateDependent: false,
  },
  {
    id: "2.5.1",
    name: "Pointer Gestures",
    level: "A",
    principle: "Operable",
    plainEnglish: "Multipoint or path-based gestures have a single-pointer alternative.",
    verdict: "FLAG",
    capabilities: ["CODE", "ACT"],
    stateDependent: false,
  },
  {
    id: "2.5.2",
    name: "Pointer Cancellation",
    level: "A",
    principle: "Operable",
    plainEnglish: "Sliding off a control before release cancels it.",
    verdict: "FLAG",
    capabilities: ["ACT"],
    stateDependent: false,
  },
  {
    id: "2.5.3",
    name: "Label in Name",
    level: "A",
    principle: "Operable",
    plainEnglish: "Visible text is contained in the accessible name.",
    verdict: "DECIDE",
    capabilities: ["VIS", "TREE"],
    stateDependent: false,
  },
  {
    id: "2.5.4",
    name: "Motion Actuation",
    level: "A",
    principle: "Operable",
    plainEnglish: "Device-motion triggers also have a conventional control.",
    verdict: "FLAG",
    capabilities: ["CODE"],
    stateDependent: false,
  },
  {
    id: "2.4.5",
    name: "Multiple Ways",
    level: "AA",
    principle: "Operable",
    plainEnglish: "More than one route reaches each page.",
    verdict: "DECIDE",
    capabilities: ["PAGES"],
    stateDependent: false,
  },
  {
    id: "2.4.6",
    name: "Headings and Labels",
    level: "AA",
    principle: "Operable",
    plainEnglish: "Headings and labels describe their content.",
    verdict: "DECIDE",
    capabilities: ["TREE"],
    stateDependent: false,
  },
  {
    id: "2.4.7",
    name: "Focus Visible",
    level: "AA",
    principle: "Operable",
    plainEnglish: "You can see where keyboard focus is.",
    verdict: "DECIDE",
    capabilities: ["ACT", "VIS"],
    stateDependent: true,
  },
  {
    id: "2.4.11",
    name: "Focus Not Obscured (Minimum)",
    level: "AA",
    principle: "Operable",
    plainEnglish: "Focus is not hidden behind sticky UI.",
    verdict: "DECIDE",
    capabilities: ["ACT", "VIS"],
    stateDependent: true,
  },
  {
    id: "2.5.7",
    name: "Dragging Movements",
    level: "AA",
    principle: "Operable",
    plainEnglish: "Dragging has a single-pointer alternative.",
    verdict: "FLAG",
    capabilities: ["ACT", "CODE"],
    stateDependent: false,
  },
  {
    id: "2.5.8",
    name: "Target Size (Minimum)",
    level: "AA",
    principle: "Operable",
    plainEnglish: "Pointer targets are at least 24 by 24 CSS pixels.",
    verdict: "DECIDE",
    capabilities: ["TREE"],
    stateDependent: false,
  },

  // ---- 3. Understandable -------------------------------------------------
  {
    id: "3.1.1",
    name: "Language of Page",
    level: "A",
    principle: "Understandable",
    plainEnglish: "The page declares its language.",
    verdict: "DECIDE",
    capabilities: ["TREE"],
    stateDependent: false,
  },
  {
    id: "3.2.1",
    name: "On Focus",
    level: "A",
    principle: "Understandable",
    plainEnglish: "Focusing a control does not jump you elsewhere.",
    verdict: "DECIDE",
    capabilities: ["ACT"],
    stateDependent: true,
  },
  {
    id: "3.2.2",
    name: "On Input",
    level: "A",
    principle: "Understandable",
    plainEnglish: "Typing or selecting does not change context.",
    verdict: "DECIDE",
    capabilities: ["ACT"],
    stateDependent: true,
  },
  {
    id: "3.2.6",
    name: "Consistent Help",
    level: "A",
    principle: "Understandable",
    plainEnglish: "Help appears in the same relative place on every page.",
    verdict: "DECIDE",
    capabilities: ["PAGES", "VIS"],
    stateDependent: false,
  },
  {
    id: "3.3.1",
    name: "Error Identification",
    level: "A",
    principle: "Understandable",
    plainEnglish: "Errors are described in words, not only in colour.",
    verdict: "DECIDE",
    capabilities: ["ACT", "VIS"],
    stateDependent: true,
  },
  {
    id: "3.3.2",
    name: "Labels or Instructions",
    level: "A",
    principle: "Understandable",
    plainEnglish: "Fields have real labels.",
    verdict: "DECIDE",
    capabilities: ["VIS", "TREE"],
    stateDependent: false,
  },
  {
    id: "3.3.7",
    name: "Redundant Entry",
    level: "A",
    principle: "Understandable",
    plainEnglish: "You are not asked for the same information twice.",
    verdict: "FLAG",
    capabilities: ["ACT", "PAGES"],
    stateDependent: false,
  },
  {
    id: "3.1.2",
    name: "Language of Parts",
    level: "AA",
    principle: "Understandable",
    plainEnglish: "Foreign-language phrases are marked up.",
    verdict: "DECIDE",
    capabilities: ["TREE"],
    stateDependent: false,
  },
  {
    id: "3.2.3",
    name: "Consistent Navigation",
    level: "AA",
    principle: "Understandable",
    plainEnglish: "Navigation order is stable across pages.",
    verdict: "DECIDE",
    capabilities: ["PAGES", "VIS"],
    stateDependent: false,
  },
  {
    id: "3.2.4",
    name: "Consistent Identification",
    level: "AA",
    principle: "Understandable",
    plainEnglish: "The same icon or control means the same thing everywhere.",
    verdict: "DECIDE",
    capabilities: ["PAGES", "VIS"],
    stateDependent: false,
  },
  {
    id: "3.3.3",
    name: "Error Suggestion",
    level: "AA",
    principle: "Understandable",
    plainEnglish: "Errors say how to fix them.",
    verdict: "DECIDE",
    capabilities: ["ACT"],
    stateDependent: true,
  },
  {
    id: "3.3.4",
    name: "Error Prevention (Legal, Financial, Data)",
    level: "AA",
    principle: "Understandable",
    plainEnglish: "Legal, financial and data submissions are reversible or confirmable.",
    verdict: "BLOCKED",
    capabilities: [],
    stateDependent: false,
    blockedReason:
      "Auditing it would require completing a real legal or financial transaction. That is approval-gate territory, not automation.",
  },
  {
    id: "3.3.8",
    name: "Accessible Authentication (Minimum)",
    level: "AA",
    principle: "Understandable",
    plainEnglish: "Logging in needs no cognitive function test.",
    verdict: "DECIDE",
    capabilities: ["VIS", "ACT"],
    stateDependent: false,
  },

  // ---- 4. Robust ---------------------------------------------------------
  {
    id: "4.1.2",
    name: "Name, Role, Value",
    level: "A",
    principle: "Robust",
    plainEnglish: "Controls expose name, role and state, and announce changes to them.",
    verdict: "DECIDE",
    capabilities: ["ACT", "TREE"],
    stateDependent: true,
  },
  {
    id: "4.1.3",
    name: "Status Messages",
    level: "AA",
    principle: "Robust",
    plainEnglish: "Status is announced without stealing focus.",
    verdict: "DECIDE",
    capabilities: ["ACT", "TREE"],
    stateDependent: true,
  },
];

/** Fast lookup by criterion number. */
export const WCAG_CRITERIA_BY_ID: ReadonlyMap<string, WcagCriterion> = new Map(
  WCAG_CRITERIA.map((criterion) => [criterion.id, criterion]),
);

/** All 55 criterion numbers, in roster order. */
export const WCAG_CRITERION_IDS: readonly string[] = WCAG_CRITERIA.map((c) => c.id);

/** The 12 criteria observable only across a state transition — the moat. */
export const STATE_DEPENDENT_CRITERION_IDS: readonly string[] = WCAG_CRITERIA.filter(
  (c) => c.stateDependent,
).map((c) => c.id);

/** The two criteria reported as BLOCKED with a stated reason (A2.4). */
export const BLOCKED_CRITERION_IDS: readonly string[] = WCAG_CRITERIA.filter(
  (c) => c.verdict === "BLOCKED",
).map((c) => c.id);

/** Shape of a criterion number, e.g. `4.1.2`. */
export const WCAG_CRITERION_PATTERN = /^[1-4]\.\d{1,2}\.\d{1,2}$/;

/** True when `id` is one of the 55 Level A/AA criteria AccessiFix audits. */
export function isWcagCriterionId(id: string): boolean {
  return WCAG_CRITERIA_BY_ID.has(id);
}

/** Every criterion number a given lane is capable of judging. */
export function criterionIdsForCapability(capability: Capability): readonly string[] {
  return WCAG_CRITERIA.filter((c) => c.capabilities.includes(capability)).map((c) => c.id);
}

/** Look a criterion up, or throw — used where a typo must not pass silently. */
export function requireCriterion(id: string): WcagCriterion {
  const criterion = WCAG_CRITERIA_BY_ID.get(id);
  if (!criterion) {
    throw new Error(`Unknown WCAG criterion: ${id}`);
  }
  return criterion;
}

/**
 * Render an ownership table for an agent's system prompt. Numbers, names and
 * one line each — never the normative text, which belongs in a Skill.
 */
export function renderCriterionTable(ids: readonly string[]): string {
  return ids
    .map((id) => {
      const c = requireCriterion(id);
      const star = c.stateDependent ? " [STATE]" : "";
      return `- ${c.id} ${c.name} (Level ${c.level}, ${c.verdict}${star}) — ${c.plainEnglish}`;
    })
    .join("\n");
}
