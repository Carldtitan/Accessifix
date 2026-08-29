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

const E2E_SCRIPTS = ['test:e2e', 'e2e', 'test:playwright', 'playwright'] as const;

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
  const e2eScript = E2E_SCRIPTS.find((name) => typeof scripts[name] === 'string') ?? null;

  for (const { script, source } of SCRIPT_PREFERENCE) {
    const body = scripts[script];
    if (typeof body !== 'string' || body.trim().length === 0) continue;
    if (script === 'test' && NO_TEST_PLACEHOLDER.test(body)) continue;

    const framework = frameworkOf(body);
    return {
      script,
      command: buildCommand(script, framework),
      framework,
      source,
      scriptBody: body,
      e2eScript,
      reason: `The repository defines \`npm run ${script}\` as \`${body}\`, so that is what ran.`,
    };
  }

  // No script, but the runner is installed. Common in repositories that rely on
  // an IDE integration or a CI-only invocation.
  const deps = { ...(pkg?.devDependencies ?? {}), ...(pkg?.dependencies ?? {}) };
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
    reason:
      'This repository defines no unit test suite, so there was nothing to run. The patch is ' +
      'backed by the build and the criterion re-check only.',
  };
}

function frameworkOf(body: string): TestFramework {
  const text = body.toLowerCase();
  if (/\bvitest\b/.test(text)) return 'vitest';
  if (/\bjest\b/.test(text)) return 'jest';
  if (/\bplaywright\b/.test(text)) return 'playwright';
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
  /** True when there was no suite to run. `ok` is true but nothing was proven. */
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

  return {
    ok,
    output,
    framework: detection.framework,
    command,
    exitCode: result.exitCode,
    skipped: false,
    detection,
    durationMs,
    summary: ok
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
      reason:
        'This repository has no unit test suite, so nothing ran. The patch is backed by a ' +
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
