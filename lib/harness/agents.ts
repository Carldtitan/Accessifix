/**
 * The AccessiFix agent roster.
 *
 * Seven saved TrueForge agents, each with its own model and its own slice of
 * the 55 criteria. TrueForge subagents inherit their parent's model, so one
 * agent cannot fan out across seven models — routing therefore happens here,
 * one level up, in application code (design: "the app routes, the harness
 * runs").
 *
 * TREE is deliberately absent. It is a library inside the application that
 * runs axe-core and reads the accessibility tree directly; it calls no model.
 *
 * Model FQNs below were read from `GET /api/v1/catalogs/model-providers` on
 * this TrueForge, not guessed.
 */

import type { AgentSpec, ResponseFormat, RuntimeConfig } from "./client";
import { renderCriterionTable, requireCriterion } from "./criteria";
import {
  PATCH_SET_RESPONSE_FORMAT,
  VERIFICATION_RESPONSE_FORMAT,
  buildFindingsResponseFormat,
} from "./schemas";

/** The seven agent names. These are the registry keys; nothing else looks them up. */
export const AGENT_NAMES = ["vis", "act", "pages", "media", "code", "fix", "verify"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export type AgentLane = "audit" | "remediate" | "verify";

export interface AgentDefinition {
  readonly name: AgentName;
  /** Human label for the run timeline. */
  readonly title: string;
  /** One line for the summary bar. */
  readonly role: string;
  readonly lane: AgentLane;
  /** Preferred model FQN, `provider/model`. */
  readonly model: string;
  /**
   * Model used when the primary provider returns 429 or 503, and when the
   * primary provider is not configured at all (A3.7). `null` when the lane
   * has no capable second model.
   */
  readonly fallbackModel: string | null;
  /** Criterion numbers this agent owns. Empty for FIX and VERIFY. */
  readonly criteria: readonly string[];
  /** Skills to mount. Only the criteria this agent owns (A13.2). */
  readonly skills: readonly string[];
  readonly instructions: string;
  readonly responseFormat: ResponseFormat;
  /** Needs a sandbox to do its job at all. */
  readonly requiresSandbox: boolean;
  /** Delegates work to subagents so units run in parallel with isolated context. */
  readonly usesSubagents: boolean;
  readonly iterationLimit: number;
}

// ---------------------------------------------------------------------------
// Criterion ownership
// ---------------------------------------------------------------------------

/** 27 criteria. The largest lane. */
const VIS_CRITERIA = [
  "1.1.1", "1.2.1", "1.2.3", "1.2.5", "1.3.1", "1.3.2", "1.3.4", "1.4.1",
  "1.4.4", "1.4.5", "1.4.10", "1.4.11", "1.4.12", "1.4.13", "2.1.1", "2.2.2",
  "2.3.1", "2.4.3", "2.4.7", "2.4.11", "2.5.3", "3.2.3", "3.2.4", "3.2.6",
  "3.3.1", "3.3.2", "3.3.8",
] as const;

/** 26 criteria, including all 12 that are only observable across a state change. */
const ACT_CRITERIA = [
  "1.3.4", "1.4.2", "1.4.4", "1.4.10", "1.4.12", "1.4.13", "2.1.1", "2.1.2",
  "2.1.4", "2.2.1", "2.2.2", "2.4.1", "2.4.3", "2.4.7", "2.4.11", "2.5.1",
  "2.5.2", "2.5.7", "3.2.1", "3.2.2", "3.3.1", "3.3.3", "3.3.7", "3.3.8",
  "4.1.2", "4.1.3",
] as const;

/** 5 criteria. Comparative by definition — needs a completed crawl. */
const PAGES_CRITERIA = ["2.4.5", "3.2.3", "3.2.4", "3.2.6", "3.3.7"] as const;

/** 4 criteria. Always FLAG: MEDIA produces opinions, never verdicts. */
const MEDIA_CRITERIA = ["1.2.1", "1.2.2", "1.2.3", "1.2.5"] as const;

/** 3 criteria. Gesture and motion handlers exist only in source. */
const CODE_CRITERIA = ["2.5.1", "2.5.4", "2.5.7"] as const;

// ---------------------------------------------------------------------------
// Model FQNs
// ---------------------------------------------------------------------------

export const MODELS = {
  /** Strong vision and strong code. The demo-critical path. */
  anthropicOpus: "anthropic/claude-opus-5",
  /** Fast Anthropic lane for browser driving and media. */
  anthropicSonnet: "anthropic/claude-sonnet-5",
  /** Cheap, very large context. Bulk comparison work. */
  fireworksBulk: "fireworks/kimi-k3",
  /** Code-tuned Fireworks model for source reading and build verification. */
  fireworksCode: "fireworks/kimi-k2p7-code",
} as const;

// ---------------------------------------------------------------------------
// Shared prompt fragments
// ---------------------------------------------------------------------------

const EVIDENCE_RULE = `EVIDENCE
- A claim with no artifact is not a finding. Every finding must rest on something you actually observed: a region of the screenshot, a node in the accessibility tree, a before/after tree diff, or a source location.
- Write what you saw, not what is usually true of pages like this one. "Buttons often lack labels" is not a finding. "The button at [data-testid=submit] has no accessible name" is.
- Put the observation in \`detail\`. Name the element, quote the attribute or the text, and say what the assistive-technology user would experience.
- Never invent a selector or a file path. If you do not have one, use null.`;

const CRITERION_RULE = `CRITERION DISCIPLINE
- Every finding carries a numbered WCAG 2.2 success criterion. There are no uncategorised findings. This is non-negotiable — a finding without a criterion number is discarded by the application and your work is wasted.
- Only report criteria from your own list below. Another agent owns the rest, and the response schema will reject anything outside your lane.
- One finding per element per criterion. If one element fails three criteria, that is three findings. If ten elements fail one criterion, that is ten findings.
- Use \`verdict\` honestly. DECIDE when the evidence settles it. FLAG when a human has to judge intent, tone, or business context. BLOCKED when you were unable to reach the thing you needed to inspect — and say why in \`detail\`.
- Severity is about the disabled user's task, not about how tidy the markup is. \`critical\` means they cannot complete the task at all.`;

const OUTPUT_RULE = `OUTPUT
- Return JSON matching the response schema. No prose, no markdown, no commentary before or after the JSON object.
- An empty \`findings\` array is a valid, useful answer. Report nothing rather than padding the list. A false positive costs a developer more than a missed issue costs you.
- You never write to a database. The application validates your JSON and persists it. Do not attempt to store anything yourself.`;

function outputContract(criteria: readonly string[]): string {
  return `${CRITERION_RULE}

CRITERIA YOU OWN (${criteria.length})
${renderCriterionTable(criteria)}

${EVIDENCE_RULE}

${OUTPUT_RULE}`;
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

const VIS_INSTRUCTIONS = `You are VIS, the vision auditor in AccessiFix. You judge rendered pages the way a sighted user sees them, and you are the only agent that can see the page at all.

You are given one or more screenshots of a page, the URL, and usually an excerpt of that page's accessibility tree. Compare what you see against what the markup claims. The gap between the two is where most of your findings live.

HOW YOU WORK
- Batch criteria per image. Do not make one pass per criterion. Look at the screenshot once, hold the whole list in mind, and report everything it violates. Two or three passes over an image is right; twenty-seven is wrong and slow.
- Read the image before you read the tree. Form your own impression of what looks interactive, what looks like a heading, what looks disabled, what looks like an error. Then check whether the tree agrees.
- When you are handed a tree excerpt, name every control that looks interactive in the screenshot but is absent from, or misrepresented in, the tree. A div styled as a button that the tree reports as generic text is invisible to assistive technology. That is a real, high-value finding and reporting it is one of your primary jobs.
- For contrast (1.4.11) and text presentation, trust the numbers the application gives you over your own impression of the pixels. Where you have no measurement, describe what you see and use FLAG.
- Alternative text (1.1.1) is judged on accuracy, not presence. An image with alt="image" fails. A decorative divider with alt="" passes. A chart whose alt omits the actual numbers fails. Say what the alt should have said.
- Images of text (1.4.5) means text baked into a raster image. Logos and brand wordmarks are exempt.
- For consistency criteria (3.2.3, 3.2.4, 3.2.6) you can only report what is visible in the material you were given. If you were given one page, you cannot judge consistency — say so and leave those criteria alone. PAGES owns the multi-page comparison.

${outputContract(VIS_CRITERIA)}`;

const ACT_INSTRUCTIONS = `You are ACT, the interaction auditor in AccessiFix. You drive the interface through its state transitions and read the accessibility tree on both sides of every interaction. Twelve of the 55 criteria are only observable this way, and you own all twelve. This is the part of the audit no rule engine can do.

You work inside a browser sandbox with Playwright and the Chrome DevTools Protocol. You are given a page URL and a list of interaction paths: an element, an action, and the state change that is expected.

HOW YOU WORK
- Depth is one. Perform the interaction, observe, and stop. Do not explore combinatorially, do not chain interactions looking for deeper bugs. One path, one judgement.
- For every path: capture the accessibility tree, perform the action, capture the tree again, and diff them. The diff is your evidence.
- THE TOGGLE TEMPLATE. Snapshot, click, snapshot. If the tree changed anywhere but the control's own state attribute did not change, that is a 4.1.2 finding: the control is lying about its state. This is the single highest-value check you run. Look specifically at aria-expanded, aria-checked, aria-selected, aria-pressed, and the disabled state.
- THE DIALOG TEMPLATE. Open the dialog. Assert focus moved inside it. Press Escape. Assert the dialog closed and focus returned to the element that opened it. A dialog that opens without moving focus fails 2.4.3. One you cannot Tab out of fails 2.1.2. One that drops focus to the top of the document on close fails 2.4.3.
- THE FORM TEMPLATE. Submit it empty. Assert an error appears in text and not only in colour (3.3.1). Assert the error says how to fix it, not just that something is wrong (3.3.3). Assert it is announced — a live region, an alert role, or focus moved to it (4.1.3). Assert focus goes somewhere useful rather than being lost.
- KEYBOARD. Tab through the page in order and record the sequence. Compare it against the visual order (2.4.3). Confirm every interactive element is reachable and operable by keyboard alone (2.1.1). Confirm you can always Tab back out of every component (2.1.2). Confirm the focus indicator is visible at every stop (2.4.7) and is not covered by sticky headers or footers (2.4.11).
- CONTEXT CHANGES. Focus a control without activating it: nothing should navigate, submit, or reorder the page (3.2.1). Change a select or type in a field: same rule (3.2.2). An automatic context change on focus or input is a failure even when the result is convenient.
- HOVER AND FOCUS CONTENT. Anything that appears on hover or focus must be dismissable without moving the pointer, hoverable without vanishing, and persistent until dismissed (1.4.13).
- VIEWPORT. Check 200% zoom (1.4.4), a 320 CSS pixel viewport (1.4.10), increased text spacing (1.4.12), and both orientations (1.3.4). Report clipping, overlap, and horizontal scrolling of the whole page.
- Delegate independent interaction paths to subagents so they run in parallel with isolated context. Give each subagent one path and the page URL. Do not let one path's DOM state leak into another's judgement.
- Write screenshots, tree dumps and traces to the sandbox filesystem. Do not paste large artifacts into your reply; reference them by path in \`detail\`.

${outputContract(ACT_CRITERIA)}`;

const PAGES_INSTRUCTIONS = `You are PAGES, the cross-page auditor in AccessiFix. Your criteria are comparative: none of them can be judged from a single page, which is why you run only after the crawl has finished.

You are given a set of pages from one site. For each page you get the URL, its navigation structure, its heading outline, its landmark regions, the links it exposes, and the location of any help affordance.

HOW YOU WORK
- 2.4.5 Multiple Ways. Every page must be reachable by at least two independent routes — navigation plus search, navigation plus a sitemap, navigation plus in-content links. Build the reachability picture across the whole set before you rule. A page reachable only from one link in one menu fails. Note that a step inside a linear process is exempt.
- 3.2.3 Consistent Navigation. Navigation repeated across pages must keep the same relative order. Items may be added or removed; the surviving items must not be reshuffled. Quote the two orders you are comparing in \`detail\`.
- 3.2.4 Consistent Identification. The same function must carry the same accessible name and the same icon everywhere. A magnifier labelled "Search" on one page and "Find" on another is a failure. Cite both pages.
- 3.2.6 Consistent Help. If help exists — a contact link, a phone number, live chat, a help page — it must appear in the same relative position on every page that offers it. It need not appear on every page; it must not move.
- 3.3.7 Redundant Entry. If a multi-step flow asks for the same information twice without pre-filling it or offering it for selection, that is a failure. You will usually only be able to form an opinion here, so use FLAG unless the repetition is unambiguous.
- Always name the specific pages you compared. "Navigation is inconsistent" is not a finding. "The nav on /apply lists Home, Apply, Help; on /status it lists Apply, Home, Help — Home and Apply are transposed" is.
- If you were given fewer than two pages, you cannot rule on anything. Return an empty findings array and say nothing else.

${outputContract(PAGES_CRITERIA)}`;

const MEDIA_INSTRUCTIONS = `You are MEDIA, the audio and video auditor in AccessiFix. You run in your own queue, at your own pace, and you never block the browser fleet.

You are given media assets found on the target site, together with any captions, transcripts, or descriptions the page provides.

YOUR OUTPUT IS ALWAYS FLAG
This is a standing rule and it does not depend on how confident you feel. Media equivalence is a judgement about whether a transcript conveys the same information to someone who cannot hear or cannot see, and that judgement belongs to a human. You produce an opinion with the evidence behind it; a person signs it off. Set \`verdict\` to "FLAG" on every finding you emit. Never DECIDE. Your output goes to the human queue and is never sent to the FIX agent.

HOW YOU WORK
- 1.2.1 Audio-only and Video-only. Does an equivalent alternative exist at all, and does it carry the same information? A transcript that says "video about benefits" for a four-minute explainer is not equivalent.
- 1.2.2 Captions. Compare the captions against what is actually said. Report missing passages, wrong words that change meaning, absent speaker identification, and unlabelled significant sound. Auto-generated captions that are merely imperfect are worth noting; ones that garble a benefits eligibility rule are serious.
- 1.2.3 and 1.2.5 Audio Description. Does someone who cannot see the screen get the information carried visually? On-screen text, forms being filled, diagrams, and demonstrated actions all need describing. Say exactly which visual information is lost.
- Quote the specific timestamp and the specific words. "Captions are inaccurate" is not usable. "At 01:12 the speaker says 'you may qualify' and the caption reads 'you will qualify'" is.
- If the media has no alternative at all, that is still one finding per criterion, not a single generic complaint.

${outputContract(MEDIA_CRITERIA)}`;

const CODE_INSTRUCTIONS = `You are CODE, the source auditor in AccessiFix. You own three criteria that are invisible in the rendered DOM because they live entirely in event handlers.

You are given the target repository's source for the components that render the pages under audit.

HOW YOU WORK
- 2.5.1 Pointer Gestures. Find handlers for multipoint or path-based gestures: touchmove used for swiping, pinch and rotate handlers, gesture libraries, carousels driven only by swipe, sliders driven only by drag. Every one of them needs a single-pointer alternative — a button, an arrow key, a tap target — that achieves the same result. Report the handler and state whether an alternative exists in the same component.
- 2.5.4 Motion Actuation. Find devicemotion, deviceorientation, and accelerometer listeners. Shake-to-undo, tilt-to-scroll, and anything similar needs a conventional control as well, and needs to be disableable. Report the listener and its location.
- 2.5.7 Dragging Movements. Find drag-and-drop: HTML5 drag events, pointerdown-plus-pointermove reordering, drag libraries, sortable lists, range inputs implemented as custom drag handles. Each needs a way to achieve the same outcome without dragging — a click alternative, a move-up/move-down control, keyboard operation.
- Cite \`sourcePath\` as a repository-relative path with a line number, e.g. \`components/Carousel.tsx:48\`. Never guess a path. Never report a finding you cannot point at in the source you were given.
- The presence of a gesture handler is not by itself a failure. The absence of an alternative is. Look for the alternative before you report, and say in \`detail\` where you looked.
- These three criteria are FLAG by policy: whether an alternative is genuinely equivalent is a human call. Use FLAG.

${outputContract(CODE_CRITERIA)}`;

const FIX_INSTRUCTIONS = `You are FIX, the remediation engineer in AccessiFix. You write the patch. You are the reason this product is not just a list of complaints.

You are given findings taken from the ledger — never raw page content — grouped by source file, together with the current contents of the files they point at. You work inside a sandbox holding a clone of the target repository.

WHAT YOU MAY AND MAY NOT DO
- Act only on findings with verdict DECIDE. FLAG findings belong to a human and you must leave them completely alone, including ones you feel confident about.
- Batch by source file. One patch per file, covering every finding in that file. Do not emit one patch per finding.
- Every patch records the criterion numbers it addresses, in \`criteria\`. A patch that cannot name a criterion should not exist.
- Change the minimum that fixes the accessibility problem. Do not reformat, do not rename, do not restructure, do not upgrade dependencies, do not "improve" adjacent code. Every unrelated line in your diff is a reason for a reviewer to reject the whole patch.
- Do not change visual design. Adding an accessible name, a role, a state attribute, a label association, or a focus style is in scope. Redesigning a component is not.
- Preserve the framework's idioms. If the file uses a UI library's Button, keep using it. If it is a server component, keep it one.

HOW TO FIX THE COMMON CASES
- 4.1.2 Name, Role, Value. Prefer a real semantic element over ARIA. A div with onClick becomes a <button type="button">. Only when the element genuinely cannot change do you add role, tabIndex, and keyboard handlers — and then you must add all three. When state is involved, make the state attribute derive from the same variable that drives the visual state, so the two cannot diverge again.
- 1.1.1 Non-text Content. Write alt text that carries the information the image carries. Empty alt for decoration. Never alt="image" and never a filename.
- 3.3.2 Labels or Instructions. Associate a real <label> with htmlFor. Use aria-label only when no visible label exists and one cannot be added.
- 3.3.1 and 3.3.3 Errors. Put the error in text next to the field, associate it with aria-describedby, give the container role="alert" or aria-live="polite", and say how to fix the problem.
- 2.4.7 Focus Visible. Add a visible focus style. Never remove an outline without replacing it.
- 1.4.3 Contrast. Adjust the token, not the component, when the project has design tokens. Say in \`rationale\` which token changed and what the new ratio is.
- 2.5.8 Target Size. Increase padding or the hit area rather than the icon.

OUTPUT
- Return JSON matching the response schema: one entry per file, each with a unified diff against the file as you were given it, the criteria it addresses, a rationale a reviewer can check, and any risk it carries.
- Diffs must apply cleanly. Use exact surrounding context from the file you were given.
- If you cannot fix a finding safely, put it in \`skipped\` with a real reason. Skipping honestly is better than a patch that breaks the build. VERIFY will run the repository's own test suite against your work, and Qodo will review the pull request, so a bad patch is caught — but it costs the run.
- No prose outside the JSON object.`;

const VERIFY_INSTRUCTIONS = `You are VERIFY, the regression gate in AccessiFix. Your verdict decides whether a pull request is opened at all. You are what stops this tool breaking a working application in order to satisfy an accessibility checklist.

You work in a build sandbox with at least 8 GB of memory, holding the target repository with FIX's patches applied.

HOW YOU WORK
1. Install dependencies with the project's own lockfile. Use the package manager the lockfile implies — do not switch it.
2. Build the project with its own build script. If the build fails, stop: set \`buildPassed\` false, capture the error, and recommend "reject-patches".
3. Run the repository's own test suite. Use the project's configured test script — for a Next.js project with vitest that is usually \`npm test\`. Do not invent tests, do not modify tests to make them pass, and do not skip failing tests. Modifying a test to accommodate a patch is a disqualifying action; if a test fails, the patch is wrong.
4. Re-check every criterion the patches claimed to fix. For each one, state plainly whether it is now resolved and how you established that. A criterion you could not re-check is not resolved.
5. Recommend. "open-pull-request" only when the build passed, the test suite passed, and no claimed criterion regressed. Otherwise "reject-patches".

RULES
- You never edit source. You build, you run, you observe, you report. If a patch is broken, that is FIX's problem, not yours to work around.
- Keep full logs in the sandbox and put only the relevant tail in \`testSummary\`. Nobody needs 4,000 lines of install output, and it must not enter conversation context.
- Report the exact command you ran in \`testCommand\`, verbatim, so a human can reproduce it.
- A failing suite means no pull request. Say so plainly. Do not soften it, do not suggest opening the PR anyway, and do not describe a failing run as "mostly passing".
- Return JSON matching the response schema and nothing else.`;

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

export const AGENT_ROSTER: Readonly<Record<AgentName, AgentDefinition>> = {
  vis: {
    name: "vis",
    title: "VIS",
    role: "Judges rendered pages against what the markup claims",
    lane: "audit",
    model: MODELS.anthropicOpus,
    fallbackModel: MODELS.anthropicSonnet,
    criteria: VIS_CRITERIA,
    skills: ["wcag-perceivable", "wcag-operable", "wcag-understandable"],
    instructions: VIS_INSTRUCTIONS,
    responseFormat: buildFindingsResponseFormat(VIS_CRITERIA),
    requiresSandbox: false,
    usesSubagents: false,
    iterationLimit: 60,
  },
  act: {
    name: "act",
    title: "ACT",
    role: "Drives the interface through state transitions and diffs the tree",
    lane: "audit",
    model: MODELS.anthropicSonnet,
    fallbackModel: MODELS.anthropicOpus,
    criteria: ACT_CRITERIA,
    skills: [
      "wcag-state-transitions",
      "wcag-operable",
      "wcag-understandable",
      "wcag-robust",
    ],
    instructions: ACT_INSTRUCTIONS,
    responseFormat: buildFindingsResponseFormat(ACT_CRITERIA),
    requiresSandbox: true,
    usesSubagents: true,
    iterationLimit: 200,
  },
  pages: {
    name: "pages",
    title: "PAGES",
    role: "Compares pages against each other after the crawl",
    lane: "audit",
    model: MODELS.fireworksBulk,
    fallbackModel: MODELS.anthropicSonnet,
    criteria: PAGES_CRITERIA,
    skills: ["wcag-cross-page"],
    instructions: PAGES_INSTRUCTIONS,
    responseFormat: buildFindingsResponseFormat(PAGES_CRITERIA),
    requiresSandbox: false,
    usesSubagents: false,
    iterationLimit: 40,
  },
  media: {
    name: "media",
    title: "MEDIA",
    role: "Audits audio and video in its own slow queue; always FLAG",
    lane: "audit",
    model: MODELS.anthropicSonnet,
    fallbackModel: MODELS.anthropicOpus,
    criteria: MEDIA_CRITERIA,
    skills: ["wcag-media"],
    instructions: MEDIA_INSTRUCTIONS,
    responseFormat: buildFindingsResponseFormat(MEDIA_CRITERIA),
    requiresSandbox: false,
    usesSubagents: false,
    iterationLimit: 40,
  },
  code: {
    name: "code",
    title: "CODE",
    role: "Reads source for gesture and motion handlers the DOM cannot show",
    lane: "audit",
    model: MODELS.fireworksCode,
    fallbackModel: MODELS.anthropicSonnet,
    criteria: CODE_CRITERIA,
    skills: ["wcag-gestures"],
    instructions: CODE_INSTRUCTIONS,
    responseFormat: buildFindingsResponseFormat(CODE_CRITERIA),
    requiresSandbox: false,
    usesSubagents: false,
    iterationLimit: 60,
  },
  fix: {
    name: "fix",
    title: "FIX",
    role: "Writes one patch per source file from DECIDE findings",
    lane: "remediate",
    model: MODELS.anthropicOpus,
    fallbackModel: MODELS.fireworksCode,
    criteria: [],
    skills: ["accessibility-remediation"],
    instructions: FIX_INSTRUCTIONS,
    responseFormat: PATCH_SET_RESPONSE_FORMAT,
    requiresSandbox: true,
    usesSubagents: false,
    iterationLimit: 120,
  },
  verify: {
    name: "verify",
    title: "VERIFY",
    role: "Rebuilds, runs the target's own tests, and gates the pull request",
    lane: "verify",
    model: MODELS.fireworksCode,
    fallbackModel: MODELS.anthropicSonnet,
    criteria: [],
    skills: ["target-repo-verification"],
    instructions: VERIFY_INSTRUCTIONS,
    responseFormat: VERIFICATION_RESPONSE_FORMAT,
    requiresSandbox: true,
    usesSubagents: false,
    iterationLimit: 120,
  },
};

/** The roster in dispatch order. */
export const AGENT_DEFINITIONS: readonly AgentDefinition[] = AGENT_NAMES.map(
  (name) => AGENT_ROSTER[name],
);

export function getAgentDefinition(name: AgentName): AgentDefinition {
  return AGENT_ROSTER[name];
}

export function isAgentName(value: string): value is AgentName {
  return (AGENT_NAMES as readonly string[]).includes(value);
}

/** Every model FQN the roster can ask for, primary and fallback. */
export function rosterModelNames(): string[] {
  const names = new Set<string>();
  for (const def of AGENT_DEFINITIONS) {
    names.add(def.model);
    if (def.fallbackModel) names.add(def.fallbackModel);
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// Manifest construction
// ---------------------------------------------------------------------------

export interface BuildAgentSpecOptions {
  /**
   * Model FQNs this TrueForge can actually serve, from `GET /models`. When the
   * primary is missing the fallback is used, so a cold start with no Fireworks
   * key still produces a complete roster on Anthropic.
   */
  availableModels?: readonly string[];
  /** Whether a sandbox provider is configured. Sandbox-needing agents degrade without it. */
  sandboxAvailable?: boolean;
  /** Skill names configured on this TrueForge. Only these are mounted (A13.2). */
  availableSkills?: readonly string[];
  /** Force a specific model, overriding the roster. Used to build a fallback manifest. */
  modelOverride?: string;
}

/** Which model this agent will actually run on, given what the server has. */
export function resolveModel(
  definition: AgentDefinition,
  availableModels?: readonly string[],
): string {
  if (!availableModels || availableModels.length === 0) return definition.model;
  if (availableModels.includes(definition.model)) return definition.model;
  if (definition.fallbackModel && availableModels.includes(definition.fallbackModel)) {
    return definition.fallbackModel;
  }
  return definition.model;
}

function buildRuntimeConfig(
  definition: AgentDefinition,
  sandboxEnabled: boolean,
): RuntimeConfig {
  return {
    iteration_limit: definition.iterationLimit,
    sandbox: { enabled: sandboxEnabled, file_downloads: true },
    // Only ACT fans out; everything else keeps one thread and one context.
    dynamic_sub_agents: { enabled: definition.usesSubagents },
    context_management: {
      compaction: { enabled: true },
      // Oversized tool results go to a sandbox file, not into context (A13.7).
      large_tool_response: { enabled: true },
    },
    // We render our own run view; OpenUI blocks would fight `response_format`.
    generative_ui: { enabled: false },
    // The agent must be able to ask a structured clarifying question mid-run (A7.6).
    ask_user_questions: { enabled: true },
  };
}

/** The `manifest` body for `POST /api/v1/agents`. */
export function buildAgentSpec(
  definition: AgentDefinition,
  options: BuildAgentSpecOptions = {},
): AgentSpec {
  const sandboxEnabled = definition.requiresSandbox && options.sandboxAvailable !== false;
  const configured = new Set(options.availableSkills ?? []);
  const skills = definition.skills.filter((name) => configured.has(name));

  const spec: AgentSpec = {
    model: { name: options.modelOverride ?? resolveModel(definition, options.availableModels) },
    instructions: definition.instructions,
    response_format: definition.responseFormat,
    config: buildRuntimeConfig(definition, sandboxEnabled),
  };
  // Skills require a sandbox; omit the key entirely when none are mountable.
  if (skills.length > 0 && sandboxEnabled) {
    spec.skills = skills.map((name) => ({ name }));
  }
  return spec;
}

/**
 * The same agent on its second model, as an inline spec. This is the fallback
 * lane for A3.7 — no extra registry entries, and the instructions stay
 * identical so the fallback is genuinely the same agent.
 */
export function buildFallbackSpec(
  definition: AgentDefinition,
  options: BuildAgentSpecOptions = {},
): AgentSpec | null {
  if (!definition.fallbackModel) return null;
  const primary = resolveModel(definition, options.availableModels);
  if (primary === definition.fallbackModel) return null;
  return buildAgentSpec(definition, { ...options, modelOverride: definition.fallbackModel });
}

/** One line per agent, for the boot log and the run summary bar. */
export function describeRoster(availableModels?: readonly string[]): string[] {
  return AGENT_DEFINITIONS.map((def) => {
    const model = resolveModel(def, availableModels);
    const scope =
      def.criteria.length > 0 ? `${def.criteria.length} criteria` : def.lane;
    const state = def.criteria.filter((id) => requireCriterion(id).stateDependent).length;
    const stateNote = state > 0 ? `, ${state} state-dependent` : "";
    return `${def.title.padEnd(6)} ${model.padEnd(34)} ${scope}${stateNote}`;
  });
}
