/**
 * The VIS candidate-extraction pass (A4.2) - the half of path enumeration that
 * only a model can do.
 *
 * `lib/paths` enumerates two sources and subtracts one from the other. The
 * accessibility tree it can read itself. The other source is a screenshot, and
 * reading a screenshot needs an eye. That eye lives here.
 *
 * Without this pass, enumeration runs tree-only. Tree-only still catches every
 * stale-state 4.1.2 - a control whose `aria-expanded` never moves - because
 * both sides of that comparison are in the tree. What it cannot catch is a
 * div-button, because a div-button is *by definition* what the tree does not
 * contain. There is nothing to enumerate and nothing to diff. This module is
 * the only way that finding is ever produced.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOES NOT USE THE SAVED `vis` AGENT DIRECTLY
 *
 * The saved `vis` agent's manifest pins `response_format` to the findings
 * schema, narrowed to the 27 criteria VIS owns. A candidate list is not a
 * findings list - it is an observation the *application* then turns into
 * findings, deterministically, in `diffSources`. So the pass runs on an inline
 * manifest: the VIS model and its fallback, with candidate instructions and the
 * candidate response format. Same eye, different question.
 *
 * That also keeps the judgement where it belongs. The model is never asked
 * "is this a 4.1.2 violation" - it does not see the accessibility tree and
 * could not answer honestly if it did. It is asked what it can see. The
 * comparison against the tree, the classification, the confidence arithmetic
 * and the verdict are all application code.
 *
 * ---------------------------------------------------------------------------
 * THIS FUNCTION NEVER THROWS
 *
 * A failed vision pass degrades enumeration to tree-only; it does not fail the
 * page. `lib/paths` documents that `visionCandidates` is optional and that its
 * absence is not an error, and this module holds up that end: every failure
 * path returns an empty candidate list with `error` set, so the caller records
 * what happened and enumerates from the tree regardless.
 */

import { z } from "zod";

import { AGENT_ROSTER, resolveModel, type AgentDefinition } from "@/lib/harness/agents";
import {
  getTrueForgeClient,
  messageText,
  TrueForgeError,
  type AgentSpec,
  type TrueForgeClient,
  type TurnInputItem,
} from "@/lib/harness/client";
import { waitForTurn } from "@/lib/harness/run";
import type { VisionControlCandidate } from "@/lib/paths";

import {
  buildVisionCandidatesResponseFormat,
  buildVisionCandidatesSchema,
  VISION_LOOKS_LIKE,
  type VisionCandidate,
  type VisionLabelSource,
  type VisionLooksLike,
} from "./schemas";

/* ========================================================================== */
/* Tunables                                                                   */
/* ========================================================================== */

/**
 * Candidates kept from one screenshot, highest confidence first.
 *
 * `MAX_PATHS_PER_PAGE` is 40 and vision-only controls outrank everything else
 * in the priority sort, so an unbounded candidate list from a dense page could
 * fill the entire path budget with guesses and evict the disclosure control the
 * run was for. Sixty leaves the diff plenty to work with while keeping that
 * impossible in practice.
 */
export const MAX_VISION_CANDIDATES = 60;

/**
 * Candidates below this stated confidence are dropped before the diff.
 *
 * This is the *only* place a hedged candidate can be stopped, which is why it
 * is not set lower. A vision-only control classified `orphan-text` starts at
 * 0.86 in `diffSources` and the model's own certainty enters as
 * `(stated - 0.6) x 0.4` - so even a candidate the model rated 0.0 still scores
 * 0.62, comfortably above the 0.35 report threshold. No amount of stated doubt
 * downstream can prevent the finding. It has to be prevented here.
 *
 * 0.5 is where it belongs on the merits: the claim a vision-only finding makes
 * is that a control exists and assistive technology cannot reach it, and a
 * model that is no more confident than not is not evidence for the first half.
 *
 * Measured against Clearway's application view, this is also exactly where the
 * model itself put the line: the eight real controls came back at 0.80-0.95,
 * and the seven checklist chips - decorative rows that only look like pills -
 * came back at 0.30. Dropping them here is not tuning to that page; it is
 * taking the model at its word.
 */
export const MIN_STATED_CONFIDENCE = 0.5;

/**
 * How much a label the model did not read off the control is worth.
 *
 * An icon-only label is the model's own word for a glyph. It is the single
 * largest false-positive risk in the feature: the label is compared against
 * accessible names in the tree, and a name the model invented will of course
 * not be there - which looks exactly like a div-button and is not one. Damping
 * the stated confidence feeds straight into the certainty term in
 * `diffSources`, and `icon` in `looksLike` additionally trips the
 * `INFERRED_LABEL_HINTS` penalty there. Both are wanted: this is the case the
 * product must be most reluctant about.
 */
export const LABEL_SOURCE_DAMPING: Readonly<Record<VisionLabelSource, number>> = {
  "visible-text": 1,
  "icon-only": 0.75,
  "tooltip-or-placeholder": 0.85,
};

/** Attempts against the primary model before the fallback model is tried. */
export const VISION_ATTEMPTS = 2;

/** Total time one candidate pass may take. */
export const VISION_TIMEOUT_MS = 180_000;

/**
 * Largest screenshot sent to a provider, in decoded bytes.
 *
 * Full-page PNGs of long pages get big, and a provider rejecting the image
 * wastes the whole pass. Over this, the pass is skipped and enumeration runs
 * tree-only - a degraded page, not a failed one.
 */
export const MAX_SCREENSHOT_BYTES = 4_500_000;

/* ========================================================================== */
/* Prompt                                                                     */
/* ========================================================================== */

/**
 * The instructions, written to suppress inference.
 *
 * Every sentence here is defending against the same failure: a capable model
 * asked to find interactive elements will happily *reason* about which
 * elements ought to be interactive, and reasoning produces labels that are not
 * on the page. A label that is not on the page cannot be in the accessibility
 * tree either, so it classifies as `absent` and reads as a discovery. The
 * defence is to keep the task perceptual and make the model say when it has
 * stopped perceiving and started naming.
 */
export const VISION_CANDIDATE_INSTRUCTIONS = `You are the eye of an accessibility auditor. You are given one screenshot of one web page.

Your only job is to list what LOOKS interactive. You are not auditing the page, you are not judging it, and you are not being asked whether anything is broken. Another system compares your list against the page's accessibility tree; anything you can see that the tree does not contain is a control that assistive technology cannot reach. That comparison is only as good as your transcription, so transcribe.

WHAT TO LIST
- Buttons, including ones drawn as plain text or as a coloured rectangle with no border.
- Dropdowns, selects, language and currency pickers, anything with a chevron or caret suggesting it opens.
- Tabs, segmented controls, pill switchers.
- Toggles, switches, checkboxes, radio buttons.
- Anything that opens a dialog, modal, drawer, sheet or menu.
- Cards, tiles and rows that look clickable as a whole - a card with a hover shadow, a row with a chevron at its right edge.
- Links that are styled as buttons, and icon-only controls: hamburgers, close crosses, search glasses, carets, avatars, kebab and meat-ball menus.
- Text fields, search boxes, sliders and steppers.

WHAT NOT TO LIST
- Headings, body copy, captions, legal text, static labels.
- Logos and decorative artwork, unless the whole thing is plainly a control.
- Anything you are guessing at. If you are not reasonably sure a click would do something, leave it out. A short accurate list is worth far more than a long speculative one - every wrong entry becomes a false accessibility finding against a real site.

TRANSCRIBE, DO NOT INTERPRET
- \`label\` is the text ON the control, copied exactly: same words, same order, same capitalisation, including any suffix or code that is rendered as part of it. If the control reads "EnglishEN", the label is "EnglishEN" and not "English" or "Language selector".
- Do not translate, expand, tidy, or normalise. Do not turn "Sign in" into "Login".
- Do not describe. "The blue button in the header" is not a label.
- \`looksLike\` is the shape you see, not the ARIA role you think it deserves. Pick \`other\` rather than forcing a fit.

WHEN THERE IS NO TEXT
- Some controls show only a glyph. Name it in one or two plain words - "hamburger menu", "close", "search" - and set \`labelSource\` to \`icon-only\`. That flag matters more than the name you choose: it tells the comparison that the words are YOURS, not the page's, and the finding is scored down accordingly.
- Never set \`labelSource\` to \`visible-text\` for a name you supplied. That is the one error that turns your guess into somebody's accessibility bug report.
- If the words you used are on screen but belong to something else - a placeholder, a tooltip, a caption underneath - use \`tooltip-or-placeholder\`.

CONFIDENCE
- \`confidence\` is how sure you are that clicking it does something, not how sure you are of the label.
- Be honest and spread the range. A submit button at the end of a form is 0.95. A slightly raised rectangle that might just be a card is 0.5.

Return only the JSON your response format describes.`;

/* ========================================================================== */
/* Input and output                                                           */
/* ========================================================================== */

export interface ExtractVisionCandidatesInput {
  /** For the run timeline, when the caller has one. */
  readonly runId?: string;
  readonly pageUrl: string;
  /** Base64 PNG, straight off `PageCapture.screenshot`. `null` skips the pass. */
  readonly screenshot: string | null;
  /** The page title, for context. Optional. */
  readonly title?: string | null;
  /** Model FQNs this TrueForge can serve, from `GET /models`. */
  readonly availableModels?: readonly string[];
  /** Narrow the appearance vocabulary this pass will accept. */
  readonly looksLike?: readonly VisionLooksLike[];
  readonly maxCandidates?: number;
  readonly timeoutMs?: number;
  readonly attempts?: number;
  readonly client?: TrueForgeClient;
  readonly signal?: AbortSignal;
}

/** Why a pass produced no candidates without that being a failure. */
export type VisionSkipReason = "no-screenshot" | "screenshot-too-large" | null;

export interface VisionCandidatesResult {
  /** Ready to hand to `enumerateInteractionPaths`. Empty on any failure. */
  readonly candidates: readonly VisionControlCandidate[];
  /** Exactly what the model returned, before damping. For the evidence trail. */
  readonly raw: readonly VisionCandidate[];
  /** The TrueForge session, recorded on the job row so a restart reattaches (A12.1). */
  readonly sessionId: string | null;
  readonly turnId: string | null;
  /** The model that answered, or was asked last. */
  readonly model: string;
  readonly usedFallback: boolean;
  readonly attempts: number;
  readonly skipped: VisionSkipReason;
  /** Set when the pass failed. Never thrown - enumeration degrades to tree-only. */
  readonly error: string | null;
  /** Candidates the model returned that this module dropped, and why. */
  readonly dropped: number;
  readonly durationMs: number;
}

/* ========================================================================== */
/* The pass                                                                   */
/* ========================================================================== */

/**
 * Ask the VIS model what looks interactive in one screenshot.
 *
 * Returns `VisionControlCandidate[]` in the exact shape `lib/paths` expects,
 * with the model's stated confidence damped by how it came by each label.
 *
 * Never throws. A page whose vision pass fails is enumerated from the tree
 * alone, which is the documented degradation.
 */
export async function extractVisionCandidates(
  input: ExtractVisionCandidatesInput,
): Promise<VisionCandidatesResult> {
  const started = Date.now();
  const definition = AGENT_ROSTER.vis;
  const primary = resolveModel(definition, input.availableModels);

  const empty = (
    over: Partial<VisionCandidatesResult> = {},
  ): VisionCandidatesResult => ({
    candidates: [],
    raw: [],
    sessionId: null,
    turnId: null,
    model: primary,
    usedFallback: false,
    attempts: 0,
    skipped: null,
    error: null,
    dropped: 0,
    durationMs: Date.now() - started,
    ...over,
  });

  const screenshot = (input.screenshot ?? "").trim();
  if (screenshot.length === 0) return empty({ skipped: "no-screenshot" });
  if (decodedBytes(screenshot) > MAX_SCREENSHOT_BYTES) {
    return empty({ skipped: "screenshot-too-large" });
  }

  const looksLike = input.looksLike ?? VISION_LOOKS_LIKE;
  const schema = buildVisionCandidatesSchema([...looksLike]);
  const client = input.client ?? getTrueForgeClient();
  const attempts = Math.max(1, input.attempts ?? VISION_ATTEMPTS);

  // The primary model, retried, then the fallback model once. Same shape as
  // `runAgentWithFallback` in the harness; reimplemented rather than reused
  // because that helper takes a string prompt and this pass sends an image.
  const lane: string[] = [primary];
  if (definition.fallbackModel && definition.fallbackModel !== primary) {
    lane.push(definition.fallbackModel);
  }

  let lastError: unknown = null;
  let used = 0;

  for (const [laneIndex, model] of lane.entries()) {
    const tries = laneIndex === 0 ? attempts : 1;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      used += 1;
      try {
        const answer = await askOnce({
          client,
          spec: candidateSpec(definition, model, looksLike),
          prompt: candidatePrompt(input),
          screenshot,
          schema,
          timeoutMs: input.timeoutMs ?? VISION_TIMEOUT_MS,
          signal: input.signal,
        });

        const shaped = shape(answer.candidates, input.maxCandidates ?? MAX_VISION_CANDIDATES);
        return {
          candidates: shaped.candidates,
          raw: answer.candidates,
          sessionId: answer.sessionId,
          turnId: answer.turnId,
          model,
          usedFallback: laneIndex > 0,
          attempts: used,
          skipped: null,
          error: null,
          dropped: shaped.dropped,
          durationMs: Date.now() - started,
        };
      } catch (error) {
        lastError = error;
        if (isAborted(error)) {
          return empty({ attempts: used, model, error: describe(error) });
        }
        // A 400 or a malformed manifest will fail identically on every retry.
        if (!isRetryable(error)) break;
      }
    }
  }

  return empty({
    attempts: used,
    model: lane[lane.length - 1] ?? primary,
    usedFallback: lane.length > 1,
    error: describe(lastError),
  });
}

/* ========================================================================== */
/* One call                                                                   */
/* ========================================================================== */

interface AskOnceInput {
  readonly client: TrueForgeClient;
  readonly spec: AgentSpec;
  readonly prompt: string;
  readonly screenshot: string;
  readonly schema: z.ZodType<{ candidates: VisionCandidate[] }>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

interface AskOnceResult {
  readonly candidates: readonly VisionCandidate[];
  readonly sessionId: string;
  readonly turnId: string;
}

/**
 * One session, one turn, one screenshot.
 *
 * The turn is built by hand rather than through `runAgent` because the harness
 * runner takes a string prompt, and this is the one call in the product that
 * has to send an image. The image goes as a `file` content part carrying a data
 * URI, which is what `POST /sessions/{id}/turns` accepts.
 */
async function askOnce(input: AskOnceInput): Promise<AskOnceResult> {
  const session = await input.client.createSession({ spec: input.spec }, input.signal);

  const content: Array<Record<string, unknown>> = [
    { type: "text", text: input.prompt },
    {
      type: "file",
      name: "page.png",
      data: `data:image/png;base64,${input.screenshot}`,
    },
  ];
  const item: TurnInputItem = { type: "user.message", content };

  const created = await input.client.createTurn(
    session.id,
    { input: [item], stream: false },
    input.signal,
  );

  const turn = await waitForTurn(session.id, created.id, {
    client: input.client,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });

  if (turn.state.status !== "done") {
    const why =
      turn.state.status === "error"
        ? turn.state.message
        : turn.state.status === "cancelled"
          ? (turn.state.reason ?? "cancelled")
          : "still running";
    throw new VisionPassError(`the vision pass did not finish: ${why}`, true);
  }

  const text = messageText(turn.state.output);
  const json = extractJson(text);
  if (json === undefined) {
    throw new VisionPassError(
      `the vision pass returned no JSON. First 200 characters: ${text.slice(0, 200)}`,
      true,
    );
  }

  const parsed = input.schema.safeParse(json);
  if (!parsed.success) {
    throw new VisionPassError(
      `the vision pass returned JSON that does not match the schema: ${formatIssues(parsed.error)}`,
      true,
    );
  }

  return { candidates: parsed.data.candidates, sessionId: session.id, turnId: created.id };
}

/** A failure inside one candidate pass. Never escapes `extractVisionCandidates`. */
export class VisionPassError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "VisionPassError";
    this.retryable = retryable;
  }
}

/* ========================================================================== */
/* Manifest and prompt                                                        */
/* ========================================================================== */

/**
 * The VIS model, asked the candidate question instead of the findings question.
 *
 * No sandbox and no skills: this pass reads one image and returns one list. It
 * has nothing to run and nothing to look up, and mounting the WCAG skills would
 * invite exactly the criterion-by-criterion reasoning the prompt spends its
 * length suppressing.
 */
function candidateSpec(
  definition: AgentDefinition,
  model: string,
  looksLike: readonly VisionLooksLike[],
): AgentSpec {
  return {
    model: { name: model },
    instructions: VISION_CANDIDATE_INSTRUCTIONS,
    response_format: buildVisionCandidatesResponseFormat([...looksLike]),
    config: {
      // One look at one image. A high iteration limit would only buy the model
      // room to second-guess what it saw.
      iteration_limit: Math.min(definition.iterationLimit, 12),
      sandbox: { enabled: false },
      dynamic_sub_agents: { enabled: false },
      context_management: {
        compaction: { enabled: true },
        large_tool_response: { enabled: true },
      },
      generative_ui: { enabled: false },
      // Nothing here is worth pausing a crawl to ask a human about.
      ask_user_questions: { enabled: false },
    },
  };
}

function candidatePrompt(input: ExtractVisionCandidatesInput): string {
  const lines = [
    `Page: ${input.pageUrl}`,
    ...(input.title ? [`Title: ${input.title}`] : []),
    "",
    "The screenshot of this page is attached. List every element in it that looks interactive.",
    "Transcribe the labels exactly as rendered. Where a control shows only an icon, name the glyph and set labelSource to icon-only.",
  ];
  return lines.join("\n");
}

/* ========================================================================== */
/* Shaping                                                                    */
/* ========================================================================== */

interface ShapedCandidates {
  readonly candidates: readonly VisionControlCandidate[];
  readonly dropped: number;
}

/**
 * Turn validated model output into the shape `lib/paths` diffs against.
 *
 * Three things happen here and nothing else:
 *
 *   1. Confidence is damped by `labelSource`, so a name the model invented for
 *      a glyph carries less weight than one it read off the page.
 *   2. `icon` is appended to `looksLike` for icon-only labels, which trips
 *      `INFERRED_LABEL_HINTS` in `diffSources` for a further penalty. The two
 *      compound deliberately.
 *   3. The list is sorted by confidence and capped, so a dense page cannot fill
 *      the 40-path budget with guesses.
 *
 * No filtering on semantics. Deciding what a candidate means against the tree
 * is `diffSources`'s job, and doing any of it here would split the judgement
 * across two modules.
 */
export function shape(
  candidates: readonly VisionCandidate[],
  maxCandidates: number = MAX_VISION_CANDIDATES,
): ShapedCandidates {
  const kept: VisionControlCandidate[] = [];
  let dropped = 0;

  for (const candidate of candidates) {
    const label = candidate.label.replace(/\s+/g, " ").trim();
    if (label.length === 0) {
      dropped += 1;
      continue;
    }
    if (candidate.confidence < MIN_STATED_CONFIDENCE) {
      dropped += 1;
      continue;
    }

    const damping = LABEL_SOURCE_DAMPING[candidate.labelSource] ?? 1;
    kept.push({
      label,
      approxSelector: candidate.approxSelector.replace(/\s+/g, " ").trim(),
      // `looksLike` is prose to `lib/paths` - `roleFromLooksLike` reads it for
      // a role and `INFERRED_LABEL_HINTS` reads it for the word `icon`.
      looksLike:
        candidate.labelSource === "icon-only"
          ? `${candidate.looksLike} icon`
          : candidate.looksLike,
      confidence: round(Math.min(1, Math.max(0, candidate.confidence * damping))),
    });
  }

  const sorted = [...kept].sort(
    (a, b) => (b.confidence ?? 0) - (a.confidence ?? 0),
  );
  const capped = sorted.slice(0, Math.max(0, maxCandidates));
  return { candidates: capped, dropped: dropped + (sorted.length - capped.length) };
}

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Decoded size of a base64 payload, without decoding it. */
function decodedBytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * `response_format` should give us a bare JSON object, but a model that wrapped
 * it in a fence or a sentence has still done the work. Mirrors the recovery in
 * `lib/harness/run.ts`, which is not exported.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;

  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  return undefined;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function isRetryable(error: unknown): boolean {
  if (error instanceof VisionPassError) return error.retryable;
  if (error instanceof TrueForgeError) return error.isRetryable;
  return false;
}

function isAborted(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "aborted");
}

function describe(error: unknown): string {
  if (error === null || error === undefined) return "the vision pass produced no answer";
  if (error instanceof Error) return error.message;
  return String(error);
}
