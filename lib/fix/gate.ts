/**
 * The approval gate (A7.1 - A7.3).
 *
 * Nothing pushes a branch, writes a commit, or opens a pull request without a
 * human saying yes first. This module is where that is enforced rather than
 * described: `assertApproved` throws unless it is holding an explicit decision
 * for the exact request in front of it, and `withApproval` is the only shape
 * the write-class call sites use.
 *
 * The other half is A7.3 — the handoff is a written explanation, not a raw tool
 * payload. Nobody can consent to `{"tool":"create_pull_request","args":{...}}`.
 * They can consent to "I want to open a pull request against clearway that
 * changes three files, because seven findings across four success criteria were
 * fixed and the repository's own test suite still passes." So the builders here
 * take structured facts and return prose, and the structured payload rides
 * alongside as a detail a curious reviewer can expand — never as the ask.
 *
 * Deliberately free of I/O. A gate that needed a database to refuse would be a
 * gate that fails open when the database is down.
 */

import type { ExcludedFinding, FixGroup } from './group';
import type { FilePatch } from './patch';

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

/** Every irreversible thing the agent can ask to do. */
export const WRITE_ACTIONS = [
  'apply-patch',
  'push-branch',
  'commit-files',
  'open-pull-request',
] as const;

export type WriteAction = (typeof WRITE_ACTIONS)[number];

const ACTION_TITLES: Record<WriteAction, string> = {
  'apply-patch': 'Apply the proposed patches',
  'push-branch': 'Push a branch to the repository',
  'commit-files': 'Commit the patches to the branch',
  'open-pull-request': 'Open a pull request',
};

/* -------------------------------------------------------------------------- */
/* Evidence                                                                   */
/* -------------------------------------------------------------------------- */

export type GateEvidenceKind =
  | 'screenshot'
  | 'tree'
  | 'source'
  | 'test'
  | 'diff'
  | 'criterion';

/**
 * One thing supporting the request (A7.2). Structurally the `ApprovalEvidence`
 * the run view renders, so the card needs no adapter.
 */
export interface GateEvidence {
  readonly id: string;
  readonly kind: GateEvidenceKind;
  /** The claim, in a few words. */
  readonly label: string;
  /** The observation behind it. One or two sentences. */
  readonly detail?: string;
  /** Artifact or external link, when there is one. */
  readonly href?: string;
}

/* -------------------------------------------------------------------------- */
/* Request and decision                                                       */
/* -------------------------------------------------------------------------- */

export interface ApprovalRequest {
  /** Stable id. The decision must name it, so an approval cannot drift. */
  readonly id: string;
  readonly runId: string;
  readonly action: WriteAction;
  /** Short name of the irreversible action. */
  readonly title: string;
  /** What the agent intends to do, written for a person (A7.3). */
  readonly intent: string;
  /** Why it wants to do it. */
  readonly reason: string;
  /** What supports it (A7.2). */
  readonly evidence: readonly GateEvidence[];
  /** The write-class tool being paused on. Shown quietly, never as the ask. */
  readonly toolName?: string;
  /**
   * The structured facts behind the prose. For an operator reading the log, not
   * for the person deciding.
   */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  /** Always true here. The gate exists for actions that cannot be undone. */
  readonly reversible: false;
}

export type GateDecisionStatus = 'pending' | 'approved' | 'rejected';

export interface GateDecision {
  /** Must equal the request's id. A decision cannot be moved to another ask. */
  readonly requestId: string;
  readonly status: GateDecisionStatus;
  /** Who decided. Recorded for the run's audit trail. */
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  /** Free text from the human, most useful on a rejection. */
  readonly reason?: string;
}

/** Thrown at every write-class call site that is not holding an approval. */
export class ApprovalRequiredError extends Error {
  readonly request: ApprovalRequest;
  readonly status: GateDecisionStatus;

  constructor(request: ApprovalRequest, status: GateDecisionStatus, detail?: string) {
    super(
      status === 'rejected'
        ? `"${request.title}" was rejected by a human${detail ? `: ${detail}` : '.'}`
        : `"${request.title}" needs human approval before it can run${detail ? `: ${detail}` : '.'}`,
    );
    this.name = 'ApprovalRequiredError';
    this.request = request;
    this.status = status;
  }
}

export function isApproved(
  request: ApprovalRequest,
  decision: GateDecision | null | undefined,
): boolean {
  return decision?.status === 'approved' && decision.requestId === request.id;
}

/**
 * The enforcement point. Every irreversible call goes through this or through
 * `withApproval`, and there is no third way.
 */
export function assertApproved(
  request: ApprovalRequest,
  decision: GateDecision | null | undefined,
): asserts decision is GateDecision {
  if (!decision) throw new ApprovalRequiredError(request, 'pending');

  if (decision.requestId !== request.id) {
    throw new ApprovalRequiredError(
      request,
      'pending',
      `the decision on hand answers "${decision.requestId}", not this request`,
    );
  }
  if (decision.status !== 'approved') {
    throw new ApprovalRequiredError(request, decision.status, decision.reason);
  }
}

/** Run `fn` only if a human approved this exact request. */
export async function withApproval<T>(
  request: ApprovalRequest,
  decision: GateDecision | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  assertApproved(request, decision);
  return fn();
}

/* -------------------------------------------------------------------------- */
/* Builders                                                                   */
/* -------------------------------------------------------------------------- */

export interface PatchApprovalInput {
  readonly runId: string;
  readonly repoFullName: string;
  readonly patches: readonly FilePatch[];
  /** Findings the patches address, for naming criteria in the prose. */
  readonly criterionNames?: ReadonlyMap<string, string>;
  /** Groups the patches came from, for the "what was left alone" line. */
  readonly groups?: readonly FixGroup[];
  /** FLAG findings a human still owns (A5.4), named so nothing looks hidden. */
  readonly humanQueue?: readonly ExcludedFinding[];
  readonly id?: string;
  readonly now?: Date;
}

/**
 * The gate before anything is written anywhere — the patches exist, and the
 * agent is asking to put them into a branch.
 */
export function buildPatchApproval(input: PatchApprovalInput): ApprovalRequest {
  const criteria = collectCriteria(input.patches);
  const files = input.patches.map((patch) => patch.filePath);
  const added = input.patches.reduce((n, p) => n + p.stats.linesAdded, 0);
  const removed = input.patches.reduce((n, p) => n + p.stats.linesRemoved, 0);

  const intent = [
    `I want to apply ${countNoun(input.patches.length, 'patch', 'patches')} to `,
    `${input.repoFullName}, touching ${countNoun(files.length, 'file')} `,
    `(${added} line${added === 1 ? '' : 's'} added, ${removed} removed). `,
    `Nothing has been written yet — this is the point where that changes.`,
  ].join('');

  const reason = [
    `${criteriaSentence(criteria, input.criterionNames)} `,
    `Each patch covers every finding in its own file, so a reviewer sees one coherent change `,
    `per component rather than one diff per complaint.`,
    input.humanQueue && input.humanQueue.length > 0
      ? ` ${countNoun(input.humanQueue.length, 'finding')} stayed out of this entirely and remain yours to judge.`
      : '',
  ].join('');

  return {
    id: input.id ?? makeId(input.runId, 'apply-patch'),
    runId: input.runId,
    action: 'apply-patch',
    title: ACTION_TITLES['apply-patch'],
    intent,
    reason,
    evidence: [
      ...input.patches.map(
        (patch, index): GateEvidence => ({
          id: `patch-${index}`,
          kind: 'diff',
          label: `${patch.filePath} — SC ${patch.criteria.join(', ')}`,
          detail: patch.rationale,
        }),
      ),
      ...(input.humanQueue ?? []).slice(0, 5).map(
        (item, index): GateEvidence => ({
          id: `flagged-${index}`,
          kind: 'criterion',
          label: `SC ${item.finding.criterion} left for you`,
          detail: item.explanation,
        }),
      ),
    ],
    toolName: 'write_files',
    payload: {
      repoFullName: input.repoFullName,
      files,
      criteria,
      findingIds: input.patches.flatMap((patch) => [...patch.findingIds]),
    },
    createdAt: (input.now ?? new Date()).toISOString(),
    reversible: false,
  };
}

export interface BranchApprovalInput {
  readonly runId: string;
  readonly repoFullName: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly patches: readonly FilePatch[];
  readonly id?: string;
  readonly now?: Date;
}

/** The gate before a branch reaches the remote (A7.1). */
export function buildBranchApproval(input: BranchApprovalInput): ApprovalRequest {
  const files = input.patches.map((patch) => patch.filePath);

  return {
    id: input.id ?? makeId(input.runId, 'push-branch'),
    runId: input.runId,
    action: 'push-branch',
    title: ACTION_TITLES['push-branch'],
    intent:
      `I want to create the branch \`${input.branch}\` in ${input.repoFullName}, cut from ` +
      `\`${input.baseBranch}\`, and commit ${countNoun(files.length, 'file')} to it. This is a ` +
      `write to your repository using your own GitHub token. \`${input.baseBranch}\` is not touched.`,
    reason:
      `The patches have to live somewhere a pull request can point at. A branch is the smallest ` +
      `thing that does that, and it can be deleted without trace if you decide against the change.`,
    evidence: input.patches.map(
      (patch, index): GateEvidence => ({
        id: `file-${index}`,
        kind: 'source',
        label: patch.filePath,
        detail: `${patch.stats.linesAdded} added, ${patch.stats.linesRemoved} removed — SC ${patch.criteria.join(', ')}`,
      }),
    ),
    toolName: 'github.createBranch',
    payload: {
      repoFullName: input.repoFullName,
      branch: input.branch,
      base: input.baseBranch,
      files,
    },
    createdAt: (input.now ?? new Date()).toISOString(),
    reversible: false,
  };
}

export interface PullRequestApprovalInput {
  readonly runId: string;
  readonly repoFullName: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly title: string;
  readonly patches: readonly FilePatch[];
  readonly criterionNames?: ReadonlyMap<string, string>;
  /** Build outcome, in the caller's own words. */
  readonly buildSummary: string;
  readonly buildOk: boolean;
  /** Test outcome. A failing suite must never reach this builder (A6.4). */
  readonly testSummary: string;
  readonly testsOk: boolean;
  readonly testsUnproven?: boolean;
  /** Re-check outcome (A6.3). */
  readonly recheckSummary: string;
  readonly resolvedCriteria?: readonly string[];
  readonly unresolvedCriteria?: readonly string[];
  readonly humanQueue?: readonly ExcludedFinding[];
  readonly id?: string;
  readonly now?: Date;
}

/**
 * The last gate. Everything the run knows, in the order a person needs it:
 * what will happen, why it is safe, and what is still uncertain.
 */
export function buildPullRequestApproval(input: PullRequestApprovalInput): ApprovalRequest {
  const criteria = collectCriteria(input.patches);
  const files = input.patches.map((patch) => patch.filePath);

  const intent =
    `I want to open a pull request on ${input.repoFullName}, from \`${input.branch}\` into ` +
    `\`${input.baseBranch}\`, titled "${input.title}". It changes ` +
    `${countNoun(files.length, 'file')} and cites ` +
    `${countNoun(criteria.length, 'WCAG success criterion', 'WCAG success criteria')}. ` +
    `Opening it notifies your reviewers and starts a Qodo review. It merges nothing.`;

  const reason = [
    criteriaSentence(criteria, input.criterionNames),
    input.buildOk
      ? `The patched tree builds: ${input.buildSummary}`
      : `The build did not pass: ${input.buildSummary}`,
    input.testsUnproven
      ? input.testSummary
      : input.testsOk
        ? `The repository's own test suite still passes: ${input.testSummary}`
        : `The repository's own test suite failed: ${input.testSummary}`,
    input.recheckSummary,
    input.unresolvedCriteria && input.unresolvedCriteria.length > 0
      ? `Not everything is settled: SC ${input.unresolvedCriteria.join(', ')} could not be confirmed fixed, and the body says so.`
      : '',
  ]
    .filter((sentence) => sentence.length > 0)
    .join(' ');

  const evidence: GateEvidence[] = [
    {
      id: 'build',
      kind: 'test',
      label: input.buildOk ? 'Build passed' : 'Build failed',
      detail: input.buildSummary,
    },
    {
      id: 'tests',
      kind: 'test',
      label: input.testsUnproven
        ? 'No test suite to run'
        : input.testsOk
          ? "Target's own test suite passed"
          : "Target's own test suite failed",
      detail: input.testSummary,
    },
    {
      id: 'recheck',
      kind: 'criterion',
      label: 'Criterion re-check',
      detail: input.recheckSummary,
    },
    ...input.patches.map(
      (patch, index): GateEvidence => ({
        id: `patch-${index}`,
        kind: 'diff',
        label: `${patch.filePath} — SC ${patch.criteria.join(', ')}`,
        detail: patch.rationale,
      }),
    ),
    ...(input.humanQueue ?? []).slice(0, 5).map(
      (item, index): GateEvidence => ({
        id: `flagged-${index}`,
        kind: 'criterion',
        label: `SC ${item.finding.criterion} not included`,
        detail: item.explanation,
      }),
    ),
  ];

  return {
    id: input.id ?? makeId(input.runId, 'open-pull-request'),
    runId: input.runId,
    action: 'open-pull-request',
    title: ACTION_TITLES['open-pull-request'],
    intent,
    reason,
    evidence,
    toolName: 'github.openPullRequest',
    payload: {
      repoFullName: input.repoFullName,
      head: input.branch,
      base: input.baseBranch,
      title: input.title,
      files,
      criteria,
      resolvedCriteria: input.resolvedCriteria ?? [],
      unresolvedCriteria: input.unresolvedCriteria ?? [],
    },
    createdAt: (input.now ?? new Date()).toISOString(),
    reversible: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The handoff as a person reads it (A7.3).
 *
 * Intent, then reason, then the evidence, in that order and in that shape. The
 * structured payload is not in here at all — it is on the request for the log,
 * and putting it in front of the decision would make the decision worse.
 */
export function renderApproval(request: ApprovalRequest): string {
  const lines: string[] = [`## ${request.title}`, '', request.intent, '', request.reason];

  if (request.evidence.length > 0) {
    lines.push('', '### What supports this', '');
    for (const item of request.evidence) {
      lines.push(item.detail ? `- **${item.label}** — ${item.detail}` : `- **${item.label}**`);
    }
  }

  lines.push(
    '',
    'This action cannot be undone by the agent. Nothing happens until you approve it.',
  );

  return lines.join('\n');
}

/**
 * The `handoffs` row for this request. The ledger holds prose, because that is
 * what the interface has to render when the page is reloaded three hours later
 * (A7.4).
 */
export function toHandoffRow(request: ApprovalRequest): {
  runId: string;
  kind: 'approval';
  intent: string;
  reason: string;
  evidenceIds: string[];
} {
  return {
    runId: request.runId,
    kind: 'approval',
    intent: request.intent,
    reason: request.reason,
    evidenceIds: request.evidence.map((item) => item.id),
  };
}

/**
 * A7.5: an unanswered handoff surfaces a reminder. Null until it has been
 * waiting long enough to be worth interrupting someone over.
 */
export function pendingReminder(
  request: ApprovalRequest,
  now: Date = new Date(),
  thresholdMs = 120_000,
): string | null {
  const waitedMs = now.getTime() - new Date(request.createdAt).getTime();
  if (waitedMs < thresholdMs) return null;
  return `The run has been waiting ${humanDuration(waitedMs)} for a decision on "${request.title}".`;
}

/** How long the request has been open, for the card's waiting line. */
export function waitingFor(request: ApprovalRequest, now: Date = new Date()): string {
  return humanDuration(now.getTime() - new Date(request.createdAt).getTime());
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function collectCriteria(patches: readonly FilePatch[]): string[] {
  const criteria = new Set<string>();
  for (const patch of patches) {
    for (const criterion of patch.criteria) criteria.add(criterion);
  }
  return [...criteria].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

function criteriaSentence(
  criteria: readonly string[],
  names?: ReadonlyMap<string, string>,
): string {
  if (criteria.length === 0) return 'No success criteria are cited, which should not happen.';
  const rendered = criteria
    .slice(0, 6)
    .map((id) => (names?.get(id) ? `${id} ${names.get(id)}` : id));
  const tail = criteria.length > 6 ? `, and ${criteria.length - 6} more` : '';
  return `The findings behind this cite SC ${rendered.join(', ')}${tail}.`;
}

function countNoun(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

function makeId(runId: string, action: WriteAction): string {
  return `${runId}:${action}`;
}

function humanDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}
