/**
 * The scaffolding every model-backed audit lane sits on.
 *
 * TREE is a library: it reads a capture and rules. The other five lanes ask a
 * model, and they all ask it the same way — one session on the saved roster
 * agent, one turn carrying the evidence, one narrowed JSON schema on the way
 * back. That shared shape lives here so `vis-lane.ts`, `act-lane.ts`,
 * `media-lane.ts`, `code-lane.ts` and `pages-lane.ts` contain only the thing
 * that actually differs between them: what evidence they gather and how they
 * describe it.
 *
 * ---------------------------------------------------------------------------
 * THREE RULES THIS FILE ENFORCES, RATHER THAN ASKS FOR
 *
 *  1. **Every finding carries a numbered criterion, and it is one of the 55.**
 *     `buildFinding` resolves the number through `lib/db/criteria` and returns
 *     `null` when it does not resolve, when the lane does not own it, when it
 *     is one of the two BLOCKED criteria, or when the claim rests on nothing.
 *     There is no other way to construct a claim in these five lanes, so an
 *     invented criterion cannot reach the ledger even if a model insists on it.
 *
 *  2. **A lane may only emit the verdicts its lane policy allows.** MEDIA and
 *     CODE are opinion lanes: `allowedVerdicts` reduces them to FLAG and
 *     `buildFinding` clamps anything else. This is the second of two locks —
 *     the first is `buildFindingsResponseFormat`, which makes the wire schema
 *     unable to express a DECIDE for those lanes at all.
 *
 *  3. **A lane that could not reach its evidence says so.** `runFindingsAgent`
 *     never throws: a failed pass comes back with `error` set and an empty
 *     findings list, and the lane turns that into `inconclusive` rather than
 *     into silence. Silence is indistinguishable from a clean page, and a page
 *     reported clean because nobody looked at it is the worst output this tool
 *     can produce.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SAVED AGENT, BOUND BY NAME
 *
 * `runAgent` in `lib/harness/run.ts` takes a string prompt; VIS has to send an
 * image, so it cannot use it. Rather than give VIS a private path, every lane
 * goes through `askOnce` below: a session bound to the saved agent *by name*,
 * and a turn whose content is an array of parts. Binding by name keeps the
 * manifest the registration script wrote — the criterion-narrowed
 * `response_format` and the mounted WCAG skill packs — instead of rebuilding a
 * near-copy of it here and quietly dropping the skills (A13.2, A13.3).
 *
 * The A3.7 fallback is the same agent on its second model, as an inline spec,
 * in a fresh session so a poisoned context is not inherited.
 */

import {
  criteriaForAgent,
  getCriterion,
  type AuditAgent,
  type Criterion,
} from '@/lib/db/criteria';
import type { ArtifactKind } from '@/lib/db/schema';
import {
  AGENT_ROSTER,
  buildAgentSpec,
  resolveModel,
  type AgentDefinition,
  type AgentName,
} from '@/lib/harness/agents';
import {
  getTrueForgeClient,
  messageText,
  TrueForgeError,
  type AgentSpec,
  type TrueForgeClient,
  type TurnInputItem,
} from '@/lib/harness/client';
import { waitForTurn } from '@/lib/harness/run';
import {
  allowedVerdicts,
  buildFindingsResponseFormat,
  buildFindingsSchema,
  type FindingVerdict,
} from '@/lib/harness/schemas';

import type { Severity } from './types';

/* ========================================================================== */
/* Claim and evidence shapes                                                  */
/* ========================================================================== */

/**
 * The ledger's evidence shape (`FindingEvidence` in `lib/pipeline/ledger.ts`),
 * declared structurally so `lib/audit` keeps no dependency on the pipeline.
 * `lane.ts` declares the identical shape for TREE; the annotations in
 * `lib/pipeline/lanes.ts` are what prove both agree with the ledger.
 */
export interface ModelLaneEvidence {
  kind: ArtifactKind;
  mimeType?: string;
  /** Base64. Small observations only — artifacts never enter model context (A9.2). */
  data?: string | null;
  storagePath?: string | null;
}

/** The ledger's claim shape (`FindingClaim` in `lib/pipeline/ledger.ts`). */
export interface ModelFindingClaim {
  criterion: string;
  severity: Severity;
  summary: string;
  detail?: string | null;
  selector?: string | null;
  sourcePath?: string | null;
  pageUrl: string;
  /** Set by PAGES, whose claims span pages and cannot use the batch page id. */
  pageId?: string | null;
  verdict?: string | null;
  evidence?: ModelLaneEvidence[];
}

/** A criterion a lane reached for and could not settle, with the reason why. */
export interface LaneInconclusive {
  readonly criterion: string;
  readonly reason: string;
}

/**
 * What every model-backed lane returns.
 *
 * `findings` and `sessionId` are the pipeline's contract (`AuditLaneResult` in
 * `lib/pipeline/lanes.ts`). The rest is the honesty channel: `evaluated` names
 * the criteria the lane actually reached, `inconclusive` names the ones it did
 * not and why. The conductor ignores both today, but a caller scoring a partial
 * run feeds `evaluated` to `scoreRun`'s `evaluatedCriteria` and gets
 * `not_evaluated` where it would otherwise have printed a pass.
 */
export interface ModelLaneResult {
  readonly findings: readonly ModelFindingClaim[];
  /** A12.1. Null when no model was reached at all. */
  readonly sessionId: string | null;
  readonly evaluated: readonly string[];
  readonly inconclusive: readonly LaneInconclusive[];
  readonly warnings: readonly string[];
}

/* ========================================================================== */
/* Finding construction                                                       */
/* ========================================================================== */

/** One claim, before this module has decided whether it may exist. */
export interface FindingDraft {
  readonly criterion: string;
  readonly severity: Severity | string;
  readonly summary: string;
  readonly detail?: string | null;
  readonly selector?: string | null;
  readonly sourcePath?: string | null;
  readonly pageUrl: string;
  readonly pageId?: string | null;
  /** The lane's proposed verdict. Clamped to what the lane policy allows. */
  readonly verdict?: string | null;
  /** At least one, or the claim is discarded. Rule 8: no artifact, no finding. */
  readonly evidence?: readonly ModelLaneEvidence[];
}

/** What a lane is allowed to claim, and how. */
export interface LanePolicy {
  /** The roster agent, for the evidence trail. */
  readonly agent: AgentName;
  /** Exactly the criteria this lane owns. Anything else is discarded. */
  readonly criteria: readonly string[];
  /** The verdicts this lane may emit. `FLAG_ONLY` for MEDIA and CODE. */
  readonly verdicts: readonly FindingVerdict[];
}

/**
 * One lane's policy, taken from the roster and checked against the criteria
 * table at module load.
 *
 * The roster is the authority for what a lane may emit, because the roster is
 * what `buildFindingsResponseFormat` was given when the saved agent was
 * registered: validating against a different set would reject answers the wire
 * schema explicitly permits. The criteria table is the authority for what the
 * *ledger* will accept (A3.1 — an agent may claim only what its capability
 * covers). They agree today; this throws if they ever stop, because a silent
 * disagreement here means findings that pass validation and are then discarded
 * on insert, which reads as a clean page.
 */
export function lanePolicy(agent: AgentName, auditAgent: AuditAgent): LanePolicy {
  const definition = AGENT_ROSTER[agent];
  const capability = criteriaForAgent(auditAgent).map((criterion) => criterion.id);

  const outside = definition.criteria.filter((id) => !capability.includes(id));
  const missing = capability.filter((id) => !definition.criteria.includes(id));
  if (outside.length > 0 || missing.length > 0) {
    throw new Error(
      `The ${agent} roster lane and ${auditAgent}'s capability in lib/db/criteria disagree` +
        (outside.length > 0 ? `; roster has ${outside.join(', ')} the table does not` : '') +
        (missing.length > 0 ? `; the table has ${missing.join(', ')} the roster does not` : ''),
    );
  }

  return { agent, criteria: definition.criteria, verdicts: definition.verdicts };
}

const SEVERITY_VALUES: readonly string[] = ['critical', 'serious', 'moderate', 'minor'];

function asSeverity(value: Severity | string | null | undefined): Severity {
  return typeof value === 'string' && SEVERITY_VALUES.includes(value)
    ? (value as Severity)
    : 'moderate';
}

/**
 * The verdict a claim is allowed to carry.
 *
 * The model's own answer wins when the lane policy permits it. Otherwise the
 * criterion's canonical verdict, then FLAG, then whatever is left — never
 * DECIDE by default, because defaulting to a ruling is the one direction a
 * mistake here must not go.
 */
function clampVerdict(
  criterion: Criterion,
  proposed: string | null | undefined,
  laneVerdicts: readonly FindingVerdict[],
): FindingVerdict {
  const allowed = allowedVerdicts(criterion.id, laneVerdicts);
  if (allowed.length === 0) return 'FLAG';
  if (proposed && (allowed as readonly string[]).includes(proposed)) {
    return proposed as FindingVerdict;
  }
  if (allowed.includes(criterion.verdict as FindingVerdict)) {
    return criterion.verdict as FindingVerdict;
  }
  if (allowed.includes('FLAG')) return 'FLAG';
  return allowed[0];
}

/**
 * The only place a model-backed lane constructs a finding.
 *
 * Returns `null` — never a finding — when:
 *
 *   - the criterion number does not resolve to one of the 55 (rule 3);
 *   - the criterion is BLOCKED, which is 1.2.4 and 3.3.4 and nothing else.
 *     They are never dispatched and never passed (A2.4); a lane that names one
 *     anyway is making a claim about something it could not have reached;
 *   - the criterion is outside this lane (A3.1, A13.2). VIS does not file
 *     4.1.2, whatever it thinks it saw;
 *   - there is no summary, or no page URL;
 *   - the claim rests on nothing: no artifact, no selector, no source path
 *     (rule 8, A9.1).
 */
export function buildFinding(
  policy: LanePolicy,
  draft: FindingDraft,
): ModelFindingClaim | null {
  const criterion = getCriterion((draft.criterion ?? '').trim());
  if (!criterion) return null;
  if (criterion.verdict === 'BLOCKED') return null;
  if (!policy.criteria.includes(criterion.id)) return null;

  const summary = collapse(draft.summary ?? '');
  if (summary.length === 0) return null;

  const pageUrl = (draft.pageUrl ?? '').trim();
  if (pageUrl.length === 0) return null;

  const selector = nonEmpty(draft.selector);
  const sourcePath = nonEmpty(draft.sourcePath);
  const evidence = (draft.evidence ?? []).filter(
    (item) => nonEmpty(item.data) !== null || nonEmpty(item.storagePath) !== null,
  );
  if (evidence.length === 0 && selector === null && sourcePath === null) return null;

  return {
    criterion: criterion.id,
    severity: asSeverity(draft.severity),
    summary: truncate(summary, 400),
    detail: nonEmpty(draft.detail),
    selector,
    sourcePath,
    pageUrl,
    ...(draft.pageId ? { pageId: draft.pageId } : {}),
    verdict: clampVerdict(criterion, draft.verdict, policy.verdicts),
    evidence: [...evidence],
  };
}

/**
 * An observation, packaged as the one artifact a claim rests on (A9.1).
 *
 * `log` rather than `screenshot` or `axtree` even when the observation came off
 * one: the payload here is the derived measurement, not the artifact itself.
 * The artifact stays where the pipeline put it — nothing large is inlined
 * (A9.2).
 */
export function observationEvidence(
  source: string,
  data: Readonly<Record<string, unknown>>,
): ModelLaneEvidence {
  return {
    kind: 'log',
    mimeType: 'application/json',
    data: toBase64(JSON.stringify({ source, ...data })),
    storagePath: null,
  };
}

/* ========================================================================== */
/* Inconclusive                                                               */
/* ========================================================================== */

/**
 * Every criterion in the list, marked unreached, with one stated reason.
 *
 * This is what a lane returns instead of an empty findings list when it could
 * not see what it needed. The distinction is the whole point: an empty list
 * means "looked, found nothing", and there is no way to tell the two apart
 * after the fact unless the lane says which one it meant.
 */
export function inconclusiveFor(
  criteria: readonly string[],
  reason: string,
): LaneInconclusive[] {
  return criteria.map((criterion) => ({ criterion, reason }));
}

/** A result carrying no findings and no claim to have evaluated anything. */
export function inconclusiveResult(
  criteria: readonly string[],
  reason: string,
  over: Partial<ModelLaneResult> = {},
): ModelLaneResult {
  return {
    findings: [],
    sessionId: null,
    evaluated: [],
    inconclusive: inconclusiveFor(criteria, reason),
    warnings: [],
    ...over,
  };
}

/* ========================================================================== */
/* One findings pass                                                          */
/* ========================================================================== */

/** An image sent alongside the prompt. VIS is the only lane that uses one. */
export interface LaneImage {
  readonly name: string;
  /** Base64, straight off `PageCapture.screenshot`. */
  readonly base64: string;
  readonly mimeType?: string;
}

export interface FindingsAgentRequest {
  readonly agent: AgentName;
  /**
   * The criteria the *response* is validated against. Always the whole lane,
   * never a batch: the saved agent's `response_format` publishes the whole
   * lane, so narrowing here would reject legal output. A batch narrows the
   * prompt, not the schema.
   */
  readonly criteria: readonly string[];
  readonly verdicts: readonly FindingVerdict[];
  readonly prompt: string;
  readonly images?: readonly LaneImage[];
  readonly timeoutMs?: number;
  /** Attempts against the primary model before the fallback model. Default 2. */
  readonly attempts?: number;
  readonly client?: TrueForgeClient;
  readonly availableModels?: readonly string[];
  readonly availableSkills?: readonly string[];
  readonly sandboxAvailable?: boolean;
  readonly signal?: AbortSignal;
}

/** One validated finding, exactly as the harness schema accepted it. */
export interface ModelFinding {
  readonly criterion: string;
  readonly verdict: FindingVerdict;
  readonly severity: Severity;
  readonly summary: string;
  readonly detail: string;
  readonly selector?: string | null;
  readonly sourcePath?: string | null;
}

export interface FindingsAgentResult {
  readonly findings: readonly ModelFinding[];
  /** A12.1: recorded on the job row so a restart reattaches rather than re-running. */
  readonly sessionId: string | null;
  readonly turnId: string | null;
  readonly model: string;
  readonly usedFallback: boolean;
  readonly attempts: number;
  /** Set when the pass failed. Never thrown: the lane turns it into inconclusive. */
  readonly error: string | null;
}

/** Total time one findings pass may take, before the fallback is tried. */
export const LANE_TIMEOUT_MS = 300_000;

/** Attempts against the primary model before the fallback model is tried. */
export const LANE_ATTEMPTS = 2;

/**
 * Ask one roster agent one question and validate the answer.
 *
 * Never throws. Every failure — a 500 from the provider, a turn that errored, a
 * reply that was not JSON, JSON that did not match the lane's schema — comes
 * back as `error` with an empty findings list, because a lane that fails must
 * degrade to inconclusive rather than take the page down with it.
 */
export async function runFindingsAgent(
  request: FindingsAgentRequest,
): Promise<FindingsAgentResult> {
  const definition = AGENT_ROSTER[request.agent];
  const primary = resolveModel(definition, request.availableModels);
  const schema = buildFindingsSchema(request.criteria, request.verdicts);
  const client = request.client ?? getTrueForgeClient();
  const attempts = Math.max(1, request.attempts ?? LANE_ATTEMPTS);
  const timeoutMs = request.timeoutMs ?? LANE_TIMEOUT_MS;

  const failed = (over: Partial<FindingsAgentResult>): FindingsAgentResult => ({
    findings: [],
    sessionId: null,
    turnId: null,
    model: primary,
    usedFallback: false,
    attempts: 0,
    error: null,
    ...over,
  });

  if (request.signal?.aborted) {
    return failed({ error: 'the run was cancelled before this lane started' });
  }

  /*
   * Two lanes. The first is the saved agent, bound by name, so the manifest the
   * registration script wrote is the one that runs — its narrowed
   * `response_format` and its mounted skill packs included. The second is the
   * A3.7 fallback: the same agent on its second model, as an inline spec, in a
   * fresh session.
   */
  const lane: Array<{ target: { name: string } | { spec: AgentSpec }; model: string }> = [
    { target: { name: definition.name }, model: primary },
  ];
  const fallback = fallbackSpec(definition, request, primary);
  if (fallback) lane.push({ target: { spec: fallback.spec }, model: fallback.model });

  let lastError: unknown = null;
  let used = 0;

  for (const [index, step] of lane.entries()) {
    const tries = index === 0 ? attempts : 1;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      used += 1;
      try {
        const answer = await askOnce({
          client,
          target: step.target,
          prompt: request.prompt,
          images: request.images ?? [],
          timeoutMs,
          signal: request.signal,
        });

        const parsed = schema.safeParse(answer.json);
        if (!parsed.success) {
          throw new LanePassError(
            `${request.agent} returned JSON outside its lane schema: ${formatIssues(parsed.error.issues)}`,
            true,
          );
        }

        return {
          findings: parsed.data.findings as readonly ModelFinding[],
          sessionId: answer.sessionId,
          turnId: answer.turnId,
          model: step.model,
          usedFallback: index > 0,
          attempts: used,
          error: null,
        };
      } catch (error) {
        lastError = error;
        if (isAborted(error)) {
          return failed({ attempts: used, model: step.model, error: describe(error) });
        }
        // A 400, an unknown agent, or a malformed manifest fails identically on
        // every retry; only the transient classes are worth another attempt.
        if (!isRetryable(error)) break;
      }
    }
  }

  return failed({
    attempts: used,
    model: lane[lane.length - 1]?.model ?? primary,
    usedFallback: lane.length > 1,
    error: describe(lastError),
  });
}

/**
 * The same agent on its second model.
 *
 * `buildAgentSpec` is used rather than a hand-written manifest so the fallback
 * differs from the primary in exactly one field. The `response_format` is then
 * re-derived from `buildFindingsResponseFormat` explicitly: it is already what
 * the roster put there, and stating it here means a roster that ever drifted
 * would still not be able to hand this lane a schema wider than its own
 * criteria.
 */
function fallbackSpec(
  definition: AgentDefinition,
  request: FindingsAgentRequest,
  primary: string,
): { spec: AgentSpec; model: string } | null {
  const model = definition.fallbackModel;
  if (!model || model === primary) return null;

  const spec = buildAgentSpec(definition, {
    availableModels: request.availableModels,
    availableSkills: request.availableSkills,
    sandboxAvailable: request.sandboxAvailable,
    modelOverride: model,
  });

  return {
    model,
    spec: {
      ...spec,
      response_format: buildFindingsResponseFormat(definition.criteria, definition.verdicts),
    },
  };
}

interface AskOnceInput {
  readonly client: TrueForgeClient;
  readonly target: { name: string } | { spec: AgentSpec };
  readonly prompt: string;
  readonly images: readonly LaneImage[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

interface AskOnceResult {
  readonly json: unknown;
  readonly sessionId: string;
  readonly turnId: string;
}

/**
 * One session, one turn.
 *
 * The turn is built by hand rather than through `runAgent` because the harness
 * runner takes a string prompt and VIS has to send an image. The image goes as
 * a `file` content part carrying a data URI, which is what
 * `POST /sessions/{id}/turns` accepts — the same call `lib/vision/candidates.ts`
 * has been making against this TrueForge since the vision pass landed.
 */
async function askOnce(input: AskOnceInput): Promise<AskOnceResult> {
  const session = await input.client.createSession(input.target, input.signal);

  const content: Array<Record<string, unknown>> = [{ type: 'text', text: input.prompt }];
  for (const image of input.images) {
    content.push({
      type: 'file',
      name: image.name,
      data: `data:${image.mimeType ?? 'image/png'};base64,${image.base64}`,
    });
  }

  const item: TurnInputItem = { type: 'user.message', content };
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

  if (turn.state.status !== 'done') {
    const why =
      turn.state.status === 'error'
        ? turn.state.message
        : turn.state.status === 'cancelled'
          ? (turn.state.reason ?? 'cancelled')
          : 'still running';
    throw new LanePassError(`the lane pass did not finish: ${why}`, true);
  }

  const text = messageText(turn.state.output);
  const json = extractJson(text);
  if (json === undefined) {
    throw new LanePassError(
      `the lane pass returned no JSON. First 200 characters: ${text.slice(0, 200)}`,
      true,
    );
  }

  return { json, sessionId: session.id, turnId: created.id };
}

/** A failure inside one findings pass. Never escapes `runFindingsAgent`. */
export class LanePassError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'LanePassError';
    this.retryable = retryable;
  }
}

/* ========================================================================== */
/* Turning validated model output into claims                                 */
/* ========================================================================== */

export interface ToClaimsOptions {
  readonly pageUrl: string;
  readonly pageId?: string | null;
  /** The source string recorded on each claim's artifact. */
  readonly source: string;
  /** Extra observation data attached to every claim from this pass. */
  readonly context?: Readonly<Record<string, unknown>>;
}

/**
 * Every model finding that survives `buildFinding`, deduplicated.
 *
 * Duplicates are real: VIS looks at one screenshot two or three times, and the
 * same missing label is worth reporting once. The key is criterion plus page
 * plus selector plus the first words of the summary — enough to collapse a
 * repeat, not so much that two genuinely different elements merge.
 */
export function toClaims(
  policy: LanePolicy,
  findings: readonly ModelFinding[],
  options: ToClaimsOptions,
): ModelFindingClaim[] {
  const claims: ModelFindingClaim[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    const claim = buildFinding(policy, {
      criterion: finding.criterion,
      severity: finding.severity,
      summary: finding.summary,
      detail: finding.detail,
      selector: finding.selector ?? null,
      sourcePath: finding.sourcePath ?? null,
      pageUrl: options.pageUrl,
      pageId: options.pageId ?? null,
      verdict: finding.verdict,
      evidence: [
        observationEvidence(options.source, {
          agent: policy.agent,
          criterion: finding.criterion,
          selector: finding.selector ?? null,
          sourcePath: finding.sourcePath ?? null,
          detail: truncate(finding.detail, 2000),
          ...(options.context ?? {}),
        }),
      ],
    });
    if (!claim) continue;

    const key = [
      claim.criterion,
      claim.pageUrl,
      claim.selector ?? claim.sourcePath ?? '',
      collapse(claim.summary).toLowerCase().slice(0, 80),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push(claim);
  }

  return claims;
}

/* ========================================================================== */
/* Accessibility-tree excerpt                                                 */
/* ========================================================================== */

/**
 * The roles worth putting in front of a model.
 *
 * A full CDP tree is thousands of nodes of mostly `generic` and `StaticText`,
 * and pasting it wholesale would spend the context window on scaffolding and
 * trip the artifact rule (A9.2, A13.7). These are the nodes a claim can
 * actually rest on: the controls, the landmarks, the headings and the images.
 */
export const EXCERPT_ROLES: readonly string[] = [
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'tablist',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'combobox',
  'listbox',
  'option',
  'slider',
  'spinbutton',
  'textbox',
  'searchbox',
  'textfield',
  'heading',
  'img',
  'image',
  'graphics-document',
  'figure',
  'banner',
  'navigation',
  'main',
  'complementary',
  'contentinfo',
  'region',
  'search',
  'form',
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'log',
  'table',
  'list',
  'video',
  'audio',
  'iframe',
  'Iframe',
  'application',
  'document',
];

export interface TreeExcerptNode {
  readonly nodeId?: string;
  readonly role?: string | null;
  readonly name?: string | null;
  readonly ignored?: boolean;
  readonly props?: {
    readonly expanded?: string | null;
    readonly checked?: string | null;
    readonly selected?: string | null;
    readonly pressed?: string | null;
    readonly focused?: string | null;
    readonly disabled?: string | null;
  };
}

export type TreeExcerptSource = Readonly<Record<string, TreeExcerptNode>>;

export interface TreeExcerptOptions {
  readonly maxNodes?: number;
  readonly maxChars?: number;
  readonly roles?: readonly string[];
}

/**
 * A compact, line-per-node rendering of the accessibility tree.
 *
 * One line per interesting node: role, accessible name, and any state property
 * the node actually exposes. `name=<none>` is deliberately loud — a control
 * with no accessible name is the single most common thing a lane is being
 * asked to notice, and it must not look like a formatting artefact.
 */
export function renderTreeExcerpt(
  tree: TreeExcerptSource | null | undefined,
  options: TreeExcerptOptions = {},
): { text: string; nodes: number; truncated: boolean } {
  const roles = new Set((options.roles ?? EXCERPT_ROLES).map((role) => role.toLowerCase()));
  const maxNodes = options.maxNodes ?? 220;
  const maxChars = options.maxChars ?? 14_000;

  const lines: string[] = [];
  let considered = 0;

  for (const node of Object.values(tree ?? {})) {
    const role = (node.role ?? '').trim();
    if (role.length === 0) continue;
    if (!roles.has(role.toLowerCase())) continue;
    considered += 1;
    if (lines.length >= maxNodes) continue;

    const name = collapse(node.name ?? '');
    const states: string[] = [];
    for (const [key, value] of Object.entries(node.props ?? {})) {
      if (value !== null && value !== undefined) states.push(`${key}=${value}`);
    }

    lines.push(
      `- ${role} name=${name.length > 0 ? JSON.stringify(truncate(name, 90)) : '<none>'}` +
        (node.ignored ? ' ignored=true' : '') +
        (states.length > 0 ? ` [${states.join(' ')}]` : ''),
    );
  }

  let text = lines.join('\n');
  let truncated = considered > lines.length;
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n…`;
    truncated = true;
  }
  return { text, nodes: lines.length, truncated };
}

/* ========================================================================== */
/* Small shared helpers                                                       */
/* ========================================================================== */

export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function toBase64(text: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64');
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decoded size of a base64 payload, without decoding it. */
export function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * `response_format` should give us a bare JSON object, but a model that wrapped
 * it in a fence or a sentence has still done the work. Mirrors the recovery in
 * `lib/harness/run.ts`, which is not exported.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;

  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
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

function formatIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

function isRetryable(error: unknown): boolean {
  if (error instanceof LanePassError) return error.retryable;
  if (error instanceof TrueForgeError) return error.isRetryable;
  return false;
}

export function isAborted(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'aborted');
}

export function describe(error: unknown): string {
  if (error === null || error === undefined) return 'the lane produced no answer';
  if (error instanceof Error) return error.message;
  return String(error);
}
