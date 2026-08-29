/**
 * Sandbox sizing and budget constants.
 *
 * Every number here was measured on 2026-08-29 against the real Daytona API.
 * Treat this file as the single source of truth: nothing else in the codebase
 * should hard-code an image name, a CPU count, or a crawl cap.
 */

/** Resource allocation accepted by Daytona. Memory and disk are GiB, cpu is cores. */
export interface SandboxResources {
  cpu: number;
  memory: number;
  disk: number;
}

export type SandboxKind = 'browser' | 'build';

/**
 * Browser image.
 *
 * Verified: Chromium launches and drives pages headless at 2 CPU / 2 GB on this
 * tag. The tag is pinned because the browser binaries under /ms-playwright are
 * version-stamped — bumping the image changes BROWSER_ROOT's directory names.
 */
export const BROWSER_IMAGE = 'mcr.microsoft.com/playwright:v1.56.0-noble' as const;

/**
 * Build image.
 *
 * Verified: the default Daytona snapshot image has no zsh, so `executeCommand`
 * dies with `fork/exec /usr/bin/zsh: no such file or directory`. Any custom
 * image with a real shell fixes it; node:22-bookworm also ships the Node and
 * npm that `next build` needs, and cloned + installed + built Clearway in 53s.
 */
export const BUILD_IMAGE = 'node:22-bookworm' as const;

/**
 * Browser sandbox size.
 *
 * Verified: Chromium runs comfortably at 2 CPU / 2 GB. Going smaller is not
 * worth testing — the CDP accessibility tree read is the workload, and it is
 * memory-bound on the renderer. 5 GB of disk is headroom for screenshots.
 */
export const BROWSER_RESOURCES: SandboxResources = { cpu: 2, memory: 2, disk: 5 };

/**
 * Build sandbox size.
 *
 * Verified: below 8 GB, `next build` is OOM-killed during the TypeScript check.
 * 8 GB is a floor, not a preference (requirement A6.1 states it as a minimum).
 * 4 cores keeps the type-check and the test suite inside the demo budget.
 */
export const BUILD_RESOURCES: SandboxResources = { cpu: 4, memory: 8, disk: 10 };

/**
 * Daytona rejects `resources` when the sandbox is created from the default
 * snapshot: "Cannot specify Sandbox resources when using a snapshot". Passing a
 * custom image via `Image.base(...)` is therefore mandatory, not stylistic.
 * This flag exists so the reason is greppable from the call site.
 */
export const RESOURCES_REQUIRE_CUSTOM_IMAGE = true as const;

/**
 * Concurrency cap.
 *
 * The Daytona account is Tier 2: a pool of 100 vCPU / 200 GiB. At 2 vCPU per
 * browser sandbox the hard ceiling is ~50 concurrent browsers, CPU-bound rather
 * than memory-bound, and one build sandbox (4 vCPU) must stay reserved. The
 * practical default is 10: provisioning latency, not the quota, is what limits
 * a demo run, and 10 parallel frames is already more than the run view can show
 * legibly (A11.1).
 *
 * Never derive this from `nproc` inside a sandbox — `nproc` reports the HOST's
 * core count (64 observed), not the sandbox's configured cap.
 */
export const DEFAULT_MAX_CONCURRENT_SANDBOXES = 10;

/** Tier 2 pool ceiling, for the summary bar and for sanity-checking an override. */
export const TIER_2_POOL_VCPU = 100;
export const TIER_2_POOL_MEMORY_GIB = 200;

/**
 * Hard ceiling on interaction paths enumerated per page (A4.1).
 *
 * A page with a large nav can expose hundreds of candidate controls. 40 keeps
 * one page's ACT work inside a single browser sandbox's useful lifetime; the
 * excess is truncated deliberately rather than queued forever.
 */
export const MAX_INTERACTION_PATHS_PER_PAGE = 40;

/**
 * Crawl cap (A2.2). Same-origin links only; 25 pages is the point at which a
 * baseline run still finishes inside the demo window.
 */
export const MAX_PAGES_PER_CRAWL = 25;

/**
 * Interaction depth (A4.6). One. The system opens a control and reads the tree
 * on both sides — it does NOT then explore what the control revealed. Combinatorial
 * exploration is explicitly out of scope, and this constant is the enforcement point.
 */
export const INTERACTION_DEPTH = 1;

/**
 * Where the Playwright image keeps its browser binaries. The chromium directory
 * is version-stamped (e.g. `chromium-1200`), so it must be discovered at runtime
 * with readdirSync rather than hard-coded.
 */
export const PLAYWRIGHT_BROWSERS_ROOT = '/ms-playwright';

/**
 * Chromium flags.
 *
 * `--no-sandbox` because the container is already the sandbox and has no user
 * namespaces; `--disable-dev-shm-usage` because /dev/shm is 64 MB in a container
 * and Chromium will crash on a large page without it; `--disable-quic` because a
 * live probe surfaced `net::ERR_QUIC_PROTOCOL_ERROR` from a sandbox, and a
 * target that fails only over HTTP/3 should fall back to TCP rather than be
 * reported as unreachable.
 *
 * Sandbox egress is narrower than it looks: the audited Vercel target resolved
 * and loaded, while cdnjs and w3.org were reset. Treat any third-party fetch
 * from inside a sandbox as unavailable and upload what the worker needs.
 */
export const CHROMIUM_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-quic',
] as const;

/** Working tree inside every sandbox. Artifacts are written here, then downloaded (A9.2). */
export const SANDBOX_WORK_DIR = '/workspace/accessifix';

/** Timeouts, in seconds, for the host side of a sandbox interaction. */
/*
 * Generous on purpose.
 *
 * Every one of these kills work that is already in flight and already paid
 * for. `npm install` on a large repository, a cold Playwright image pull, a
 * screenshot upload on a slow link - none of them are wrong just because they
 * are slow, and a run that dies at minute five has to start again from zero.
 *
 * Waiting is cheap. Abandoning a half-finished audit is not.
 */
export const SANDBOX_CREATE_TIMEOUT_SEC = 600;
export const SANDBOX_COMMAND_TIMEOUT_SEC = 1_800;
export const SANDBOX_FILE_TIMEOUT_SEC = 600;

/**
 * Lifecycle guards. A leaked sandbox burns the pool quota, so every sandbox is
 * given a wall-clock TTL and an auto-delete interval even though `withSandbox`
 * already destroys in a finally block. Belt and braces, because the finally
 * block does not run if the Node process is killed mid-run.
 */
export const BROWSER_SANDBOX_LIFECYCLE = {
  /** Minutes of inactivity before Daytona stops the sandbox. */
  autoStopInterval: 10,
  /** Minutes after stopping before Daytona deletes it. */
  autoDeleteInterval: 15,
  /** Wall-clock minutes from creation before destruction, whatever the state. */
  ttlMinutes: 30,
} as const;

export const BUILD_SANDBOX_LIFECYCLE = {
  autoStopInterval: 20,
  autoDeleteInterval: 30,
  ttlMinutes: 60,
} as const;

/**
 * axe-core version injected in-page, matched to the dependency in package.json.
 *
 * jsDelivr, not cdnjs: cdnjs stops at 4.10.3 and 404s on anything newer, which
 * silently produced zero deterministic violations in a live probe. jsDelivr
 * serves any published npm version. The CDN is only a fallback — the runner
 * uploads axe.min.js from the host, because sandbox egress reached the audited
 * site but could not reach either CDN.
 */
export const AXE_CORE_VERSION = '4.11.0';
export const AXE_CORE_CDN_URL =
  'https://cdn.jsdelivr.net/npm/axe-core@' + AXE_CORE_VERSION + '/axe.min.js';

export function resourcesFor(kind: SandboxKind): SandboxResources {
  return kind === 'build' ? BUILD_RESOURCES : BROWSER_RESOURCES;
}

export function imageFor(kind: SandboxKind): string {
  return kind === 'build' ? BUILD_IMAGE : BROWSER_IMAGE;
}
