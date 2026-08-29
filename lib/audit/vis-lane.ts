/**
 * The VIS lane: 27 criteria, one screenshot, two or three looks.
 *
 * VIS is the only agent that can see the page at all. Everything else in the
 * product reads structure — the accessibility tree, axe's rule output, the
 * source — and structure is exactly what a div styled as a button is missing.
 * This lane is where the rendered page enters the audit.
 *
 * ---------------------------------------------------------------------------
 * WHY THREE PASSES AND NOT TWENTY-SEVEN
 *
 * Latency is the constraint here, not cost. A screenshot is a large input and
 * the round trip is dominated by it, so twenty-seven single-criterion calls
 * would upload the same image twenty-seven times and take twenty-seven times as
 * long to say the same thing. The model is perfectly able to hold a list of
 * eight criteria while it looks at one picture; that is what the roster's own
 * instructions tell it to do ("Two or three passes over an image is right;
 * twenty-seven is wrong and slow").
 *
 * So the 27 are split into three coherent batches — one about text and imagery,
 * one about structure and semantics, one about controls and behaviour — and the
 * three run concurrently against the same screenshot. Coherent rather than
 * arbitrary: a pass that is asked about contrast and alt text at once is asked
 * about one way of looking at the page, and does not have to switch frames
 * mid-answer.
 *
 * The split narrows the *prompt*, never the schema. The saved `vis` agent
 * publishes a `response_format` covering all 27 (`buildFindingsResponseFormat`
 * in `lib/harness/schemas.ts`), and validating a batch's reply against only that
 * batch would reject an answer the wire schema explicitly permits. Findings are
 * merged and deduplicated instead — the same missing label seen twice is one
 * finding.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS LANE WILL NOT DO
 *
 * No screenshot, no pass. A page whose screenshot never arrived is returned
 * inconclusive across all 27, not clean: VIS's entire evidence base is the
 * image, and an empty findings list from a lane that never saw anything is a
 * false pass with extra steps.
 *
 * The three consistency criteria (3.2.3, 3.2.4, 3.2.6) are in VIS's lane because
 * VIS can *contribute* to them, but they are comparative and cannot be settled
 * from one page. They come back inconclusive from here every time; PAGES owns
 * the comparison and rules on them after the crawl.
 */

import type { AxTreeLike } from './tree';
import type { AuditPhase } from './types';
import {
  MAX_LANE_SCREENSHOT_BYTES,
  resolveLaneCapabilities,
  type LaneCapabilityOptions,
} from './lane-context';
import {
  decodedBytes,
  inconclusiveFor,
  inconclusiveResult,
  lanePolicy,
  renderTreeExcerpt,
  runFindingsAgent,
  toClaims,
  truncate,
  type LaneInconclusive,
  type ModelFindingClaim,
  type ModelLaneResult,
} from './model-lane';
import { renderCriterionTable } from '@/lib/harness/criteria';

/* ========================================================================== */
/* Lane policy                                                                */
/* ========================================================================== */

/** The 27, from the roster, checked against `criteriaForAgent('VIS')` on load. */
export const VIS_POLICY = lanePolicy('vis', 'VIS');

/**
 * The three batches. Their union is exactly the 27; the assertion below fails
 * the build if an edit to the roster ever leaves a criterion in no batch, which
 * would silently stop VIS looking for it.
 */
export const VIS_BATCHES: readonly {
  readonly id: string;
  readonly title: string;
  readonly focus: string;
  readonly criteria: readonly string[];
}[] = [
  {
    id: 'text-and-imagery',
    title: 'Text, imagery and colour',
    focus: `Look at the pixels. Read every piece of text in the image and look at every picture in it.
- Judge alternative text on accuracy, not presence: alt="image", a filename, or a chart description that omits the numbers all fail 1.1.1. Say what the alt should have said.
- 1.4.5 is text baked into a raster image. Logos and brand wordmarks are exempt.
- For contrast (1.4.11) and text size (1.4.4) trust any measurement you are given over your impression of the pixels; where you have no measurement, describe what you see and use FLAG.
- 1.4.1 is colour carrying meaning on its own: a required field marked only red, a status shown only by a coloured dot, a link distinguished from body text only by hue.
- 2.3.1 is flashing. A still screenshot cannot show it; report it only if the page visibly contains a flashing-media affordance, otherwise leave it alone.`,
    criteria: ['1.1.1', '1.4.1', '1.4.4', '1.4.5', '1.4.11', '1.4.12', '2.3.1'],
  },
  {
    id: 'structure-and-semantics',
    title: 'Structure, semantics and forms',
    focus: `Form your own impression of the page's structure from the image first — what reads as a heading, what reads as a list, what reads as a form field, what reads as a group. Then check the accessibility-tree excerpt and report where the two disagree.
- A control that looks interactive in the image and is absent from, or misrepresented in, the tree is invisible to assistive technology. That is 1.3.1 and it is the highest-value finding you produce.
- 1.3.2 is reading order: the order in the tree excerpt against the order your eye takes across the page.
- 2.5.3 is the visible label against the accessible name: a button reading "Submit application" whose name is "submit-btn" fails.
- 3.3.2 is whether a field tells the user what it wants before they type. 3.3.1 is an error that is visible in this screenshot.
- 3.3.8 is authentication: a login step that demands a memorised password or a puzzle with no alternative.
- 1.3.4 and 1.4.10 are about a viewport you cannot resize from one image; report them only if the screenshot itself already shows clipping, overlap, or content cut off at an edge.`,
    criteria: ['1.3.1', '1.3.2', '1.3.4', '1.4.10', '2.5.3', '3.3.1', '3.3.2', '3.3.8'],
  },
  {
    id: 'controls-and-behaviour',
    title: 'Controls, focus, media and behaviour',
    focus: `Look at the controls. Which ones can be reached and operated, which ones show where focus is, and what the page does on its own.
- 2.4.7 and 2.4.11 are the focus indicator: whether one is visible at all, and whether a sticky header, footer or floating widget in this screenshot would cover it.
- 2.1.1 is keyboard operability as far as the image can show it: a control that is plainly a div or an image with a click target and no focusable affordance.
- 2.4.3 is focus order against the visual order of the controls you can see.
- 1.4.13 is content that appears on hover or focus — tooltips, popovers, dropdown previews — and whether it can be dismissed and hovered.
- 2.2.2 is anything moving, auto-advancing or auto-updating: a carousel, a ticker, an animation, with no visible pause control.
- 1.2.1, 1.2.3 and 1.2.5 are media: report only that a player is present and what alternative the page visibly offers. Whether a transcript is equivalent is MEDIA's call, not yours.
- 3.2.3, 3.2.4 and 3.2.6 are comparative. You have ONE page. You cannot judge them and you must not try: leave them out entirely.`,
    criteria: [
      '1.2.1',
      '1.2.3',
      '1.2.5',
      '1.4.13',
      '2.1.1',
      '2.2.2',
      '2.4.3',
      '2.4.7',
      '2.4.11',
      '3.2.3',
      '3.2.4',
      '3.2.6',
    ],
  },
];

/**
 * The comparative criteria, which VIS holds a capability for but cannot settle
 * from one page. PAGES rules on them after the crawl; here they are always
 * inconclusive, never a pass (A2.4's spirit applied to a lane that cannot see
 * far enough).
 */
export const VIS_NOT_DECIDABLE_ALONE: readonly string[] = ['3.2.3', '3.2.4', '3.2.6'];

const VIS_NOT_DECIDABLE_REASON =
  'Consistency across pages cannot be judged from a single screenshot. PAGES compares the crawl and rules on this criterion.';

/* -- Build-time proof the batches still cover the lane ---------------------- */
{
  const batched = new Set(VIS_BATCHES.flatMap((batch) => batch.criteria));
  const missing = VIS_POLICY.criteria.filter((id) => !batched.has(id));
  const extra = [...batched].filter((id) => !VIS_POLICY.criteria.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      'VIS batches do not cover the VIS lane' +
        (missing.length > 0 ? `; no batch asks about ${missing.join(', ')}` : '') +
        (extra.length > 0 ? `; a batch asks about ${extra.join(', ')}, outside the lane` : ''),
    );
  }
}

/* ========================================================================== */
/* Input and output                                                           */
/* ========================================================================== */

/**
 * The part of a `PageCapture` VIS reads.
 *
 * Declared structurally, like `TreePageInput`, so `lib/audit` keeps no
 * dependency on the browser layer's zod types and a caller holding any capture
 * shape can drop it in.
 */
export interface VisPageCapture {
  readonly url?: string;
  readonly finalUrl?: string;
  readonly title?: string | null;
  /** Base64 PNG from the crawl. No page is reopened for this. */
  readonly screenshot?: string | null;
  readonly axTree?: AxTreeLike;
  readonly warnings?: readonly string[];
}

export interface VisLaneInput extends LaneCapabilityOptions {
  readonly pageUrl: string;
  readonly capture: VisPageCapture;
  readonly runId?: string;
  readonly phase?: AuditPhase;
  readonly pageId?: string | null;
  /** Cancellation, honoured between and inside passes. */
  readonly signal?: AbortSignal;
  /** Run fewer batches. Used by the smoke script; the lane runs all three. */
  readonly batchIds?: readonly string[];
  readonly timeoutMs?: number;
}

export interface VisLaneResult extends ModelLaneResult {
  /** One session per batch, in batch order. `sessionId` is the first of these. */
  readonly sessionIds: readonly string[];
  /** Per-batch outcome, for the run timeline. */
  readonly passes: readonly {
    readonly id: string;
    readonly ok: boolean;
    readonly findings: number;
    readonly model: string;
    readonly usedFallback: boolean;
    readonly error: string | null;
  }[];
}

/* ========================================================================== */
/* The lane                                                                   */
/* ========================================================================== */

/**
 * Audit one page's screenshot against the 27 criteria VIS owns.
 *
 * Never throws. A batch that fails leaves its criteria inconclusive and the
 * other batches still report; a page whose screenshot is missing or too large
 * to send leaves all 27 inconclusive.
 */
export async function runVisLane(input: VisLaneInput): Promise<VisLaneResult> {
  const empty = (over: Partial<VisLaneResult>): VisLaneResult => ({
    ...inconclusiveResult(VIS_POLICY.criteria, 'VIS did not run on this page.'),
    sessionIds: [],
    passes: [],
    ...over,
  });

  const screenshot = (input.capture.screenshot ?? '').trim();
  if (screenshot.length === 0) {
    return empty({
      inconclusive: inconclusiveFor(
        VIS_POLICY.criteria,
        'No screenshot was captured for this page, and VIS judges nothing but the rendered image.',
      ),
    });
  }
  if (decodedBytes(screenshot) > MAX_LANE_SCREENSHOT_BYTES) {
    return empty({
      inconclusive: inconclusiveFor(
        VIS_POLICY.criteria,
        `The screenshot is ${Math.round(decodedBytes(screenshot) / 1_000_000)} MB, over the ${Math.round(MAX_LANE_SCREENSHOT_BYTES / 1_000_000)} MB a provider will accept, so it was not sent.`,
      ),
    });
  }
  if (input.signal?.aborted) {
    return empty({
      inconclusive: inconclusiveFor(
        VIS_POLICY.criteria,
        'The run was cancelled before VIS looked at this page.',
      ),
    });
  }

  const batches = input.batchIds
    ? VIS_BATCHES.filter((batch) => input.batchIds?.includes(batch.id))
    : VIS_BATCHES;

  const excerpt = renderTreeExcerpt(input.capture.axTree);
  const capabilities = await resolveLaneCapabilities(input, input.signal);

  // Concurrent: three looks at one image, not three round trips end to end.
  const outcomes = await Promise.all(
    batches.map(async (batch) => {
      const answer = await runFindingsAgent({
        agent: 'vis',
        criteria: VIS_POLICY.criteria,
        verdicts: VIS_POLICY.verdicts,
        prompt: buildVisPrompt(input, batch, excerpt.text, excerpt.truncated),
        images: [{ name: 'page.png', base64: screenshot, mimeType: 'image/png' }],
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        ...capabilities,
      });
      return { batch, answer };
    }),
  );

  const findings: ModelFindingClaim[] = [];
  const evaluated = new Set<string>();
  const inconclusive: LaneInconclusive[] = [];
  const warnings: string[] = [];
  const sessionIds: string[] = [];
  const seen = new Set<string>();

  for (const { batch, answer } of outcomes) {
    if (answer.sessionId) sessionIds.push(answer.sessionId);

    if (answer.error !== null) {
      for (const criterion of batch.criteria) {
        inconclusive.push({
          criterion,
          reason: `The VIS "${batch.id}" pass did not return a usable answer: ${answer.error}`,
        });
      }
      warnings.push(`VIS ${batch.id}: ${answer.error}`);
      continue;
    }

    if (answer.usedFallback) {
      warnings.push(`VIS ${batch.id} answered on the fallback model ${answer.model} (A3.7).`);
    }

    for (const criterion of batch.criteria) {
      if (VIS_NOT_DECIDABLE_ALONE.includes(criterion)) continue;
      evaluated.add(criterion);
    }

    for (const claim of toClaims(VIS_POLICY, answer.findings, {
      pageUrl: input.pageUrl,
      pageId: input.pageId ?? null,
      source: `vis:${batch.id}`,
      context: { batch: batch.id, model: answer.model, sessionId: answer.sessionId },
    })) {
      // A criterion is only credited to the batch that was asked about it; a
      // model that wandered outside its batch is still inside its lane, so the
      // finding stands, but it does not make an unasked criterion "evaluated".
      const key = [claim.criterion, claim.selector ?? '', claim.summary.toLowerCase()].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(claim);
    }
  }

  for (const criterion of VIS_NOT_DECIDABLE_ALONE) {
    if (!VIS_POLICY.criteria.includes(criterion)) continue;
    inconclusive.push({ criterion, reason: VIS_NOT_DECIDABLE_REASON });
  }

  if (excerpt.truncated) {
    warnings.push(
      'The accessibility-tree excerpt sent to VIS was truncated; structural findings may be incomplete.',
    );
  }

  return {
    findings,
    sessionId: sessionIds[0] ?? null,
    sessionIds,
    evaluated: [...evaluated],
    inconclusive,
    warnings,
    passes: outcomes.map(({ batch, answer }) => ({
      id: batch.id,
      ok: answer.error === null,
      findings: answer.findings.length,
      model: answer.model,
      usedFallback: answer.usedFallback,
      error: answer.error,
    })),
  };
}

/* ========================================================================== */
/* Prompt                                                                     */
/* ========================================================================== */

function buildVisPrompt(
  input: VisLaneInput,
  batch: (typeof VIS_BATCHES)[number],
  excerpt: string,
  truncated: boolean,
): string {
  const title = input.capture.title ?? null;
  const finalUrl = input.capture.finalUrl ?? input.pageUrl;

  const lines = [
    `PAGE: ${input.pageUrl}`,
    ...(finalUrl !== input.pageUrl ? [`FINAL URL: ${finalUrl}`] : []),
    ...(title ? [`TITLE: ${title}`] : ['TITLE: <the page has no title>']),
    '',
    `THIS PASS: ${batch.title}`,
    '',
    'The screenshot of this page is attached. Look at it, then report every violation of the criteria below that you can see in it.',
    '',
    batch.focus,
    '',
    `CRITERIA FOR THIS PASS (${batch.criteria.length})`,
    renderCriterionTable(batch.criteria),
    '',
    'Report only these criteria in this pass. Another pass over the same screenshot covers the rest of your lane; duplicating their work costs the run time and produces the same finding twice.',
    '',
    'ACCESSIBILITY TREE, as assistive technology sees this page',
    excerpt.length > 0
      ? excerpt
      : '<the accessibility tree for this page is empty or was not captured — judge from the image alone, and say so in `detail` where the claim would have needed the tree>',
    ...(truncated
      ? ['', '(The tree excerpt above was truncated. Do not treat an absent node as proof of absence.)']
      : []),
    '',
    'Every finding needs a selector where one is knowable and a `detail` that names the element and quotes what you actually read off the image. Never invent a selector; null is correct when you do not have one.',
  ];

  return truncate(lines.join('\n'), 60_000);
}
