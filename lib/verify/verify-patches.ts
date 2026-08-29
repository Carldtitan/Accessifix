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
 * - A **failing** suite rejects the patches. That is A6.4 and it is absolute.
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
import { materializePatches } from '@/lib/fix/source';
import type { FixableFinding } from '@/lib/fix/group';

import { withBuildWorkspace, buildGate } from './build';
import { runTargetTests, pullRequestGate } from './tests';
import { recheckFixedCriteria } from './recheck';

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

export interface VerifyPatchesResult {
  buildPassed: boolean;
  /**
   * False when no build script ran. `buildPassed` cannot carry this on its own:
   * a repository with no build script fails nothing and compiles nothing, and
   * the two have to stay distinguishable all the way to the approval card.
   */
  buildRan: boolean;
  testsPassed: boolean;
  /** False when no suite ran, or one ran and found nothing. Unproven, not a pass. */
  testsRan: boolean;
  testCommand: string;
  testSummary: string;
  recheck: readonly { criterion: string; resolved: boolean; note: string }[];
  recommendation: 'open-pull-request' | 'reject-patches';
  sessionId?: string | null;
  previewUrl?: string | null;
}

export async function verifyPatches(input: VerifyPatchesInput): Promise<VerifyPatchesResult> {
  const failure = (reason: string): VerifyPatchesResult => ({
    buildPassed: false,
    buildRan: false,
    testsPassed: false,
    testsRan: false,
    testCommand: '',
    testSummary: reason,
    recheck: [],
    recommendation: 'reject-patches',
    previewUrl: null,
  });

  // The sandbox is written whole files, not diffs, so the stored diffs are
  // turned back into bytes first — and refused if they no longer reproduce.
  // Verifying a tree assembled from a patch that does not apply would report on
  // a change nobody wrote.
  const materialized = await materializePatches({
    repoFullName: input.repoFullName,
    accessToken: input.accessToken,
    patches: input.patches,
    ...(input.ref === undefined ? {} : { ref: input.ref }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  if (materialized.patches.length === 0) {
    return failure(
      'None of the proposed patches could be applied to the current state of ' +
        `${input.repoFullName}, so there was nothing to verify. ` +
        materialized.failures.map((f) => `${f.filePath}: ${f.reason}`).join('; '),
    );
  }

  try {
    return await withBuildWorkspace(
      {
        repoFullName: input.repoFullName,
        token: input.accessToken,
        files: materialized.patches.map((patch) => ({
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

        // Same sandbox, same patched tree: A6.1, A6.2 and A6.3 all judge one
        // build rather than three provisioned separately.
        const tests = await runTargetTests(workspace.sandbox, workspace.repoDir);

        const buildVerdict = buildGate(build);
        const testVerdict = pullRequestGate(tests);

        // Nothing failed, and nothing was demonstrated either. That is not a
        // shrug; it is the state with no evidence in it, and it is a rejection.
        const nothingProven = buildVerdict.unproven && testVerdict.unproven;

        // Nothing serves the patched build, so the re-check reads the diff
        // against each finding rather than re-driving the page. `recheck.ts`
        // labels that as the weakest method wherever it is shown.
        const report = await recheckFixedCriteria({
          findings: input.findings ?? [],
          patches: materialized.patches,
          repoFullName: input.repoFullName,
        }).catch(() => null);

        const recommendation: VerifyPatchesResult['recommendation'] =
          buildVerdict.allowed && testVerdict.allowed && !nothingProven
            ? 'open-pull-request'
            : 'reject-patches';

        const failedToApply = materialized.failures.map(
          (f) => ` ${f.filePath} was left out: ${f.reason}.`,
        );

        return {
          buildPassed: build.ok && build.buildRan,
          buildRan: build.buildRan,
          testsPassed: tests.ok && !tests.skipped,
          testsRan: !tests.skipped,
          testCommand: tests.command ?? '',
          testSummary: nothingProven
            ? 'Neither the build nor a test suite could be run, so nothing about this ' +
              'patch has been demonstrated. Refusing to open a pull request on no evidence.'
            : `${buildVerdict.reason} ${testVerdict.reason}${failedToApply.join('')}`,
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
