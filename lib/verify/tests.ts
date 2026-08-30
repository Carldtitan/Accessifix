/**
 * Running the target's own test suite (A6.2, A6.4).
 *
 * The point of this module is one sentence in the requirements: *when the test
 * suite fails, the run shall not open a pull request*. That is the promise that
 * makes an accessibility agent safe to point at someone's repository. It is not
 * a checklist item — it is the difference between a tool that fixes a site and
 * a tool that breaks one to satisfy a rule.
 *
 * What that sentence protects is the repository's tests *as they were*. A suite
 * that was already red before anything was touched proves nothing about the
 * patch, and blocking on it refuses every fix on every repository with one
 * broken test — which is what happened on the reference target. So the suite is
 * run twice, on the base tree and on the patched tree, and `pullRequestGate`
 * decides on the comparison in `./baseline`: a failure that was already there
 * is reported, a failure that was not is absolute.
 *
 * The suite is the target's, not ours. We detect what the repository already
 * runs and we run exactly that: `test`, then `test:unit`, then `vitest`. For
 * the reference target that resolves to `npm test` (vitest); its Playwright
 * suite under `test:e2e` is reported but not run, because an end-to-end suite
 * needs a served application and is a different gate.
 */

import { downloadFile, runCommand, shellQuote, type Sandbox } from '@/lib/sandbox/daytona';
import { readPackageJson } from './build';
import {
  describeComparison,
  extractFailedFromText,
  looksLikeTestOutput,
  nameList,
  parseJsonTestReport,
  type BaselineComparison,
  type CaseSource,
  type TestCaseResult,
  type TestTotals,
} from './baseline';

/* -------------------------------------------------------------------------- */
/* Detection                                                                  */
/* -------------------------------------------------------------------------- */

export type TestFramework =
  | 'vitest'
  | 'jest'
  | 'playwright'
  | 'cypress'
  | 'testcafe'
  | 'nightwatch'
  | 'webdriverio'
  | 'mocha'
  | 'ava'
  | 'node'
  | 'unknown'
  | 'none';

export type DetectionSource =
  | 'script:test'
  | 'script:test:unit'
  | 'script:vitest'
  | 'devDependency'
  | 'none';

export interface TestDetection {
  /** The npm script to run, e.g. `test`. Null when there is no suite. */
  readonly script: string | null;
  /** The shell command that will actually be executed. Null when there is none. */
  readonly command: string | null;
  readonly framework: TestFramework;
  readonly source: DetectionSource;
  /** The raw script body, for the log and the pull-request body. */
  readonly scriptBody: string | null;
  /** An end-to-end suite that exists but is not this gate. Reported, not run. */
  readonly e2eScript: string | null;
  /** Why detection landed where it did, in a sentence. */
  readonly reason: string;
}

export interface PackageJsonLike {
  readonly scripts?: Readonly<Record<string, string>> | undefined;
  readonly devDependencies?: Readonly<Record<string, string>> | undefined;
  readonly dependencies?: Readonly<Record<string, string>> | undefined;
}

/** npm's own placeholder. A repository with this has no suite, not a failing one. */
const NO_TEST_PLACEHOLDER = /no test specified/i;

/** Order is the requirement's: `test`, then `test:unit`, then `vitest`. */
const SCRIPT_PREFERENCE: ReadonlyArray<{ script: string; source: DetectionSource }> = [
  { script: 'test', source: 'script:test' },
  { script: 'test:unit', source: 'script:test:unit' },
  { script: 'vitest', source: 'script:vitest' },
];

const E2E_SCRIPTS = [
  'test:e2e',
  'e2e',
  'test:playwright',
  'playwright',
  'test:cypress',
  'cypress',
  'cy:run',
] as const;

/**
 * Runners that drive a real browser against a served application.
 *
 * Not one of them can run in this gate, because nothing here serves the target.
 * They fail on the environment, and A6.4 turns a failing suite into a stop — so
 * misreading one of these as a unit suite rejects a good patch for a reason that
 * has nothing to do with the patch. Which runner it is makes no difference to
 * that, so the whole family is reported and skipped, whatever the script holding
 * it happens to be called.
 */
const E2E_FRAMEWORKS: ReadonlySet<TestFramework> = new Set<TestFramework>([
  'playwright',
  'cypress',
  'testcafe',
  'nightwatch',
  'webdriverio',
]);

/** True when this runner needs a served application, and so is a different gate. */
function isE2eFramework(framework: TestFramework): boolean {
  return E2E_FRAMEWORKS.has(framework);
}

/** The runner's name as it reads in a sentence on the approval card. */
const E2E_FRAMEWORK_LABELS: Readonly<Record<string, string>> = {
  playwright: 'Playwright',
  cypress: 'Cypress',
  testcafe: 'TestCafe',
  nightwatch: 'Nightwatch',
  webdriverio: 'WebdriverIO',
};

function e2eLabel(framework: TestFramework): string {
  return E2E_FRAMEWORK_LABELS[framework] ?? 'browser-based';
}

/**
 * Work out how this repository runs its tests.
 *
 * A repository with no suite is not a failure. It is a fact a human needs at
 * the approval gate — "nothing verified this patch except the build" is a
 * different decision from "the tests passed" — so it comes back as
 * `framework: 'none'` with a reason, and `blocksPullRequest` leaves the call
 * to the human rather than inventing a pass.
 */
export function detectTestCommand(pkg: PackageJsonLike | null | undefined): TestDetection {
  const scripts = pkg?.scripts ?? {};
  const namedE2e = E2E_SCRIPTS.find((name) => typeof scripts[name] === 'string') ?? null;

  // A `test` script that turns out to be an end-to-end runner is a browser suite
  // that happens to be called `test`. Running it here would launch a browser
  // against an application nothing has served, and reject a good patch on a
  // failure that is about the environment. Which runner it is changes nothing:
  // Playwright, Cypress and the rest are all reported as e2e, and the search for
  // a unit suite carries on to `test:unit` and `vitest`.
  let e2eFromScript: {
    readonly script: string;
    readonly framework: TestFramework;
    readonly via: string | null;
  } | null = null;

  for (const { script, source } of SCRIPT_PREFERENCE) {
    const body = scripts[script];
    if (typeof body !== 'string' || body.trim().length === 0) continue;
    if (script === 'test' && NO_TEST_PLACEHOLDER.test(body)) continue;

    const { framework, via } = resolveFramework(body, scripts);
    if (isE2eFramework(framework)) {
      e2eFromScript ??= { script, framework, via };
      continue;
    }

    return {
      script,
      // The framework is resolved through delegation, but the command is built
      // from the body itself: `-- --run` is belt and braces for a script that is
      // bare `vitest`, and forwarding it through a wrapper would hand the flag
      // to npm rather than to the runner.
      command: buildCommand(script, frameworkOf(body)),
      framework,
      source,
      scriptBody: body,
      e2eScript: namedE2e ?? e2eFromScript?.via ?? e2eFromScript?.script ?? null,
      reason:
        `The repository defines \`npm run ${script}\` as \`${body}\`, so that is what ran.` +
        (e2eFromScript
          ? ` Its \`${e2eFromScript.via ?? e2eFromScript.script}\` script is ` +
            `${e2eLabel(e2eFromScript.framework)}` +
            (e2eFromScript.via ? ` — reached from \`${e2eFromScript.script}\` —` : '') +
            ' and was left alone: an end-to-end suite needs a served application and is a ' +
            'different gate.'
          : ''),
    };
  }

  // No script, but the runner is installed. Common in repositories that rely on
  // an IDE integration or a CI-only invocation.
  //
  // `--passWithNoTests` stays: without it a repository that has vitest installed
  // and no test files exits non-zero, and a *missing* suite would block the pull
  // request as though it had failed. The zero-test case is separated afterwards,
  // from the runner's own output, and reported as unproven rather than as a pass.
  const deps = { ...(pkg?.devDependencies ?? {}), ...(pkg?.dependencies ?? {}) };
  const e2eScript = namedE2e ?? e2eFromScript?.via ?? e2eFromScript?.script ?? null;

  if (typeof deps['vitest'] === 'string') {
    return {
      script: null,
      command: 'CI=true npx vitest run --passWithNoTests',
      framework: 'vitest',
      source: 'devDependency',
      scriptBody: null,
      e2eScript,
      reason:
        'No test script is defined, but vitest is a dependency, so it was invoked directly.',
    };
  }
  if (typeof deps['jest'] === 'string') {
    return {
      script: null,
      command: 'CI=true npx jest --ci --passWithNoTests',
      framework: 'jest',
      source: 'devDependency',
      scriptBody: null,
      e2eScript,
      reason: 'No test script is defined, but jest is a dependency, so it was invoked directly.',
    };
  }

  return {
    script: null,
    command: null,
    framework: 'none',
    source: 'none',
    scriptBody: null,
    e2eScript,
    reason: e2eFromScript
      ? `This repository's \`${e2eFromScript.via ?? e2eFromScript.script}\` script is a ` +
        `${e2eLabel(e2eFromScript.framework)} end-to-end suite, which needs a served ` +
        'application and is a different gate. It defines no unit test suite, so nothing ran ' +
        'here. The patch is backed by the build and the criterion re-check only.'
      : 'This repository defines no unit test suite, so there was nothing to run. The patch is ' +
        'backed by the build and the criterion re-check only.',
  };
}

/**
 * Output that says the runner started, found nothing, and exited zero anyway.
 *
 * `--passWithNoTests` keeps an empty suite from looking like a failure; this
 * keeps it from looking like a pass. A6.4 draws the line between "the suite
 * passed" and "there was no suite", and an exit code cannot tell them apart.
 */
const NO_TESTS_PATTERNS: readonly RegExp[] = [
  /No test files found/i,
  /No tests? found/i,
  /No test suites? found/i,
  /\bTests:\s+0 total\b/i,
  /\bTest Files\s+no tests\b/i,
  /\bno tests\b[^\n]*\bexiting with code 0\b/i,
];

/** True when a zero-exit run in fact executed no tests at all. */
export function ranZeroTests(output: string): boolean {
  return NO_TESTS_PATTERNS.some((pattern) => pattern.test(output));
}

function frameworkOf(body: string): TestFramework {
  const text = body.toLowerCase();
  if (/\bvitest\b/.test(text)) return 'vitest';
  if (/\bjest\b/.test(text)) return 'jest';
  if (/\bplaywright\b/.test(text)) return 'playwright';
  if (/\bcypress\b|\bcy:(?:run|open)\b/.test(text)) return 'cypress';
  if (/\btestcafe\b/.test(text)) return 'testcafe';
  if (/\bnightwatch\b/.test(text)) return 'nightwatch';
  if (/\bwdio\b|\bwebdriverio\b/.test(text)) return 'webdriverio';
  if (/\bmocha\b/.test(text)) return 'mocha';
  if (/\bava\b/.test(text)) return 'ava';
  if (/node\s+--test|node:test/.test(text)) return 'node';
  return 'unknown';
}

/**
 * The npm scripts a script body hands off to.
 *
 * `"test": "npm run test:e2e"` is the conventional way to give a browser suite
 * the default name, and its body names no runner at all — so classifying the
 * literal text returns `unknown`, the suite runs here against an application
 * nothing served, and a good patch is rejected for a failure that is purely
 * about the environment.
 *
 * Only explicit delegation forms count, and only names the package actually
 * defines are followed, so a script that merely contains a matching word is
 * never mistaken for a reference to one.
 */
function referencedScripts(body: string): string[] {
  const names: string[] = [];
  const add = (name: string | undefined): void => {
    if (name && !names.includes(name)) names.push(name);
  };

  for (const match of body.matchAll(
    /(?:^|[\s;&|(])(?:npm|pnpm|bun)\s+(?:run|run-script)\s+(?:--\s+)?([\w:.-]+)/g,
  )) {
    add(match[1]);
  }
  for (const match of body.matchAll(/(?:^|[\s;&|(])yarn\s+(?:run\s+)?([\w:.-]+)/g)) {
    add(match[1]);
  }
  // `npm-run-all`, `run-s`, `run-p`: every non-flag token is a script name.
  for (const match of body.matchAll(
    /(?:^|[\s;&|(])(?:npm-run-all|run-s|run-p)\s+([^;&|]*)/g,
  )) {
    for (const token of (match[1] ?? '').split(/\s+/)) {
      if (token.length > 0 && !token.startsWith('-')) add(token);
    }
  }

  return names;
}

/** Chains deeper than this are pathological; stop rather than walk forever. */
const MAX_DELEGATION_DEPTH = 4;

/**
 * Classify a script by what it ultimately runs, not by the text of its body.
 *
 * An end-to-end runner anywhere in the chain classifies the whole script,
 * because the script runs all of it: `"test": "npm run test:unit && npm run
 * test:e2e"` still launches a browser, so it still is not this gate's suite and
 * the search carries on to `test:unit` and `vitest`.
 *
 * `via` names the script the classification actually came from, so the reason
 * can say which suite was left alone rather than pointing at the wrapper.
 */
function resolveFramework(
  body: string,
  scripts: Readonly<Record<string, string>>,
  seen: ReadonlySet<string> = new Set<string>(),
): { readonly framework: TestFramework; readonly via: string | null } {
  const direct = frameworkOf(body);
  if (isE2eFramework(direct)) return { framework: direct, via: null };
  if (seen.size >= MAX_DELEGATION_DEPTH) return { framework: direct, via: null };

  let resolved: { readonly framework: TestFramework; readonly via: string | null } = {
    framework: direct,
    via: null,
  };

  for (const name of referencedScripts(body)) {
    if (seen.has(name)) continue;
    const nested = scripts[name];
    if (typeof nested !== 'string' || nested.trim().length === 0) continue;

    const inner = resolveFramework(nested, scripts, new Set([...seen, name]));
    // An e2e runner settles it outright; anything else only fills in a body that
    // named no runner of its own.
    if (isE2eFramework(inner.framework)) {
      return { framework: inner.framework, via: inner.via ?? name };
    }
    if (resolved.framework === 'unknown' && inner.framework !== 'unknown') {
      resolved = { framework: inner.framework, via: inner.via ?? name };
    }
  }

  return resolved;
}

/**
 * `CI=true` is load-bearing, not decoration: vitest and jest both watch by
 * default outside CI, and a watching test runner in a sandbox is a command that
 * never returns. The extra `-- --run` for vitest is belt and braces for a bare
 * `vitest` script.
 */
function buildCommand(script: string, framework: TestFramework): string {
  const base = `CI=true npm run ${script} --silent`;
  return framework === 'vitest' ? `${base} -- --run` : base;
}

/* -------------------------------------------------------------------------- */
/* Running                                                                    */
/* -------------------------------------------------------------------------- */

export interface TestRunResult {
  /** True when the suite ran and passed, or when there is no suite to run. */
  readonly ok: boolean;
  /** Trimmed tail of the runner's output. The full log stays in the sandbox. */
  readonly output: string;
  readonly framework: TestFramework;
  /** The command executed, or null when nothing ran. */
  readonly command: string | null;
  readonly exitCode: number | null;
  /**
   * True when no test actually ran — either there was no suite to invoke, or the
   * runner was invoked and found nothing. `ok` is true alongside it, because
   * nothing failed, and nothing was proven either.
   */
  readonly skipped: boolean;
  readonly detection: TestDetection;
  readonly durationMs: number;
  /** One sentence for the pull-request body and the approval card. */
  readonly summary: string;
  /**
   * Per-test results, when the runner could be made to report them (A6.4).
   *
   * Optional because the field is new and other call sites build a
   * `TestRunResult` from flat evidence they never observed; an absent list is
   * "no per-test detail", never "no failures".
   */
  readonly cases?: readonly TestCaseResult[];
  /** Where `cases` came from. `none` means the run yielded no per-test detail. */
  readonly caseSource?: CaseSource;
  /** Totals as the runner reported them. Only from a JSON report. */
  readonly totals?: TestTotals | null;
}

export interface RunTestsOptions {
  /** Seconds allowed for the suite. Default 900. */
  readonly timeoutSec?: number;
  /** Extra environment for the run. `CI` is already set. */
  readonly env?: Readonly<Record<string, string>>;
  /** Override detection entirely, e.g. from a target's configuration. */
  readonly command?: string;
  /** Characters of output kept in the result. Default 12000. */
  readonly outputTail?: number;
  /**
   * Ask the runner for a machine-readable report, so the run can be compared
   * test by test against another. Default true; ignored for a runner that has
   * no such flag.
   */
  readonly report?: boolean;
  /** Absolute path in the sandbox for that report. Defaults per `label`. */
  readonly reportPath?: string;
  /** Distinguishes two runs' report files, e.g. `baseline` and `patched`. */
  readonly label?: string;
}

const DEFAULT_TEST_TIMEOUT_SEC = 900;
const DEFAULT_OUTPUT_TAIL = 12_000;

/**
 * Where a run's machine-readable report is written.
 *
 * Outside the clone on purpose: the baseline run and the patched run happen in
 * the same working tree, and dropping a file into it between them would mean
 * the two suites ran against trees that differ by more than the patch.
 */
const REPORT_DIR = '/tmp/accessifix-verify';

/**
 * Detect the suite and run it in the sandbox holding the patched build.
 *
 * The exit code is the verdict; the output is the evidence. Neither is
 * interpreted by a model — a test suite either passed or it did not, and that
 * is not a judgement call.
 */
export async function runTargetTests(
  sandbox: Sandbox,
  repoDir: string,
  options: RunTestsOptions = {},
): Promise<TestRunResult> {
  const pkg = await readPackageJson(sandbox, repoDir);
  const detection = detectTestCommand(pkg as PackageJsonLike | null);
  const command = options.command ?? detection.command;
  const started = Date.now();

  if (!command) {
    return {
      ok: true,
      output: '',
      framework: detection.framework,
      command: null,
      exitCode: null,
      skipped: true,
      detection,
      durationMs: 0,
      summary: detection.reason,
      cases: [],
      caseSource: 'none',
      totals: null,
    };
  }

  // A6.4 needs to know *which* tests failed, not just that some did, so the
  // runner is asked for a machine-readable report where it has one. The flags
  // are additive to the repository's own command — the suite that runs is still
  // the target's.
  const reportable = options.report !== false && supportsJsonReport(detection.framework);
  const reportPath = reportable
    ? (options.reportPath ?? `${REPORT_DIR}/${options.label ?? 'tests'}.json`)
    : null;

  const invocation = withEnv(
    reportPath === null
      ? command
      : withRunnerFlags(command, reportFlagsFor(detection.framework, reportPath)),
    options.env,
  );
  // `rm -f` first: a crashed run must not be read from the previous run's file.
  const shell =
    reportPath === null
      ? invocation
      : `mkdir -p ${shellQuote(REPORT_DIR)} && rm -f ${shellQuote(reportPath)} && ${invocation}`;

  let result = await runCommand(
    sandbox,
    shell,
    repoDir,
    options.timeoutSec ?? DEFAULT_TEST_TIMEOUT_SEC,
  );
  let report = reportPath === null ? null : await readTestReport(sandbox, reportPath, repoDir);

  // The reporter flags broke the invocation rather than the suite failing: no
  // report was written and the output never reached the point of reporting on
  // tests at all. Run exactly what the repository defines, so a good patch is
  // not rejected over a flag this module added.
  let reportFlagsRejected = false;
  if (
    reportPath !== null &&
    report === null &&
    result.exitCode !== 0 &&
    !looksLikeTestOutput(result.stdout)
  ) {
    reportFlagsRejected = true;
    result = await runCommand(
      sandbox,
      withEnv(command, options.env),
      repoDir,
      options.timeoutSec ?? DEFAULT_TEST_TIMEOUT_SEC,
    );
  }

  const durationMs = Date.now() - started;
  const rawOutput = result.stdout;
  const ok = result.exitCode === 0;

  const caseSource: CaseSource = report
    ? 'json'
    : looksLikeTestOutput(rawOutput)
      ? 'text'
      : 'none';
  const cases = report?.cases ?? (caseSource === 'text' ? extractFailedFromText(rawOutput, repoDir) : []);

  // With `--reporter=json` the runner prints nothing a human can read, so the
  // failing tests are rendered back out of the report. The full log stays in
  // the sandbox either way (A9.2).
  const output = tail(
    rawOutput.trim().length > 0 ? rawOutput : renderReport(cases),
    options.outputTail ?? DEFAULT_OUTPUT_TAIL,
  );

  // A runner that exited zero because it found nothing to run has proven
  // nothing. `skipped` puts it where an absent suite already sits — allowed,
  // unproven — instead of reporting an empty run as a passing one. The report's
  // own count answers this exactly when there is one; the text patterns are the
  // fallback for when there is not.
  const zeroTests = ok && (report ? report.totals.total === 0 : ranZeroTests(output));

  const failedNames = cases.filter((entry) => entry.status === 'failed');

  return {
    ok,
    output,
    framework: detection.framework,
    command,
    exitCode: result.exitCode,
    skipped: zeroTests,
    detection,
    durationMs,
    summary: zeroTests
      ? `\`${command}\` ran and found no tests, so nothing was verified by the suite.`
      : ok
        ? `\`${command}\` passed in ${(durationMs / 1000).toFixed(1)}s${
            detection.framework === 'none' ? '' : ` (${detection.framework})`
          }${report ? ` — ${report.totals.passed} of ${report.totals.total} tests passing` : ''}.`
        : `\`${command}\` failed with exit code ${result.exitCode}` +
          (failedNames.length > 0
            ? `: ${failedNames.length} failing test${failedNames.length === 1 ? '' : 's'}, ` +
              `${failedNames
                .slice(0, 3)
                .map((entry) => `\`${entry.id}\``)
                .join(', ')}${failedNames.length > 3 ? `, and ${failedNames.length - 3} more` : ''}.`
            : `. ${firstFailureLine(output) ?? 'See the attached log.'}`) +
          (reportFlagsRejected
            ? ' (Re-run without the JSON reporter, which this repository refused.)'
            : ''),
    cases,
    caseSource,
    totals: report?.totals ?? null,
  };
}

/**
 * Runners that can write a jest-shaped JSON report on request. Vitest's json
 * reporter is a deliberate copy of jest's, so one parser reads both; everything
 * else falls back to reading the runner's console output.
 */
function supportsJsonReport(framework: TestFramework): boolean {
  return framework === 'vitest' || framework === 'jest';
}

/** The flags that make that runner write its report to `path`. */
function reportFlagsFor(framework: TestFramework, path: string): string {
  const quoted = shellQuote(path);
  return framework === 'jest'
    ? `--json --outputFile=${quoted}`
    : `--reporter=json --outputFile=${quoted}`;
}

/**
 * Append runner flags to a command that may be an npm script wrapper.
 *
 * `npm run test --silent` needs a `--` before flags meant for the runner, or
 * npm swallows them; a direct `npx vitest run` does not, and a command that
 * already carries a `--` must not be given a second one.
 */
function withRunnerFlags(command: string, flags: string): string {
  const isScriptWrapper = /\b(?:npm|pnpm|yarn|bun)\s+(?:run|run-script)\b/.test(command);
  const alreadySeparated = / -- /.test(`${command} `);
  return isScriptWrapper && !alreadySeparated ? `${command} -- ${flags}` : `${command} ${flags}`;
}

/**
 * Read the report the runner wrote, or null if it wrote none this module can
 * read.
 *
 * Two ways in, because with `--reporter=json` the runner prints nothing to the
 * console: if this comes back empty the run has no per-test detail at all, the
 * comparison cannot be made, and a pre-existing failure starts blocking pull
 * requests again. A download that fails for a transport reason is not a reason
 * to lose the evidence, so `cat` is tried after it.
 */
async function readTestReport(
  sandbox: Sandbox,
  path: string,
  repoDir: string,
): Promise<ReturnType<typeof parseJsonTestReport>> {
  try {
    const buffer = await downloadFile(sandbox, path, 120);
    const parsed = parseJsonTestReport(buffer.toString('utf8'), repoDir);
    if (parsed) return parsed;
  } catch {
    // Fall through to `cat`.
  }
  const result = await runCommand(sandbox, `cat ${shellQuote(path)}`, undefined, 120);
  if (result.exitCode !== 0) return null;
  return parseJsonTestReport(result.stdout, repoDir);
}

/** A human-readable rendering of a JSON-only run, for the log and the card. */
function renderReport(cases: readonly TestCaseResult[]): string {
  const failed = cases.filter((entry) => entry.status === 'failed');
  if (cases.length === 0) return '';
  const header = `${cases.length} test(s) reported, ${failed.length} failing.`;
  if (failed.length === 0) return header;
  return [
    header,
    ...failed.map((entry) => `FAIL ${entry.id}${entry.message ? `\n  ${entry.message}` : ''}`),
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* The gate (A6.4)                                                            */
/* -------------------------------------------------------------------------- */

export interface PullRequestGate {
  /** False stops the run before a pull request exists. */
  readonly allowed: boolean;
  /** Why, in a sentence a human reads on the approval card. */
  readonly reason: string;
  /** True when nothing failed but nothing was proven either. */
  readonly unproven: boolean;
  /**
   * True when the suite is red but every red test was red before the patch.
   * Allowed, and never silent: every surface that renders this says so.
   */
  readonly preExistingFailuresOnly?: boolean;
}

/**
 * A6.4, stated once so nothing else has to restate it: a test **this change
 * broke** is not a warning, it is a stop.
 *
 * Without a baseline that reads "any red test is a stop", which refuses every
 * pull request on every repository that already has one broken test. With one,
 * it reads what A6.4 means: a failure that was already there is reported and
 * does not block; a failure that was not is absolute. The two directions are
 * decided in `compareTestRuns`, and the gate does not restate them — it reads
 * `blocking`.
 *
 * Where no comparison could be made — no baseline, no per-test detail, a
 * suite-level crash nothing attributes — `comparison` is absent or
 * `comparable: false`, and this falls straight back to the old rule: any
 * failure blocks, with the reason saying why it had to.
 *
 * A repository with no suite is `allowed` but `unproven` — the gate does not
 * pretend an absent suite passed, and the approval card says so plainly so the
 * human is deciding with the truth in front of them.
 */
export function pullRequestGate(
  result: TestRunResult,
  comparison?: BaselineComparison | null,
): PullRequestGate {
  if (!result.ok) {
    // The one branch that lets a red suite through, and it is narrow: the two
    // runs were comparable *and* nothing failing now was passing before.
    if (comparison?.comparable && !comparison.blocking) {
      return {
        allowed: true,
        unproven: false,
        preExistingFailuresOnly: true,
        reason:
          `The target's own test suite is red, but no test this change touched regressed: ` +
          `${describeComparison(comparison)} The suite was run on the base tree first and ` +
          'compared test by test, so the failures above are not this patch\'s doing.',
      };
    }

    const detail = comparison?.comparable
      ? ` ${describeComparison(comparison)}`
      : comparison
        ? ` No baseline comparison was possible: ${comparison.reason} Every failure is ` +
          'therefore treated as this patch\'s.'
        : '';

    return {
      allowed: false,
      unproven: false,
      reason:
        `The target's own test suite failed (${result.command}, exit ${result.exitCode}).` +
        `${detail} The patch is rejected and no pull request will be opened.`,
    };
  }
  if (result.skipped) {
    return {
      allowed: true,
      unproven: true,
      reason: result.command
        ? `${result.summary} The patch is backed by a successful build and the criterion ` +
          're-check, and by nothing else.'
        : 'This repository has no unit test suite, so nothing ran. The patch is backed by a ' +
          'successful build and the criterion re-check, and by nothing else.',
    };
  }
  // Green. The baseline is still worth a sentence when it was red: a patch that
  // repaired something on the way past is evidence a reviewer should have.
  const improved = comparison?.comparable && comparison.fixed.length > 0;
  return {
    allowed: true,
    unproven: false,
    reason:
      `The target's own test suite passed: ${result.summary}` +
      (improved && comparison
        ? ` It also fixed ${comparison.fixed.length} test(s) that were failing on the base ` +
          `branch: ${nameList(comparison.fixed)}.`
        : ''),
  };
}

/** Convenience for a call site that only needs the boolean. */
export function blocksPullRequest(
  result: TestRunResult,
  comparison?: BaselineComparison | null,
): boolean {
  return !pullRequestGate(result, comparison).allowed;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function withEnv(command: string, env?: Readonly<Record<string, string>>): string {
  if (!env) return command;
  const prefix = Object.entries(env)
    .map(([key, value]) => `${key}='${value.split("'").join("'\\''")}'`)
    .join(' ');
  return prefix.length > 0 ? `${prefix} ${command}` : command;
}

function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…(${text.length - max} earlier characters omitted)\n${text.slice(-max)}`;
}

/** The first line that reads like a failure, for a one-line summary. */
function firstFailureLine(output: string): string | null {
  const patterns = [
    /^\s*(?:FAIL|✗|×)\s+.*$/m,
    /^.*\b\d+ (?:failed|failing)\b.*$/m,
    /^\s*(?:AssertionError|Error):.*$/m,
  ];
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match?.[0]) return match[0].trim().slice(0, 300);
  }
  return null;
}
