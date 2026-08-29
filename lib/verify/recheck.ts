/**
 * Re-checking each fixed criterion against the patched build (A6.3, A6.5).
 *
 * A green build and a green test suite prove the patch did not break the
 * application. They prove nothing at all about whether it fixed the
 * accessibility defect. This module is the part that asks the second question,
 * and it is the reason the pull-request body can say "resolved" rather than
 * "attempted".
 *
 * Three methods, strongest first:
 *
 *  - **path** — re-drive the interaction the finding came from and diff the
 *    accessibility tree on both sides. This is the product's core mechanic run
 *    backwards: the finding existed because the tree changed while the state
 *    attribute did not, so the fix is proven when the state attribute now moves
 *    with it. Nothing else is this direct.
 *  - **axe** — re-run the deterministic rule engine on the patched page and ask
 *    whether a violation for that criterion is still there. Only trusted for
 *    the criteria axe actually decides; everything else it stays silent on, and
 *    silence is not a pass.
 *  - **source** — no reachable build, so VERIFY reads the diff against the
 *    finding and judges. Weakest, and labelled as such wherever it is shown.
 *
 * A6.5 is why every input finding gets an outcome, including the ones nothing
 * could rule on. A finding that quietly vanishes from the report is worse than
 * one marked unresolved.
 */

import { z } from 'zod';

import { capturePage, diffPathResult, runPaths } from '@/lib/browser/runner';
import type { AxeViolation, InteractionPath, PathResult } from '@/lib/browser/types';
import { getCriterion } from '@/lib/db/criteria';
import { runRosterAgent } from '@/lib/harness/run';
import type { FixableFinding } from '@/lib/fix/group';
import type { FilePatch } from '@/lib/fix/patch';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type RecheckMethod = 'path' | 'axe' | 'source' | 'none';

export interface RecheckOutcome {
  readonly findingId: string;
  readonly criterion: string;
  /** True only on positive evidence. Absence of evidence is never a pass. */
  readonly resolved: boolean;
  /** True when nothing could rule either way. `resolved` is false alongside it. */
  readonly inconclusive: boolean;
  readonly method: RecheckMethod;
  /** What was actually observed, in a sentence. Goes in the pull-request body. */
  readonly note: string;
}

export interface RecheckReport {
  /** A6.5: one outcome for every finding handed in, with no exceptions. */
  readonly outcomes: readonly RecheckOutcome[];
  readonly resolvedFindingIds: readonly string[];
  readonly unresolvedFindingIds: readonly string[];
  readonly inconclusiveFindingIds: readonly string[];
  /** Criteria where every finding is resolved — these moved failing to passing. */
  readonly resolvedCriteria: readonly string[];
  /** Criteria still carrying at least one unresolved finding. */
  readonly unresolvedCriteria: readonly string[];
  /** Where the URL that was re-checked, when there was one. */
  readonly checkedUrl: string | null;
  readonly summary: string;
}

/* -------------------------------------------------------------------------- */
/* axe coverage                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The criteria the deterministic rule engine can actually rule on.
 *
 * axe-core tags every rule with the criteria it maps to, but a *clean* run only
 * proves something for criteria axe has rules for. For everything else an empty
 * violation list means "axe has no opinion", not "fixed" — and reading it the
 * other way would let this product claim resolutions it never observed.
 */
export const AXE_DECIDABLE_CRITERIA: ReadonlySet<string> = new Set([
  '1.1.1',
  '1.2.2',
  '1.3.1',
  '1.3.4',
  '1.3.5',
  '1.4.1',
  '1.4.2',
  '1.4.3',
  '1.4.4',
  '1.4.10',
  '1.4.12',
  '2.1.1',
  '2.1.2',
  '2.2.1',
  '2.2.2',
  '2.4.1',
  '2.4.2',
  '2.4.3',
  '2.4.4',
  '2.4.7',
  '2.5.8',
  '3.1.1',
  '3.1.2',
  '3.2.1',
  '3.2.2',
  '3.3.1',
  '3.3.2',
  '4.1.2',
  '4.1.3',
]);

/**
 * `wcag412` -> `4.1.2`. axe tags criteria as digit-run after the `wcag` prefix:
 * the first two digits are the principle and the guideline, everything left is
 * the criterion, which is what makes `wcag1410` read as 1.4.10 and not 1.41.0.
 * Level tags (`wcag2a`, `wcag21aa`, `wcag22aa`) fail the pattern and are ignored.
 */
export function criterionFromAxeTag(tag: string): string | null {
  const match = /^wcag(\d)(\d)(\d+)$/.exec(tag);
  if (!match) return null;
  const id = `${match[1]}.${match[2]}.${match[3]}`;
  return getCriterion(id) ? id : null;
}

/** Every criterion a violation maps to. One axe rule can cover several. */
export function criteriaFromViolation(violation: AxeViolation): string[] {
  const found = new Set<string>();
  for (const tag of violation.tags) {
    const criterion = criterionFromAxeTag(tag);
    if (criterion) found.add(criterion);
  }
  return [...found];
}

/* -------------------------------------------------------------------------- */
/* Live re-check                                                              */
/* -------------------------------------------------------------------------- */

export interface LiveRecheckOptions {
  /**
   * The interaction path a finding came from, keyed by finding id. Supplying
   * these is what turns a re-check from "axe is quiet" into "the control now
   * reports its own state", which is the evidence worth putting in a pull
   * request.
   */
  readonly paths?: ReadonlyMap<string, InteractionPath>;
  /** Labels for the browser sandbox, so a leak traces back to its run. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Skip the axe pass and rely on paths alone. */
  readonly skipAxe?: boolean;
  /**
   * How many distinct routes to re-check. Every route costs a page load, and a
   * run with findings spread over forty pages should not turn into forty browser
   * jobs. Findings past the cap come back inconclusive and say so. Default 8.
   */
  readonly maxRoutes?: number;
}

const DEFAULT_MAX_RECHECK_ROUTES = 8;

/**
 * Whether the deterministic rule engine actually ran.
 *
 * The browser layer reports a missing or broken axe through `warnings` and
 * returns an empty violation list either way, so an instrumentation failure and
 * a clean page are the same value. Every axe warning it emits is a failure —
 * source unavailable, CDN refused, CDN unreachable, run threw — so any of them
 * means the empty list proves nothing.
 */
function axeFailures(warnings: readonly string[] | undefined): string[] {
  return (warnings ?? []).filter((warning) => /axe[-\s]?core/i.test(warning));
}

/**
 * The URL on the patched build that corresponds to where a finding was seen.
 *
 * Findings carry the deployed URL they were observed on; `base` serves the
 * patched tree, which is usually a different origin. The path is what identifies
 * the route, so it is carried over and everything else is taken from `base`.
 */
export function patchedUrlFor(base: string, pageUrl: string | null | undefined): string {
  if (!pageUrl) return base;
  try {
    const observed = new URL(pageUrl);
    const resolved = new URL(base);
    resolved.pathname = observed.pathname;
    resolved.search = observed.search;
    return resolved.toString();
  } catch {
    // Not a URL we can take apart — re-check against the base and let the
    // evidence speak for itself rather than inventing a route.
    return base;
  }
}

/**
 * Re-check findings against a reachable build of the patched application.
 *
 * `url` is whatever serves the patched tree: a preview deployment, a port
 * forwarded out of the build sandbox, or a staging URL. This function does not
 * care which — it only needs a browser sandbox to be able to load it.
 */
export async function recheckAgainstUrl(
  url: string,
  findings: readonly FixableFinding[],
  options: LiveRecheckOptions = {},
): Promise<RecheckReport> {
  if (findings.length === 0) return emptyReport(url);

  const outcomes = new Map<string, RecheckOutcome>();

  // A finding is only proven on the page it was observed on. Evaluating a
  // finding from `/checkout` against whatever `/` happens to render would mark
  // it resolved because its selector and its violation are simply not on that
  // page — which is absence of the evidence, presented as evidence of the fix.
  const maxRoutes = options.maxRoutes ?? DEFAULT_MAX_RECHECK_ROUTES;
  const byRoute = new Map<string, FixableFinding[]>();
  for (const finding of findings) {
    const route = patchedUrlFor(url, finding.pageUrl);
    const bucket = byRoute.get(route);
    if (bucket) bucket.push(finding);
    else byRoute.set(route, [finding]);
  }

  const routes = [...byRoute.entries()];
  for (const [route, routeFindings] of routes.slice(maxRoutes)) {
    for (const finding of routeFindings) {
      outcomes.set(finding.id, {
        findingId: finding.id,
        criterion: finding.criterion,
        resolved: false,
        inconclusive: true,
        method: 'none',
        note:
          `${route} is past the re-check budget of ${maxRoutes} routes for this run, so this ` +
          'finding was not re-checked. It is reported unproven rather than assumed fixed.',
      });
    }
  }

  for (const [route, routeFindings] of routes.slice(0, maxRoutes)) {
    /* -- path evidence, for the findings that carry an interaction -------- */

    const paths = options.paths;
    if (paths && paths.size > 0) {
      const targets = routeFindings.filter((f) => paths.has(f.id));
      const list: InteractionPath[] = targets.map((f) => ({
        ...paths.get(f.id)!,
        id: f.id,
      }));

      if (list.length > 0) {
        const results = await runPaths(route, list, { labels: options.labels });
        const byId = new Map<string, PathResult>();
        for (const result of results) {
          const id = result.path.id;
          if (id) byId.set(id, result);
        }
        for (const finding of targets) {
          const result = byId.get(finding.id);
          if (result) outcomes.set(finding.id, evaluatePath(finding, result));
        }
      }
    }

    /* -- deterministic evidence for everything else ---------------------- */

    const remaining = routeFindings.filter((f) => !outcomes.has(f.id));
    if (remaining.length === 0) continue;

    if (options.skipAxe) {
      for (const finding of remaining) {
        outcomes.set(finding.id, {
          findingId: finding.id,
          criterion: finding.criterion,
          resolved: false,
          inconclusive: true,
          method: 'none',
          note: 'No re-check ran against this finding.',
        });
      }
      continue;
    }

    const capture = await capturePage(route, { labels: options.labels });

    // An empty violation list from a page where axe never loaded is not a clean
    // page. Without this check an instrumentation failure would resolve every
    // axe-decidable finding at once, and the pull request would claim fixes
    // nothing observed.
    const failures = axeFailures(capture.warnings);
    if (failures.length > 0) {
      for (const finding of remaining) {
        outcomes.set(finding.id, {
          findingId: finding.id,
          criterion: finding.criterion,
          resolved: false,
          inconclusive: true,
          method: 'none',
          note:
            `The deterministic rule engine did not run on ${route} (${failures[0]}), so its ` +
            'empty result says nothing about this finding.',
        });
      }
      continue;
    }

    for (const finding of remaining) {
      outcomes.set(finding.id, evaluateAxe(finding, capture.axeViolations));
    }
  }

  return buildReport(findings, outcomes, url);
}

/**
 * The 4.1.2 mechanic, run in reverse.
 *
 * The finding existed because the tree changed and the control's own state
 * attribute did not. It is fixed when both move together, and it is not fixed
 * when the control has simply stopped doing anything.
 */
function evaluatePath(finding: FixableFinding, result: PathResult): RecheckOutcome {
  const base = { findingId: finding.id, criterion: finding.criterion, method: 'path' as const };

  if (!result.ok) {
    return {
      ...base,
      resolved: false,
      inconclusive: true,
      note:
        `The control could not be driven after the patch (${result.error ?? 'no reason given'}), ` +
        'so nothing was proven either way.',
    };
  }

  const diff = diffPathResult(result);
  const treeChanged = diff.sizeDelta !== 0 || diff.addedCount > 0 || diff.removedCount > 0;
  const treeStateChanged = diff.changedCount > 0;
  const attributeChanged = ariaStateChanged(result);

  if ((treeStateChanged || attributeChanged) && treeChanged) {
    return {
      ...base,
      resolved: true,
      inconclusive: false,
      note:
        `Driving the control now changes both the accessibility tree (${describeDelta(diff.sizeDelta)}) ` +
        `and its own state (${describeStateChange(result, diff.changedCount)}). ` +
        'Assistive technology and the screen agree again.',
    };
  }

  if (treeChanged && !treeStateChanged && !attributeChanged) {
    return {
      ...base,
      resolved: false,
      inconclusive: false,
      note:
        `The control still changes the accessibility tree (${describeDelta(diff.sizeDelta)}) while ` +
        'its own state attribute stays put. This is the original failure, unchanged.',
    };
  }

  if (!treeChanged && (treeStateChanged || attributeChanged)) {
    return {
      ...base,
      resolved: true,
      inconclusive: false,
      note:
        'The control now reports its own state change. The tree itself did not move, which is ' +
        'expected for a control whose effect is purely visual.',
    };
  }

  return {
    ...base,
    resolved: false,
    inconclusive: true,
    note:
      'Driving the control produced no change to the accessibility tree and no change to its ' +
      'state, so there was nothing to compare. Check that the control still works at all.',
  };
}

const ARIA_STATE_ATTRIBUTES = [
  'aria-expanded',
  'aria-checked',
  'aria-selected',
  'aria-pressed',
  'aria-current',
  'aria-disabled',
  'aria-hidden',
  'open',
  'checked',
  'disabled',
] as const;

function ariaStateChanged(result: PathResult): boolean {
  const before = result.stateBefore?.attributes;
  const after = result.stateAfter?.attributes;
  if (!before || !after) return false;
  return ARIA_STATE_ATTRIBUTES.some((name) => (before[name] ?? null) !== (after[name] ?? null));
}

function describeStateChange(result: PathResult, changedCount: number): string {
  const before = result.stateBefore?.attributes ?? {};
  const after = result.stateAfter?.attributes ?? {};
  for (const name of ARIA_STATE_ATTRIBUTES) {
    const a = before[name] ?? null;
    const b = after[name] ?? null;
    if (a !== b) return `${name} ${a ?? 'absent'} → ${b ?? 'absent'}`;
  }
  return `${changedCount} state propert${changedCount === 1 ? 'y' : 'ies'} in the tree`;
}

function describeDelta(sizeDelta: number): string {
  if (sizeDelta === 0) return 'same node count, different content';
  return `${sizeDelta > 0 ? '+' : ''}${sizeDelta} nodes`;
}

function evaluateAxe(
  finding: FixableFinding,
  violations: readonly AxeViolation[],
): RecheckOutcome {
  const base = { findingId: finding.id, criterion: finding.criterion, method: 'axe' as const };

  if (!AXE_DECIDABLE_CRITERIA.has(finding.criterion)) {
    return {
      ...base,
      method: 'none',
      resolved: false,
      inconclusive: true,
      note:
        `SC ${finding.criterion} is not decidable by the deterministic rule engine, so a clean ` +
        'axe run says nothing about it. The final audit re-runs the full 55.',
    };
  }

  const matching = violations.filter((violation) =>
    criteriaFromViolation(violation).includes(finding.criterion),
  );

  if (matching.length === 0) {
    return {
      ...base,
      resolved: true,
      inconclusive: false,
      note: `axe-core reports no remaining SC ${finding.criterion} violation on the patched page.`,
    };
  }

  const selector = finding.selector?.trim();
  if (selector) {
    const stillOnElement = matching.some((violation) =>
      violation.nodes.some((node) => node.target.some((target) => target === selector)),
    );
    if (!stillOnElement) {
      return {
        ...base,
        resolved: true,
        inconclusive: false,
        note:
          `axe-core no longer reports SC ${finding.criterion} on \`${selector}\`. ` +
          `${matching.length} other element${matching.length === 1 ? '' : 's'} on the page still ` +
          'fail this criterion and remain open.',
      };
    }
  }

  const rule = matching[0];
  return {
    ...base,
    resolved: false,
    inconclusive: false,
    note:
      `axe-core still reports SC ${finding.criterion} on the patched page ` +
      `(${rule?.id ?? 'rule unknown'}: ${rule?.help ?? 'no description'}).`,
  };
}

/* -------------------------------------------------------------------------- */
/* Source re-check                                                            */
/* -------------------------------------------------------------------------- */

const SourceRecheckSchema = z.object({
  recheck: z
    .array(
      z.object({
        findingId: z.string().nullish(),
        criterion: z.string(),
        resolved: z.boolean(),
        note: z.string().min(1),
      }),
    )
    .default([]),
});

export interface SourceRecheckOptions {
  readonly repoFullName?: string;
  /** Passed through to the harness for retry and fallback. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Judge each finding from the patch alone, when no build is reachable.
 *
 * This is the weak method and it is labelled as such in every outcome it
 * produces. It exists because "we could not check" and "we did not check" are
 * different things to a reviewer, and the second one is not acceptable in a
 * pull request that claims a fix.
 */
export async function recheckFromSource(
  findings: readonly FixableFinding[],
  patches: readonly FilePatch[],
  options: SourceRecheckOptions = {},
): Promise<RecheckReport> {
  if (findings.length === 0) return emptyReport(null);

  const prompt = buildSourceRecheckPrompt(findings, patches, options.repoFullName);
  const outcomes = new Map<string, RecheckOutcome>();

  try {
    const run = await runRosterAgent('verify', prompt, {
      schema: SourceRecheckSchema,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    // An exact finding id, or nothing. Falling back to the criterion would let
    // one defect's judgement settle another: three separate 4.1.2 failures share
    // a criterion, the map keeps whichever entry came last, and the other two
    // would inherit a "resolved" that was never about them.
    const known = new Set(findings.map((finding) => finding.id));
    const byId = new Map<string, { resolved: boolean; note: string }>();
    const duplicated = new Set<string>();

    for (const entry of run.data?.recheck ?? []) {
      const id = entry.findingId?.trim();
      if (!id || !known.has(id)) continue;
      if (byId.has(id)) {
        // Two judgements for one finding, possibly disagreeing. Neither is
        // trustworthy, so the finding stays unproven.
        duplicated.add(id);
        continue;
      }
      byId.set(id, { resolved: entry.resolved, note: entry.note });
    }

    for (const finding of findings) {
      const judgement = duplicated.has(finding.id) ? undefined : byId.get(finding.id);
      outcomes.set(finding.id, {
        findingId: finding.id,
        criterion: finding.criterion,
        resolved: judgement?.resolved ?? false,
        inconclusive: judgement === undefined,
        method: judgement ? 'source' : 'none',
        note: judgement
          ? `Judged from the patch, without a running build: ${judgement.note}`
          : duplicated.has(finding.id)
            ? 'VERIFY returned more than one judgement for this finding, so none of them can ' +
              'be relied on.'
            : 'VERIFY returned no judgement for this finding.',
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const finding of findings) {
      outcomes.set(finding.id, {
        findingId: finding.id,
        criterion: finding.criterion,
        resolved: false,
        inconclusive: true,
        method: 'none',
        note: `The source re-check could not run: ${message}`,
      });
    }
  }

  return buildReport(findings, outcomes, null);
}

function buildSourceRecheckPrompt(
  findings: readonly FixableFinding[],
  patches: readonly FilePatch[],
  repoFullName?: string,
): string {
  const findingLines = findings
    .map((finding) => {
      const record = getCriterion(finding.criterion);
      return [
        `- id: ${finding.id}`,
        `  criterion: ${finding.criterion}${record ? ` (${record.name})` : ''}`,
        `  requirement: ${record?.plainEnglish ?? 'see WCAG 2.2'}`,
        `  observed: ${finding.summary}`,
        finding.sourcePath ? `  source: ${finding.sourcePath}` : null,
      ]
        .filter((line): line is string => line !== null)
        .join('\n');
    })
    .join('\n');

  const diffs = patches
    .map((patch) => `--- ${patch.filePath} ---\n${patch.diff}`)
    .join('\n\n');

  return [
    'Re-check each accessibility finding against the patch that claims to fix it.',
    repoFullName ? `Repository: ${repoFullName}` : '',
    '',
    'There is no running build available, so judge from the diff alone. Be strict: mark a',
    'finding resolved only when the diff plainly and completely addresses what the finding',
    'describes. A partial fix, a fix to a different element, or a change that adds an ARIA',
    'attribute without wiring it to state is NOT resolved.',
    '',
    'FINDINGS',
    findingLines,
    '',
    'PATCHES',
    diffs,
    '',
    'Return JSON with a `recheck` array: exactly one entry per finding above, carrying its',
    '`findingId` copied verbatim from the list, its `criterion`, a boolean `resolved`, and a',
    '`note` stating what in the diff settles it. The `findingId` is what binds a judgement to a',
    'finding: an entry without one, with an id that is not in the list, or a second entry for an',
    'id already used, is discarded and its finding is reported as unproven. Two findings that',
    'cite the same criterion still need one entry each.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

export interface RecheckInput {
  readonly findings: readonly FixableFinding[];
  readonly patches: readonly FilePatch[];
  /** A reachable URL serving the patched build. Omit to fall back to source. */
  readonly url?: string | null;
  readonly paths?: ReadonlyMap<string, InteractionPath>;
  readonly repoFullName?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * Re-check every criterion a patch claimed, by the strongest method available.
 *
 * A live URL is always preferred. If the browser pass throws — an unreachable
 * preview, a sandbox that would not provision — the run degrades to the source
 * judgement rather than losing the re-check entirely, and every outcome says
 * which method produced it.
 */
export async function recheckFixedCriteria(input: RecheckInput): Promise<RecheckReport> {
  if (input.findings.length === 0) return emptyReport(input.url ?? null);

  if (input.url) {
    try {
      const liveOptions: LiveRecheckOptions = {
        ...(input.paths === undefined ? {} : { paths: input.paths }),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
      };
      return await recheckAgainstUrl(input.url, input.findings, liveOptions);
    } catch {
      // Fall through to the source judgement below, which says so in its notes.
    }
  }

  return recheckFromSource(input.findings, input.patches, {
    ...(input.repoFullName === undefined ? {} : { repoFullName: input.repoFullName }),
  });
}

/* -------------------------------------------------------------------------- */
/* Report assembly                                                            */
/* -------------------------------------------------------------------------- */

function buildReport(
  findings: readonly FixableFinding[],
  outcomes: ReadonlyMap<string, RecheckOutcome>,
  checkedUrl: string | null,
): RecheckReport {
  // A6.5: every finding gets a row, including any the methods above missed.
  const ordered: RecheckOutcome[] = findings.map(
    (finding) =>
      outcomes.get(finding.id) ?? {
        findingId: finding.id,
        criterion: finding.criterion,
        resolved: false,
        inconclusive: true,
        method: 'none' as const,
        note: 'No re-check ran against this finding.',
      },
  );

  const resolvedFindingIds = ordered.filter((o) => o.resolved).map((o) => o.findingId);
  const inconclusiveFindingIds = ordered.filter((o) => o.inconclusive).map((o) => o.findingId);
  const unresolvedFindingIds = ordered
    .filter((o) => !o.resolved && !o.inconclusive)
    .map((o) => o.findingId);

  const criteria = new Map<string, { total: number; resolved: number }>();
  for (const outcome of ordered) {
    const entry = criteria.get(outcome.criterion) ?? { total: 0, resolved: 0 };
    entry.total += 1;
    if (outcome.resolved) entry.resolved += 1;
    criteria.set(outcome.criterion, entry);
  }

  const resolvedCriteria: string[] = [];
  const unresolvedCriteria: string[] = [];
  for (const [criterion, counts] of criteria) {
    if (counts.resolved === counts.total) resolvedCriteria.push(criterion);
    else unresolvedCriteria.push(criterion);
  }
  const byNumber = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
  resolvedCriteria.sort(byNumber);
  unresolvedCriteria.sort(byNumber);

  return {
    outcomes: ordered,
    resolvedFindingIds,
    unresolvedFindingIds,
    inconclusiveFindingIds,
    resolvedCriteria,
    unresolvedCriteria,
    checkedUrl,
    summary: summarise(ordered.length, resolvedFindingIds.length, unresolvedFindingIds.length, inconclusiveFindingIds.length),
  };
}

function summarise(
  total: number,
  resolved: number,
  unresolved: number,
  inconclusive: number,
): string {
  if (total === 0) return 'Nothing to re-check.';
  const parts = [`${resolved} of ${total} findings re-checked as resolved`];
  if (unresolved > 0) parts.push(`${unresolved} still failing`);
  if (inconclusive > 0) parts.push(`${inconclusive} could not be ruled on`);
  return `${parts.join(', ')}.`;
}

function emptyReport(checkedUrl: string | null): RecheckReport {
  return {
    outcomes: [],
    resolvedFindingIds: [],
    unresolvedFindingIds: [],
    inconclusiveFindingIds: [],
    resolvedCriteria: [],
    unresolvedCriteria: [],
    checkedUrl,
    summary: 'Nothing to re-check.',
  };
}
