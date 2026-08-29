/**
 * The approval gate (A7.1 - A7.3).
 *
 * Nothing pushes a branch, writes a commit, or opens a pull request without a
 * human saying yes first. This module is where that is enforced rather than
 * described: `assertApproved` throws unless it is holding an explicit decision
 * for the exact request in front of it, and `withApproval` is the only shape
 * the write-class call sites use.
 *
 * "The exact request" means the operation, not the label. Every request carries
 * an `ApprovalOperation` — repository, branch, base, title, commit, and a digest
 * of every file's contents — and the enforcement point compares it field by
 * field against what is about to be sent. An id alone binds nothing: a decision
 * answering `run-7:open-pull-request` would otherwise authorise a pull request
 * against any repository, from any branch, carrying any bytes.
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
/* The operation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The irreversible act itself, stripped of the prose around it.
 *
 * A request id alone cannot bind an approval to anything: `run-7:open-pull-request`
 * says nothing about which repository, which branch or which bytes, so a decision
 * for one payload would authorise any other. This is the part a human actually
 * consented to, carried on the request so the call site can compare it — field by
 * field — against what it is about to send.
 *
 * One flat shape for all four actions rather than a union: the enforcement point
 * has to compare two of these without caring which action it is holding, and a
 * field that does not apply is null rather than absent.
 */
export interface ApprovalOperation {
  readonly action: WriteAction;
  /** `owner/repo` the write lands in. */
  readonly repoFullName: string;
  /** The branch being written, or a pull request's head. Null when there is none. */
  readonly branch: string | null;
  /** The base branch, when the action has one. */
  readonly base: string | null;
  /** The pull-request title, when the action has one. */
  readonly title: string | null;
  /**
   * `path@length:hash` for every file, ascending. Digests rather than paths,
   * because approving "three files" and approving *these* three files with
   * *these* contents are different consents.
   */
  readonly files: readonly string[];
  /** The commit the head must already be at, when one was pushed. */
  readonly commitSha: string | null;
}

/**
 * A stable digest of one operation.
 *
 * Only used to make the default request id payload-specific, so a stored
 * decision cannot be replayed against a different operation. Enforcement itself
 * compares the operations field by field (`operationMismatch`) rather than
 * trusting this, because a non-cryptographic hash is an integrity check and not
 * an authentication one.
 */
export function fingerprintOperation(operation: ApprovalOperation): string {
  return stableHash(
    [
      operation.action,
      operation.repoFullName,
      operation.branch ?? '',
      operation.base ?? '',
      operation.title ?? '',
      operation.commitSha ?? '',
      ...[...operation.files].sort(),
    ].join('\u0000'),
  );
}

/** `path@length:hash` per file, ascending. Binds the exact bytes, not the count. */
export function fileDigests(
  files: readonly { readonly path: string; readonly contents: string }[],
): string[] {
  return files
    .map((file) => `${file.path}@${file.contents.length}:${stableHash(file.contents)}`)
    .sort();
}

/**
 * Why two operations differ, in a sentence, or null when they are the same act.
 *
 * Exported because the GitHub client enforces the same comparison at its own
 * boundary, and two implementations of "the same" would eventually disagree.
 */
export function operationMismatch(
  approved: ApprovalOperation,
  aboutToRun: ApprovalOperation,
): string | null {
  const fields: ReadonlyArray<[string, unknown, unknown]> = [
    ['action', approved.action, aboutToRun.action],
    ['repository', approved.repoFullName, aboutToRun.repoFullName],
    ['branch', approved.branch, aboutToRun.branch],
    ['base branch', approved.base, aboutToRun.base],
    ['title', approved.title, aboutToRun.title],
    ['commit', approved.commitSha, aboutToRun.commitSha],
  ];
  for (const [name, was, now] of fields) {
    if (was !== now) {
      return `the approved ${name} is ${describe(was)}, but ${describe(now)} is about to run`;
    }
  }

  const approvedFiles = [...approved.files].sort();
  const runningFiles = [...aboutToRun.files].sort();
  if (
    approvedFiles.length !== runningFiles.length ||
    approvedFiles.some((digest, index) => digest !== runningFiles[index])
  ) {
    return (
      `the approved file set is not the one about to be written ` +
      `(${approvedFiles.length} approved, ${runningFiles.length} about to run, and their contents ` +
      'are compared by digest, not by name)'
    );
  }

  return null;
}

function describe(value: unknown): string {
  return value === null || value === undefined ? 'unset' : `"${String(value)}"`;
}

/**
 * FNV-1a in four lanes, so the digest is wide enough to be useful and the module
 * stays free of imports — `lib/fix/gate.ts` is rendered by the run view as well
 * as run on the server, and pulling `node:crypto` in here would break the client
 * bundle for no gain the field-by-field comparison does not already give.
 */
function stableHash(text: string): string {
  const lanes = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    for (let lane = 0; lane < lanes.length; lane += 1) {
      lanes[lane] = Math.imul((lanes[lane]! ^ (code + lane * 31 + i)) >>> 0, 0x01000193) >>> 0;
    }
  }
  return lanes.map((lane) => lane.toString(16).padStart(8, '0')).join('');
}

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
   * Exactly what was consented to, in the terms the write call site works in.
   * The enforcement point compares this against the operation it is about to
   * run, so an approval cannot be carried across to a different repository,
   * branch, title or file set.
   */
  readonly operation: ApprovalOperation;
  /** Digest of `operation`, folded into the default id so a decision cannot drift. */
  readonly fingerprint: string;
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
 *
 * Three questions, and all three have to answer yes:
 *
 *  1. Is this decision about this request at all?
 *  2. Does the request describe the operation that is about to run? Pass
 *     `aboutToRun` and it is compared field by field — repository, branch, base,
 *     title, commit and the digest of every file. A human who approved a two-file
 *     change to `accessifix/a11y-3f2c` has not approved anything else, and
 *     without this argument the gate could not tell the difference.
 *  3. Did the human say yes?
 *
 * `aboutToRun` is optional only so a caller that has already compared the
 * operation itself is not forced to build it twice. A write-class call site that
 * omits it is trusting its own caller, which is exactly what A7.1 forbids, so
 * everything under `lib/github` passes it.
 */
export function assertApproved(
  request: ApprovalRequest,
  decision: GateDecision | null | undefined,
  aboutToRun?: ApprovalOperation,
): asserts decision is GateDecision {
  if (aboutToRun) {
    const mismatch = operationMismatch(request.operation, aboutToRun);
    if (mismatch) {
      throw new ApprovalRequiredError(
        request,
        'pending',
        `the approval does not cover this operation — ${mismatch}`,
      );
    }
  }

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

/** Run `fn` only if a human approved this exact request, for this exact operation. */
export async function withApproval<T>(
  request: ApprovalRequest,
  decision: GateDecision | null | undefined,
  fn: () => Promise<T>,
  aboutToRun?: ApprovalOperation,
): Promise<T> {
  assertApproved(request, decision, aboutToRun);
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
  const operation = patchOperation('apply-patch', {
    repoFullName: input.repoFullName,
    patches: input.patches,
  });
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
    id: input.id ?? makeId(input.runId, operation),
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
    operation,
    fingerprint: fingerprintOperation(operation),
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
  const operation = patchOperation('push-branch', {
    repoFullName: input.repoFullName,
    patches: input.patches,
    branch: input.branch,
    base: input.baseBranch,
  });

  return {
    id: input.id ?? makeId(input.runId, operation),
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
    operation,
    fingerprint: fingerprintOperation(operation),
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
  /**
   * The commit already pushed to `branch`. The approval is bound to it, so a
   * yes for one tree cannot open a pull request from a different one.
   */
  readonly commitSha?: string | null;
  /** Build outcome, in the caller's own words. */
  readonly buildSummary: string;
  readonly buildOk: boolean;
  /**
   * True when nothing was compiled — the repository defines no build script, so
   * the build step ran nothing and proved nothing. `buildOk` is true alongside
   * it, because nothing failed either, and the card must not read as a pass.
   */
  readonly buildUnproven?: boolean;
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
  const operation = patchOperation('open-pull-request', {
    repoFullName: input.repoFullName,
    patches: input.patches,
    branch: input.branch,
    base: input.baseBranch,
    title: input.title,
    commitSha: input.commitSha ?? null,
  });

  const intent =
    `I want to open a pull request on ${input.repoFullName}, from \`${input.branch}\` into ` +
    `\`${input.baseBranch}\`, titled "${input.title}". It changes ` +
    `${countNoun(files.length, 'file')} and cites ` +
    `${countNoun(criteria.length, 'WCAG success criterion', 'WCAG success criteria')}. ` +
    `Opening it notifies your reviewers and starts a Qodo review. It merges nothing.`;

  const reason = [
    criteriaSentence(criteria, input.criterionNames),
    !input.buildOk
      ? `The build did not pass: ${input.buildSummary}`
      : input.buildUnproven
        ? `Nothing was compiled: ${input.buildSummary}`
        : `The patched tree builds: ${input.buildSummary}`,
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
      label: !input.buildOk
        ? 'Build failed'
        : input.buildUnproven
          ? 'Nothing to build'
          : 'Build passed',
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
    id: input.id ?? makeId(input.runId, operation),
    runId: input.runId,
    action: 'open-pull-request',
    title: ACTION_TITLES['open-pull-request'],
    intent,
    reason,
    evidence,
    toolName: 'github.openPullRequest',
    operation,
    fingerprint: fingerprintOperation(operation),
    payload: {
      repoFullName: input.repoFullName,
      head: input.branch,
      base: input.baseBranch,
      title: input.title,
      commitSha: input.commitSha ?? null,
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

/** The operation a patch set implies, for whichever action is asking. */
function patchOperation(
  action: WriteAction,
  facts: {
    readonly repoFullName: string;
    readonly patches: readonly FilePatch[];
    readonly branch?: string | null;
    readonly base?: string | null;
    readonly title?: string | null;
    readonly commitSha?: string | null;
  },
): ApprovalOperation {
  return {
    action,
    repoFullName: facts.repoFullName,
    branch: facts.branch ?? null,
    base: facts.base ?? null,
    title: facts.title ?? null,
    files: fileDigests(
      facts.patches.map((patch) => ({ path: patch.filePath, contents: patch.newContents })),
    ),
    commitSha: facts.commitSha ?? null,
  };
}

/**
 * `run-7:open-pull-request:9a3f…` — the operation's digest is part of the id, so
 * a decision stored against one payload cannot be presented for another. Without
 * it the id is `run:action` and every pull request in a run shares one.
 */
function makeId(runId: string, operation: ApprovalOperation): string {
  return `${runId}:${operation.action}:${fingerprintOperation(operation)}`;
}

function humanDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}
