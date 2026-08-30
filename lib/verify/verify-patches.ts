/**
 * `verifyPatches` — the VERIFY orchestrator, and the gate on the pull request.
 *
 * Composes the pieces that already existed: build the patched tree in a
 * sandbox, run the target repository's own test suite in that same sandbox,
 * re-check each criterion a patch claimed, then decide.
 *
 * The decision rule is the point of this file, and it is deliberately
 * pessimistic:
 *
 * - A patch that **no longer applies** rejects the whole set before anything is
 *   built. Verifying the survivors would produce a verdict about a tree the
 *   proposal does not describe, and then recommend a pull request on it.
 * - A test **this patch broke** rejects the patches. That is A6.4 and it is
 *   absolute. To be able to say "this patch broke it" the suite is run twice —
 *   once on the base tree, once on the patched tree — and compared per test.
 * - A test that was **already failing** on the base branch is reported and does
 *   not block. Blocking on it would refuse every fix on every repository that
 *   already has one broken test, which is a tool nobody can use.
 * - A baseline that **could not be established** falls back to the old rule:
 *   any failure blocks, and the reason says which evidence was missing.
 * - A **missing** suite is not a pass. It returns allowed-but-unproven, and
 *   says so in prose rather than reporting a tick.
 * - **Unproven build and unproven tests together** is a rejection, because
 *   that is no evidence at all — and shipping a change on no evidence is
 *   exactly what an accessibility tool must not do.
 *
 * A false pass here is worse than a failure. A failure stops the run; a false
 * pass opens a pull request against someone's repository claiming a fix that
 * was never demonstrated.
 *
 * Neither gate is re-implemented here. `buildGate` and `pullRequestGate` are
 * the two places those rules are written down, and this file combines their
 * answers rather than restating them, so a change to either is picked up here
 * and in `openVerifiedPullRequest` alike.
 */
import { materializeAllPatches, PatchesDoNotApplyError } from '@/lib/fix/source';
import type { FilePatch } from '@/lib/fix/patch';
import type { FixableFinding } from '@/lib/fix/group';
import { ensureDir, uploadFile, type Sandbox } from '@/lib/sandbox/daytona';

import { withBuildWorkspace, buildGate } from './build';
import { runTargetTests, pullRequestGate, type TestRunResult } from './tests';
import { recheckFixedCriteria } from './recheck';
import {
  compareTestRuns,
  describeComparison,
  noComparison,
  type BaselineComparison,
  type TestCaseResult,
} from './baseline';

export interface VerifyPatchesInput {
  runId: string;
  repoFullName: string;
  accessToken: string;
  patches: readonly { id: string; filePath: string; diff: string }[];
  /** Findings the patches claim to fix, so the re-check knows what to re-test. */
  findings?: readonly FixableFinding[];
  /** Branch, tag or SHA to build. Default: the remote's HEAD. */
  ref?: string;
  signal?: AbortSignal;
}

/** One failing test, named plainly enough for a maintainer to go and look. */
export interface FailingTest {
  /** `<file> > <describe…> > <test>`. */
  readonly id: string;
  readonly file: string;
  readonly name: string;
  /** First line of the failure, when the runner gave one. */
  readonly message: string | null;
}

/**
 * What the two suite runs said about each other (A6.4).
 *
 * This is the field a maintainer reads to answer the only question that
 * matters when a run is refused: *is our change at fault?*
 */
export interface TestBaselineReport {
  /** True when the suite ran on the unpatched tree at all. */
  readonly ran: boolean;
  /** True when the two runs could be compared test by test. */
  readonly comparable: boolean;
  /** How the comparison was made, or why it could not be. */
  readonly reason: string;
  /** Failing before this change and still failing. Reported, does not block. */
  readonly preExisting: readonly FailingTest[];
  /** Passing before this change and failing now. This is the blocking set. */
  readonly regressions: readonly FailingTest[];
  /** Failing now and absent from the baseline. Also counted against the patch. */
  readonly introduced: readonly FailingTest[];
  /** Failing before and passing now. An incidental improvement. */
  readonly fixed: readonly FailingTest[];
}

export interface VerifyPatchesResult {
  buildPassed: boolean;
  /**
   * False when no build script ran. `buildPassed` cannot carry this on its own:
   * a repository with no build script fails nothing and compiles nothing, and
   * the two have to stay distinguishable all the way to the approval card.
   */
  buildRan: boolean;
  /**
   * Whether the suite is a reason to refuse — **not** whether every test is
   * green.
   *
   * A suite that is red only where it was already red before the patch sets
   * this true, because the gate it feeds asks "does the suite refuse this pull
   * request?" and the answer is no. What is actually red is in `testSummary`
   * and, test by test, in `baseline` — nothing here hides a failure, and
   * `baseline.regressions` is never non-empty alongside a true here.
   */
  testsPassed: boolean;
  /** False when no suite ran, or one ran and found nothing. Unproven, not a pass. */
  testsRan: boolean;
  testCommand: string;
  testSummary: string;
  /** Every test failing on the patched tree, whoever's fault it is. */
  failingTests: readonly FailingTest[];
  /** The base-tree run and its comparison with the patched run (A6.4). */
  baseline: TestBaselineReport;
  recheck: readonly { criterion: string; resolved: boolean; note: string }[];
  recommendation: 'open-pull-request' | 'reject-patches';
  sessionId?: string | null;
  previewUrl?: string | null;
}

function verificationFailure(reason: string): VerifyPatchesResult {
  return {
    buildPassed: false,
    buildRan: false,
    testsPassed: false,
    testsRan: false,
    testCommand: '',
    testSummary: reason,
    failingTests: [],
    baseline: emptyBaseline(
      'Nothing was built, so the suite was never run on either tree and there is no ' +
        'baseline to compare against.',
    ),
    recheck: [],
    recommendation: 'reject-patches',
    previewUrl: null,
  };
}

export async function verifyPatches(input: VerifyPatchesInput): Promise<VerifyPatchesResult> {
  // The sandbox is written whole files, not diffs, so the stored diffs are
  // turned back into bytes first — and refused if they no longer reproduce.
  // Verifying a tree assembled from a patch that does not apply would report on
  // a change nobody wrote.
  //
  // All of them, or none. Building the subset that still applies and reporting
  // the rest in prose would let a run pass verification and reach the approval
  // card as an incomplete fix, holding a recommendation earned by a tree that is
  // not the one the patches describe.
  let materialized: readonly FilePatch[];
  try {
    materialized = await materializeAllPatches({
      repoFullName: input.repoFullName,
      accessToken: input.accessToken,
      patches: input.patches,
      ...(input.ref === undefined ? {} : { ref: input.ref }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    return verificationFailure(
      error instanceof PatchesDoNotApplyError
        ? `${error.message} Nothing was verified.`
        : `The proposed patches could not be read back from ${input.repoFullName}: ` +
          `${(error as Error).message}`,
    );
  }

  return verifyMaterializedPatches({
    runId: input.runId,
    repoFullName: input.repoFullName,
    accessToken: input.accessToken,
    patches: materialized,
    ...(input.findings === undefined ? {} : { findings: input.findings }),
    ...(input.ref === undefined ? {} : { ref: input.ref }),
  });
}

export interface VerifyMaterializedInput {
  runId: string;
  repoFullName: string;
  /** Used to clone a private target. Empty for a public one. */
  accessToken: string;
  /**
   * Patches already rebuilt against the base ref. `originalContents` is what
   * makes the baseline run possible: it is the exact bytes of the unpatched
   * file, so the base tree can be reconstructed in the sandbox without a second
   * clone or a second install.
   */
  patches: readonly FilePatch[];
  findings?: readonly FixableFinding[];
  ref?: string;
}

/**
 * The sandbox half of verification: build the patched tree, run the suite on
 * the base tree and again on the patched tree, re-check the criteria, decide.
 *
 * Split out from `verifyPatches` so the decision can be exercised against a
 * real repository without a GitHub token in the loop — the materialization step
 * is the only part that needs one, and it is not what the gate is about.
 */
export async function verifyMaterializedPatches(
  input: VerifyMaterializedInput,
): Promise<VerifyPatchesResult> {
  const failure = verificationFailure;
  const materialized = input.patches;

  try {
    return await withBuildWorkspace(
      {
        repoFullName: input.repoFullName,
        token: input.accessToken,
        files: materialized.map((patch) => ({
          path: patch.filePath,
          contents: patch.newContents,
        })),
        ...(input.ref === undefined ? {} : { ref: input.ref }),
        labels: { runId: input.runId },
      },
      async (workspace) => {
        const build = workspace.build;

        // An OOM is a sandbox-size problem, not a bad patch. Saying so is the
        // difference between fixing the config and debugging the wrong thing.
        if (build.oomKilled) {
          return failure(
            'The build was killed for running out of memory. That is a sandbox size ' +
              'problem, not a problem with the patch. Raise the build sandbox above 8 GB.',
          );
        }

        // A6.4's baseline. The suite is run on the tree *without* the patch
        // first, so that a failure on the patched tree can be attributed —
        // pre-existing, or ours — instead of blocking a good fix over somebody
        // else's broken test.
        //
        // The unpatched tree is reconstructed in place rather than cloned
        // again: `originalContents` is the exact bytes read back from the base
        // ref by `materializeAllPatches`, so writing them over the clone
        // restores the base tree byte for byte, and the second run reuses the
        // install and the `.env` the first one already has. The extra cost is
        // one suite run, which is the whole point — the alternative is refusing
        // every fix on any repository with one flaky test.
        const baselineRun = await withTree(
          workspace.sandbox,
          workspace.repoDir,
          materialized.map((patch) => ({
            path: patch.filePath,
            contents: patch.originalContents,
          })),
          () =>
            runTargetTests(workspace.sandbox, workspace.repoDir, { label: 'baseline' }),
        );

        // Back to the tree that was built and is being proposed. If restoring
        // it failed, nothing below is about the patch, so this is fatal rather
        // than something to note and continue past.
        const restored = await writeTree(
          workspace.sandbox,
          workspace.repoDir,
          materialized.map((patch) => ({
            path: patch.filePath,
            contents: patch.newContents,
          })),
        );
        if (!restored.ok) {
          return failure(
            `The patched files could not be restored after the baseline run (${restored.error}), ` +
              'so nothing that followed would have been about this patch. Nothing was verified.',
          );
        }

        // Same sandbox, same patched tree: A6.1, A6.2 and A6.3 all judge one
        // build rather than three provisioned separately.
        const tests = await runTargetTests(workspace.sandbox, workspace.repoDir, {
          label: 'patched',
        });

        const comparison = compareRuns(baselineRun, tests);

        const buildVerdict = buildGate(build);
        const testVerdict = pullRequestGate(tests, comparison);

        // Nothing failed, and nothing was demonstrated either. That is not a
        // shrug; it is the state with no evidence in it, and it is a rejection.
        const nothingProven = buildVerdict.unproven && testVerdict.unproven;

        // Nothing serves the patched build, so the re-check reads the diff
        // against each finding rather than re-driving the page. `recheck.ts`
        // labels that as the weakest method wherever it is shown.
        const report = await recheckFixedCriteria({
          findings: input.findings ?? [],
          patches: materialized,
          repoFullName: input.repoFullName,
        }).catch(() => null);

        const recommendation: VerifyPatchesResult['recommendation'] =
          buildVerdict.allowed && testVerdict.allowed && !nothingProven
            ? 'open-pull-request'
            : 'reject-patches';

        return {
          buildPassed: build.ok && build.buildRan,
          buildRan: build.buildRan,
          // "The suite is not a reason to refuse", not "every test is green".
          // A red suite whose every red test was already red passes this and
          // says so in `testSummary`; a regression never does, because
          // `pullRequestGate` refuses one outright.
          testsPassed: testVerdict.allowed && !testVerdict.unproven,
          testsRan: !tests.skipped,
          testCommand: tests.command ?? '',
          testSummary: nothingProven
            ? 'Neither the build nor a test suite could be run, so nothing about this ' +
              'patch has been demonstrated. Refusing to open a pull request on no evidence.'
            : `${buildVerdict.reason} ${testVerdict.reason}`,
          failingTests: failingOf(tests),
          baseline: {
            ran: isRun(baselineRun) && !baselineRun.skipped,
            comparable: comparison.comparable,
            reason: comparison.comparable ? describeComparison(comparison) : comparison.reason,
            preExisting: comparison.preExisting.map(toFailingTest),
            regressions: comparison.regressions.map(toFailingTest),
            introduced: comparison.introduced.map(toFailingTest),
            fixed: comparison.fixed.map(toFailingTest),
          },
          recheck: (report?.outcomes ?? []).map((outcome) => ({
            criterion: outcome.criterion,
            // A6.3: only positive evidence resolves a criterion. Inconclusive
            // is not a resolution, and `recheck.ts` already keeps them apart.
            resolved: outcome.resolved,
            note: outcome.note,
          })),
          recommendation,
          // Nothing deploys the patched build, so there is no preview to audit
          // in `final`. Null rather than a URL nothing is serving.
          previewUrl: null,
        };
      },
    );
  } catch (error) {
    return failure(`Verification could not complete: ${(error as Error).message}`);
  }
}

/* -------------------------------------------------------------------------- */
/* The baseline tree                                                          */
/* -------------------------------------------------------------------------- */

interface TreeFile {
  readonly path: string;
  readonly contents: string;
}

/**
 * Write a set of files over the clone, reporting rather than throwing.
 *
 * The same path guard as `build.ts`: a patch may not write outside the
 * repository, and a path that tries is refused rather than sanitised.
 */
async function writeTree(
  sandbox: Sandbox,
  repoDir: string,
  files: readonly TreeFile[],
): Promise<{ ok: boolean; error: string }> {
  for (const file of files) {
    const relative = file.path
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/^\/+/, '');
    if (relative.length === 0 || relative.split('/').includes('..')) {
      return { ok: false, error: `refused to write "${file.path}" outside the repository` };
    }
    const absolute = `${repoDir}/${relative}`;
    try {
      const parent = absolute.slice(0, absolute.lastIndexOf('/'));
      if (parent.length > 0) await ensureDir(sandbox, parent);
      await uploadFile(sandbox, Buffer.from(file.contents, 'utf8'), absolute);
    } catch (error) {
      return {
        ok: false,
        error: `${relative}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { ok: true, error: '' };
}

/**
 * Run `fn` against a tree temporarily rewritten to `files`.
 *
 * The caller restores the tree afterwards — explicitly, and checking that it
 * worked — because a silent failure to restore would leave every later step
 * judging the wrong bytes. This only handles getting *into* the other tree.
 */
async function withTree<T>(
  sandbox: Sandbox,
  repoDir: string,
  files: readonly TreeFile[],
  fn: () => Promise<T>,
): Promise<T | { readonly unavailable: string }> {
  const written = await writeTree(sandbox, repoDir, files);
  if (!written.ok) return { unavailable: written.error };
  return fn();
}

/* -------------------------------------------------------------------------- */
/* Comparing the two runs                                                     */
/* -------------------------------------------------------------------------- */

/** The baseline run, or the reason there was not one. */
type BaselineRun = TestRunResult | { readonly unavailable: string };

function isRun(run: BaselineRun): run is TestRunResult {
  return !('unavailable' in run);
}

/**
 * Compare the two runs, refusing to compare wherever the evidence is thin.
 *
 * Every early return here is a refusal in the safe direction: the caller then
 * blocks on any failure, exactly as it did before a baseline existed.
 */
function compareRuns(baseline: BaselineRun, patched: TestRunResult): BaselineComparison {
  if (!isRun(baseline)) {
    return noComparison(
      `The unpatched tree could not be reconstructed to run a baseline (${baseline.unavailable}), ` +
        'so every failure is treated as this patch\'s.',
    );
  }
  if (baseline.skipped) {
    return noComparison(
      'No suite ran on the unpatched tree, so there is nothing to compare against.',
    );
  }
  return compareTestRuns(
    {
      ok: baseline.ok,
      ran: !baseline.skipped,
      cases: baseline.cases ?? [],
      source: baseline.caseSource ?? 'none',
    },
    {
      ok: patched.ok,
      ran: !patched.skipped,
      cases: patched.cases ?? [],
      source: patched.caseSource ?? 'none',
    },
  );
}

function toFailingTest(entry: TestCaseResult): FailingTest {
  return { id: entry.id, file: entry.file, name: entry.name, message: entry.message };
}

function failingOf(result: TestRunResult): FailingTest[] {
  return (result.cases ?? [])
    .filter((entry) => entry.status === 'failed')
    .map(toFailingTest);
}

function emptyBaseline(reason: string): TestBaselineReport {
  return {
    ran: false,
    comparable: false,
    reason,
    preExisting: [],
    regressions: [],
    introduced: [],
    fixed: [],
  };
}
