/**
 * The ACT lane: 26 criteria, twelve of them observable only across a state
 * transition.
 *
 * This is the part of the audit no rule engine does. Every other lane looks at
 * a page as it stands; ACT changes it and looks again. The finding the whole
 * product is built around lives here — a control that rearranges the
 * accessibility tree while its own `aria-expanded` never moves is lying to
 * assistive technology, and the only way to know is to click it and diff.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE ACTUALLY DOES
 *
 * Almost none of the machinery. `lib/paths` enumerated the paths and knows how
 * to analyse a transition; `lib/browser` knows how to drive one in a sandbox.
 * This lane is the orchestration between them, in four steps:
 *
 *   1. Drive the enumerated paths against the page (`runPaths`, one sandbox,
 *      the page reloaded before each path so depth stays at one — A4.3, A4.6).
 *   2. Restore each result's provenance. The browser's path schema strips the
 *      enumerator's `source` and `selectorConfidence` on the way through the
 *      sandbox, and both feed the confidence arithmetic, so they are matched
 *      back on by path id before analysis.
 *   3. Analyse deterministically (`analysePathResult`). These findings are
 *      arithmetic over two trees, not an opinion, and they stand whether or not
 *      a model is reachable.
 *   4. Ask the ACT agent to judge the transitions the arithmetic cannot settle,
 *      from a compact digest of what was observed. Never from the raw trees:
 *      an accessibility tree is an artifact and artifacts do not enter model
 *      context (A9.2, A13.7).
 *
 * ---------------------------------------------------------------------------
 * COVERAGE IS DERIVED, NOT ASSERTED
 *
 * ACT holds a capability for 26 criteria. The path harness drives three
 * templates at one viewport, which reaches nine of them. It does not resize the
 * window, does not tab through the page, does not play audio and does not
 * drag anything, so it cannot say a word about 1.4.4, 2.4.1 or 2.5.7 — and a
 * lane that returns no findings for a criterion it never tested is reporting a
 * pass it did not earn.
 *
 * So `evaluated` is computed from `ASSERTIONS_BY_TEMPLATE` — the templates that
 * actually ran, mapped through the assertions those templates make, mapped
 * through the criteria those assertions cite. Everything else comes back
 * inconclusive with the specific reason it was out of reach. The model's
 * silence never adds to `evaluated`: a model that did not mention a criterion
 * has not tested it either.
 */

import { ASSERTIONS, ASSERTIONS_BY_TEMPLATE, analysePathResult, diffTreeSnapshots } from '@/lib/paths';
import type { PathFinding, TransitionResult } from '@/lib/paths';
import { renderCriterionTable } from '@/lib/harness/criteria';

import { resolveLaneCapabilities, type LaneCapabilityOptions } from './lane-context';
import {
  buildFinding,
  collapse,
  describe as describeError,
  inconclusiveResult,
  lanePolicy,
  observationEvidence,
  runFindingsAgent,
  toClaims,
  truncate,
  type LaneInconclusive,
  type ModelFindingClaim,
  type ModelLaneResult,
} from './model-lane';
import type { AuditPhase } from './types';

/* ========================================================================== */
/* Lane policy and coverage                                                   */
/* ========================================================================== */

/** The 26, from the roster, checked against `criteriaForAgent('ACT')` on load. */
export const ACT_POLICY = lanePolicy('act', 'ACT');

export type ActTemplate = 'toggle' | 'dialog' | 'form';
export type ActAction = 'click' | 'hover' | 'focus' | 'key';

/**
 * What one driven template can settle, taken from the assertion table in
 * `lib/paths/templates.ts` rather than restated here.
 *
 * Restating it is how coverage claims rot: an assertion added to the dialog
 * template would widen what ACT genuinely checks, and a hand-written list here
 * would go on reporting the old set.
 */
export const ACT_TEMPLATE_COVERAGE: Readonly<Record<ActTemplate, readonly string[]>> = {
  toggle: criteriaOfTemplate('toggle'),
  dialog: criteriaOfTemplate('dialog'),
  form: criteriaOfTemplate('form'),
};

function criteriaOfTemplate(template: ActTemplate): readonly string[] {
  const ids = new Set<string>();
  for (const assertionId of ASSERTIONS_BY_TEMPLATE[template]) {
    for (const criterion of ASSERTIONS[assertionId].criteria) ids.add(criterion);
  }
  return [...ids];
}

/**
 * Why each ACT criterion the path harness does not reach is out of reach.
 *
 * A stated reason is the difference between "inconclusive" and "we forgot".
 * Anything absent from this map and absent from the template coverage above
 * falls back to a generic sentence, which is a signal that the lane grew a
 * criterion nobody wrote a reason for.
 */
export const ACT_OUT_OF_REACH: Readonly<Record<string, string>> = {
  '1.3.4':
    'Orientation needs the page rendered in both portrait and landscape. The path harness drives one viewport.',
  '1.4.2':
    'Audio control needs media to be playing. The path harness does not start playback.',
  '1.4.4':
    'Resize text needs the page rendered at 200%. The path harness drives one zoom level.',
  '1.4.10':
    'Reflow needs the page rendered at a 320 CSS pixel viewport. The path harness drives one viewport.',
  '1.4.12':
    'Text spacing needs the page re-rendered with the spacing overrides applied. The path harness does not inject them.',
  '1.4.13':
    'Hover and focus content needs a pointer parked on the trigger while the revealed content is probed. The path harness records the transition, not the dwell.',
  '2.1.1':
    'Keyboard operability needs every control reached by Tab and activated by keyboard. The path harness drives the pointer.',
  '2.1.4':
    'Character key shortcuts need single keys pressed outside a field and the page watched for a reaction. The path harness does not sweep the keyboard.',
  '2.2.1':
    'Timing adjustable needs a session or content timer to be observed expiring. A depth-one interaction cannot wait for one.',
  '2.2.2':
    'Pause, stop, hide needs moving content watched over time. A before-and-after snapshot cannot see motion.',
  '2.4.1':
    'Bypass blocks needs the skip link focused by keyboard and followed. The path harness drives the pointer.',
  '2.4.11':
    'Focus not obscured needs the focused element rendered and compared against sticky overlays. The path harness captures no per-transition screenshot.',
  '2.5.1':
    'Pointer gestures live in event handlers, not in the rendered DOM. CODE reads them from source.',
  '2.5.2':
    'Pointer cancellation needs a press aborted before release. The path harness clicks.',
  '2.5.7':
    'Dragging movements live in event handlers, not in the rendered DOM. CODE reads them from source.',
  '3.2.1':
    'On focus needs a control focused without being activated and the page watched for a context change. Reported only when a focus path was driven.',
  '3.2.2':
    'On input needs a value changed and the page watched for a context change. Reported only when a form path was driven.',
  '3.3.7':
    'Redundant entry is comparative across the steps of a flow. PAGES rules on it after the crawl.',
  '3.3.8':
    'Accessible authentication needs a sign-in step to be driven. The crawl does not authenticate.',
};

const NO_TEMPLATE_REASON =
  'No interaction path exercising this criterion ran successfully on this page.';

/* ========================================================================== */
/* Input and output                                                           */
/* ========================================================================== */

/** One enumerated path, in the shape both `lib/paths` and `lib/browser` accept. */
export interface ActPath {
  readonly id?: string;
  readonly selector: string;
  readonly label?: string;
  readonly action?: ActAction;
  readonly key?: string;
  readonly template: ActTemplate;
  /** `vision` alone is already a finding, and it changes the confidence. */
  readonly source?: 'tree' | 'vision' | 'both';
  readonly selectorConfidence?: number;
  readonly expectedStateChange?: string;
  readonly reason?: string;
}

/** The part of a `PathResult` this lane and `lib/paths` read. */
export interface ActPathResult {
  readonly path: { readonly id?: string; readonly selector: string; readonly template: ActTemplate };
  readonly ok: boolean;
  readonly error?: string | null;
  readonly treeBefore: Readonly<Record<string, unknown>>;
  readonly treeAfter: Readonly<Record<string, unknown>>;
  readonly stateBefore?: unknown;
  readonly stateAfter?: unknown;
  readonly observations?: Readonly<Record<string, unknown>>;
  readonly durationMs?: number;
}

/** What ACT reads off the capture. */
export interface ActPageCapture {
  readonly url?: string;
  readonly finalUrl?: string;
  readonly title?: string | null;
}

export interface ActLaneInput extends LaneCapabilityOptions {
  readonly pageUrl: string;
  readonly capture: ActPageCapture;
  /** A4.1: the paths enumerated for this page. No paths, no transitions. */
  readonly paths: readonly ActPath[];
  readonly runId?: string;
  readonly phase?: AuditPhase;
  readonly pageId?: string | null;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Labels written onto the sandbox so a leak can be traced back to its run. */
  readonly labels?: Record<string, string>;
  /** Called with the sandbox id once provisioned, for the environments grid (A11.1). */
  readonly onSandbox?: (sandboxId: string) => void;
  /**
   * Drive the paths some other way.
   *
   * The default takes a browser sandbox through `lib/browser`. Supplying this
   * lets a caller replay recorded results — the whole analysis below is pure
   * once the transitions exist, and it is worth being able to exercise it
   * without provisioning anything.
   */
  readonly drivePaths?: (
    url: string,
    paths: readonly ActPath[],
    options: { signal?: AbortSignal },
  ) => Promise<readonly ActPathResult[]>;
  /** Skip the model pass and return only the deterministic transition findings. */
  readonly deterministicOnly?: boolean;
}

export interface ActLaneResult extends ModelLaneResult {
  /** Paths driven, and how many of them the browser could actually perform. */
  readonly pathsDriven: number;
  readonly pathsSucceeded: number;
  /** Findings the tree diff produced on its own, before any model was asked. */
  readonly deterministicFindings: number;
  readonly usedFallback: boolean;
}

/* ========================================================================== */
/* The lane                                                                   */
/* ========================================================================== */

/**
 * Drive one page's interaction paths and turn the transitions into findings.
 *
 * Never throws. A browser sandbox that cannot be provisioned, a page that will
 * not load, a worker that dies — every one of them leaves all 26 criteria
 * inconclusive with the reason attached, because a transition lane that never
 * transitioned anything has tested nothing.
 */
export async function runActLane(input: ActLaneInput): Promise<ActLaneResult> {
  const base = {
    pathsDriven: 0,
    pathsSucceeded: 0,
    deterministicFindings: 0,
    usedFallback: false,
  };

  if (input.signal?.aborted) {
    return {
      ...inconclusiveResult(
        ACT_POLICY.criteria,
        'The run was cancelled before ACT drove this page.',
      ),
      ...base,
    };
  }

  if (input.paths.length === 0) {
    return {
      ...inconclusiveResult(
        ACT_POLICY.criteria,
        'Path enumeration produced no interaction paths for this page, so no state transition was observed.',
      ),
      ...base,
    };
  }

  /* -- 1. Drive ---------------------------------------------------------- */
  let results: readonly ActPathResult[];
  try {
    results = input.drivePaths
      ? await input.drivePaths(input.pageUrl, input.paths, { signal: input.signal })
      : await driveInSandbox(input);
  } catch (error) {
    return {
      ...inconclusiveResult(
        ACT_POLICY.criteria,
        `The browser could not drive this page: ${describeError(error)}`,
      ),
      ...base,
      warnings: [`ACT could not drive ${input.pageUrl}: ${describeError(error)}`],
    };
  }

  const succeeded = results.filter((result) => result.ok);
  if (results.length === 0) {
    return {
      ...inconclusiveResult(
        ACT_POLICY.criteria,
        'The browser returned no path results for this page.',
      ),
      ...base,
      pathsDriven: 0,
    };
  }

  /* -- 2. Restore provenance --------------------------------------------- */
  const byKey = new Map<string, ActPath>();
  for (const path of input.paths) byKey.set(pathKey(path.id, path.selector), path);

  const transitions: { result: ActPathResult; origin: ActPath | undefined }[] = results.map(
    (result) => ({
      result,
      origin: byKey.get(pathKey(result.path.id, result.path.selector)),
    }),
  );

  /* -- 3. Deterministic analysis ----------------------------------------- */
  const deterministic: PathFinding[] = [];
  for (const { result, origin } of transitions) {
    if (!result.ok) continue;
    deterministic.push(
      ...analysePathResult(restoreSubject(result, origin) as TransitionResult, {
        pageUrl: input.pageUrl,
        ...(origin?.selectorConfidence === undefined
          ? {}
          : { selectorConfidence: origin.selectorConfidence }),
      }),
    );
  }

  const findings: ModelFindingClaim[] = [];
  for (const finding of deterministic) {
    const claim = buildFinding(ACT_POLICY, {
      criterion: finding.criterion,
      severity: finding.severity,
      summary: finding.summary,
      detail: finding.detail,
      selector: finding.selector,
      pageUrl: finding.pageUrl ?? input.pageUrl,
      pageId: input.pageId ?? null,
      verdict: finding.verdict,
      evidence: [
        observationEvidence(`act:${finding.assertion}`, {
          assertion: finding.assertion,
          label: finding.label,
          template: finding.template,
          source: finding.source,
          confidence: finding.confidence,
          pathId: finding.pathId,
          ...finding.evidence,
        }),
      ],
    });
    if (claim) findings.push(claim);
  }

  /* -- 4. Coverage, from the templates that actually ran ------------------ */
  const evaluated = new Set<string>();
  for (const { result } of transitions) {
    if (!result.ok) continue;
    for (const criterion of ACT_TEMPLATE_COVERAGE[result.path.template] ?? []) {
      evaluated.add(criterion);
    }
  }

  const warnings: string[] = [];
  for (const { result } of transitions) {
    if (result.ok) continue;
    warnings.push(
      `ACT could not perform ${result.path.template} on ${result.path.selector}: ${result.error ?? 'no reason given'}`,
    );
  }

  /* -- 5. The judgement pass --------------------------------------------- */
  let sessionId: string | null = null;
  let usedFallback = false;

  if (!input.deterministicOnly && succeeded.length > 0 && !input.signal?.aborted) {
    const capabilities = await resolveLaneCapabilities(input, input.signal);
    const answer = await runFindingsAgent({
      agent: 'act',
      criteria: ACT_POLICY.criteria,
      verdicts: ACT_POLICY.verdicts,
      prompt: buildActPrompt(input, transitions, deterministic),
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      ...capabilities,
    });

    sessionId = answer.sessionId;
    usedFallback = answer.usedFallback;

    if (answer.error !== null) {
      warnings.push(`The ACT judgement pass did not return a usable answer: ${answer.error}`);
    } else {
      if (answer.usedFallback) {
        warnings.push(`ACT answered on the fallback model ${answer.model} (A3.7).`);
      }
      const existing = new Set(
        findings.map((claim) => `${claim.criterion}|${claim.selector ?? ''}`),
      );
      for (const claim of toClaims(ACT_POLICY, answer.findings, {
        pageUrl: input.pageUrl,
        pageId: input.pageId ?? null,
        source: 'act:transitions',
        context: { model: answer.model, sessionId: answer.sessionId },
      })) {
        // The tree diff already said it, with arithmetic behind it. One finding.
        if (existing.has(`${claim.criterion}|${claim.selector ?? ''}`)) continue;
        findings.push(claim);
      }
    }
  } else if (succeeded.length === 0) {
    warnings.push(
      'Every interaction path failed, so ACT had no transition to judge and asked no model.',
    );
  }

  /* -- 6. Everything not evaluated is inconclusive, with a reason --------- */
  const inconclusive: LaneInconclusive[] = [];
  for (const criterion of ACT_POLICY.criteria) {
    if (evaluated.has(criterion)) continue;
    inconclusive.push({
      criterion,
      reason: ACT_OUT_OF_REACH[criterion] ?? NO_TEMPLATE_REASON,
    });
  }

  return {
    findings,
    sessionId,
    evaluated: [...evaluated],
    inconclusive,
    warnings,
    pathsDriven: results.length,
    pathsSucceeded: succeeded.length,
    deterministicFindings: deterministic.length,
    usedFallback,
  };
}

/* ========================================================================== */
/* Driving                                                                    */
/* ========================================================================== */

/**
 * The default executor: one browser sandbox, taken through the pool.
 *
 * Imported lazily so that importing `@/lib/audit` for TREE or VIS does not pull
 * the Daytona SDK into the module graph. ACT is the only lane that needs a
 * sandbox at all (A3.2, A4.3).
 */
async function driveInSandbox(input: ActLaneInput): Promise<readonly ActPathResult[]> {
  const { runPaths } = await import('@/lib/browser/runner');

  const driveable = input.paths.map((path) => ({
    ...(path.id ? { id: path.id } : {}),
    selector: path.selector,
    label: path.label ?? '',
    action: path.action ?? ('click' as const),
    ...(path.key ? { key: path.key } : {}),
    template: path.template,
  }));

  const results = await runPaths(input.pageUrl, driveable, {
    ...(input.labels ? { labels: input.labels } : {}),
    ...(input.onSandbox ? { onSandbox: input.onSandbox } : {}),
  });
  return results as readonly ActPathResult[];
}

function pathKey(id: string | undefined, selector: string): string {
  return `${id ?? ''}|${selector}`;
}

/**
 * Put the enumerator's provenance back on the result.
 *
 * `interactionPathSchema` strips `source`, `selectorConfidence` and the rest on
 * the way into the sandbox, and both feed `scoreConfidence`. A vision-only
 * control that comes back marked `tree` is scored as though the accessibility
 * tree had exposed it, which is exactly backwards.
 */
function restoreSubject(result: ActPathResult, origin: ActPath | undefined): unknown {
  if (!origin) return result;
  return {
    ...result,
    path: {
      ...result.path,
      ...(origin.label === undefined ? {} : { label: origin.label }),
      ...(origin.action === undefined ? {} : { action: origin.action }),
      ...(origin.source === undefined ? {} : { source: origin.source }),
    },
  };
}

/* ========================================================================== */
/* Prompt                                                                     */
/* ========================================================================== */

/**
 * The transition digest.
 *
 * Measurements, not trees. The accessibility tree on either side of a click is
 * an artifact; it stays in the pipeline and only the numbers derived from it
 * come here (A9.2, A13.7). That is also what makes the digest readable: the
 * headline for every transition is the one line the whole product turns on —
 * how much the tree moved, and whether the control said anything about it.
 */
function buildActPrompt(
  input: ActLaneInput,
  transitions: readonly { result: ActPathResult; origin: ActPath | undefined }[],
  deterministic: readonly PathFinding[],
): string {
  const lines: string[] = [
    `PAGE: ${input.pageUrl}`,
    ...(input.capture.title ? [`TITLE: ${input.capture.title}`] : []),
    '',
    `TRANSITIONS OBSERVED (${transitions.length})`,
    'Each block below is one interaction, driven at depth one on a freshly loaded page. The trees themselves stay in the artifact store; these are the measurements taken from them.',
    '',
  ];

  transitions.forEach(({ result, origin }, index) => {
    lines.push(describeTransition(index + 1, result, origin));
  });

  if (deterministic.length > 0) {
    lines.push(
      '',
      `ALREADY FILED BY THE TREE DIFF (${deterministic.length})`,
      'These are arithmetic, not opinion, and they are already in the ledger. Do not repeat them; report only what they missed.',
      ...deterministic
        .slice(0, 40)
        .map(
          (finding) =>
            `- ${finding.criterion} on ${finding.selector || '<no selector>'}: ${collapse(finding.summary)}`,
        ),
    );
  }

  lines.push(
    '',
    `CRITERIA YOU OWN (${ACT_POLICY.criteria.length})`,
    renderCriterionTable(ACT_POLICY.criteria),
    '',
    'WHAT TO REPORT',
    '- Judge only what the observations above actually show. You did not drive this browser yourself; you are reading what it recorded, and anything the record does not contain, you did not see.',
    '- A transition where the tree moved and the control exposed no state property, or exposed one that did not change, is a 4.1.2 failure. The diff has already filed the clear ones; report a case it framed differently only if you can say what it missed.',
    '- A dialog that opened without focus moving inside it, or that did not return focus on Escape, is a 2.4.3 failure. One that Escape did not dismiss is 2.1.2.',
    '- A form submitted empty whose error reached no live region is 4.1.3; one whose message does not say how to fix the problem is 3.3.3; one with no message in text at all is 3.3.1.',
    '- A path that failed to run is a run problem, not an accessibility problem. Report nothing for it.',
    '- Say in `detail` which numbered transition above your finding rests on.',
  );

  return truncate(lines.join('\n'), 90_000);
}

function describeTransition(
  index: number,
  result: ActPathResult,
  origin: ActPath | undefined,
): string {
  const label = origin?.label && origin.label.length > 0 ? origin.label : result.path.selector;
  const head =
    `[${index}] "${truncate(collapse(label), 80)}"  ${result.path.template}/${origin?.action ?? 'click'}` +
    `  selector=${truncate(result.path.selector, 120)}` +
    `  source=${origin?.source ?? 'tree'}`;

  if (!result.ok) {
    return `${head}\n    NOT PERFORMED: ${result.error ?? 'no reason given'}`;
  }

  const delta = diffTreeSnapshots(
    result.treeBefore as Parameters<typeof diffTreeSnapshots>[0],
    result.treeAfter as Parameters<typeof diffTreeSnapshots>[1],
  );

  const before = describeElement(result.stateBefore);
  const after = describeElement(result.stateAfter);
  const changed = delta.changedProps
    .slice(0, 6)
    .map((prop) => `${prop.prop} ${prop.before ?? 'null'}->${prop.after ?? 'null'} on ${prop.role ?? '?'} "${truncate(collapse(prop.name ?? ''), 40)}"`);

  const observations = describeObservations(result.observations);

  return [
    head,
    `    tree: ${delta.sizeDelta >= 0 ? '+' : ''}${delta.sizeDelta} nodes (added ${delta.addedCount}, removed ${delta.removedCount}, state props changed ${delta.changedCount}, id stability ${delta.idStability.toFixed(2)})`,
    `    control before: ${before}`,
    `    control after : ${after}`,
    ...(changed.length > 0 ? [`    state moved: ${changed.join('; ')}`] : []),
    ...(observations ? [`    observations: ${observations}`] : []),
    ...(origin?.expectedStateChange ? [`    expected: ${collapse(origin.expectedStateChange)}`] : []),
  ].join('\n');
}

function describeElement(state: unknown): string {
  if (!state || typeof state !== 'object') return '<not captured>';
  const snapshot = state as {
    present?: boolean;
    tagName?: string | null;
    role?: string | null;
    text?: string | null;
    attributes?: Record<string, string | null>;
  };
  if (snapshot.present === false) return '<not present>';

  const attributes = Object.entries(snapshot.attributes ?? {})
    .filter(([, value]) => value !== null && value !== undefined)
    .slice(0, 10)
    .map(([key, value]) => `${key}=${JSON.stringify(truncate(String(value), 40))}`);

  return (
    `<${snapshot.tagName ?? '?'}` +
    (snapshot.role ? ` role=${snapshot.role}` : '') +
    (attributes.length > 0 ? ` ${attributes.join(' ')}` : '') +
    `>${snapshot.text ? ` text=${JSON.stringify(truncate(collapse(snapshot.text), 60))}` : ''}`
  );
}

function describeObservations(observations: Readonly<Record<string, unknown>> | undefined): string {
  if (!observations) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(observations)) {
    // The escape-side tree is a whole artifact; the diff layer reads it, a
    // prompt must not carry it.
    if (key === 'treeAfterEscape') continue;
    parts.push(`${key}=${truncate(JSON.stringify(value) ?? 'null', 200)}`);
    if (parts.length >= 12) break;
  }
  return parts.join(' ');
}
