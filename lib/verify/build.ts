/**
 * Building the patched target in a sandbox (A6.1).
 *
 * Clone at a ref, write the patched files over the working tree, copy
 * `.env.example` to `.env`, install, build. Return whether it worked and the
 * log that proves it either way.
 *
 * Two verified facts shape this whole module:
 *
 *  - The build sandbox is 4 CPU / **8 GB**. Below 8 GB `next build` is
 *    OOM-killed during the TypeScript check, and the failure looks nothing like
 *    a broken patch: the process disappears, exit code 137, no error message
 *    about the code at all. Reporting that as "the patch broke the build" would
 *    send a human to read a diff that is fine. `oomKilled` is therefore a
 *    separate field from `compileErrors`, and the two are never conflated.
 *  - Copying `.env.example` to `.env` is enough for the reference target. It
 *    builds with empty API keys, so no secret ever enters the sandbox.
 *
 * The whole flow is 53 seconds on the reference target — 10s to install 590
 * packages, 11s to build — which is what makes a verified pull request possible
 * inside a demo at all.
 */

import {
  ensureDir,
  runCommand,
  shellQuote,
  uploadFile,
  withSandbox,
  type CommandResult,
  type Sandbox,
} from '@/lib/sandbox/daytona';
import { SANDBOX_WORK_DIR } from '@/lib/sandbox/config';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** A patched file to write over the clone before installing. */
export interface PatchedFile {
  /** Repository-relative path, forward slashes. */
  readonly path: string;
  /** Complete new contents. */
  readonly contents: string;
}

export type BuildStage = 'clone' | 'patch' | 'env' | 'install' | 'build';

export interface BuildStep {
  readonly stage: BuildStage;
  readonly command: string;
  readonly exitCode: number;
  readonly ok: boolean;
  readonly durationMs: number;
  /** Tail of the step's output, already redacted. */
  readonly output: string;
}

export interface BuildResult {
  /** True only when every stage that ran succeeded. */
  readonly ok: boolean;
  /** The full transcript, redacted, ready to attach as an artifact. */
  readonly log: string;
  readonly steps: readonly BuildStep[];
  /** The stage that failed, or null when everything passed. */
  readonly failedStage: BuildStage | null;
  /**
   * The build ran out of memory rather than failing to compile. A different
   * problem with a different fix: raise the sandbox, do not touch the patch.
   */
  readonly oomKilled: boolean;
  /**
   * Whether a build command actually ran and compiled something.
   *
   * False when the repository defines no `build` script. `ok` is true in that
   * case — nothing failed — but nothing was compiled either, and a gate that
   * reads `ok` alone would treat "there was no build" as "the build passed".
   * The two are different facts and this is the one that says which.
   */
  readonly buildRan: boolean;
  /**
   * False when `npm ci` was refused for lockfile drift and the run fell back to
   * `npm install`. The tree that built is then not the tree the repository
   * pins, so the build proves less than it appears to.
   */
  readonly installReproducible: boolean;
  /** Compiler and bundler errors pulled out of the log, for the handoff card. */
  readonly compileErrors: readonly string[];
  /** Absolute path of the clone inside the sandbox. */
  readonly repoDir: string;
  /** The commit actually checked out, when it could be read. */
  readonly commitSha: string | null;
  /** Whether `.env.example` was copied to `.env`. */
  readonly envCopied: boolean;
  readonly durationMs: number;
  /** One sentence for the timeline and the pull-request body. */
  readonly summary: string;
}

export interface BuildOptions {
  /** `owner/repo`. Used to derive the clone URL when `cloneUrl` is absent. */
  readonly repoFullName?: string;
  /** Explicit clone URL. Overrides `repoFullName`. */
  readonly cloneUrl?: string;
  /** Branch, tag or commit SHA to build. Default: the remote's HEAD. */
  readonly ref?: string;
  /**
   * GitHub token for a private repository. Injected into the clone URL and
   * redacted out of every line of the returned log.
   */
  readonly token?: string;
  /** Patched files written over the clone before install (A5, A6.1). */
  readonly files?: readonly PatchedFile[];
  /** Directory to clone into. Default `${SANDBOX_WORK_DIR}/target`. */
  readonly repoDir?: string;
  /** Override the install command. Default `npm ci` when a lockfile exists. */
  readonly installCommand?: string;
  /** Override the build command. Default `npm run build`. */
  readonly buildCommand?: string;
  /** Extra environment for the install and build steps, e.g. `CI`. */
  readonly env?: Readonly<Record<string, string>>;
  /** Reuse a sandbox instead of provisioning one. Tests and recheck need this. */
  readonly sandbox?: Sandbox;
  /** Labels for a provisioned sandbox, so a leak traces back to its run. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Per-step timeouts, in seconds. */
  readonly cloneTimeoutSec?: number;
  readonly installTimeoutSec?: number;
  readonly buildTimeoutSec?: number;
  /** Called after every step, for the live run view. */
  readonly onStep?: (step: BuildStep) => void;
}

const DEFAULT_CLONE_TIMEOUT_SEC = 300;
const DEFAULT_INSTALL_TIMEOUT_SEC = 900;
const DEFAULT_BUILD_TIMEOUT_SEC = 1_200;

/** Characters of a step's output kept in the result. The rest stays in the log. */
const STEP_OUTPUT_TAIL = 8_000;

/* -------------------------------------------------------------------------- */
/* OOM and compile-error detection                                            */
/* -------------------------------------------------------------------------- */

/**
 * Signatures of a kill, not a compile failure.
 *
 * 137 is 128+9, the shell's encoding of SIGKILL, which is what the kernel OOM
 * killer sends. V8's own message appears when the heap limit is hit before the
 * kernel intervenes. Both mean the same thing to a human: the sandbox was too
 * small.
 *
 * 139 is *not* on that list. It is 128+11, SIGSEGV — a crash in the compiler or
 * a native module, which is a real defect somebody has to look at. Reporting it
 * as "the sandbox was too small" would suppress the compile diagnostics and send
 * a human to resize a machine that is the right size. A 139 that genuinely ran
 * out of memory says so in its output and is caught by the patterns below.
 */
const OOM_PATTERNS: readonly RegExp[] = [
  /JavaScript heap out of memory/i,
  /FATAL ERROR:.*Reached heap limit/i,
  /Allocation failed - JavaScript heap out of memory/i,
  /\bout of memory\b/i,
  /oom[-_ ]?kill/i,
  /Killed\s*$/m,
  /signal\s+SIGKILL/i,
  /exited with signal 9\b/i,
];

const COMPILE_ERROR_PATTERNS: readonly RegExp[] = [
  /^.*?\berror TS\d+:.*$/gm,
  /^Type error:.*$/gm,
  /^\s*Failed to compile\.?\s*$/gm,
  /^Module not found:.*$/gm,
  /^SyntaxError:.*$/gm,
  /^Error:\s+.*$/gm,
];

/**
 * True when the output is an out-of-memory kill rather than a compile failure.
 *
 * Only SIGKILL/137 is unconditional. Every other exit code has to carry an
 * explicit OOM signature in its output before this claims memory was the cause.
 */
export function detectOom(output: string, exitCode: number): boolean {
  if (exitCode === 137) return true;
  return OOM_PATTERNS.some((pattern) => pattern.test(output));
}

/**
 * `npm ci` refusing a lockfile that has drifted from `package.json`, as opposed
 * to failing for any of the dozen other reasons an install fails.
 *
 * The distinction matters because the drift case is a property of the
 * repository — nothing the patch did — while a registry outage, an engine
 * mismatch or a failing lifecycle script is a real failure that an `npm install`
 * retry would paper over, silently validating a dependency tree the repository
 * does not pin.
 */
const LOCKFILE_DRIFT_PATTERNS: readonly RegExp[] = [
  /can only install packages when your package\.json and package-lock\.json[\s\S]{0,120}?in sync/i,
  /can only install with an existing package-lock\.json/i,
  /^\s*npm (?:ERR!|error)\s+Invalid: lock file's /im,
  /^\s*npm (?:ERR!|error)\s+Missing: [^\n]* from lock file/im,
  /lock ?file (?:is )?out of (?:date|sync)/i,
];

export function isLockfileDrift(output: string): boolean {
  return LOCKFILE_DRIFT_PATTERNS.some((pattern) => pattern.test(output));
}

/** Compiler and bundler errors, deduplicated, for the handoff card. */
export function extractCompileErrors(output: string, limit = 12): string[] {
  const found = new Set<string>();
  for (const pattern of COMPILE_ERROR_PATTERNS) {
    for (const match of output.matchAll(pattern)) {
      const line = match[0]?.trim();
      if (line && line.length > 0 && line.length < 400) found.add(line);
      if (found.size >= limit) return [...found];
    }
  }
  return [...found];
}

/* -------------------------------------------------------------------------- */
/* Build                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Clone, patch, install and build.
 *
 * Provisions a build sandbox when one is not supplied, and destroys it on the
 * way out. Supply `options.sandbox` when the same workspace has to carry the
 * test run and the re-check — provisioning is the slow part, not the build.
 */
export async function runBuildVerification(options: BuildOptions): Promise<BuildResult> {
  if (options.sandbox) return buildIn(options.sandbox, options);
  return withSandbox('build', (sandbox) => buildIn(sandbox, options), {
    name: options.repoFullName?.split('/')[1] ?? 'target',
    labels: { ...(options.labels ?? {}), stage: 'verify' },
  });
}

/** What a verification run gets to work with once the build has happened. */
export interface BuildWorkspace {
  readonly sandbox: Sandbox;
  readonly repoDir: string;
  readonly build: BuildResult;
}

/**
 * One build sandbox, held open across the build, the test suite and the
 * re-check. This is the composition the VERIFY phase actually wants: A6.1,
 * A6.2 and A6.3 all run against the same patched tree, and provisioning it
 * three times would cost more than all three steps together.
 */
export async function withBuildWorkspace<T>(
  options: BuildOptions,
  fn: (workspace: BuildWorkspace) => Promise<T>,
): Promise<T> {
  if (options.sandbox) {
    const build = await buildIn(options.sandbox, options);
    return fn({ sandbox: options.sandbox, repoDir: build.repoDir, build });
  }
  return withSandbox(
    'build',
    async (sandbox) => {
      const build = await buildIn(sandbox, options);
      return fn({ sandbox, repoDir: build.repoDir, build });
    },
    {
      name: options.repoFullName?.split('/')[1] ?? 'target',
      labels: { ...(options.labels ?? {}), stage: 'verify' },
    },
  );
}

async function buildIn(sandbox: Sandbox, options: BuildOptions): Promise<BuildResult> {
  const started = Date.now();
  const repoDir = options.repoDir ?? `${SANDBOX_WORK_DIR}/target`;
  const redact = redactor(options.token);
  const steps: BuildStep[] = [];
  const log: string[] = [];

  const record = (step: BuildStep): BuildStep => {
    steps.push(step);
    log.push(
      `$ ${step.command}`,
      step.output,
      `[${step.stage}] exit ${step.exitCode} in ${step.durationMs}ms`,
      '',
    );
    options.onStep?.(step);
    return step;
  };

  const finish = (
    failedStage: BuildStage | null,
    extras: {
      commitSha?: string | null;
      envCopied?: boolean;
      buildRan?: boolean;
      installReproducible?: boolean;
    } = {},
  ): BuildResult => {
    const transcript = redact(log.join('\n'));
    const failedStep = failedStage ? steps.find((s) => s.stage === failedStage && !s.ok) : undefined;
    const oomKilled = failedStep
      ? detectOom(failedStep.output, failedStep.exitCode)
      : false;
    const compileErrors =
      failedStep && !oomKilled ? extractCompileErrors(failedStep.output) : [];
    const buildRan = extras.buildRan ?? false;
    const installReproducible = extras.installReproducible ?? true;

    return {
      ok: failedStage === null,
      log: transcript,
      steps,
      failedStage,
      oomKilled,
      buildRan,
      installReproducible,
      compileErrors,
      repoDir,
      commitSha: extras.commitSha ?? null,
      envCopied: extras.envCopied ?? false,
      durationMs: Date.now() - started,
      summary: summarise({
        failedStage,
        oomKilled,
        compileErrors,
        exitCode: failedStep?.exitCode ?? null,
        buildRan,
        installReproducible,
        durationMs: Date.now() - started,
      }),
    };
  };

  const run = async (
    stage: BuildStage,
    command: string,
    cwd: string | undefined,
    timeoutSec: number,
  ): Promise<BuildStep> => {
    const at = Date.now();
    const result: CommandResult = await runCommand(sandbox, command, cwd, timeoutSec);
    return record({
      stage,
      command: redact(command),
      exitCode: result.exitCode,
      ok: result.exitCode === 0,
      durationMs: Date.now() - at,
      output: redact(tail(result.stdout, STEP_OUTPUT_TAIL)),
    });
  };

  /* -- clone ------------------------------------------------------------- */

  const cloneUrl = resolveCloneUrl(options);
  const cloneTimeout = options.cloneTimeoutSec ?? DEFAULT_CLONE_TIMEOUT_SEC;

  // `git init` + `fetch --depth 1 <ref>` rather than `clone --branch`, because
  // the ref may be a commit SHA and `--branch` only accepts a branch or a tag.
  const clone = await run(
    'clone',
    [
      `rm -rf ${shellQuote(repoDir)}`,
      `mkdir -p ${shellQuote(repoDir)}`,
      `git init -q ${shellQuote(repoDir)}`,
      `git -C ${shellQuote(repoDir)} remote add origin ${shellQuote(cloneUrl)}`,
      options.ref
        ? `git -C ${shellQuote(repoDir)} fetch --depth 1 origin ${shellQuote(options.ref)}`
        : `git -C ${shellQuote(repoDir)} fetch --depth 1 origin HEAD`,
      `git -C ${shellQuote(repoDir)} checkout -q FETCH_HEAD`,
    ].join(' && '),
    undefined,
    cloneTimeout,
  );

  if (!clone.ok) {
    // A shallow fetch of a SHA is refused by some hosts. Full-clone fallback.
    const fallback = await run(
      'clone',
      [
        `rm -rf ${shellQuote(repoDir)}`,
        `git clone ${shellQuote(cloneUrl)} ${shellQuote(repoDir)}`,
        options.ref ? `git -C ${shellQuote(repoDir)} checkout -q ${shellQuote(options.ref)}` : 'true',
      ].join(' && '),
      undefined,
      cloneTimeout,
    );
    if (!fallback.ok) return finish('clone');
  }

  const head = await runCommand(sandbox, 'git rev-parse HEAD', repoDir, 60);
  const commitSha = head.exitCode === 0 ? head.stdout.trim().split('\n')[0] ?? null : null;

  /* -- patch ------------------------------------------------------------- */

  if (options.files && options.files.length > 0) {
    const at = Date.now();
    const written: string[] = [];
    let failure: string | null = null;

    for (const file of options.files) {
      const relative = file.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
      if (relative.length === 0 || relative.split('/').includes('..')) {
        failure = `Refused to write "${file.path}": a patch may not escape the repository.`;
        break;
      }
      const absolute = `${repoDir}/${relative}`;
      try {
        const parent = absolute.slice(0, absolute.lastIndexOf('/'));
        if (parent.length > 0) await ensureDir(sandbox, parent);
        await uploadFile(sandbox, Buffer.from(file.contents, 'utf8'), absolute);
        written.push(relative);
      } catch (error) {
        failure = `Failed to write ${relative}: ${error instanceof Error ? error.message : String(error)}`;
        break;
      }
    }

    record({
      stage: 'patch',
      command: `write ${options.files.length} patched file(s)`,
      exitCode: failure ? 1 : 0,
      ok: failure === null,
      durationMs: Date.now() - at,
      output: failure ?? `Wrote:\n${written.map((p) => `  ${p}`).join('\n')}`,
    });

    if (failure) return finish('patch', { commitSha });
  }

  /* -- env --------------------------------------------------------------- */

  // Verified: `.env.example` is enough — the reference target builds with empty
  // API keys, so nothing secret has to reach the sandbox to prove the build.
  const env = await run(
    'env',
    'if [ -f .env.example ] && [ ! -f .env ]; then cp .env.example .env; echo "copied .env.example to .env"; ' +
      'elif [ -f .env ]; then echo "repository already provides .env"; ' +
      'else echo "no .env.example present"; fi',
    repoDir,
    60,
  );
  const envCopied = env.output.includes('copied .env.example');

  /* -- install ----------------------------------------------------------- */

  const hasLockfile = await fileExists(sandbox, `${repoDir}/package-lock.json`);
  const installCommand =
    options.installCommand ??
    (hasLockfile ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund');

  let install = await run(
    'install',
    withEnv(installCommand, options.env),
    repoDir,
    options.installTimeoutSec ?? DEFAULT_INSTALL_TIMEOUT_SEC,
  );

  // `npm ci` refuses a lockfile that has drifted from package.json. That is a
  // property of the repository, not of the patch, so fall back rather than
  // reporting the run as broken — but only for that specific refusal. A
  // registry outage, an engine mismatch or a failing lifecycle script is a real
  // failure, and retrying it with `npm install` would hide it behind a
  // dependency tree the repository does not pin.
  let installReproducible = true;
  if (
    !install.ok &&
    !options.installCommand &&
    hasLockfile &&
    isLockfileDrift(install.output)
  ) {
    installReproducible = false;
    install = await run(
      'install',
      withEnv('npm install --no-audit --no-fund', options.env),
      repoDir,
      options.installTimeoutSec ?? DEFAULT_INSTALL_TIMEOUT_SEC,
    );
  }
  if (!install.ok) return finish('install', { commitSha, envCopied, installReproducible });

  /* -- build ------------------------------------------------------------- */

  const scripts = await readScripts(sandbox, repoDir);
  if (!options.buildCommand && !scripts.build) {
    // Nothing failed, so this is not a failure — but nothing compiled either.
    // `buildRan: false` is what stops a later gate from reading "install
    // succeeded" as "the patched tree builds".
    record({
      stage: 'build',
      command: '(no build script)',
      exitCode: 0,
      ok: true,
      durationMs: 0,
      output:
        'No `build` script in package.json. Nothing was compiled; the install succeeded and ' +
        'that is the whole of what this step proves.',
    });
    return finish(null, { commitSha, envCopied, buildRan: false, installReproducible });
  }

  const build = await run(
    'build',
    withEnv(options.buildCommand ?? 'npm run build', options.env),
    repoDir,
    options.buildTimeoutSec ?? DEFAULT_BUILD_TIMEOUT_SEC,
  );

  return finish(build.ok ? null : 'build', {
    commitSha,
    envCopied,
    buildRan: true,
    installReproducible,
  });
}

/* -------------------------------------------------------------------------- */
/* The build gate (A6.1)                                                      */
/* -------------------------------------------------------------------------- */

export interface BuildGate {
  /** False stops the run before a pull request exists. */
  readonly allowed: boolean;
  /** True when nothing failed but no compilation happened either. */
  readonly unproven: boolean;
  /** Why, in a sentence a human reads on the approval card. */
  readonly reason: string;
}

/**
 * A6.1, stated once: a failed build is a stop, and an *absent* build is not a
 * pass.
 *
 * The second half is the one worth writing down. A repository with no `build`
 * script produces `ok: true` because nothing failed, and a gate that reads that
 * boolean alone would tell a human "the patched tree builds" on the strength of
 * an install. It is allowed — a library with no build step is an ordinary
 * repository — but it is `unproven`, and every surface that renders it has to
 * say so rather than print a tick.
 */
export function buildGate(result: BuildResult): BuildGate {
  if (!result.ok) {
    return {
      allowed: false,
      unproven: false,
      reason: `The patched tree did not build. ${result.summary}`,
    };
  }
  if (!result.buildRan) {
    return {
      allowed: true,
      unproven: true,
      reason:
        'This repository defines no build script, so nothing was compiled. The install ' +
        'succeeded and that is all this step proves.',
    };
  }
  if (!result.installReproducible) {
    return {
      allowed: true,
      unproven: false,
      reason:
        `${result.summary} The lockfile had drifted from package.json, so dependencies came ` +
        'from `npm install` rather than `npm ci` — the tree that built is not the one the ' +
        'repository pins.',
    };
  }
  return { allowed: true, unproven: false, reason: result.summary };
}

/* -------------------------------------------------------------------------- */
/* Sandbox helpers                                                            */
/* -------------------------------------------------------------------------- */

/** `package.json` scripts, or an empty record when it cannot be read. */
export async function readScripts(
  sandbox: Sandbox,
  repoDir: string,
): Promise<Record<string, string>> {
  const pkg = await readPackageJson(sandbox, repoDir);
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** The target's `package.json`, parsed on the host. Null when absent or invalid. */
export async function readPackageJson(
  sandbox: Sandbox,
  repoDir: string,
): Promise<Record<string, unknown> | null> {
  const result = await runCommand(sandbox, 'cat package.json', repoDir, 60);
  if (result.exitCode !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function fileExists(sandbox: Sandbox, path: string): Promise<boolean> {
  const result = await runCommand(sandbox, `test -f ${shellQuote(path)}`, undefined, 30);
  return result.exitCode === 0;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function resolveCloneUrl(options: BuildOptions): string {
  const base =
    options.cloneUrl ??
    (options.repoFullName ? `https://github.com/${options.repoFullName}.git` : null);
  if (!base) {
    throw new Error('runBuildVerification needs either `cloneUrl` or `repoFullName`.');
  }
  if (!options.token) return base;
  // `x-access-token` is the username GitHub expects for an OAuth or app token.
  return base.replace(/^https:\/\//, `https://x-access-token:${options.token}@`);
}

function withEnv(command: string, env?: Readonly<Record<string, string>>): string {
  if (!env) return command;
  const prefix = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ');
  return prefix.length > 0 ? `${prefix} ${command}` : command;
}

/**
 * Redact the token everywhere it could appear before the log leaves this
 * module. It is in the clone URL, and git echoes the remote on failure.
 */
function redactor(token?: string): (text: string) => string {
  if (!token || token.length < 8) return (text) => text;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escaped, 'g');
  return (text) => text.replace(pattern, '***');
}

function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…(${text.length - max} earlier characters omitted)\n${text.slice(-max)}`;
}

function summarise(facts: {
  failedStage: BuildStage | null;
  oomKilled: boolean;
  compileErrors: readonly string[];
  exitCode: number | null;
  buildRan: boolean;
  installReproducible: boolean;
  durationMs: number;
}): string {
  const { failedStage, oomKilled, compileErrors, exitCode, durationMs } = facts;
  const seconds = (durationMs / 1000).toFixed(1);

  if (failedStage === null) {
    const drift = facts.installReproducible
      ? ''
      : ' Dependencies came from `npm install` rather than `npm ci`, because the lockfile had ' +
        'drifted from package.json.';
    if (!facts.buildRan) {
      return (
        `Install succeeded in ${seconds}s. This repository defines no build script, so nothing ` +
        `was compiled.${drift}`
      );
    }
    return `Build succeeded in ${seconds}s.${drift}`;
  }

  if (oomKilled) {
    return (
      `The ${failedStage} step was killed for running out of memory after ${seconds}s. ` +
      'This is a sandbox size problem, not a problem with the patch — the build needs at ' +
      'least 8 GB, and the code never got far enough to be judged.'
    );
  }
  if (compileErrors.length > 0) {
    return `The ${failedStage} step failed to compile after ${seconds}s: ${compileErrors[0]}`;
  }
  // 128+N is a termination by signal. Naming it keeps a segfault in a native
  // module from being read as an ordinary non-zero exit.
  if (exitCode !== null && exitCode > 128 && exitCode < 160) {
    const signal = exitCode - 128;
    const name = signal === 11 ? ' (SIGSEGV, a crash)' : signal === 9 ? ' (SIGKILL)' : '';
    return (
      `The ${failedStage} step was terminated by signal ${signal}${name} after ${seconds}s, ` +
      'with no out-of-memory signature in its output.'
    );
  }
  return `The ${failedStage} step failed after ${seconds}s.`;
}
