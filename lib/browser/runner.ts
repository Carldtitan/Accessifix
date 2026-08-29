/**
 * Host side of the browser layer.
 *
 * Provisions a browser sandbox through the concurrency governor, uploads the
 * worker and its job, runs it, and validates whatever comes back. The sandbox
 * is a separate process on a separate machine — its stdout is untrusted input,
 * so every field is parsed through the zod schemas in ./types before any caller
 * sees it. A malformed response is an error, never a partially-trusted result.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import {
  AXE_CORE_CDN_URL,
  MAX_INTERACTION_PATHS_PER_PAGE,
  SANDBOX_COMMAND_TIMEOUT_SEC,
  SANDBOX_WORK_DIR,
} from '@/lib/sandbox/config';
import {
  describeError,
  downloadFile,
  ensureDir,
  runCommand,
  uploadFile,
  withSandbox,
  type Sandbox,
} from '@/lib/sandbox/daytona';
import { sandboxPool, type SandboxPool } from '@/lib/sandbox/pool';

import {
  AXE_REMOTE_PATH,
  BROWSER_WORKER_SOURCE,
  JOB_REMOTE_PATH,
  OUTPUT_REMOTE_DIR,
  WORKER_REMOTE_PATH,
  buildLaunchCommand,
  defaultJob,
  extractResultJson,
  type BrowserJob,
} from './script';
import {
  AX_STATE_PROPS,
  browserResultSchema,
  interactionPathSchema,
  type AxNode,
  type AxTree,
  type BrowserResult,
  type ChangedProp,
  type InteractionPath,
  type PageCapture,
  type PathResult,
  type TreeDiff,
} from './types';

export class BrowserRunError extends Error {
  readonly stdout: string;
  constructor(message: string, stdout = '') {
    super(message);
    this.name = 'BrowserRunError';
    this.stdout = stdout;
  }
}

export interface BrowserRunOptions {
  /** Governor to take the sandbox permit from. Defaults to the process-wide pool. */
  pool?: SandboxPool;
  /** Labels written onto the sandbox so a leak can be traced back to its run. */
  labels?: Record<string, string>;
  /** Seconds allowed for the in-sandbox command. */
  timeoutSec?: number;
  /** Download the PNG and return it as base64. On by default; artifacts matter (A9.1). */
  downloadScreenshot?: boolean;
  /** Overrides folded into the job payload. */
  job?: Partial<BrowserJob>;
  /** Called with the sandbox id once provisioned, for the live environments grid (A11.1). */
  onSandbox?: (sandboxId: string) => void;
}

export interface BrowserRunOutcome {
  result: BrowserResult;
  /** Base64 PNG pulled off the sandbox filesystem, not carried over stdout. */
  screenshot: string | null;
  sandboxId: string;
}

/* ------------------------------------------------------------------ */
/* Core                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Provision one browser sandbox, run one job, tear it down.
 *
 * The permit is taken before provisioning and released after teardown, so the
 * queue depth reported by the pool is the number of paths actually waiting for
 * capacity rather than the number waiting for a network round trip.
 */
export async function runBrowserJob(
  url: string,
  jobOverrides: Partial<BrowserJob> = {},
  options: BrowserRunOptions = {},
): Promise<BrowserRunOutcome> {
  const pool = options.pool ?? sandboxPool;
  const release = await pool.acquire();
  try {
    return await withSandbox(
      'browser',
      (sandbox) => executeJob(sandbox, url, jobOverrides, options),
      { labels: options.labels, name: hostOf(url) },
    );
  } finally {
    release();
  }
}

async function executeJob(
  sandbox: Sandbox,
  url: string,
  jobOverrides: Partial<BrowserJob>,
  options: BrowserRunOptions,
): Promise<BrowserRunOutcome> {
  options.onSandbox?.(sandbox.id);

  const job = defaultJob(url, jobOverrides);

  await ensureDir(sandbox, SANDBOX_WORK_DIR);
  await ensureDir(sandbox, OUTPUT_REMOTE_DIR);

  const uploads: Array<Promise<void>> = [
    uploadFile(sandbox, Buffer.from(BROWSER_WORKER_SOURCE, 'utf8'), WORKER_REMOTE_PATH),
    uploadFile(sandbox, Buffer.from(JSON.stringify(job), 'utf8'), JOB_REMOTE_PATH),
  ];

  // axe-core is uploaded from the host rather than fetched by the sandbox: a
  // live probe showed sandbox egress reaching the audited site but not cdnjs,
  // and a silent loss of every deterministic rule is not an acceptable default.
  const axeSource = await loadAxeSource();
  if (axeSource) uploads.push(uploadFile(sandbox, axeSource, AXE_REMOTE_PATH));

  await Promise.all(uploads);

  const command = buildLaunchCommand(WORKER_REMOTE_PATH, JOB_REMOTE_PATH);
  const { exitCode, stdout } = await runCommand(
    sandbox,
    command,
    SANDBOX_WORK_DIR,
    options.timeoutSec ?? SANDBOX_COMMAND_TIMEOUT_SEC,
  );

  const result = parseBrowserResult(stdout, exitCode);

  let screenshot = result.screenshot?.base64 ?? null;
  const remotePath = result.screenshot?.path ?? null;
  if (!screenshot && remotePath && options.downloadScreenshot !== false) {
    try {
      const buffer = await downloadFile(sandbox, remotePath);
      screenshot = buffer.toString('base64');
    } catch (error) {
      result.warnings.push('screenshot download failed: ' + describeError(error));
    }
  }

  return { result, screenshot, sandboxId: sandbox.id };
}

/**
 * Parse and validate the worker's stdout.
 *
 * Failure modes are distinguished on purpose: no delimiter means the worker
 * never got far enough to print, bad JSON means the output was truncated, and
 * a schema failure means the shape changed. Each needs a different fix.
 */
export function parseBrowserResult(stdout: string, exitCode = 0): BrowserResult {
  const raw = extractResultJson(stdout);
  if (!raw) {
    throw new BrowserRunError(
      `The browser worker produced no result blob (exit code ${exitCode}).`,
      tail(stdout),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BrowserRunError(
      'The browser worker produced an unparseable result blob: ' + describeError(error),
      tail(stdout),
    );
  }

  const validated = browserResultSchema.safeParse(parsed);
  if (!validated.success) {
    throw new BrowserRunError(
      'The browser worker returned an unexpected shape: ' + formatIssues(validated.error),
      tail(stdout),
    );
  }

  const result = validated.data;
  if (!result.ok) {
    throw new BrowserRunError(
      'The browser worker failed: ' + (result.error ?? 'no reason given'),
      tail(stdout),
    );
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */

/**
 * Capture one page: accessibility tree, full-page screenshot, axe-core
 * violations, and title. This is the TREE input (A3.2) and the VIS input.
 */
export async function capturePage(
  url: string,
  options: BrowserRunOptions = {},
): Promise<PageCapture> {
  const { result, screenshot } = await runBrowserJob(
    url,
    { capture: true, screenshot: true, axe: true, paths: [], ...options.job },
    options,
  );
  return {
    url,
    finalUrl: result.finalUrl || url,
    title: result.title,
    axTree: result.axTree,
    screenshot,
    axeViolations: result.axeViolations,
    axeRan: result.axeRan,
    links: result.links,
    warnings: result.warnings,
  };
}

/**
 * Drive a list of interaction paths against one URL and return the before and
 * after trees plus the control's own state attributes on both sides (A4.3).
 *
 * The page is reloaded before every path, so depth stays at one (A4.6) and no
 * path inherits state left behind by the one before it. A path whose selector
 * misses comes back with `ok: false` rather than aborting the batch.
 */
export async function runPaths(
  url: string,
  paths: readonly InteractionPath[],
  options: BrowserRunOptions = {},
): Promise<PathResult[]> {
  const validated = z.array(interactionPathSchema).parse(paths);
  if (validated.length === 0) return [];

  const capped = validated.slice(0, MAX_INTERACTION_PATHS_PER_PAGE);
  const { result } = await runBrowserJob(
    url,
    {
      capture: false,
      screenshot: false,
      axe: false,
      paths: capped,
      ...options.job,
    },
    options,
  );

  if (capped.length < validated.length) {
    result.warnings.push(
      `Truncated ${validated.length} paths to the per-page cap of ${MAX_INTERACTION_PATHS_PER_PAGE}.`,
    );
  }
  return result.paths;
}

/**
 * Capture and drive paths in a single sandbox.
 *
 * Preferred over calling capturePage and runPaths separately for the same URL:
 * provisioning is the slow part, and one sandbox holds one page's whole job.
 */
export async function auditPage(
  url: string,
  paths: readonly InteractionPath[] = [],
  options: BrowserRunOptions = {},
): Promise<{ capture: PageCapture; paths: PathResult[] }> {
  const validated = z
    .array(interactionPathSchema)
    .parse(paths)
    .slice(0, MAX_INTERACTION_PATHS_PER_PAGE);

  const { result, screenshot } = await runBrowserJob(
    url,
    { capture: true, screenshot: true, axe: true, paths: validated, ...options.job },
    options,
  );

  return {
    capture: {
      url,
      finalUrl: result.finalUrl || url,
      title: result.title,
      axTree: result.axTree,
      screenshot,
      axeViolations: result.axeViolations,
      axeRan: result.axeRan,
      links: result.links,
      warnings: result.warnings,
    },
    paths: result.paths,
  };
}

/* ------------------------------------------------------------------ */
/* Tree diffing                                                         */
/* ------------------------------------------------------------------ */

/**
 * Diff two accessibility trees.
 *
 * This is the product's core mechanic. On clearway-kappa.vercel.app the
 * "EnglishEN" control produced 98 added nodes while its own `expanded` property
 * stayed null on both sides — tree changed, state did not, WCAG 4.1.2.
 *
 * A caveat the caller must respect: CDP reassigns AXNodeIds when a subtree is
 * rebuilt, so `nodesAdded` and `nodesRemoved` can both be large for a page that
 * merely re-rendered. `idStability` reports what fraction of the before-ids
 * survived; when it is low, trust `sizeDelta` over the add/remove lists.
 */
export function diffTrees(before: AxTree, after: AxTree): TreeDiff {
  const beforeIds = Object.keys(before);
  const afterIds = Object.keys(after);

  const nodesAdded: AxNode[] = [];
  const nodesRemoved: AxNode[] = [];
  const changedProps: ChangedProp[] = [];
  let retained = 0;

  for (const id of afterIds) {
    if (!(id in before)) nodesAdded.push(after[id]);
  }

  for (const id of beforeIds) {
    const previous = before[id];
    const next = after[id];
    if (!next) {
      nodesRemoved.push(previous);
      continue;
    }
    retained += 1;
    for (const prop of AX_STATE_PROPS) {
      const from = previous.props[prop] ?? null;
      const to = next.props[prop] ?? null;
      if (from === to) continue;
      changedProps.push({
        nodeId: id,
        role: next.role ?? previous.role,
        name: next.name ?? previous.name,
        prop,
        before: from,
        after: to,
      });
    }
  }

  return {
    nodesAdded,
    nodesRemoved,
    changedProps,
    addedCount: nodesAdded.length,
    removedCount: nodesRemoved.length,
    changedCount: changedProps.length,
    sizeDelta: afterIds.length - beforeIds.length,
    idStability: beforeIds.length === 0 ? 1 : retained / beforeIds.length,
  };
}

/** Convenience: diff the two trees a path result already carries. */
export function diffPathResult(result: PathResult): TreeDiff {
  return diffTrees(result.treeBefore, result.treeAfter);
}

/* ------------------------------------------------------------------ */
/* Internals                                                            */
/* ------------------------------------------------------------------ */

let cachedAxeSource: Buffer | null | undefined;

/**
 * Get axe.min.js to upload into the sandbox.
 *
 * Tried in order: the installed dependency, then the pinned CDN — fetched HERE,
 * on the host, not in the sandbox. A live probe showed the sandbox reaching the
 * audited site but failing to reach cdnjs, so relying on sandbox egress for the
 * rule engine loses every deterministic finding (A3.2) with only a warning.
 * The host has network; use it, and upload the bytes.
 *
 * Null only when both fail, in which case the worker's own CDN attempt is the
 * last resort and axe violations may legitimately be empty.
 */
async function loadAxeSource(): Promise<Buffer | null> {
  if (cachedAxeSource !== undefined) return cachedAxeSource;

  const candidates = [
    path.join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js'),
    path.join(process.cwd(), 'node_modules', 'axe-core', 'axe.js'),
  ];
  for (const candidate of candidates) {
    try {
      cachedAxeSource = await readFile(candidate);
      return cachedAxeSource;
    } catch {
      // Try the next candidate.
    }
  }

  try {
    const response = await fetch(AXE_CORE_CDN_URL);
    if (response.ok) {
      cachedAxeSource = Buffer.from(await response.arrayBuffer());
      return cachedAxeSource;
    }
  } catch {
    // Fall through to null; the worker will try the CDN itself.
  }

  cachedAxeSource = null;
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'page';
  }
}

function tail(stdout: string, limit = 4000): string {
  return stdout.length <= limit ? stdout : stdout.slice(stdout.length - limit);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => issue.path.join('.') + ': ' + issue.message)
    .join('; ');
}
