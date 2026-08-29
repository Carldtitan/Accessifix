/**
 * Typed wrapper around the Daytona SDK.
 *
 * Two rules are load-bearing and were both verified against the live API:
 *
 *  1. Daytona refuses `resources` when the sandbox comes from the default
 *     snapshot — "Cannot specify Sandbox resources when using a snapshot".
 *     Every creation path here therefore passes `Image.base(...)`.
 *  2. The default snapshot image has no zsh, so `executeCommand` fails with
 *     `fork/exec /usr/bin/zsh: no such file or directory`. The two custom
 *     images in config.ts both ship bash, which is why commands work at all.
 *
 * Nothing outside this module should import `@daytonaio/sdk` directly.
 */

import { Daytona, Image, type Sandbox } from '@daytonaio/sdk';
import {
  BROWSER_SANDBOX_LIFECYCLE,
  BUILD_SANDBOX_LIFECYCLE,
  SANDBOX_COMMAND_TIMEOUT_SEC,
  SANDBOX_CREATE_TIMEOUT_SEC,
  SANDBOX_FILE_TIMEOUT_SEC,
  imageFor,
  resourcesFor,
  type SandboxKind,
} from './config';

export type { Sandbox, SandboxKind };

/** Result of a command run inside a sandbox. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
}

/** Options accepted when provisioning either size class. */
export interface CreateSandboxOptions {
  /** Human-readable label folded into the sandbox name for the run view. */
  name?: string;
  /** Labels written onto the sandbox so a leaked one can be traced to its run. */
  labels?: Record<string, string>;
  /** Environment variables available to every command in the sandbox. */
  envVars?: Record<string, string>;
  /** Comma-separated allow list. Omit to leave egress unrestricted. */
  domainAllowList?: string;
  /** Seconds to wait for provisioning. */
  timeoutSec?: number;
}

let client: Daytona | null = null;

/**
 * Lazily construct the Daytona client. The SDK reads DAYTONA_API_KEY and
 * DAYTONA_API_URL from the environment on its own, but reading them here turns
 * a missing key into a clear error at the call site instead of a 401 later.
 */
export function getDaytona(): Daytona {
  if (client) return client;
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) {
    throw new Error('DAYTONA_API_KEY is not set. Sandbox provisioning is unavailable.');
  }
  const apiUrl = process.env.DAYTONA_API_URL || undefined;
  client = new Daytona({ apiKey, ...(apiUrl ? { apiUrl } : {}) });
  return client;
}

/** Test seam: drop the memoised client so a new key or URL takes effect. */
export function resetDaytona(): void {
  client = null;
}

/** True when the environment carries enough to provision a sandbox at all. */
export function sandboxesConfigured(): boolean {
  return Boolean(process.env.DAYTONA_API_KEY);
}

function safeName(kind: SandboxKind, name: string | undefined): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  const base = (name ?? kind)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `accessifix-${kind}-${base || kind}-${suffix}`.slice(0, 60);
}

async function create(kind: SandboxKind, options: CreateSandboxOptions = {}): Promise<Sandbox> {
  const daytona = getDaytona();
  const lifecycle = kind === 'build' ? BUILD_SANDBOX_LIFECYCLE : BROWSER_SANDBOX_LIFECYCLE;

  // Image.base(...) is mandatory here: `resources` is rejected outright when the
  // sandbox is created from the default snapshot.
  return daytona.create(
    {
      image: Image.base(imageFor(kind)),
      resources: resourcesFor(kind),
      name: safeName(kind, options.name),
      labels: { product: 'accessifix', role: kind, ...(options.labels ?? {}) },
      ...(options.envVars ? { envVars: options.envVars } : {}),
      ...(options.domainAllowList ? { domainAllowList: options.domainAllowList } : {}),
      autoStopInterval: lifecycle.autoStopInterval,
      autoDeleteInterval: lifecycle.autoDeleteInterval,
      ttlMinutes: lifecycle.ttlMinutes,
    },
    { timeout: options.timeoutSec ?? SANDBOX_CREATE_TIMEOUT_SEC },
  );
}

/** 2 CPU / 2 GB on the pinned Playwright image. Verified to run Chromium headless. */
export function createBrowserSandbox(options: CreateSandboxOptions = {}): Promise<Sandbox> {
  return create('browser', options);
}

/** 4 CPU / 8 GB on node:22-bookworm. 8 GB is a floor — `next build` OOMs below it. */
export function createBuildSandbox(options: CreateSandboxOptions = {}): Promise<Sandbox> {
  return create('build', options);
}

/**
 * Run a shell command inside a sandbox.
 *
 * The SDK returns `{ exitCode, result, artifacts }`; `artifacts.stdout` is the
 * richer field when present and `result` is the fallback. A non-zero exit code
 * is returned rather than thrown — callers decide whether a failure is fatal,
 * because one failed interaction path must not abort a whole run.
 */
export async function runCommand(
  sandbox: Sandbox,
  cmd: string,
  cwd?: string,
  timeoutSec: number = SANDBOX_COMMAND_TIMEOUT_SEC,
): Promise<CommandResult> {
  try {
    const response = await sandbox.process.executeCommand(cmd, cwd, undefined, timeoutSec);
    const stdout = response.artifacts?.stdout ?? response.result ?? '';
    return { exitCode: response.exitCode ?? 0, stdout };
  } catch (error) {
    return { exitCode: -1, stdout: describeError(error) };
  }
}

/** Upload a buffer to an absolute path inside the sandbox. */
export async function uploadFile(
  sandbox: Sandbox,
  buffer: Buffer,
  path: string,
  timeoutSec: number = SANDBOX_FILE_TIMEOUT_SEC,
): Promise<void> {
  await sandbox.fs.uploadFile(buffer, path, timeoutSec);
}

/**
 * Download a file from the sandbox.
 *
 * This is the mechanism behind A9.2: screenshots and tree dumps are written to
 * the sandbox filesystem and pulled down as artifacts, never carried through a
 * model's context.
 */
export async function downloadFile(
  sandbox: Sandbox,
  path: string,
  timeoutSec: number = SANDBOX_FILE_TIMEOUT_SEC,
): Promise<Buffer> {
  return sandbox.fs.downloadFile(path, timeoutSec);
}

/** Create a directory inside the sandbox. Succeeds quietly when it already exists. */
export async function ensureDir(sandbox: Sandbox, path: string, mode = '755'): Promise<void> {
  try {
    await sandbox.fs.createFolder(path, mode);
  } catch {
    await runCommand(sandbox, `mkdir -p ${shellQuote(path)}`, undefined, 30);
  }
}

/**
 * Destroy a sandbox. Always safe to call, never throws.
 *
 * Leaking a sandbox burns pool quota that other paths in the same run need, so
 * every failure mode here is swallowed and reported by return value only.
 */
export async function destroy(sandbox: Sandbox | null | undefined): Promise<boolean> {
  if (!sandbox) return false;
  try {
    await sandbox.delete(60, false);
    return true;
  } catch {
    try {
      await getDaytona().delete(sandbox, 60, false);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Provision, run, and guarantee cleanup.
 *
 * The finally block is the only cleanup path the application controls; the TTL
 * and auto-delete interval set in config.ts cover the case where this process
 * dies before the finally block ever runs.
 */
export async function withSandbox<T>(
  kind: SandboxKind,
  fn: (sandbox: Sandbox) => Promise<T>,
  options: CreateSandboxOptions = {},
): Promise<T> {
  const sandbox = await create(kind, options);
  try {
    return await fn(sandbox);
  } finally {
    await destroy(sandbox);
  }
}

/** Single-quote a value for safe interpolation into a shell command. */
export function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
