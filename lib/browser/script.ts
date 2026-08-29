/**
 * The worker that runs INSIDE a browser sandbox.
 *
 * It is held as a string and uploaded rather than imported, because it executes
 * in a different process on a different machine with a different module graph:
 * it needs `playwright-core` from the Playwright image, which the Next.js app
 * neither has nor wants as a dependency.
 *
 * Conventions the source below obeys, deliberately:
 *  - CommonJS, so NODE_PATH resolution to the image's global modules works.
 *    ESM ignores NODE_PATH, which would make `playwright-core` unresolvable.
 *  - No template literals and no backticks, so the source can live inside a
 *    TypeScript template literal without escaping.
 *  - One JSON blob on stdout between two delimiters, so the host can parse it
 *    past whatever npm, Chromium, or the shell decided to print first.
 *  - Artifacts (screenshots) are written to the sandbox filesystem and only
 *    referenced by path in the JSON. A9.2 forbids carrying them through context.
 */

import {
  AXE_CORE_CDN_URL,
  CHROMIUM_LAUNCH_ARGS,
  PLAYWRIGHT_BROWSERS_ROOT,
  SANDBOX_WORK_DIR,
} from '@/lib/sandbox/config';
import type { InteractionPath } from './types';

/** Delimiters framing the JSON blob on stdout. */
export const RESULT_BEGIN = '__ACCESSIFIX_RESULT_BEGIN__';
export const RESULT_END = '__ACCESSIFIX_RESULT_END__';

export const WORKER_REMOTE_PATH = SANDBOX_WORK_DIR + '/worker.cjs';
export const JOB_REMOTE_PATH = SANDBOX_WORK_DIR + '/job.json';
export const AXE_REMOTE_PATH = SANDBOX_WORK_DIR + '/axe.min.js';
export const OUTPUT_REMOTE_DIR = SANDBOX_WORK_DIR + '/out';
export const RESULT_REMOTE_PATH = OUTPUT_REMOTE_DIR + '/result.json';
export const SCREENSHOT_REMOTE_PATH = OUTPUT_REMOTE_DIR + '/page.png';

/** Playwright npm package version pinned to the image tag in config.ts. */
export const PLAYWRIGHT_CORE_VERSION = '1.56.0';

/** The job payload the worker reads from argv[2]. */
export interface BrowserJob {
  url: string;
  outputDir: string;
  browsersRoot: string;
  launchArgs: string[];
  /** Capture tree, screenshot, axe, and links for the landing state. */
  capture: boolean;
  screenshot: boolean;
  axe: boolean;
  /** Embed screenshot base64 in the JSON. Off by default: the host downloads the PNG. */
  inlineScreenshots: boolean;
  /** Take a post-action screenshot for each path. Off by default; it is expensive. */
  pathScreenshots: boolean;
  axePath: string | null;
  axeUrl: string | null;
  paths: InteractionPath[];
  navTimeoutMs: number;
  actionTimeoutMs: number;
  settleMs: number;
  viewport: { width: number; height: number };
  maxLinks: number;
}

export function defaultJob(url: string, overrides: Partial<BrowserJob> = {}): BrowserJob {
  return {
    url,
    outputDir: OUTPUT_REMOTE_DIR,
    browsersRoot: PLAYWRIGHT_BROWSERS_ROOT,
    launchArgs: [...CHROMIUM_LAUNCH_ARGS],
    capture: true,
    screenshot: true,
    axe: true,
    inlineScreenshots: false,
    pathScreenshots: false,
    axePath: AXE_REMOTE_PATH,
    axeUrl: AXE_CORE_CDN_URL,
    paths: [],
    navTimeoutMs: 45_000,
    actionTimeoutMs: 10_000,
    settleMs: 600,
    viewport: { width: 1280, height: 900 },
    maxLinks: 200,
    ...overrides,
  };
}

/**
 * The shell command that runs the worker.
 *
 * `playwright-core` is resolved from the image's global modules when present and
 * installed only if it is not — the browsers themselves are always already in
 * /ms-playwright, so this never downloads a browser.
 */
export function buildLaunchCommand(
  workerPath: string = WORKER_REMOTE_PATH,
  jobPath: string = JOB_REMOTE_PATH,
): string {
  return [
    'export NODE_PATH="$(npm root -g)"',
    'node -e "require.resolve(\'playwright-core\')" >/dev/null 2>&1 || ' +
      'npm install -g --no-audit --no-fund playwright-core@' +
      PLAYWRIGHT_CORE_VERSION +
      ' >/dev/null 2>&1',
    'node ' + workerPath + ' ' + jobPath,
  ].join('; ');
}

/**
 * Pull the JSON blob out of a stdout stream.
 * Returns null when the delimiters are absent or unbalanced — the host treats
 * that as a failed run rather than guessing.
 */
export function extractResultJson(stdout: string): string | null {
  const start = stdout.indexOf(RESULT_BEGIN);
  if (start === -1) return null;
  const end = stdout.indexOf(RESULT_END, start + RESULT_BEGIN.length);
  if (end === -1) return null;
  return stdout.slice(start + RESULT_BEGIN.length, end).trim() || null;
}

/**
 * The worker source. CommonJS, no backticks, no template literals.
 * Uploaded to WORKER_REMOTE_PATH and run by buildLaunchCommand().
 */
export const BROWSER_WORKER_SOURCE = `'use strict';
/* AccessiFix browser worker. Generated from lib/browser/script.ts. */

var fs = require('node:fs');
var path = require('node:path');

var BEGIN = '${RESULT_BEGIN}';
var END = '${RESULT_END}';

var STATE_PROPS = ['expanded', 'checked', 'selected', 'pressed', 'focused', 'disabled'];

/* The author-side attributes read from the control itself, before and after. */
var STATE_ATTRS = [
  'aria-expanded', 'aria-checked', 'aria-selected', 'aria-pressed', 'aria-current',
  'aria-haspopup', 'aria-controls', 'aria-modal', 'aria-hidden', 'aria-disabled',
  'aria-describedby', 'aria-invalid', 'disabled', 'open', 'role', 'type', 'href'
];

var TRIGGER_MARK = 'data-accessifix-trigger';

function loadPlaywright() {
  var candidates = [
    'playwright-core',
    'playwright',
    '/usr/lib/node_modules/playwright-core',
    '/usr/local/lib/node_modules/playwright-core',
    '/usr/lib/node_modules/playwright',
    '/usr/local/lib/node_modules/playwright'
  ];
  var tried = [];
  for (var i = 0; i < candidates.length; i++) {
    try {
      return require(candidates[i]);
    } catch (error) {
      tried.push(candidates[i]);
    }
  }
  throw new Error('playwright-core is not resolvable in this sandbox. Tried: ' + tried.join(', '));
}

/*
 * The chromium directory under /ms-playwright is version-stamped, so it has to
 * be discovered rather than hard-coded. The full build is preferred over the
 * headless shell because the shell cannot take full-page screenshots reliably.
 */
function findChromiumExecutable(root) {
  var entries = fs.readdirSync(root);
  var full = [];
  var shells = [];
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].indexOf('chromium') !== 0) continue;
    if (entries[i].indexOf('headless_shell') === -1) full.push(entries[i]);
    else shells.push(entries[i]);
  }
  var ordered = full.concat(shells);
  for (var j = 0; j < ordered.length; j++) {
    var options = [
      path.join(root, ordered[j], 'chrome-linux', 'chrome'),
      path.join(root, ordered[j], 'chrome-linux', 'headless_shell')
    ];
    for (var k = 0; k < options.length; k++) {
      if (fs.existsSync(options[k])) return options[k];
    }
  }
  throw new Error('No chromium build under ' + root + '. Present: ' + entries.join(','));
}

function axValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'value')) return axValue(value.value);
    try { return JSON.stringify(value); } catch (error) { return String(value); }
  }
  return String(value);
}

/* nodeId -> { nodeId, role, name, props } */
function normaliseTree(nodes) {
  var tree = {};
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var props = {};
    for (var p = 0; p < STATE_PROPS.length; p++) props[STATE_PROPS[p]] = null;
    var properties = node.properties || [];
    for (var q = 0; q < properties.length; q++) {
      var entry = properties[q];
      if (STATE_PROPS.indexOf(entry.name) === -1) continue;
      props[entry.name] = axValue(entry.value);
    }
    var childIds = [];
    var rawChildren = node.childIds || [];
    for (var c = 0; c < rawChildren.length; c++) childIds.push(String(rawChildren[c]));
    tree[String(node.nodeId)] = {
      nodeId: String(node.nodeId),
      role: node.role ? axValue(node.role) : null,
      name: node.name ? axValue(node.name) : null,
      ignored: node.ignored === true,
      backendDomNodeId: typeof node.backendDOMNodeId === 'number' ? node.backendDOMNodeId : null,
      childIds: childIds,
      props: props
    };
  }
  return tree;
}

async function snapshotTree(cdp) {
  try { await cdp.send('Accessibility.enable'); } catch (error) { /* already enabled */ }
  var response = await cdp.send('Accessibility.getFullAXTree');
  return normaliseTree(response && response.nodes ? response.nodes : []);
}

async function gotoSafe(page, url, navTimeoutMs, settleMs, warnings) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: navTimeoutMs });
    return;
  } catch (error) {
    warnings.push('networkidle never settled for ' + url + ': ' + error.message);
  }
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
  await page.waitForTimeout(settleMs);
}

async function loadAxeSource(job, warnings) {
  var localCandidates = [];
  if (job.axePath) localCandidates.push(job.axePath);
  localCandidates.push('/usr/lib/node_modules/axe-core/axe.min.js');
  localCandidates.push('/usr/local/lib/node_modules/axe-core/axe.min.js');
  for (var i = 0; i < localCandidates.length; i++) {
    try {
      if (fs.existsSync(localCandidates[i])) return fs.readFileSync(localCandidates[i], 'utf8');
    } catch (error) { /* try the next candidate */ }
  }
  if (job.axeUrl) {
    try {
      var response = await fetch(job.axeUrl);
      if (response.ok) return await response.text();
      warnings.push('axe-core CDN returned ' + response.status);
    } catch (error) {
      warnings.push('axe-core CDN fetch failed: ' + error.message);
    }
  }
  return null;
}

async function runAxe(page, source, warnings) {
  // Returns violations plus a ran flag. An empty violations array from a
  // page where axe never executed is indistinguishable from a clean page,
  // and reporting that as a pass is the worst result this tool can produce.
  // Only a completed run sets ran to true.
  if (!source) {
    warnings.push('axe-core source unavailable; no deterministic violations collected');
    return { violations: [], ran: false };
  }
  try {
    await page.addScriptTag({ content: source });
    var violations = await page.evaluate(function () {
      if (!window.axe) return [];
      return window.axe.run(document, { resultTypes: ['violations'] }).then(function (results) {
        return results.violations || [];
      });
    });
    var out = [];
    for (var i = 0; i < violations.length; i++) {
      var v = violations[i];
      var nodes = [];
      var raw = v.nodes || [];
      for (var j = 0; j < raw.length && j < 10; j++) {
        nodes.push({
          target: (raw[j].target || []).map(String),
          html: String(raw[j].html || '').slice(0, 400),
          failureSummary: raw[j].failureSummary ? String(raw[j].failureSummary).slice(0, 600) : null
        });
      }
      out.push({
        id: String(v.id || ''),
        impact: v.impact ? String(v.impact) : null,
        help: String(v.help || ''),
        description: String(v.description || ''),
        helpUrl: String(v.helpUrl || ''),
        tags: (v.tags || []).map(String),
        nodes: nodes
      });
    }
    return { violations: out, ran: true };
  } catch (error) {
    warnings.push('axe-core run failed: ' + error.message);
    return { violations: [], ran: false };
  }
}

async function takeScreenshot(page, filePath, inline, warnings) {
  var buffer = null;
  try {
    buffer = await page.screenshot({ fullPage: true, type: 'png', timeout: 30000 });
  } catch (error) {
    warnings.push('full-page screenshot failed, falling back to viewport: ' + error.message);
    try {
      buffer = await page.screenshot({ fullPage: false, type: 'png', timeout: 15000 });
    } catch (inner) {
      warnings.push('screenshot failed: ' + inner.message);
      return null;
    }
  }
  try {
    fs.writeFileSync(filePath, buffer);
  } catch (error) {
    warnings.push('could not write screenshot to ' + filePath + ': ' + error.message);
    return { path: null, bytes: buffer.length, base64: buffer.toString('base64') };
  }
  return {
    path: filePath,
    bytes: buffer.length,
    base64: inline ? buffer.toString('base64') : null
  };
}

async function collectLinks(page, maxLinks, warnings) {
  try {
    var links = await page.evaluate(function () {
      var origin = window.location.origin;
      var seen = {};
      var out = [];
      var anchors = document.querySelectorAll('a[href]');
      for (var i = 0; i < anchors.length; i++) {
        var href = anchors[i].getAttribute('href');
        if (!href) continue;
        var resolved = null;
        try { resolved = new URL(href, window.location.href); } catch (error) { continue; }
        if (resolved.origin !== origin) continue;
        if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
        resolved.hash = '';
        var value = resolved.toString();
        if (seen[value]) continue;
        seen[value] = true;
        out.push(value);
      }
      return out;
    });
    return links.slice(0, maxLinks);
  } catch (error) {
    warnings.push('link collection failed: ' + error.message);
    return [];
  }
}

/*
 * Absent elements still carry the full attribute key set, every value null.
 * A consumer asking for attributes['aria-expanded'] must be able to tell
 * "the author never set it" from "we never looked", and undefined does neither.
 */
function emptyElementState() {
  var attributes = {};
  for (var i = 0; i < STATE_ATTRS.length; i++) attributes[STATE_ATTRS[i]] = null;
  return { present: false, tagName: null, role: null, text: null, attributes: attributes };
}

async function readElementState(page, selector, actionTimeoutMs) {
  try {
    var locator = page.locator(selector).first();
    var count = await locator.count();
    if (count === 0) return emptyElementState();
    return await locator.evaluate(function (element, names) {
      var attributes = {};
      for (var i = 0; i < names.length; i++) {
        attributes[names[i]] = element.hasAttribute(names[i]) ? element.getAttribute(names[i]) : null;
      }
      var text = (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
      return {
        present: true,
        tagName: element.tagName ? element.tagName.toLowerCase() : null,
        role: element.getAttribute('role'),
        text: text,
        attributes: attributes
      };
    }, STATE_ATTRS, { timeout: actionTimeoutMs });
  } catch (error) {
    return emptyElementState();
  }
}

async function markTrigger(page, selector, actionTimeoutMs) {
  try {
    var locator = page.locator(selector).first();
    await locator.evaluate(function (element, mark) {
      element.setAttribute(mark, '1');
    }, TRIGGER_MARK, { timeout: actionTimeoutMs });
    return true;
  } catch (error) {
    return false;
  }
}

async function describeActiveElement(page, mark) {
  try {
    return await page.evaluate(function (triggerMark) {
      var element = document.activeElement;
      if (!element || element === document.body) {
        return { present: false, tagName: null, role: null, text: null, insideDialog: false, isTrigger: false };
      }
      var insideDialog = false;
      try {
        insideDialog = !!element.closest('[role="dialog"], [role="alertdialog"], dialog');
      } catch (error) { insideDialog = false; }
      return {
        present: true,
        tagName: element.tagName ? element.tagName.toLowerCase() : null,
        role: element.getAttribute ? element.getAttribute('role') : null,
        text: (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
        insideDialog: insideDialog,
        isTrigger: element.hasAttribute ? element.hasAttribute(triggerMark) : false
      };
    }, mark);
  } catch (error) {
    return null;
  }
}

async function countVisibleDialogs(page) {
  try {
    return await page.evaluate(function () {
      var nodes = document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]');
      var visible = 0;
      for (var i = 0; i < nodes.length; i++) {
        var rect = nodes[i].getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) visible += 1;
      }
      return visible;
    });
  } catch (error) {
    return 0;
  }
}

async function collectFormErrors(page) {
  try {
    return await page.evaluate(function () {
      function textOf(element) {
        return (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
      }
      var alerts = document.querySelectorAll('[role="alert"], [aria-live="assertive"], [aria-live="polite"]');
      var messages = [];
      for (var i = 0; i < alerts.length && i < 10; i++) {
        var text = textOf(alerts[i]);
        if (text) messages.push(text);
      }
      var invalid = document.querySelectorAll('[aria-invalid="true"], :invalid');
      var described = 0;
      for (var j = 0; j < invalid.length; j++) {
        if (invalid[j].getAttribute && invalid[j].getAttribute('aria-describedby')) described += 1;
      }
      return {
        liveRegionCount: alerts.length,
        announcedMessages: messages,
        invalidCount: invalid.length,
        invalidWithDescription: described
      };
    });
  } catch (error) {
    return { liveRegionCount: 0, announcedMessages: [], invalidCount: 0, invalidWithDescription: 0 };
  }
}

async function performAction(page, interaction, actionTimeoutMs) {
  var locator = page.locator(interaction.selector).first();
  var options = { timeout: actionTimeoutMs };
  if (interaction.action === 'click') return locator.click(options);
  if (interaction.action === 'hover') return locator.hover(options);
  if (interaction.action === 'focus') return locator.focus(options);
  if (interaction.action === 'key') return locator.press(interaction.key || 'Enter', options);
  throw new Error('unsupported action: ' + String(interaction.action));
}

/*
 * One interaction path, at depth one (A4.6).
 *
 * The page is reloaded first so paths never contaminate each other, then the
 * tree and the control's own attributes are read on both sides of the action.
 * The comparison itself happens on the host, in runner.diffTrees.
 */
async function runPath(page, cdp, job, interaction, index, warnings) {
  var started = Date.now();
  var result = {
    path: interaction,
    ok: false,
    error: null,
    treeBefore: {},
    treeAfter: {},
    stateBefore: null,
    stateAfter: null,
    observations: {},
    screenshot: null,
    durationMs: 0
  };
  try {
    await gotoSafe(page, job.url, job.navTimeoutMs, job.settleMs, warnings);
    result.treeBefore = await snapshotTree(cdp);
    result.stateBefore = await readElementState(page, interaction.selector, job.actionTimeoutMs);
    if (!result.stateBefore.present) {
      throw new Error('selector matched no element: ' + interaction.selector);
    }
    var marked = await markTrigger(page, interaction.selector, job.actionTimeoutMs);
    result.observations.triggerMarked = marked;

    await performAction(page, interaction, job.actionTimeoutMs);
    await page.waitForTimeout(job.settleMs);

    result.treeAfter = await snapshotTree(cdp);

    /*
     * Read the "after" state through the marker rather than the original
     * selector. A text= or :has-text() selector stops matching the moment the
     * control's label changes, and 4.1.2 is about THIS element's own state on
     * both sides of the action, so it must be the same DOM node both times.
     */
    if (marked) {
      result.stateAfter = await readElementState(page, '[' + TRIGGER_MARK + ']', job.actionTimeoutMs);
      result.observations.stateAfterReadVia = 'trigger-mark';
    }
    if (!marked || !result.stateAfter.present) {
      result.stateAfter = await readElementState(page, interaction.selector, job.actionTimeoutMs);
      result.observations.stateAfterReadVia = 'selector';
    }

    if (interaction.template === 'dialog') {
      result.observations.dialogsVisibleAfterOpen = await countVisibleDialogs(page);
      result.observations.focusAfterOpen = await describeActiveElement(page, TRIGGER_MARK);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(job.settleMs);
      result.observations.dialogsVisibleAfterEscape = await countVisibleDialogs(page);
      var afterEscape = await describeActiveElement(page, TRIGGER_MARK);
      result.observations.focusAfterEscape = afterEscape;
      result.observations.focusReturnedToTrigger = !!(afterEscape && afterEscape.isTrigger);
      result.observations.treeAfterEscape = await snapshotTree(cdp);
    } else if (interaction.template === 'form') {
      result.observations.formErrors = await collectFormErrors(page);
      result.observations.focusAfterSubmit = await describeActiveElement(page, TRIGGER_MARK);
    }

    if (job.pathScreenshots) {
      var file = path.join(job.outputDir, 'path-' + String(index) + '.png');
      result.screenshot = await takeScreenshot(page, file, false, warnings);
    }
    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.error = error && error.message ? error.message : String(error);
  }
  result.durationMs = Date.now() - started;
  return result;
}

async function main() {
  var jobPath = process.argv[2];
  if (!jobPath) throw new Error('usage: node worker.cjs <job.json>');
  var job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));

  var warnings = [];
  var timings = {};
  var result = {
    ok: false,
    error: null,
    requestedUrl: job.url,
    finalUrl: '',
    title: '',
    axTree: {},
    screenshot: null,
    axeViolations: [],
    axeRan: false,
    links: [],
    paths: [],
    timings: timings,
    warnings: warnings
  };

  try { fs.mkdirSync(job.outputDir, { recursive: true }); } catch (error) { /* exists */ }

  var browser = null;
  try {
    var playwright = loadPlaywright();
    var executablePath = findChromiumExecutable(job.browsersRoot || '/ms-playwright');
    var launchStarted = Date.now();
    browser = await playwright.chromium.launch({
      executablePath: executablePath,
      args: job.launchArgs || ['--no-sandbox', '--disable-dev-shm-usage']
    });
    timings.launchMs = Date.now() - launchStarted;

    var context = await browser.newContext({ viewport: job.viewport || { width: 1280, height: 900 } });
    var page = await context.newPage();
    page.setDefaultTimeout(job.actionTimeoutMs || 10000);
    page.setDefaultNavigationTimeout(job.navTimeoutMs || 45000);

    var cdp = await context.newCDPSession(page);
    try { await cdp.send('DOM.enable'); } catch (error) { /* optional */ }
    await cdp.send('Accessibility.enable');

    var navStarted = Date.now();
    await gotoSafe(page, job.url, job.navTimeoutMs, job.settleMs, warnings);
    timings.navigationMs = Date.now() - navStarted;

    result.finalUrl = page.url();
    try { result.title = await page.title(); } catch (error) { result.title = ''; }

    if (job.capture !== false) {
      var treeStarted = Date.now();
      result.axTree = await snapshotTree(cdp);
      timings.treeMs = Date.now() - treeStarted;
      result.links = await collectLinks(page, job.maxLinks || 200, warnings);
    }

    if (job.screenshot !== false) {
      var shotStarted = Date.now();
      result.screenshot = await takeScreenshot(
        page,
        path.join(job.outputDir, 'page.png'),
        job.inlineScreenshots === true,
        warnings
      );
      timings.screenshotMs = Date.now() - shotStarted;
    }

    if (job.axe !== false) {
      var axeStarted = Date.now();
      var axeSource = await loadAxeSource(job, warnings);
      var axeOutcome = await runAxe(page, axeSource, warnings);
      result.axeViolations = axeOutcome.violations;
      result.axeRan = axeOutcome.ran;
      timings.axeMs = Date.now() - axeStarted;
    }

    var paths = job.paths || [];
    if (paths.length > 0) {
      var pathsStarted = Date.now();
      for (var i = 0; i < paths.length; i++) {
        result.paths.push(await runPath(page, cdp, job, paths[i], i, warnings));
      }
      timings.pathsMs = Date.now() - pathsStarted;
    }

    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.error = error && error.message ? error.message : String(error);
  } finally {
    if (browser) {
      try { await browser.close(); } catch (error) { /* nothing useful to do */ }
    }
  }

  var json = JSON.stringify(result);
  try {
    fs.writeFileSync(path.join(job.outputDir, 'result.json'), json);
  } catch (error) {
    warnings.push('could not write result.json: ' + error.message);
  }

  console.log(BEGIN);
  console.log(json);
  console.log(END);
}

main().catch(function (error) {
  var json = JSON.stringify({
    ok: false,
    error: error && error.message ? error.message : String(error),
    requestedUrl: '',
    finalUrl: '',
    title: '',
    axTree: {},
    screenshot: null,
    axeViolations: [],
    axeRan: false,
    links: [],
    paths: [],
    timings: {},
    warnings: []
  });
  console.log(BEGIN);
  console.log(json);
  console.log(END);
  process.exitCode = 1;
});
`;
