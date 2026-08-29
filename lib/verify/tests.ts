/**
 * Running the target's own test suite (A6.2, A6.4).
 *
 * The point of this module is one sentence in the requirements: *when the test
 * suite fails, the run shall not open a pull request*. That is the promise that
 * makes an accessibility agent safe to point at someone's repository. It is not
 * a checklist item — it is the difference between a tool that fixes a site and
 * a tool that breaks one to satisfy a rule.
 *
 * The suite is the target's, not ours. We detect what the repository already
 * runs and we run exactly that: `test`, then `test:unit`, then `vitest`. For
 * the reference target that resolves to `npm test` (vitest); its Playwright
 * suite under `test:e2e` is reported but not run, because an end-to-end suite
 * needs a served application and is a different gate.
 */

import { runCommand, type Sandbox } from '@/lib/sandbox/daytona';
import { readPackageJson } from './build';

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
  let e2eFromScript: { readonly script: string; readonly framework: TestFramework } | null = null;

  for (const { script, source } of SCRIPT_PREFERENCE) {
    const body = scripts[script];
    if (typeof body !== 'string' || body.trim().length === 0) continue;
    if (script === 'test' && NO_TEST_PLACEHOLDER.test(body)) continue;

    const framework = frameworkOf(body);
    if (isE2eFramework(framework)) {
      e2eFromScript ??= { script, framework };
      continue;
    }

    return {
      script,
      command: buildCommand(script, framework),
      framework,
      source,
      scriptBody: body,
      e2eScript: namedE2e ?? e2eFromScript?.script ?? null,
      reason:
        `The repository defines \`npm run ${script}\` as \`${body}\`, so that is what ran.` +
        (e2eFromScript
          ? ` Its \`${e2eFromScript.script}\` script is ${e2eLabel(e2eFromScript.framework)} and ` +
            'was left alone — an end-to-end suite needs a served application and is a different ' +
            'gate.'
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
  const e2eScript = namedE2e ?? e2eFromScript?.script ?? null;

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
      ? `This repository's \`${e2eFromScript.script}\` script is a ` +
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
}

const DEFAULT_TEST_TIMEOUT_SEC = 900;
const DEFAULT_OUTPUT_TAIL = 12_000;

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
    };
  }

  const result = await runCommand(
    sandbox,
    withEnv(command, options.env),
    repoDir,
    options.timeoutSec ?? DEFAULT_TEST_TIMEOUT_SEC,
  );

  const durationMs = Date.now() - started;
  const output = tail(result.stdout, options.outputTail ?? DEFAULT_OUTPUT_TAIL);
  const ok = result.exitCode === 0;

  // A runner that exited zero because it found nothing to run has proven
  // nothing. `skipped` puts it where an absent suite already sits — allowed,
  // unproven — instead of reporting an empty run as a passing one.
  const zeroTests = ok && ranZeroTests(output);

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
          }.`
        : `\`${command}\` failed with exit code ${result.exitCode}. ` +
          `${firstFailureLine(output) ?? 'See the attached log.'}`,
  };
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
}

/**
 * A6.4, stated once so nothing else has to restate it: a failing suite is not
 * a warning, it is a stop.
 *
 * A repository with no suite is `allowed` but `unproven` — the gate does not
 * pretend an absent suite passed, and the approval card says so plainly so the
 * human is deciding with the truth in front of them.
 */
export function pullRequestGate(result: TestRunResult): PullRequestGate {
  if (!result.ok) {
    return {
      allowed: false,
      unproven: false,
      reason:
        `The target's own test suite failed (${result.command}, exit ${result.exitCode}). ` +
        'The patch is rejected and no pull request will be opened.',
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
  return {
    allowed: true,
    unproven: false,
    reason: `The target's own test suite passed: ${result.summary}`,
  };
}

/** Convenience for a call site that only needs the boolean. */
export function blocksPullRequest(result: TestRunResult): boolean {
  return !pullRequestGate(result).allowed;
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
