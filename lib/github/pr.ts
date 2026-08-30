/**
 * Composing and opening the pull request (A6.4, A7.1, A10.5).
 *
 * This body is a product surface, not a log dump. Three audiences read it and
 * all three have to be served by the same text:
 *
 *  - the maintainer, who did not ask for this change and needs to know in ten
 *    seconds whether it is safe;
 *  - Qodo, which reviews it automatically (A10.5) and does better work when the
 *    intent of each change is stated rather than inferred from a diff;
 *  - the person who has to justify the accessibility work to someone else, and
 *    needs the success criterion numbers, the evidence and the verification in
 *    one place they can link to.
 *
 * So: what was wrong, what changed, what proves it still works, and what is
 * still uncertain. In that order, with a criterion number against every claim,
 * and with the uncertainty stated rather than buried.
 */

import { getCriterion } from '@/lib/db/criteria';
import {
  assertApproved,
  fileDigests,
  type ApprovalOperation,
  type ApprovalRequest,
  type GateDecision,
} from '@/lib/fix/gate';
import type { ExcludedFinding, FixableFinding } from '@/lib/fix/group';
import type { FilePatch } from '@/lib/fix/patch';
import { buildGate, type BuildResult } from '@/lib/verify/build';
import type { RecheckReport } from '@/lib/verify/recheck';
import { pullRequestGate, type TestRunResult } from '@/lib/verify/tests';
import {
  GitHubError,
  type CommitResult,
  type GitHubClient,
  type PullRequestResult,
  type RepoLike,
} from './client';

/* -------------------------------------------------------------------------- */
/* Input                                                                      */
/* -------------------------------------------------------------------------- */

export interface PullRequestComposition {
  readonly title: string;
  readonly body: string;
  readonly branch: string;
  readonly commitMessage: string;
  /** Every criterion the pull request claims to address, ascending. */
  readonly criteria: readonly string[];
}

export interface ComposePullRequestInput {
  readonly runId: string;
  readonly repoFullName: string;
  /** The deployed URL the findings were observed on. */
  readonly targetUrl?: string;
  readonly baseBranch: string;
  /** Override the generated branch name. */
  readonly branch?: string;
  readonly patches: readonly FilePatch[];
  /** Every finding the patches address, for the before evidence. */
  readonly findings: readonly FixableFinding[];
  readonly build: BuildResult;
  readonly tests: TestRunResult;
  readonly recheck: RecheckReport;
  /** FLAG findings a human still owns (A5.4). Named so nothing looks hidden. */
  readonly humanQueue?: readonly ExcludedFinding[];
  /** Link back to the run in AccessiFix. */
  readonly runUrl?: string;
}

/* -------------------------------------------------------------------------- */
/* Branch and commit                                                          */
/* -------------------------------------------------------------------------- */

/** `accessifix/a11y-3f2c1b` — namespaced so it is obvious where it came from. */
export function branchNameForRun(runId: string): string {
  const slug = runId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase() || 'run';
  return `accessifix/a11y-${slug}`;
}

export function commitMessageFor(
  criteria: readonly string[],
  patches: readonly FilePatch[],
): string {
  const subject = `fix(a11y): ${criteriaPhrase(criteria)} across ${countNoun(patches.length, 'file')}`;
  const body = patches
    .map((patch) => `- ${patch.filePath}: SC ${patch.criteria.join(', ')} — ${oneLine(patch.rationale, 160)}`)
    .join('\n');
  return `${truncate(subject, 72)}\n\n${body}\n`;
}

/* -------------------------------------------------------------------------- */
/* Title                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The title cites the criteria, because a maintainer scanning a list of pull
 * requests should be able to tell what standard this one is about without
 * opening it.
 */
export function composeTitle(
  criteria: readonly string[],
  patches: readonly FilePatch[],
  findingCount: number,
): string {
  const shown = criteria.slice(0, 4).map((id) => `SC ${id}`).join(', ');
  const more = criteria.length > 4 ? ` +${criteria.length - 4} more` : '';
  const scope = `${countNoun(patches.length, 'file')}, ${countNoun(findingCount, 'finding')}`;
  if (criteria.length === 0) return `Accessibility fixes (${scope})`;
  return `Accessibility: ${shown}${more} (${scope})`;
}

/* -------------------------------------------------------------------------- */
/* Body                                                                       */
/* -------------------------------------------------------------------------- */

export function composePullRequest(input: ComposePullRequestInput): PullRequestComposition {
  const criteria = collectCriteria(input.patches);
  const branch = input.branch ?? branchNameForRun(input.runId);
  const findingsById = new Map(input.findings.map((finding) => [finding.id, finding]));
  const outcomeById = new Map(input.recheck.outcomes.map((o) => [o.findingId, o]));

  const coveredFindings = input.patches.flatMap((patch) =>
    patch.findingIds.map((id) => findingsById.get(id)).filter((f): f is FixableFinding => Boolean(f)),
  );

  const title = composeTitle(criteria, input.patches, coveredFindings.length);

  const body = [
    lead(input, criteria, coveredFindings.length),
    whatChanged(input),
    criteriaSection(input, criteria, findingsById, outcomeById),
    verificationSection(input),
    notIncludedSection(input, outcomeById, findingsById),
    reviewSection(input),
    footer(input),
  ]
    .filter((section) => section.trim().length > 0)
    .join('\n\n');

  return {
    title,
    body,
    branch,
    commitMessage: commitMessageFor(criteria, input.patches),
    criteria,
  };
}

function lead(
  input: ComposePullRequestInput,
  criteria: readonly string[],
  findingCount: number,
): string {
  const target = input.targetUrl ? ` on ${input.targetUrl}` : '';
  const tests = pullRequestGate(input.tests);
  const build = buildGate(input.build);

  const opening =
    `This pull request fixes ${countNoun(findingCount, 'accessibility finding')} against ` +
    `${countNoun(criteria.length, 'WCAG 2.2 Level A/AA success criterion', 'WCAG 2.2 Level A/AA success criteria')}, ` +
    `found by auditing the deployed application${target}.`;

  // Each half says what actually happened. "The patched tree builds" is a claim
  // about a compiler having run, and a repository with no build script never ran
  // one — saying so is the difference between evidence and a formality.
  const buildSentence = build.unproven
    ? 'This repository defines no build script, so nothing was compiled — the dependencies ' +
      'install and that is all that was proven.'
    : 'The patched tree builds.';
  const testSentence = tests.unproven
    ? input.tests.command
      ? `Its test runner was invoked and found no tests (\`${input.tests.command}\`), so the ` +
        'suite proved nothing either. That is stated here rather than presented as a pass.'
      : 'This repository has no unit test suite, so nothing else ran — which is stated here ' +
        'rather than presented as a pass.'
    : /*
       * VERIFY's own sentence, when it wrote one.
       *
       * `testsPassed` is baseline-aware: it means "no test this change touched
       * regressed", not "every test is green". Clearway's suite is red on main,
       * and this body used to answer that with "This repository's own test
       * suite still passes" — a claim a reviewer disproves by running it once,
       * in the one document whose whole purpose is to be believed.
       *
       * `tests.summary` is what the verifier concluded, having run the suite
       * over the base tree first and compared it test by test. It says the
       * suite is red and says the red is not ours.
       */
      input.tests.summary.trim().length > 0
      ? input.tests.summary.trim()
      : "This repository's own test suite still passes.";

  const verified = [
    `${buildSentence} ${testSentence}`,
    input.recheck.outcomes.length > 0
      ? `Each fixed criterion was then re-checked against the patched build: ${input.recheck.summary}`
      : '',
  ]
    .filter((sentence) => sentence.length > 0)
    .join(' ');

  const provenance =
    'It was written by AccessiFix, an accessibility code-review agent, and opened with the ' +
    'GitHub token of the person who ran it. **It changes source, not configuration, and it ' +
    'merges nothing.** Review it exactly as you would a pull request from a colleague who is ' +
    'confident about accessibility and unfamiliar with your codebase.';

  return [opening, verified, provenance].join('\n\n');
}

function whatChanged(input: ComposePullRequestInput): string {
  const rows = input.patches.map((patch) => {
    const criteria = patch.criteria.map((id) => `\`${id}\``).join(', ');
    return `| \`${patch.filePath}\` | ${criteria} | +${patch.stats.linesAdded} / −${patch.stats.linesRemoved} | ${oneLine(patch.rationale, 200)} |`;
  });

  return [
    '## What changed',
    '',
    '| File | Success criteria | Lines | Why |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    'One patch per file, covering every finding in that file (A5.2). A component with three ' +
      'problems is one change, not three.',
  ].join('\n');
}

/**
 * The section that earns the pull request. Per criterion: the standard's own
 * words, what was actually observed, what the diff does about it, and what the
 * re-check saw afterwards.
 */
function criteriaSection(
  input: ComposePullRequestInput,
  criteria: readonly string[],
  findingsById: ReadonlyMap<string, FixableFinding>,
  outcomeById: ReadonlyMap<string, RecheckReport['outcomes'][number]>,
): string {
  if (criteria.length === 0) return '';

  // A patch covering three criteria would otherwise reprint the same diff three
  // times. Show it under the first criterion and point at it from the rest.
  const snippetShownFor = new Map<string, string>();

  const sections = criteria.map((id) => {
    const record = getCriterion(id);
    const heading = record
      ? `### SC ${id} ${record.name} (Level ${record.level})`
      : `### SC ${id}`;

    const patches = input.patches.filter((patch) => patch.criteria.includes(id));
    const findings = patches
      .flatMap((patch) => patch.findingIds)
      .map((findingId) => findingsById.get(findingId))
      .filter((f): f is FixableFinding => Boolean(f) && f?.criterion === id);

    const lines: string[] = [heading, ''];
    if (record) lines.push(`> ${record.plainEnglish}.`, '');

    if (findings.length > 0) {
      lines.push('**Before**', '');
      for (const finding of findings) {
        const where = finding.pageUrl ? ` — ${finding.pageUrl}` : '';
        const selector = finding.selector ? ` \`${finding.selector}\`` : '';
        lines.push(`- ${finding.summary}${selector}${where}`);
        if (finding.detail) lines.push(`  <br>${oneLine(finding.detail, 500)}`);
      }
      lines.push('');
    }

    lines.push('**After**', '');
    for (const patch of patches) {
      lines.push(`- \`${patch.filePath}\` — ${patch.rationale}`);
      if (patch.risk) lines.push(`  <br>_Risk noted by the agent: ${oneLine(patch.risk, 300)}_`);

      const alreadyShown = snippetShownFor.get(patch.filePath);
      if (alreadyShown) {
        lines.push(`  <br>The diff is shown under SC ${alreadyShown}.`);
        continue;
      }
      const snippet = evidenceSnippet(patch.diff);
      if (snippet) {
        snippetShownFor.set(patch.filePath, id);
        lines.push('', snippet);
      }
    }

    const outcomes = findings
      .map((finding) => outcomeById.get(finding.id))
      .filter((o): o is RecheckReport['outcomes'][number] => Boolean(o));

    if (outcomes.length > 0) {
      lines.push('', '**Verified**', '');
      for (const outcome of outcomes) {
        const mark = outcome.resolved ? '✅' : outcome.inconclusive ? '⚠️' : '❌';
        lines.push(`- ${mark} ${outcome.note} _(${methodLabel(outcome.method)})_`);
      }
    }

    return lines.join('\n');
  });

  return ['## Criteria fixed', ...sections].join('\n\n');
}

function verificationSection(input: ComposePullRequestInput): string {
  const gate = pullRequestGate(input.tests);
  const build = buildGate(input.build);
  const lines = [
    '## Verification',
    '',
    '| Check | Result |',
    '| --- | --- |',
    `| Build (4 CPU / 8 GB sandbox) | ${
      !input.build.ok ? '❌ failed' : build.unproven ? '➖ nothing to build' : '✅ passed'
    } — ${oneLine(input.build.summary, 220)} |`,
    `| Target's own test suite | ${
      input.tests.skipped ? '➖ nothing ran' : input.tests.ok ? '✅ passed' : '❌ failed'
    } — ${oneLine(input.tests.summary, 220)} |`,
    `| Criterion re-check | ${
      input.recheck.unresolvedFindingIds.length === 0 ? '✅' : '⚠️'
    } ${oneLine(input.recheck.summary, 220)} |`,
    '',
  ];

  if (input.tests.command) {
    lines.push(
      `The test command was detected from this repository's \`package.json\`, not imposed: ` +
        `\`${input.tests.command}\`. ${input.tests.detection.reason}`,
      '',
    );
  }

  if (input.tests.detection.e2eScript) {
    lines.push(
      `An end-to-end suite exists (\`${input.tests.detection.e2eScript}\`) and was **not** run — ` +
        'it needs a served application, which is a different gate from this one.',
      '',
    );
  }

  if (gate.unproven || build.unproven) {
    const standing = build.unproven
      ? 'Neither a compiler nor a test suite'
      : 'Nothing but the build';
    lines.push(
      `> **Read this before merging.** ${standing} stands behind these changes in this ` +
        'repository. Give the diff the attention you would give an unverified change.',
      '',
    );
  }

  if (!input.build.installReproducible) {
    lines.push(
      '> Dependencies were installed with `npm install` rather than `npm ci`: this repository’s ' +
        'lockfile has drifted from its `package.json`, so the tree that built is not the tree ' +
        'the lockfile pins. That is a pre-existing condition, not something this diff changed.',
      '',
    );
  }

  if (input.build.oomKilled) {
    lines.push(
      '> The build sandbox ran out of memory during an earlier attempt. That is a sandbox size ' +
        'problem, not a problem with this diff.',
      '',
    );
  }

  return lines.join('\n');
}

function notIncludedSection(
  input: ComposePullRequestInput,
  outcomeById: ReadonlyMap<string, RecheckReport['outcomes'][number]>,
  findingsById: ReadonlyMap<string, FixableFinding>,
): string {
  const unresolved = [
    ...input.recheck.unresolvedFindingIds,
    ...input.recheck.inconclusiveFindingIds,
  ]
    .map((id) => ({ finding: findingsById.get(id), outcome: outcomeById.get(id) }))
    .filter((entry) => entry.finding && entry.outcome);

  const flagged = input.humanQueue ?? [];
  if (unresolved.length === 0 && flagged.length === 0) return '';

  const lines = ['## Not settled by this pull request', ''];

  if (unresolved.length > 0) {
    lines.push(
      'These were patched but the re-check could not confirm them. They are listed rather than ' +
        'quietly counted as fixed.',
      '',
    );
    for (const entry of unresolved) {
      lines.push(`- **SC ${entry.finding!.criterion}** — ${entry.outcome!.note}`);
    }
    lines.push('');
  }

  if (flagged.length > 0) {
    lines.push(
      'These findings were never auto-fixed. They need a judgement about intent, tone or ' +
        'business context that an agent should not make on your behalf.',
      '',
    );
    for (const item of flagged.slice(0, 20)) {
      lines.push(
        `- **SC ${item.finding.criterion}** — ${item.finding.summary} <br>${item.explanation}`,
      );
    }
    if (flagged.length > 20) lines.push(`- …and ${flagged.length - 20} more.`);
    lines.push('');
  }

  return lines.join('\n');
}

function reviewSection(input: ComposePullRequestInput): string {
  const steps = [
    '1. **Check the semantics, not just the attributes.** The change should use the element that ' +
      'already carries the meaning — a `<button>` rather than a `<div role="button">`. If you see ' +
      'ARIA added on top of a native element that already had the semantics, that is a defect and ' +
      'it should be rejected.',
    '2. **Check that state is bound, not written.** Any `aria-expanded`, `aria-checked`, ' +
      '`aria-selected` or `aria-pressed` in the diff should read from the same variable that drives ' +
      'the visible state. A hardcoded value is the exact bug this tool exists to find.',
    '3. **Try the keyboard.** Tab to each changed control, then Enter, Space and Escape. Everything ' +
      'interactive should answer all four, and focus should return to the trigger when something ' +
      'closes.',
    '4. **Check nothing unrelated moved.** These patches are meant to change only what the findings ' +
      'required. Formatting churn, renames or dependency changes are not intended and are worth ' +
      'questioning.',
  ];

  const paragraphs = ['## How to review this', steps.join('\n')];
  if (input.runUrl) {
    paragraphs.push(
      `The full run, including the accessibility tree before and after each interaction, is at ${input.runUrl}.`,
    );
  }
  return paragraphs.join('\n\n');
}

function footer(input: ComposePullRequestInput): string {
  return [
    '---',
    '',
    'AccessiFix reports findings against numbered WCAG 2.2 success criteria. **It does not claim ' +
      'a conformance level** — no certifying body has assessed this application, and a passing ' +
      'automated audit is not a conformance statement.',
    '',
    `Run \`${input.runId}\`${input.build.commitSha ? ` · built at \`${input.build.commitSha.slice(0, 7)}\`` : ''}.`,
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Opening it (A6.4 + A7.1)                                                   */
/* -------------------------------------------------------------------------- */

export interface OpenVerifiedPullRequestInput extends ComposePullRequestInput {
  readonly repo: RepoLike;
  /**
   * The commit already pushed to the head branch. Required: the build and the
   * test suite were run against local patched files, and this is the only thing
   * tying that evidence to what is actually on GitHub. Without it a pull request
   * could be opened from a stale or unrelated branch tip while the body claims
   * a verification that was performed on something else.
   */
  readonly commit: CommitResult;
  readonly draft?: boolean;
  readonly reviewers?: readonly string[];
  readonly labels?: readonly string[];
}

export interface OpenedPullRequest {
  readonly pullRequest: PullRequestResult;
  readonly composition: PullRequestComposition;
}

/**
 * The only sanctioned path to `GitHubClient.openPullRequest`.
 *
 * Five gates, in order, and every one of them is a hard stop:
 *
 *  1. A6.4 — the target's own test suite must not have failed.
 *  2. A6.1 — the patched tree must have built. A repository with no build script
 *     is allowed through as unproven, but not alongside an unproven suite: if
 *     nothing compiled *and* nothing tested, no evidence exists and the run has
 *     nothing to stand a pull request on.
 *  3. The commit under review must be the one that was verified — same branch,
 *     same files.
 *  4. A7.1 — a human must have approved this exact operation, compared field by
 *     field rather than by request id.
 *  5. The remote head must still be at that commit at the moment of writing.
 *
 * The approval is checked late on purpose: nobody should be asked to approve a
 * pull request that the run had already disqualified. The remote head check is
 * checked later still, immediately before the create call, so nothing can move
 * the branch between the check and the write.
 */
export async function openVerifiedPullRequest(
  client: GitHubClient,
  input: OpenVerifiedPullRequestInput,
  approval: ApprovalRequest,
  decision: GateDecision | null | undefined,
): Promise<OpenedPullRequest> {
  const tests = pullRequestGate(input.tests);
  if (!tests.allowed) {
    throw new GitHubError('openVerifiedPullRequest', tests.reason, undefined);
  }

  const build = buildGate(input.build);
  if (!build.allowed) {
    throw new GitHubError(
      'openVerifiedPullRequest',
      `${build.reason} No pull request is opened.`,
    );
  }
  if (build.unproven && tests.unproven) {
    throw new GitHubError(
      'openVerifiedPullRequest',
      'Nothing verified this patch: this repository defines neither a build script nor a unit ' +
        'test suite, so no pull request is opened. ' +
        `${build.reason} ${tests.reason}`,
    );
  }

  if (approval.action !== 'open-pull-request') {
    throw new GitHubError(
      'openVerifiedPullRequest',
      `The approval on hand is for "${approval.action}", not for opening a pull request.`,
    );
  }

  const composition = composePullRequest(input);

  // The build and the tests ran over local files. This is where that evidence is
  // tied to the bytes on GitHub: same branch, and the same file set the patches
  // describe.
  if (input.commit.branch !== composition.branch) {
    throw new GitHubError(
      'openVerifiedPullRequest',
      `The verified commit is on "${input.commit.branch}", but the pull request would be ` +
        `opened from "${composition.branch}".`,
    );
  }
  const committed = [...input.commit.files].sort();
  const patched = input.patches.map((patch) => patch.filePath).sort();
  if (
    committed.length !== patched.length ||
    committed.some((path, index) => path !== patched[index])
  ) {
    throw new GitHubError(
      'openVerifiedPullRequest',
      `The commit on "${composition.branch}" carries ${committed.length} file(s), but this ` +
        `pull request describes ${patched.length}. It is not the change that was verified.`,
    );
  }

  const operation: ApprovalOperation = {
    action: 'open-pull-request',
    repoFullName: input.repoFullName,
    branch: composition.branch,
    base: input.baseBranch,
    title: composition.title,
    files: fileDigests(
      input.patches.map((patch) => ({ path: patch.filePath, contents: patch.newContents })),
    ),
    commitSha: input.commit.commitSha,
  };

  // A7.1. Throws ApprovalRequiredError when there is no explicit yes, and when
  // the yes on hand was given for some other repository, branch, title, commit
  // or set of bytes.
  assertApproved(approval, decision, operation);

  const head = await client.getBranchSha(input.repo, composition.branch);
  if (head !== input.commit.commitSha) {
    throw new GitHubError(
      'openVerifiedPullRequest',
      `\`${composition.branch}\` is at ${head ?? 'no commit'}, not at the verified commit ` +
        `${input.commit.commitSha}. Something moved the branch after it was checked, so the ` +
        'pull request would not be the change that passed.',
    );
  }

  const pullRequest = await client.openPullRequest(
    input.repo,
    {
      head: composition.branch,
      base: input.baseBranch,
      title: composition.title,
      body: composition.body,
      draft: input.draft ?? false,
      ...(input.reviewers ? { reviewers: input.reviewers } : {}),
      ...(input.labels ? { labels: input.labels } : { labels: ['accessibility'] }),
    },
    { approval, decision },
  );

  return { pullRequest, composition };
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

function criteriaPhrase(criteria: readonly string[]): string {
  if (criteria.length === 0) return 'accessibility defects';
  if (criteria.length <= 3) return `WCAG ${criteria.join(', ')}`;
  return `WCAG ${criteria.slice(0, 3).join(', ')} +${criteria.length - 3}`;
}

/**
 * A few changed lines from the diff, for the before/after in the body.
 *
 * Only the first hunk, and only a handful of lines: the full diff is one click
 * away in the Files tab, and a body that reprints it buries the reasoning.
 */
function evidenceSnippet(diff: string, maxLines = 10): string | null {
  const lines = diff.split('\n');
  const start = lines.findIndex((line) => line.startsWith('@@'));
  if (start === -1) return null;

  const kept: string[] = [];
  for (let i = start + 1; i < lines.length && kept.length < maxLines; i += 1) {
    const line = lines[i]!;
    // A blank entry is the trailing newline of the diff, not a context line —
    // every real context line in a unified diff starts with a space.
    if (line === '' || line.startsWith('@@')) break;
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+') || line.startsWith('-') || kept.length > 0) kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1]!.startsWith(' ')) kept.pop();
  if (kept.length === 0) return null;
  return ['```diff', ...kept, '```'].join('\n');
}

function methodLabel(method: RecheckReport['outcomes'][number]['method']): string {
  switch (method) {
    case 'path':
      return 'accessibility tree diffed across the interaction';
    case 'axe':
      return 'deterministic rule engine on the patched page';
    case 'source':
      return 'judged from the diff — no running build was reachable';
    default:
      return 'not re-checked';
  }
}

function countNoun(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

function oneLine(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
