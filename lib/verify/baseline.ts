/**
 * Baselining the target's test suite, and comparing the two runs (A6.4).
 *
 * A6.4 says a failing suite stops the run. Read as "any red test blocks", that
 * rule refuses every pull request on every repository that already has one
 * broken test — which is most of them, and which is exactly what happened on
 * the reference target: `packet-flow.test.tsx` fails on clean `main`, and a
 * perfectly good accessibility patch was rejected for it.
 *
 * The rule A6.4 is actually stating is narrower and stronger: **a test we broke
 * blocks**. To say that you have to know what was already broken, so VERIFY
 * runs the suite twice — once on the base tree, once on the patched tree — and
 * compares them *per test*, not on the exit code.
 *
 *   failed before, fails now   → pre-existing. Reported, does not block.
 *   passed before, fails now   → a regression. Blocks, absolutely.
 *   failed before, passes now  → an incidental improvement. Reported.
 *   fails now, unknown before  → the patch brought it. Blocks.
 *
 * The last line is the one that keeps this from becoming a way to wave failures
 * through: anything failing now that cannot be *matched* to a failure in the
 * baseline is treated as ours. Absence of evidence is never read as evidence,
 * and where the baseline cannot be compared at all (`comparable: false`) the
 * caller falls back to the old behaviour — any failure blocks — and says why.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PER-TEST IDENTITY RELIES ON
 *
 * Both runs are parsed by the code in this file, so the identity only has to be
 * stable between two runs of the same runner, not portable across runners. It
 * is `<repo-relative file> > <describe blocks…> > <test name>`.
 *
 *  - From JSON (`vitest --reporter=json`, `jest --json`, which share a shape):
 *    the file comes from `testResults[].name` with the sandbox clone directory
 *    stripped, and the name from `assertionResults[].ancestorTitles` + `title`.
 *    `fullName` is only a fallback, because its join character has differed
 *    between runners and versions and it is not needed when the parts are there.
 *  - From text (the fallback, when a repository's config refuses to emit JSON):
 *    vitest and jest both print one `FAIL <file> > <name>` line per failing
 *    test, and that line is the whole of what is parsed. A `FAIL` line with no
 *    ` > ` in it names a file rather than a test, so it is discarded — matching
 *    on a file alone would let a *different* broken test in an already-broken
 *    file count as pre-existing.
 *
 * Text output lists failures only, never passes, so a text baseline cannot tell
 * "passed before" from "did not exist before". Both block, which is the safe
 * direction. The two runs must also be read the same way: a JSON run is never
 * compared against a text run.
 */

export type TestCaseStatus = 'passed' | 'failed' | 'skipped';

export interface TestCaseResult {
  /** Identity across the two runs: `<file> > <describe…> > <test>`. */
  readonly id: string;
  /** Repository-relative path of the test file, forward slashes. */
  readonly file: string;
  /** The test's name, including its describe blocks. */
  readonly name: string;
  readonly status: TestCaseStatus;
  /** First line of the failure, trimmed. Null when it passed. */
  readonly message: string | null;
}

export interface TestTotals {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

/** How a run's per-test detail was obtained. `none` means there was none. */
export type CaseSource = 'json' | 'text' | 'none';

export interface ParsedTestReport {
  readonly cases: readonly TestCaseResult[];
  readonly totals: TestTotals;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Parse the JSON that `vitest --reporter=json` and `jest --json` both emit.
 *
 * Vitest's reporter is a deliberate copy of jest's, so one parser covers both:
 * `{ testResults: [{ name, assertionResults: [{ ancestorTitles, title, status,
 * failureMessages }] }] }`. Everything is read defensively — a runner that
 * writes a shape this does not recognise returns null, which the caller treats
 * as "no per-test detail", not as "no failures".
 */
export function parseJsonTestReport(raw: string, repoDir?: string): ParsedTestReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const files = (parsed as { testResults?: unknown }).testResults;
  if (!Array.isArray(files)) return null;

  const cases: TestCaseResult[] = [];
  for (const entry of files) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { name?: unknown; assertionResults?: unknown };
    const file = relativeTestFile(typeof record.name === 'string' ? record.name : '', repoDir);
    const assertions = record.assertionResults;
    if (!Array.isArray(assertions)) continue;

    for (const assertion of assertions) {
      if (typeof assertion !== 'object' || assertion === null) continue;
      const a = assertion as {
        ancestorTitles?: unknown;
        title?: unknown;
        fullName?: unknown;
        status?: unknown;
        failureMessages?: unknown;
      };

      const ancestors = Array.isArray(a.ancestorTitles)
        ? a.ancestorTitles.filter((t): t is string => typeof t === 'string' && t.length > 0)
        : [];
      const title = typeof a.title === 'string' ? a.title : '';
      // `fullName` only when the parts are missing: its join character has
      // differed between runners and versions, and the parts have not.
      const name =
        [...ancestors, title].filter((part) => part.length > 0).join(' > ') ||
        (typeof a.fullName === 'string' ? a.fullName : '');
      if (name.length === 0) continue;

      const status = normalizeStatus(typeof a.status === 'string' ? a.status : '');
      const failures = Array.isArray(a.failureMessages)
        ? a.failureMessages.filter((m): m is string => typeof m === 'string')
        : [];

      cases.push({
        id: caseId(file, name),
        file,
        name,
        status,
        message: status === 'failed' ? firstLine(failures[0] ?? '') : null,
      });
    }
  }

  // A report with a `testResults` array and not one readable case is not a
  // suite that passed — it is a shape this parser did not understand.
  if (cases.length === 0) {
    const declared = (parsed as { numTotalTests?: unknown }).numTotalTests;
    if (typeof declared === 'number' && declared > 0) return null;
  }

  return { cases, totals: totalsOf(cases) };
}

/**
 * Failing tests read off the runner's human output.
 *
 * Used only when JSON could not be produced. Vitest and jest both print
 * `FAIL <file> > <describe> > <test>`, and that is the entire contract relied
 * on here. A `FAIL` line naming only a file is dropped: a file-level identity
 * would let a different broken test in an already-broken file be waved through
 * as pre-existing, which is the one mistake this module must never make.
 */
export function extractFailedFromText(output: string, repoDir?: string): TestCaseResult[] {
  const seen = new Set<string>();
  const cases: TestCaseResult[] = [];

  for (const match of output.matchAll(/^\s*(?:FAIL|❯\s*FAIL)\s+(.+?)\s*$/gm)) {
    const line = (match[1] ?? '').trim();
    if (line.length === 0) continue;
    // Strip a trailing duration vitest appends, e.g. "… > renders 1203ms".
    const cleaned = line.replace(/\s+\d+(?:\.\d+)?m?s$/, '').trim();
    const separator = cleaned.indexOf(' > ');
    if (separator <= 0) continue; // a file, not a test — see the doc comment.

    const file = relativeTestFile(cleaned.slice(0, separator), repoDir);
    const name = cleaned.slice(separator + 3).trim();
    if (name.length === 0) continue;

    const id = caseId(file, name);
    if (seen.has(id)) continue;
    seen.add(id);
    cases.push({ id, file, name, status: 'failed', message: null });
  }

  return cases;
}

/** True when output looks like a test runner reporting on tests, not a crash. */
export function looksLikeTestOutput(output: string): boolean {
  return (
    /\bTest Files\b/i.test(output) ||
    /\bTests\s+\d+/i.test(output) ||
    /\bTests:\s+\d+/i.test(output) ||
    /\b\d+ (?:passing|failing|passed|failed)\b/i.test(output) ||
    /No test files found/i.test(output)
  );
}

/* -------------------------------------------------------------------------- */
/* Comparison                                                                 */
/* -------------------------------------------------------------------------- */

/** One side of the comparison: a suite run, as this module needs to read it. */
export interface RunSnapshot {
  /** False when the runner exited non-zero. */
  readonly ok: boolean;
  /** False when nothing ran at all — no suite, or a suite that found nothing. */
  readonly ran: boolean;
  readonly cases: readonly TestCaseResult[];
  readonly source: CaseSource;
  /** For the prose, when there is nothing better to say. */
  readonly summary?: string;
}

export interface BaselineComparison {
  /**
   * True when the two runs can be compared test by test. False sends the caller
   * back to the old rule — any failure blocks — with `reason` saying why.
   */
  readonly comparable: boolean;
  /** `json` when both runs were read from a machine report, `text` from output. */
  readonly method: CaseSource;
  /** Why the comparison is or is not usable, in a sentence. */
  readonly reason: string;
  /** Failed on the base tree and still fails. Not this patch's doing. */
  readonly preExisting: readonly TestCaseResult[];
  /** Passed on the base tree and fails now. We broke it. */
  readonly regressions: readonly TestCaseResult[];
  /** Fails now and was not in the baseline at all. Also ours. */
  readonly introduced: readonly TestCaseResult[];
  /** Failed on the base tree and passes now. An incidental improvement. */
  readonly fixed: readonly TestCaseResult[];
  /** True when something the patch is answerable for is failing. */
  readonly blocking: boolean;
  readonly baselineTotals: TestTotals | null;
  readonly patchedTotals: TestTotals | null;
}

/** The comparison that could not be made, with the reason it could not. */
export function noComparison(reason: string): BaselineComparison {
  return {
    comparable: false,
    method: 'none',
    reason,
    preExisting: [],
    regressions: [],
    introduced: [],
    fixed: [],
    blocking: false,
    baselineTotals: null,
    patchedTotals: null,
  };
}

/**
 * Compare the base-tree run against the patched run, test by test.
 *
 * Every refusal to compare is a refusal in the safe direction: the caller then
 * blocks on any failure, exactly as it did before this existed.
 */
export function compareTestRuns(
  baseline: RunSnapshot,
  patched: RunSnapshot,
): BaselineComparison {
  if (!baseline.ran) {
    return noComparison(
      'The test suite could not be run on the unpatched tree, so there is nothing to ' +
        'compare against and every failure has to be treated as ours.',
    );
  }
  if (baseline.source === 'none') {
    return noComparison(
      'The baseline run produced no per-test detail, so a failure now cannot be matched ' +
        'against one that was already there.',
    );
  }
  if (patched.source === 'none') {
    return noComparison(
      'The patched run produced no per-test detail, so its failures cannot be matched ' +
        'against the baseline.',
    );
  }
  if (baseline.source !== patched.source) {
    // JSON identities and text identities are built from different material.
    // Matching across them would be a guess, and a guess here waves failures
    // through.
    return noComparison(
      `The baseline was read from ${sourceLabel(baseline.source)} and the patched run from ` +
        `${sourceLabel(patched.source)}. Those identities are not built the same way, so ` +
        'they are not compared.',
    );
  }

  const method = baseline.source;
  const baselineFailed = new Map(
    baseline.cases.filter((c) => c.status === 'failed').map((c) => [c.id, c]),
  );
  // Text output lists failures only. "Not in this set" therefore means "we do
  // not know", not "it passed", and the split below sends the unknowns to
  // `introduced`, which blocks.
  const baselineKnown =
    method === 'json' ? new Set(baseline.cases.map((c) => c.id)) : new Set(baselineFailed.keys());

  const patchedFailed = patched.cases.filter((c) => c.status === 'failed');

  // A run that exited non-zero with no failing test named is a suite-level
  // failure — a collection error, a crashed worker, a script after the runner.
  // Nothing attributes it, so nothing may excuse it.
  if (!patched.ok && patchedFailed.length === 0) {
    return noComparison(
      'The patched run failed without naming a failing test — a collection error or a ' +
        'crash rather than an assertion — so it cannot be attributed to a pre-existing ' +
        'failure.',
    );
  }

  const preExisting: TestCaseResult[] = [];
  const regressions: TestCaseResult[] = [];
  const introduced: TestCaseResult[] = [];

  for (const failure of patchedFailed) {
    if (baselineFailed.has(failure.id)) preExisting.push(failure);
    else if (baselineKnown.has(failure.id)) regressions.push(failure);
    else introduced.push(failure);
  }

  const patchedPassed = new Set(
    patched.cases.filter((c) => c.status === 'passed').map((c) => c.id),
  );
  const fixed = [...baselineFailed.values()].filter((c) => patchedPassed.has(c.id));

  return {
    comparable: true,
    method,
    reason:
      method === 'json'
        ? "The suite ran on the unpatched tree and again on the patched tree, and the two " +
          'runs were compared test by test from the runner\'s own JSON report.'
        : "The suite ran on the unpatched tree and again on the patched tree. The runner " +
          'emitted no JSON report, so the comparison is over the failing tests named in its ' +
          'output; a failure that cannot be matched there is counted against this patch.',
    preExisting,
    regressions,
    introduced,
    fixed,
    blocking: regressions.length + introduced.length > 0,
    baselineTotals: method === 'json' ? totalsOf(baseline.cases) : null,
    patchedTotals: method === 'json' ? totalsOf(patched.cases) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Prose                                                                      */
/* -------------------------------------------------------------------------- */

/** Up to `limit` test names, for a sentence rather than a log. */
export function nameList(cases: readonly TestCaseResult[], limit = 3): string {
  const shown = cases.slice(0, limit).map((c) => `\`${c.id}\``);
  const rest = cases.length - shown.length;
  return shown.join(', ') + (rest > 0 ? `, and ${rest} more` : '');
}

/**
 * What the comparison found, in the sentence a maintainer needs: whether this
 * change is at fault, and if not, what was already broken.
 */
export function describeComparison(comparison: BaselineComparison): string {
  if (!comparison.comparable) return comparison.reason;

  const parts: string[] = [];

  if (comparison.regressions.length > 0) {
    parts.push(
      `${count(comparison.regressions.length, 'test')} that passed on the unpatched tree ` +
        `now fail${comparison.regressions.length === 1 ? 's' : ''}: ` +
        `${nameList(comparison.regressions)}. This change broke ` +
        `${comparison.regressions.length === 1 ? 'it' : 'them'}.`,
    );
  }
  if (comparison.introduced.length > 0) {
    parts.push(
      `${count(comparison.introduced.length, 'failing test')} did not exist in the baseline ` +
        `run and so cannot be excused by it: ${nameList(comparison.introduced)}.`,
    );
  }
  if (comparison.preExisting.length > 0) {
    parts.push(
      `${count(comparison.preExisting.length, 'test')} ` +
        `${comparison.preExisting.length === 1 ? 'was' : 'were'} already failing on the base ` +
        `branch before this change and still ${comparison.preExisting.length === 1 ? 'fails' : 'fail'}: ` +
        `${nameList(comparison.preExisting)}.`,
    );
  }
  if (comparison.fixed.length > 0) {
    parts.push(
      `${count(comparison.fixed.length, 'test')} that failed on the base branch now ` +
        `${comparison.fixed.length === 1 ? 'passes' : 'pass'}: ${nameList(comparison.fixed)}.`,
    );
  }

  if (parts.length === 0) {
    return comparison.patchedTotals
      ? `No test changed state: ${comparison.patchedTotals.passed} passing, ` +
          `${comparison.patchedTotals.failed} failing, the same as the unpatched tree.`
      : 'No test changed state between the unpatched and the patched tree.';
  }

  return parts.join(' ');
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function caseId(file: string, name: string): string {
  return file.length > 0 ? `${file} > ${name}` : name;
}

function normalizeStatus(raw: string): TestCaseStatus {
  const status = raw.toLowerCase();
  if (status === 'failed' || status === 'fail') return 'failed';
  if (status === 'passed' || status === 'pass') return 'passed';
  return 'skipped';
}

function totalsOf(cases: readonly TestCaseResult[]): TestTotals {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const entry of cases) {
    if (entry.status === 'passed') passed += 1;
    else if (entry.status === 'failed') failed += 1;
    else skipped += 1;
  }
  return { total: cases.length, passed, failed, skipped };
}

/**
 * A test file path as it reads in the repository.
 *
 * The runner reports absolute paths inside the sandbox clone; the clone
 * directory differs between a baseline and a patched run only if the caller
 * moved it, but stripping it keeps the identity readable in a pull request and
 * stable if the directory ever changes.
 */
function relativeTestFile(raw: string, repoDir?: string): string {
  let path = raw.replace(/\\/g, '/').trim();
  if (repoDir) {
    const prefix = repoDir.replace(/\\/g, '/').replace(/\/+$/, '');
    if (path === prefix) return '';
    if (path.startsWith(`${prefix}/`)) path = path.slice(prefix.length + 1);
  }
  return path.replace(/^\.\//, '').replace(/^\/+/, '');
}

function firstLine(message: string): string | null {
  const line = message.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return line ? line.slice(0, 300) : null;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function sourceLabel(source: CaseSource): string {
  if (source === 'json') return "the runner's JSON report";
  if (source === 'text') return "the runner's console output";
  return 'nothing';
}
