/**
 * Grouping findings for the FIX pass (A5.1 - A5.4).
 *
 * FIX receives findings from the ledger, never raw page content, and it works
 * one source file at a time. Three problems in one component are one patch, not
 * three: a model that sees all three at once writes a coherent change, while
 * three separate passes over the same file produce three diffs that conflict.
 *
 * The other half of this module is exclusion, and it is the more important
 * half. `FLAG` findings are a human's to judge (A5.4) and never reach the FIX
 * prompt at all — not as context, not as a footnote. `BLOCKED` findings were
 * never observable. A `DECIDE` finding with no source path cannot be patched
 * even though the agent ruled on it, so it goes to the same human queue rather
 * than being quietly dropped.
 *
 * Nothing here calls a model or touches the database. It is a pure function of
 * the ledger rows handed to it, which is what makes the A5 guarantees testable.
 */

import { getCriterion, type Criterion } from '@/lib/db/criteria';

/* -------------------------------------------------------------------------- */
/* Input                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The subset of a ledger row FIX needs.
 *
 * Structural rather than a direct import of the Drizzle row type, so a caller
 * can hand this a row, a projection of a row, or a fixture without a cast.
 */
export interface FixableFinding {
  readonly id: string;
  /** One of the 55. Never null in the ledger; validated again here. */
  readonly criterion: string;
  readonly verdict: 'DECIDE' | 'FLAG' | 'BLOCKED';
  readonly severity: 'critical' | 'serious' | 'moderate' | 'minor';
  readonly summary: string;
  readonly detail?: string | null;
  /** `app/components/Nav.tsx`, optionally with `:42` or `:42:9`. */
  readonly sourcePath?: string | null;
  readonly pageUrl?: string | null;
  readonly selector?: string | null;
  readonly status?: string | null;
  readonly level?: 'A' | 'AA' | null;
  readonly agent?: string | null;
}

/** A finding admitted to a group, with its path normalised and lines pulled out. */
export interface GroupedFinding extends FixableFinding {
  /** Repository-relative, forward slashes, no line suffix. */
  readonly filePath: string;
  /** Line numbers recovered from `sourcePath`, ascending. Empty when unknown. */
  readonly lines: readonly number[];
  /** The criterion record, so the prompt can name it properly. */
  readonly criterionRecord: Criterion;
}

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

/** One file, every `DECIDE` finding that lands in it. One patch will come out. */
export interface FixGroup {
  /** Repository-relative path. The key of the group and the patch target. */
  readonly filePath: string;
  readonly findings: readonly GroupedFinding[];
  /** A5.5: exactly the findings the resulting patch addresses. */
  readonly findingIds: readonly string[];
  /** Distinct criterion numbers in the group, ascending. */
  readonly criteria: readonly string[];
  /** Worst severity in the group. Drives ordering, not behaviour. */
  readonly severity: FixableFinding['severity'];
  /** Distinct pages these findings were observed on, for the patch rationale. */
  readonly pageUrls: readonly string[];
}

export type ExclusionReason =
  /** A5.4: a human signs this off. Never auto-fixed, never shown to FIX. */
  | 'flag'
  /** Out of reach for every lane; there was nothing to fix. */
  | 'blocked'
  /** Ruled on, but with nowhere in the source to apply a change. */
  | 'no-source-path'
  /** Cites a criterion outside the 55. The application rejects it (rule 3). */
  | 'unknown-criterion'
  /** Already fixed, verified or dismissed on a previous pass. */
  | 'not-actionable'
  /** Beyond the per-run file cap; deferred rather than dropped. */
  | 'over-file-cap'
  /** Beyond the per-file finding cap; deferred rather than dropped. */
  | 'over-finding-cap';

export interface ExcludedFinding {
  readonly finding: FixableFinding;
  readonly reason: ExclusionReason;
  /** A sentence a human can read in the queue. Not a code. */
  readonly explanation: string;
}

export interface FixGroupingStats {
  readonly considered: number;
  readonly grouped: number;
  readonly files: number;
  readonly excluded: number;
  readonly byReason: Readonly<Record<ExclusionReason, number>>;
}

export interface FixGrouping {
  /** One entry per source file. FIX is invoked once per entry. */
  readonly groups: readonly FixGroup[];
  /** Everything the FIX pass will not touch, each with a reason. */
  readonly excluded: readonly ExcludedFinding[];
  /**
   * The subset of `excluded` a person actually has to look at: `FLAG` findings
   * (A5.4) and `DECIDE` findings with nowhere to apply a fix.
   */
  readonly humanQueue: readonly ExcludedFinding[];
  readonly stats: FixGroupingStats;
}

export interface GroupFindingsOptions {
  /** Only findings in these statuses are actionable. Default: open, fixing. */
  readonly actionableStatuses?: readonly string[];
  /** Files patched in one run. Default 25. The rest are deferred, not dropped. */
  readonly maxFiles?: number;
  /** Findings shown to FIX for one file. Default 12, to keep the prompt bounded. */
  readonly maxFindingsPerFile?: number;
  /** Strip this prefix from every source path, e.g. a monorepo package root. */
  readonly stripPrefix?: string;
}

const DEFAULT_ACTIONABLE_STATUSES = ['open', 'fixing'] as const;
const DEFAULT_MAX_FILES = 25;
const DEFAULT_MAX_FINDINGS_PER_FILE = 12;

const SEVERITY_RANK: Record<FixableFinding['severity'], number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
};

/* -------------------------------------------------------------------------- */
/* Source path normalisation                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Agents write source paths in whatever shape they saw them: `./app/page.tsx`,
 * `app\components\Nav.tsx`, `src/Nav.tsx:42:9`, `app/page.tsx#L18`. All four
 * are the same file, and grouping is only correct if they collapse to one key.
 */
export function normalizeSourcePath(
  raw: string | null | undefined,
  stripPrefix?: string,
): { filePath: string; lines: number[] } | null {
  if (typeof raw !== 'string') return null;

  let value = raw.trim();
  if (value.length === 0) return null;

  const lines: number[] = [];

  // `path#L18` / `path#L18-L24`
  const hash = value.match(/#L(\d+)(?:-L?(\d+))?$/i);
  if (hash) {
    value = value.slice(0, hash.index);
    lines.push(Number(hash[1]));
    if (hash[2]) lines.push(Number(hash[2]));
  }

  // `path (line 18)` / `path line 18`
  const words = value.match(/[\s(]*\bline[s]?\s+(\d+)\)?$/i);
  if (words) {
    value = value.slice(0, words.index);
    lines.push(Number(words[1]));
  }

  // `path:18` / `path:18:9`. Anchored to the end so a Windows drive letter or a
  // URL scheme earlier in the string is left alone.
  const colon = value.match(/:(\d+)(?::(\d+))?\s*$/);
  if (colon) {
    value = value.slice(0, colon.index);
    lines.push(Number(colon[1]));
  }

  value = value.trim().replace(/\\/g, '/');
  value = value.replace(/^\.\//, '').replace(/^\/+/, '');

  if (stripPrefix) {
    const prefix = stripPrefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (prefix && value.startsWith(`${prefix}/`)) {
      value = value.slice(prefix.length + 1);
    }
  }

  // Collapse `a/./b` and `a/b/../c`, which show up when an agent quotes an
  // import specifier rather than a repository path.
  //
  // A `..` with nothing left to pop is a path that leaves the repository, and it
  // is rejected rather than collapsed. Popping an empty stack would silently
  // rewrite `../src/Nav.tsx` into `src/Nav.tsx` — a real file, in this
  // repository, that the finding was never about, and which a patch would then
  // overwrite.
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  value = segments.join('/');

  if (value.length === 0) return null;

  const unique = [...new Set(lines.filter((n) => Number.isInteger(n) && n > 0))].sort(
    (a, b) => a - b,
  );
  return { filePath: value, lines: unique };
}

/* -------------------------------------------------------------------------- */
/* Grouping                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Group `DECIDE` findings by source file (A5.2) and route everything else.
 *
 * The returned `groups` are ordered worst-first — highest severity, then most
 * findings — so a run that runs out of budget has already done the work that
 * matters most.
 */
export function groupFindingsForFix(
  findings: readonly FixableFinding[],
  options: GroupFindingsOptions = {},
): FixGrouping {
  const actionable = new Set(options.actionableStatuses ?? DEFAULT_ACTIONABLE_STATUSES);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxPerFile = options.maxFindingsPerFile ?? DEFAULT_MAX_FINDINGS_PER_FILE;

  const excluded: ExcludedFinding[] = [];
  const buckets = new Map<string, GroupedFinding[]>();

  for (const finding of findings) {
    // A5.3 / A5.4. FLAG first, and unconditionally: a FLAG finding must not
    // reach the FIX prompt even as background context.
    if (finding.verdict === 'FLAG') {
      excluded.push({
        finding,
        reason: 'flag',
        explanation:
          `${finding.criterion} was flagged rather than decided, so a person has to judge it. ` +
          'It stays in the human queue and no patch will be written for it.',
      });
      continue;
    }

    if (finding.verdict === 'BLOCKED') {
      excluded.push({
        finding,
        reason: 'blocked',
        explanation:
          `${finding.criterion} is out of reach for every audit lane, so there is nothing ` +
          'to fix from it.',
      });
      continue;
    }

    const criterionRecord = getCriterion(finding.criterion);
    if (!criterionRecord) {
      excluded.push({
        finding,
        reason: 'unknown-criterion',
        explanation:
          `"${finding.criterion}" is not one of the 55 WCAG 2.2 Level A/AA success criteria, ` +
          'so the finding is rejected rather than patched.',
      });
      continue;
    }

    if (finding.status != null && !actionable.has(finding.status)) {
      excluded.push({
        finding,
        reason: 'not-actionable',
        explanation:
          `This finding is already \`${finding.status}\`, so the FIX pass leaves it alone.`,
      });
      continue;
    }

    const normalized = normalizeSourcePath(finding.sourcePath, options.stripPrefix);
    if (!normalized) {
      excluded.push({
        finding,
        reason: 'no-source-path',
        explanation:
          `${finding.criterion} was decided, but the finding carries no usable source location ` +
          '— it is missing, or it points outside the repository — so there is no file to ' +
          'patch. A person has to point it at one.',
      });
      continue;
    }

    const entry: GroupedFinding = {
      ...finding,
      filePath: normalized.filePath,
      lines: normalized.lines,
      criterionRecord,
    };

    const bucket = buckets.get(normalized.filePath);
    if (bucket) bucket.push(entry);
    else buckets.set(normalized.filePath, [entry]);
  }

  // Order within a file: worst first, then by line, so the prompt reads top-down.
  const draft: FixGroup[] = [];
  for (const [filePath, bucket] of buckets) {
    const sorted = [...bucket].sort((a, b) => {
      const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (severity !== 0) return severity;
      const lineA = a.lines[0] ?? Number.MAX_SAFE_INTEGER;
      const lineB = b.lines[0] ?? Number.MAX_SAFE_INTEGER;
      if (lineA !== lineB) return lineA - lineB;
      return a.criterion.localeCompare(b.criterion, 'en', { numeric: true });
    });

    const kept = sorted.slice(0, maxPerFile);
    for (const overflow of sorted.slice(maxPerFile)) {
      excluded.push({
        finding: overflow,
        reason: 'over-finding-cap',
        explanation:
          `${filePath} carries ${sorted.length} findings, above the per-file cap of ` +
          `${maxPerFile}. This one is deferred to the next FIX pass rather than crowding ` +
          'the prompt.',
      });
    }

    draft.push(buildGroup(filePath, kept));
  }

  draft.sort((a, b) => {
    const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severity !== 0) return severity;
    if (a.findings.length !== b.findings.length) return b.findings.length - a.findings.length;
    return a.filePath.localeCompare(b.filePath);
  });

  const groups = draft.slice(0, maxFiles);
  for (const overflow of draft.slice(maxFiles)) {
    for (const finding of overflow.findings) {
      excluded.push({
        finding,
        reason: 'over-file-cap',
        explanation:
          `This run patches at most ${maxFiles} files. ${overflow.filePath} falls outside that ` +
          'budget and is deferred to the next pass.',
      });
    }
  }

  const byReason = countReasons(excluded);
  const grouped = groups.reduce((total, group) => total + group.findings.length, 0);

  return {
    groups,
    excluded,
    humanQueue: excluded.filter(
      (item) => item.reason === 'flag' || item.reason === 'no-source-path',
    ),
    stats: {
      considered: findings.length,
      grouped,
      files: groups.length,
      excluded: excluded.length,
      byReason,
    },
  };
}

function buildGroup(filePath: string, findings: readonly GroupedFinding[]): FixGroup {
  const criteria = [...new Set(findings.map((f) => f.criterion))].sort((a, b) =>
    a.localeCompare(b, 'en', { numeric: true }),
  );
  const pageUrls = [
    ...new Set(findings.map((f) => f.pageUrl).filter((url): url is string => Boolean(url))),
  ];
  const severity = findings.reduce<FixableFinding['severity']>(
    (worst, f) => (SEVERITY_RANK[f.severity] < SEVERITY_RANK[worst] ? f.severity : worst),
    'minor',
  );

  return {
    filePath,
    findings,
    findingIds: findings.map((f) => f.id),
    criteria,
    severity,
    pageUrls,
  };
}

function countReasons(
  excluded: readonly ExcludedFinding[],
): Readonly<Record<ExclusionReason, number>> {
  const counts: Record<ExclusionReason, number> = {
    flag: 0,
    blocked: 0,
    'no-source-path': 0,
    'unknown-criterion': 0,
    'not-actionable': 0,
    'over-file-cap': 0,
    'over-finding-cap': 0,
  };
  for (const item of excluded) counts[item.reason] += 1;
  return counts;
}

/* -------------------------------------------------------------------------- */
/* Convenience                                                                */
/* -------------------------------------------------------------------------- */

/** Every file the FIX pass needs the current contents of, in group order. */
export function filesToRead(grouping: FixGrouping): string[] {
  return grouping.groups.map((group) => group.filePath);
}

/** Every criterion the run is attempting to fix, ascending. For the PR body. */
export function criteriaUnderRepair(grouping: FixGrouping): string[] {
  const all = new Set<string>();
  for (const group of grouping.groups) {
    for (const criterion of group.criteria) all.add(criterion);
  }
  return [...all].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/**
 * A one-line human summary of what the FIX pass is about to do, for the run
 * timeline and the top of the approval card.
 */
export function describeGrouping(grouping: FixGrouping): string {
  const { files, grouped, excluded } = grouping.stats;
  if (files === 0) {
    return excluded === 0
      ? 'No findings to fix.'
      : `Nothing to patch: all ${excluded} findings were routed elsewhere.`;
  }
  const flagged = grouping.stats.byReason.flag;
  const tail =
    flagged > 0
      ? flagged === 1
        ? ' 1 flagged finding stays with a human.'
        : ` ${flagged} flagged findings stay with a human.`
      : '';
  return (
    `${grouped} finding${grouped === 1 ? '' : 's'} across ${files} ` +
    `file${files === 1 ? '' : 's'}, one patch per file.${tail}`
  );
}
