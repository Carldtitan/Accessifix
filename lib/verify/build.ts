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

/** True when the output is a kill rather than a compile failure. */
export function detectOom(output: string, exitCode: number): boolean {
  if (exitCode === 137 || exitCode === 139) return true;
  return OOM_PATTERNS.some((pattern) => pattern.test(output));
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
    extras: { commitSha?: string | null; envCopied?: boolean } = {},
  ): BuildResult => {
    const transcript = redact(log.join('\n'));
    const failedStep = failedStage ? steps.find((s) => s.stage === failedStage && !s.ok) : undefined;
    const oomKilled = failedStep
      ? detectOom(failedStep.output, failedStep.exitCode)
      : false;
    const compileErrors =
      failedStep && !oomKilled ? extractCompileErrors(failedStep.output) : [];

    return {
      ok: failedStage === null,
      log: transcript,
      steps,
      failedStage,
      oomKilled,
      compileErrors,
      repoDir,
      commitSha: extras.commitSha ?? null,
      envCopied: extras.envCopied ?? false,
      durationMs: Date.now() - started,
      summary: summarise(failedStage, oomKilled, compileErrors, Date.now() - started),
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
  // reporting the run as broken.
  if (!install.ok && !options.installCommand && hasLockfile) {
    install = await run(
      'install',
      withEnv('npm install --no-audit --no-fund', options.env),
      repoDir,
      options.installTimeoutSec ?? DEFAULT_INSTALL_TIMEOUT_SEC,
    );
  }
  if (!install.ok) return finish('install', { commitSha, envCopied });

  /* -- build ------------------------------------------------------------- */

  const scripts = await readScripts(sandbox, repoDir);
  if (!options.buildCommand && !scripts.build) {
    record({
      stage: 'build',
      command: 'npm run build',
      exitCode: 0,
      ok: true,
      durationMs: 0,
      output: 'No `build` script in package.json. Nothing to build; install succeeded.',
    });
    return finish(null, { commitSha, envCopied });
  }

  const build = await run(
    'build',
    withEnv(options.buildCommand ?? 'npm run build', options.env),
    repoDir,
    options.buildTimeoutSec ?? DEFAULT_BUILD_TIMEOUT_SEC,
  );

  return finish(build.ok ? null : 'build', { commitSha, envCopied });
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

function summarise(
  failedStage: BuildStage | null,
  oomKilled: boolean,
  compileErrors: readonly string[],
  durationMs: number,
): string {
  const seconds = (durationMs / 1000).toFixed(1);
  if (failedStage === null) return `Build succeeded in ${seconds}s.`;
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
  return `The ${failedStage} step failed after ${seconds}s.`;
}
