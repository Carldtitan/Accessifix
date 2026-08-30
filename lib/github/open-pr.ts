/**
 * `openPullRequest` — the pipeline-facing adapter.
 *
 * `lib/github/pr.ts` exposes `openVerifiedPullRequest`, which is the only
 * sanctioned path to GitHub's `pulls.create`. It enforces, in order: the test
 * suite did not fail, the build passed, the commit under review is the one that
 * was verified, and an approval matching this exact operation is held. That
 * ordering is not decoration — it is what stops a patch reaching someone else's
 * repository on no evidence.
 *
 * The conductor's seam wants a flatter call, and the gap between the two shapes
 * is wider than it looks:
 *
 *  - The seam carries **diffs**, because a `patches` row stores a diff and
 *    nothing else. Everything downstream needs whole files — to digest for the
 *    approval, and to commit. So the bytes are rebuilt from the diff and the
 *    file it was computed against, and a diff that no longer reproduces takes
 *    the whole set down with it rather than being forced or quietly dropped
 *    (`lib/fix/source.ts`). A pull request cites every criterion the proposal
 *    covered, so a partial commit would be a claim without the bytes behind it.
 *  - `openVerifiedPullRequest` requires a commit **already on the head branch**,
 *    because the build and the suite ran over local files and the commit is the
 *    only thing tying that evidence to what is on GitHub. So this adapter is
 *    also the thing that creates the branch and pushes the commit.
 *  - The seam's `title` and `body` are advisory. The composed body is built from
 *    the structured evidence and is what the gates bind to, so it wins; taking
 *    the caller's prose instead would let the text drift from the operation the
 *    human approved.
 *
 * It **does not loosen a single gate**. Each write is bound to its own operation
 * — repository, branch, base, title, commit and a digest of every file's
 * contents — so a decision cannot be replayed against a different payload, and
 * an approval built for the branch push is refused by `openPullRequest` and vice
 * versa, because each call site accepts only its own action.
 *
 * Without an approved decision it throws. Opening a pull request against a
 * user's repository is irreversible, and A7.1 says irreversible actions wait
 * for a person.
 */
import {
  bindApprovalToOperation,
  buildBranchApproval,
  buildPullRequestApproval,
  type ApprovalOperation,
  type GateDecision,
} from '@/lib/fix/gate';
import type { FilePatch } from '@/lib/fix/patch';
import { materializeAllPatches, PatchesDoNotApplyError } from '@/lib/fix/source';
import type { StoredPatchInput } from '@/lib/fix/source';
import type { FixableFinding } from '@/lib/fix/group';
import type { BuildResult } from '@/lib/verify/build';
import type { RecheckReport } from '@/lib/verify/recheck';
import type { TestRunResult } from '@/lib/verify/tests';

import { GitHubClient, GitHubError } from './client';
import { composePullRequest, openVerifiedPullRequest, type PullRequestComposition } from './pr';

/**
 * The two irreversible acts a run asks for, as the human answered them.
 *
 * They are produced by `planPullRequestForRun` *before* the card goes up, and
 * they are what the conductor records against the decision. Handing them back
 * here is what makes the check at the write real: without them the write path
 * would have to derive an operation from the payload it is already holding and
 * compare it against itself, which agrees with everything.
 */
export interface ApprovedWriteOperations {
  /** Creating or reusing the branch, and committing the bytes onto it. */
  readonly branch: ApprovalOperation;
  /**
   * Opening the pull request. Its `commitSha` is null at approval time — the
   * commit does not exist yet — and is filled from the commit this run makes
   * under `branch`, which is itself bound to the approved bytes and tip.
   */
  readonly pullRequest: ApprovalOperation;
}

export interface PipelineOpenPullRequestInput {
  runId: string;
  repoFullName: string;
  accessToken: string;
  branch: string;
  title: string;
  body: string;
  /**
   * The stored patches, with the findings and criteria they were written for.
   *
   * Not merely `{filePath, diff}`: the title and body are composed from these,
   * and a patch that arrives without its criteria produces a pull request
   * titled "Accessibility fixes (1 file, 0 findings)" over a diff that fixes
   * four. The citation is the product; it travels with the bytes.
   */
  patches: readonly StoredPatchInput[];
  /**
   * The findings those patches address, for the before/after evidence and the
   * count in the title. Empty means the pull request cites no finding, so the
   * conductor passes the ledger rows the FIX pass worked from.
   */
  findings?: readonly FixableFinding[];
  /** Verification evidence. The gates read this; they do not take our word. */
  verification?: {
    buildPassed: boolean;
    /** False when no build script ran. Unproven, which is not the same as failed. */
    buildRan?: boolean;
    testsPassed: boolean;
    /** False when no suite ran, or one ran and found nothing. Unproven, not a pass. */
    testsRan?: boolean;
    testCommand?: string;
    testSummary?: string;
  };
  /**
   * The human decision (A7.1). Absent, unapproved, or carrying no operations
   * means refuse — an id on its own authorises nothing.
   */
  approval?: {
    requestId: string;
    approved: boolean;
    operations?: ApprovedWriteOperations;
  };
  signal?: AbortSignal;
}

/** Everything needed to plan the write. The decision is what the plan is for. */
export type PullRequestPlanInput = Omit<PipelineOpenPullRequestInput, 'approval'>;

/**
 * What this run intends to write, resolved against the repository as it is now.
 *
 * Built once before the human is asked, and built again immediately before the
 * write. The two are compared, and the write happens only where they agree.
 */
export interface PullRequestPlan {
  readonly repoFullName: string;
  /** The default branch the diffs were read against and the PR would target. */
  readonly base: string;
  readonly composition: PullRequestComposition;
  /**
   * Whole files, rebuilt from the stored diffs and verified to reproduce them.
   *
   * Every proposed patch, or the plan does not exist: planning throws rather
   * than returning a shorter list, so this is never a subset of what FIX wrote.
   */
  readonly patches: readonly FilePatch[];
  /** An existing branch tip above the base, which reuse would absorb. */
  readonly resumeFromSha: string | null;
  readonly operations: ApprovedWriteOperations;
  readonly evidence: { build: BuildResult; tests: TestRunResult; recheck: RecheckReport };
}

/**
 * Work out exactly what would be written, without writing anything.
 *
 * This is the half of the old `openPullRequestForRun` that has to run *before*
 * consent rather than after it: resolve the base, rebuild the bytes from the
 * stored diffs, compose the title and body the gates bind to, read the branch
 * tip, and turn all of it into the two `ApprovalOperation`s the write will be
 * measured against.
 *
 * Read-only. Every GitHub call here is a GET, so a run that is never approved
 * has changed nothing.
 */
export async function planPullRequestForRun(
  input: PullRequestPlanInput,
  existingClient?: GitHubClient,
): Promise<PullRequestPlan> {
  const client = existingClient ?? new GitHubClient(input.accessToken);
  const base = await client.getDefaultBranch(input.repoFullName);

  /*
   * Whole files, rebuilt from the stored diffs and verified to reproduce them
   * exactly. A patch that no longer applies is not committed on a guess — and
   * neither are the ones beside it.
   *
   * All or nothing, because a pull request is a claim. Its body cites every
   * criterion the proposal covered and its title counts them, so committing the
   * subset that still applies would open a pull request asserting repairs whose
   * bytes are not in it. Dropping the patch quietly and leaving the claim
   * standing is the worst outcome this tool has: a reviewer reads the citation,
   * not the diff, and merges an unfixed criterion believing it fixed.
   *
   * It throws rather than trimming, so the refusal happens here — before the
   * card goes up — and the human is never asked to approve a fix that is
   * already incomplete.
   */
  let patches: readonly FilePatch[];
  try {
    patches = await materializeAllPatches({
      repoFullName: input.repoFullName,
      accessToken: input.accessToken,
      patches: input.patches,
      ref: base,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    throw new GitHubError(
      'openPullRequest',
      error instanceof PatchesDoNotApplyError
        ? `${error.message} No pull request was opened.`
        : `The proposed patches could not be rebuilt against ${input.repoFullName}@${base}: ` +
          `${(error as Error).message}`,
    );
  }

  const evidence = pullRequestVerificationEvidence(input, base);
  const composition = composePullRequest(composeInputFor(input, base, patches, evidence));

  // Read the tip first. An existing branch already ahead of the base is history
  // this run did not write, and the approval has to say so rather than absorb
  // it silently.
  const existingTip = await client.getBranchSha(input.repoFullName, composition.branch);
  const baseTip = await client.getBranchSha(input.repoFullName, base);
  const resumeFromSha = existingTip && existingTip !== baseTip ? existingTip : null;

  /*
   * The operations, built by the same builders the write path uses, so the
   * digests shown on the card and the digests checked at the write are computed
   * exactly one way.
   *
   * The pull request's `commitSha` is null here and cannot be anything else:
   * the commit is made under the branch approval, so it does not exist until
   * after this decision has been answered.
   */
  const branchOperation = buildBranchApproval({
    runId: input.runId,
    repoFullName: input.repoFullName,
    branch: composition.branch,
    baseBranch: base,
    patches,
    resumeFromSha,
  }).operation;

  const pullRequestOperation = buildPullRequestApproval({
    runId: input.runId,
    repoFullName: input.repoFullName,
    branch: composition.branch,
    baseBranch: base,
    title: composition.title,
    patches,
    commitSha: null,
    buildSummary: evidence.build.summary,
    buildOk: evidence.build.ok,
    buildUnproven: !evidence.build.buildRan,
    testSummary: evidence.tests.summary,
    testsOk: evidence.tests.ok,
    testsUnproven: evidence.tests.skipped,
    recheckSummary: evidence.recheck.summary,
  }).operation;

  return {
    repoFullName: input.repoFullName,
    base,
    composition,
    patches,
    resumeFromSha,
    operations: { branch: branchOperation, pullRequest: pullRequestOperation },
    evidence,
  };
}

/**
 * The seam's flat input, in the shape `composePullRequest` takes.
 *
 * One function rather than two literals: the composed title and branch are what
 * the approval binds to, so the plan and the write have to compose from
 * identical inputs or the operation comparison would fail on wording alone.
 */
function composeInputFor(
  input: PullRequestPlanInput,
  base: string,
  patches: readonly FilePatch[],
  evidence: { build: BuildResult; tests: TestRunResult; recheck: RecheckReport },
) {
  return {
    runId: input.runId,
    repoFullName: input.repoFullName,
    baseBranch: base,
    branch: input.branch,
    patches,
    findings: input.findings ?? [],
    build: evidence.build,
    tests: evidence.tests,
    recheck: evidence.recheck,
  } as const;
}

/**
 * Fill in the one field the human could not have seen.
 *
 * The pull-request operation is approved with `commitSha: null`, which means
 * "the commit this run makes on the approved branch from the approved bytes".
 * That commit is not a free variable: `commitFiles` refused to write anything
 * whose digests were not the approved ones, onto any branch but the approved
 * one, on top of any tip but the approved one. So the sha is a consequence of
 * what was approved rather than an addition to it, and substituting it here
 * does not widen the consent.
 *
 * Everything else is left exactly as the human answered it, and the two guards
 * below are what keep the substitution from becoming a hole: an approval that
 * already names a commit must name *this* one, and the bytes in the pull-request
 * operation must be the bytes the branch operation authorised.
 */
function pullRequestOperationForCommit(
  approved: ApprovedWriteOperations,
  commitSha: string,
): ApprovalOperation {
  const operation = approved.pullRequest;

  if (operation.commitSha !== null && operation.commitSha !== commitSha) {
    throw new GitHubError(
      'openPullRequest',
      `The approval opens a pull request from commit ${operation.commitSha}, but this run ` +
        `pushed ${commitSha}. That is not the change that was approved.`,
    );
  }

  const branchFiles = [...approved.branch.files].sort();
  const pullRequestFiles = [...operation.files].sort();
  if (
    branchFiles.length !== pullRequestFiles.length ||
    branchFiles.some((digest, index) => digest !== pullRequestFiles[index])
  ) {
    throw new GitHubError(
      'openPullRequest',
      'The approved branch push and the approved pull request describe different bytes, so the ' +
        'commit sha cannot be carried from one to the other.',
    );
  }

  return { ...operation, commitSha };
}

/**
 * The pull request that was opened, and the files that are actually in it.
 *
 * `files` is not decoration. The conductor writes `applied` against patch rows
 * on the strength of this call returning, and "the pull request was opened" does
 * not say *what* it contains. Returning the committed paths lets the ledger be
 * marked from what was written rather than from what was proposed, so the two
 * cannot drift even if a future change reintroduces a partial write.
 */
export interface OpenedPullRequestForRun {
  readonly url: string;
  readonly number: number;
  readonly branch: string;
  /** Repository-relative paths of every file committed, normalised. */
  readonly files: readonly string[];
}

export async function openPullRequestForRun(
  input: PipelineOpenPullRequestInput,
): Promise<OpenedPullRequestForRun> {
  if (!input.approval?.approved) {
    throw new Error(
      'openPullRequest was called without an approved decision. Opening a pull ' +
        'request against a user repository is irreversible and requires explicit ' +
        'human approval (A7.1).',
    );
  }

  /*
   * The operations the human answered. Refusing without them is the whole point
   * of this check: a decision id says which card was clicked and nothing about
   * which repository, which branch, which title or which bytes, so building an
   * operation out of the payload in hand and comparing it against itself would
   * agree with every payload — including one assembled after the yes.
   */
  const approvedOperations = input.approval.operations;
  if (!approvedOperations) {
    throw new Error(
      'openPullRequest was called with an approval that names no operation. A decision id ' +
        'binds nothing on its own: the repository, branch, base, title and the digest of every ' +
        "file's contents have to come from what the human was shown (A7.1). Plan the write with " +
        '`planPullRequestForRun`, record its operations against the decision, and pass them here.',
    );
  }

  const client = new GitHubClient(input.accessToken);

  // What would be written *now*, resolved against the repository as it is at
  // this moment rather than as it was when the card went up. Anything that
  // moved in between shows up as a mismatch at the write and is refused there.
  const plan = await planPullRequestForRun(input, client);

  const decisionId = input.approval.requestId;
  const decision: GateDecision = { requestId: decisionId, status: 'approved' };

  /*
   * The branch has to exist and carry the commit before the pull request can
   * point at it, and pushing is itself a write, so it carries its own approval
   * bound to its own operation. The prose is rebuilt from the current plan; the
   * operation is the recorded one, so `createBranch` and `commitFiles` compare
   * the repository, branch, base, tip and file digests the human approved
   * against the ones actually about to be written.
   */
  const branchApproval = bindApprovalToOperation(
    buildBranchApproval({
      id: decisionId,
      runId: input.runId,
      repoFullName: input.repoFullName,
      branch: plan.composition.branch,
      baseBranch: plan.base,
      patches: plan.patches,
      resumeFromSha: plan.resumeFromSha,
    }),
    approvedOperations.branch,
  );

  const branchResult = await client.createBranch(
    input.repoFullName,
    plan.composition.branch,
    { approval: branchApproval, decision },
    plan.base,
  );

  const commit = await client.commitFiles(
    input.repoFullName,
    {
      branch: plan.composition.branch,
      message: plan.composition.commitMessage,
      files: plan.patches.map((patch) => ({
        path: patch.filePath,
        contents: patch.newContents,
      })),
      // The tip that was just validated, not whatever the branch happens to be
      // at by now — that is what makes the non-forced ref update meaningful.
      parentSha: branchResult.sha,
    },
    { approval: branchApproval, decision },
  );

  // The approval is bound to these exact bytes, on this exact commit. Approving
  // "three files" and approving *these* three files with *these* contents are
  // different consents.
  const approval = bindApprovalToOperation(
    buildPullRequestApproval({
      id: decisionId,
      runId: input.runId,
      repoFullName: input.repoFullName,
      branch: plan.composition.branch,
      baseBranch: plan.base,
      title: plan.composition.title,
      patches: plan.patches,
      commitSha: commit.commitSha,
      buildSummary: plan.evidence.build.summary,
      buildOk: plan.evidence.build.ok,
      buildUnproven: !plan.evidence.build.buildRan,
      testSummary: plan.evidence.tests.summary,
      testsOk: plan.evidence.tests.ok,
      testsUnproven: plan.evidence.tests.skipped,
      recheckSummary: plan.evidence.recheck.summary,
    }),
    pullRequestOperationForCommit(approvedOperations, commit.commitSha),
  );

  const opened = await openVerifiedPullRequest(
    client,
    {
      ...composeInputFor(input, plan.base, plan.patches, plan.evidence),
      repo: input.repoFullName,
      commit,
    },
    approval,
    decision,
  );

  return {
    url: opened.pullRequest.url,
    number: opened.pullRequest.number,
    branch: opened.pullRequest.head,
    // The paths that were committed, taken from the plan the approval was
    // checked against — the same list `commitFiles` digested and wrote.
    files: plan.patches.map((patch) => patch.filePath),
  };
}

/* -------------------------------------------------------------------------- */
/* Evidence                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The seam's flat booleans, widened into the shapes the two gates read.
 *
 * Nothing here invents a pass. The mapping is deliberately one-directional:
 *
 *  - No `verification` at all means nothing was demonstrated, so both sides come
 *    back unproven — and `openVerifiedPullRequest` rejects unproven-and-unproven
 *    as no evidence at all. A caller that forgets to pass its evidence gets a
 *    refusal, never a pull request.
 *  - `buildPassed: false` is a **failure** unless the caller says the build
 *    never ran. A build that failed and a build that was never attempted are
 *    different facts, and only the caller knows which it had.
 *  - `testsPassed: false` is likewise a failure unless the caller says no suite
 *    ran. Where the caller says nothing, an empty `testCommand` is taken as
 *    "there was no suite" — that is what `verifyPatches` puts there when it had
 *    no command to run — and anything else is read as a suite that did not pass,
 *    which is A6.4's hard stop.
 */
export function pullRequestVerificationEvidence(
  input: PullRequestPlanInput,
  base: string,
): { build: BuildResult; tests: TestRunResult; recheck: RecheckReport } {
  const verification = input.verification;
  const command = verification?.testCommand ?? '';

  /*
   * With nothing supplied, nothing is proven — on either axis. That is not the
   * same as a failure, and saying so gets the refusal from the branch that
   * states the truth ("nothing verified this patch") rather than from one that
   * claims a build failed that was never reported.
   *
   * `buildRan` and `testsRan` default to *true* when evidence was supplied
   * without them. That direction matters: it makes `buildPassed: false` read as
   * a build that failed, which is a hard stop, rather than as one that never
   * ran, which is merely unproven. Only a caller that explicitly says the step
   * did not run gets the softer reading, because only that caller knows.
   */
  const buildRan = verification === undefined ? false : (verification.buildRan ?? true);
  const buildOk = verification === undefined ? true : verification.buildPassed || !buildRan;

  // Where the caller says nothing, an empty command is "there was no suite" —
  // that is what `verifyPatches` puts there when it had nothing to run.
  const testsRan =
    verification === undefined
      ? false
      : (verification.testsRan ?? (verification.testsPassed || command !== ''));
  const testsOk = verification === undefined ? true : verification.testsPassed || !testsRan;

  const build: BuildResult = {
    ok: buildOk,
    log: '',
    steps: [],
    failedStage: buildOk ? null : 'build',
    oomKilled: false,
    buildRan,
    // Nothing here watched the install. `buildGate` reads a false here as
    // observed lockfile drift, which would be a claim about something this
    // step never saw, so it is not asserted.
    installReproducible: true,
    compileErrors: [],
    repoDir: '',
    commitSha: null,
    envCopied: false,
    durationMs: 0,
    summary:
      verification === undefined
        ? 'No build evidence reached this step, so nothing about this patch has been compiled ' +
          'or checked here.'
        : buildRan
          ? buildOk
            ? 'The patched tree was built and the build passed, as reported by the VERIFY phase.'
            : 'The patched tree did not build, as reported by the VERIFY phase.'
          : 'No build script ran, so nothing was compiled and the build proves nothing.',
  };

  const detectionReason =
    verification === undefined
      ? 'No test evidence reached this step, so no suite has been shown to pass.'
      : testsRan
        ? `The verification step ran \`${command || 'the repository test suite'}\`.`
        : 'No unit test suite ran, so the suite proves nothing about this patch.';

  const tests: TestRunResult = {
    ok: testsOk,
    output: verification?.testSummary ?? '',
    framework: testsRan ? 'unknown' : 'none',
    command: command === '' ? null : command,
    exitCode: testsRan ? (testsOk ? 0 : 1) : null,
    // `skipped` is the gate's word for allowed-but-unproven. It is true only
    // when no test actually ran, never as a way past a failing suite.
    skipped: !testsRan,
    detection: {
      script: null,
      command: command === '' ? null : command,
      framework: testsRan ? 'unknown' : 'none',
      source: 'none',
      scriptBody: null,
      e2eScript: null,
      reason: detectionReason,
    },
    durationMs: 0,
    summary:
      verification?.testSummary ??
      (testsRan
        ? testsOk
          ? `\`${command}\` passed.`
          : `\`${command}\` failed.`
        : detectionReason),
  };

  // The seam carries no per-criterion re-check, so the body says so rather than
  // implying findings were re-tested. A6.5: nothing is reported as resolved
  // that nothing observed.
  const recheck: RecheckReport = {
    outcomes: [],
    resolvedFindingIds: [],
    unresolvedFindingIds: [],
    inconclusiveFindingIds: [],
    resolvedCriteria: [],
    unresolvedCriteria: [],
    checkedUrl: null,
    summary:
      'No per-criterion re-check was carried into this step, so no finding is reported as ' +
      `resolved. The patches are backed by the build and the test suite against \`${base}\`.`,
  };

  return { build, tests, recheck };
}
