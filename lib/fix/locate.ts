/**
 * Source location for findings observed on a rendered page (the FIX pre-pass).
 *
 * VIS and ACT audit the deployed site. What they hand back is a claim about a
 * *pixel* and a *DOM node* — an accessible name, a CSS selector, a criterion,
 * a screenshot region. None of that is a file. `groupFindingsForFix` batches by
 * `sourcePath`, so a finding without one is routed to the human queue and FIX
 * never sees it. Left alone, every live-audit finding is skipped and no pull
 * request is ever opened. Only CODE sets `sourcePath`, because CODE reads the
 * repository directly, and CODE covers three criteria.
 *
 * This module closes that gap: given a finding and a repository, it names the
 * file that renders the element, or says it does not know.
 *
 * Three passes, cheapest first:
 *
 *  1. **Literal.** The repository tree is fetched once and the source files are
 *     read once, then scored against terms pulled out of the finding — quoted
 *     labels, the accessible name, class names and ids lifted from the
 *     selector. Terms are weighted by how *rare* they are in this repository,
 *     which is what separates `Español` from `button`. A file that both scores
 *     strongly and actually contains markup wins outright.
 *
 *  2. **Import expansion.** The literal pass finds the file that holds the
 *     string, which is very often not the file that renders it — the label
 *     lives in `lib/i18n/locales.ts` and the button that displays it lives in a
 *     component three directories away. So any module that imports the
 *     top-scoring data file, and mentions the identifiers sitting next to the
 *     matched literal, joins the shortlist.
 *
 *  3. **Model.** When the shortlist is genuinely ambiguous, a small
 *     locator agent is shown the finding and an excerpt of each candidate and
 *     asked which one renders the element. Structured output, zod-validated,
 *     and the answer is only accepted if it names a file that was actually on
 *     the shortlist.
 *
 * The default answer is `null`. A wrong path is far worse than no path: it
 * makes FIX rewrite an unrelated component, and VERIFY then has to catch it.
 * `null` sends the finding to the human queue, which is the correct outcome for
 * something we could not locate.
 *
 * Nothing here writes to the database. The caller populates `sourcePath` on the
 * in-memory findings it is about to group; `recordFindings()` remains the only
 * writer to the `findings` table.
 */

import { z } from 'zod';

import { MODELS } from '@/lib/harness/agents';
import type { AgentSpec, ResponseFormat } from '@/lib/harness/client';
import { runAgentWithFallback } from '@/lib/harness/run';

/* -------------------------------------------------------------------------- */
/* Input and output                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The subset of a finding the locator can work from.
 *
 * Structural rather than an import of the Drizzle row, so a ledger row, a
 * projection, or a fixture all satisfy it without a cast. `selector` is
 * accepted directly and also recovered from `detail`, because the ledger folds
 * it into the detail text as a `Selector:` line rather than giving it a column.
 */
export interface LocatableFinding {
  readonly id: string;
  readonly criterion: string;
  readonly summary: string;
  readonly detail?: string | null;
  readonly selector?: string | null;
  /** Already known? Then it is returned untouched and costs nothing. */
  readonly sourcePath?: string | null;
  readonly pageUrl?: string | null;
}

export type LocateMethod =
  /** The finding already carried a path (CODE lane). Nothing was done. */
  | 'existing'
  /** A distinctive literal pointed at exactly one file that renders markup. */
  | 'literal'
  /** The shortlist was ambiguous and the locator agent chose from it. */
  | 'model'
  /** No candidate survived. The finding goes to the human queue. */
  | 'none';

export interface LocatedSource {
  readonly findingId: string;
  /** Repository-relative, forward slashes. `null` when genuinely unsure. */
  readonly sourcePath: string | null;
  readonly method: LocateMethod;
  readonly confidence: 'high' | 'medium' | 'low' | 'none';
  /** The shortlist that was considered, best first. For the run timeline. */
  readonly candidates: readonly string[];
  /** One line, why. */
  readonly reason: string;
}

export interface LocateFindingSourcesInput {
  /** `owner/repo`. */
  readonly repoFullName: string;
  /** The user's OAuth token. Empty string is allowed for a public repository. */
  readonly accessToken: string;
  readonly findings: readonly LocatableFinding[];
  /** Branch, tag or SHA. Defaults to the repository's default branch. */
  readonly ref?: string;
  readonly signal?: AbortSignal;
  /** Cap on source files read from the repository. Default 500. */
  readonly maxFiles?: number;
  /** Cap on the shortlist handed to the model. Default 6. */
  readonly maxCandidates?: number;
  /** Set false to run the literal passes only (no model calls). Default true. */
  readonly useModel?: boolean;
  /** Log the full ranking per finding through `onLog`. Off by default. */
  readonly debug?: boolean;
  /** Progress lines for the run timeline. */
  readonly onLog?: (line: string) => void;
}

/* -------------------------------------------------------------------------- */
/* Repository index                                                           */
/* -------------------------------------------------------------------------- */

const GITHUB_API = 'https://api.github.com';

const SOURCE_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs', '.html', '.vue', '.svelte'];

const EXCLUDED_DIRECTORIES = [
  'node_modules/',
  '.next/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  'vendor/',
  '.git/',
  '.turbo/',
  'storybook-static/',
];

/** Bundled or generated output. Nothing here is a file a human would patch. */
const EXCLUDED_SUFFIXES = ['.min.js', '.umd.js', '.bundle.js', '.d.ts', '.map'];

const MAX_FILE_BYTES = 400_000;

interface RepoFile {
  readonly path: string;
  readonly content: string;
  readonly lower: string;
  readonly lines: readonly string[];
  /** Contains markup: JSX/HTML tags, `className=`, `class=`. */
  readonly renders: boolean;
  /** A test, spec or story file. Real, but almost never the thing to patch. */
  readonly auxiliary: boolean;
}

interface RepoIndex {
  readonly repoFullName: string;
  readonly ref: string;
  readonly files: readonly RepoFile[];
  readonly byPath: ReadonlyMap<string, RepoFile>;
}

/**
 * One index per repo+ref for the lifetime of the process. A run locates dozens
 * of findings against the same tree and the tree does not move underneath it.
 */
const indexCache = new Map<string, Promise<RepoIndex>>();

function githubHeaders(token: string, accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept,
    'user-agent': 'accessifix',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function encodeRepoPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function parseRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.trim().replace(/^\/+|\/+$/g, '').split('/');
  if (!owner || !repo) throw new Error(`Not an owner/repo: "${fullName}"`);
  return { owner, repo };
}

async function resolveRef(
  repoFullName: string,
  token: string,
  ref: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (ref) return ref;
  const { owner, repo } = parseRepo(repoFullName);
  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
    headers: githubHeaders(token, 'application/vnd.github+json'),
    signal,
  });
  if (!response.ok) {
    throw new Error(`GitHub ${response.status} reading ${repoFullName}: ${await safeText(response)}`);
  }
  const body = (await response.json()) as { default_branch?: string };
  return body.default_branch ?? 'main';
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
}

interface TreeEntry {
  path?: string;
  type?: string;
  size?: number;
}

/**
 * Path priority when the repository has more source files than the cap allows.
 * Markup-bearing files under the usual UI directories are read first, tests
 * last, because the answer to "which file renders this" is overwhelmingly in
 * the first group.
 */
function pathPriority(path: string): number {
  const lower = path.toLowerCase();
  if (/(^|\/)(__tests__|__mocks__|tests?|e2e|cypress|playwright|\.storybook)\//.test(lower)) return 4;
  if (/\.(test|spec|stories)\.[a-z]+$/.test(lower)) return 4;
  // Build scripts, dev tooling and bundled skills live in the repository but
  // never render a page. In an accessibility target they are actively
  // misleading: a linting script is full of the same vocabulary as a finding.
  if (/(^|\/)(scripts?|skills?|tools?|bin|docs?|examples?|fixtures?)\//.test(lower)) return 4;
  const markup = /\.(tsx|jsx|vue|svelte|html)$/.test(lower);
  const uiDirectory =
    /(^|\/)(app|src|components|component|pages|ui|views|layouts|templates|screens|containers|widgets|features|routes)\//.test(
      lower,
    );
  if (markup && uiDirectory) return 0;
  if (markup) return 1;
  if (uiDirectory) return 2;
  return 3;
}

function isSourcePath(path: string): boolean {
  const lower = path.toLowerCase();
  if (EXCLUDED_DIRECTORIES.some((dir) => lower === dir || lower.startsWith(dir) || lower.includes(`/${dir}`))) {
    return false;
  }
  if (EXCLUDED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;
  return SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

const MARKUP_SIGNALS = [
  'classname=',
  'class="',
  "class='",
  'aria-',
  'role=',
  '<button',
  '<div',
  '<span',
  '<a ',
  '<input',
  '<nav',
  '<section',
  '<template',
];

function looksLikeRenderer(path: string, content: string, lower: string): boolean {
  if (/\.(html|vue|svelte)$/i.test(path)) return true;
  if (MARKUP_SIGNALS.some((signal) => lower.includes(signal))) return true;
  // A JSX return is markup even when it carries no attributes at all.
  return /return\s*\(\s*</.test(content) || /=>\s*\(?\s*</.test(content);
}

async function fetchFile(
  repoFullName: string,
  token: string,
  path: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const { owner, repo } = parseRepo(repoFullName);
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(ref)}`;
  try {
    const response = await fetch(url, {
      headers: githubHeaders(token, 'application/vnd.github.raw'),
      signal,
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function buildRepoIndex(
  repoFullName: string,
  token: string,
  ref: string,
  maxFiles: number,
  signal: AbortSignal | undefined,
  onLog: ((line: string) => void) | undefined,
): Promise<RepoIndex> {
  const { owner, repo } = parseRepo(repoFullName);
  const treeUrl = `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const response = await fetch(treeUrl, {
    headers: githubHeaders(token, 'application/vnd.github+json'),
    signal,
  });
  if (!response.ok) {
    throw new Error(`GitHub ${response.status} reading the tree of ${repoFullName}@${ref}`);
  }
  const body = (await response.json()) as { tree?: TreeEntry[]; truncated?: boolean };

  const wanted = (body.tree ?? [])
    .filter(
      (entry): entry is TreeEntry & { path: string } =>
        entry.type === 'blob' &&
        typeof entry.path === 'string' &&
        isSourcePath(entry.path) &&
        (entry.size ?? 0) <= MAX_FILE_BYTES,
    )
    .map((entry) => entry.path)
    // Priority 4 is tests, specs, stories, build scripts and bundled tooling.
    // They are dropped rather than merely deprioritised, for two reasons. They
    // are never the answer — patching an end-to-end spec does not fix a
    // contrast bug — and, worse, an e2e spec contains the accessible names of
    // everything it drives, so leaving it in makes the one string that
    // identifies the element look twice as common as it is and dilutes the
    // rarity weighting that the whole literal pass rests on.
    .filter((path) => pathPriority(path) < 4)
    .sort((a, b) => pathPriority(a) - pathPriority(b) || a.localeCompare(b))
    .slice(0, maxFiles);

  onLog?.(
    `Locator: ${wanted.length} source file(s) in ${repoFullName}@${ref}` +
      (body.truncated ? ' (tree truncated by GitHub)' : ''),
  );

  const fetched = await mapLimit(wanted, 8, async (path) => {
    const content = await fetchFile(repoFullName, token, path, ref, signal);
    if (content === null || content.length === 0) return null;
    const lower = content.toLowerCase();
    const file: RepoFile = {
      path,
      content,
      lower,
      lines: content.split('\n'),
      renders: looksLikeRenderer(path, content, lower),
      auxiliary: pathPriority(path) === 4,
    };
    return file;
  });

  const files = fetched.filter((file): file is RepoFile => file !== null);
  return {
    repoFullName,
    ref,
    files,
    byPath: new Map(files.map((file) => [file.path, file])),
  };
}

async function getRepoIndex(input: LocateFindingSourcesInput): Promise<RepoIndex> {
  const ref = await resolveRef(input.repoFullName, input.accessToken, input.ref, input.signal);
  const key = `${input.repoFullName}@${ref}`;
  const cached = indexCache.get(key);
  if (cached) return cached;

  const pending = buildRepoIndex(
    input.repoFullName,
    input.accessToken,
    ref,
    input.maxFiles ?? 500,
    input.signal,
    input.onLog,
  );
  indexCache.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    indexCache.delete(key);
    throw error;
  }
}

/** Exported for tests and long-lived processes; the index is otherwise sticky. */
export function clearRepoIndexCache(): void {
  indexCache.clear();
}

/* -------------------------------------------------------------------------- */
/* Turning a finding into search terms                                        */
/* -------------------------------------------------------------------------- */

/**
 * Words that carry no location information. Two groups: ordinary English
 * function words, and accessibility vocabulary — every finding says "contrast"
 * and "button", so neither tells you which file to open. The rarity weighting
 * below would mostly suppress these anyway; listing them explicitly keeps a
 * small repository (where "button" genuinely is rare) from being misled.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'has', 'have', 'not', 'are', 'was', 'were', 'its',
  'from', 'into', 'onto', 'but', 'all', 'any', 'can', 'cannot', 'does', 'their', 'there', 'when',
  'which', 'while', 'would', 'should', 'could', 'than', 'then', 'them', 'they', 'you', 'your',
  'page', 'pages', 'element', 'elements', 'component', 'components', 'user', 'users', 'users',
  'button', 'buttons', 'link', 'links', 'input', 'inputs', 'label', 'labels', 'labelled', 'labeled',
  'text', 'texts', 'colour', 'color', 'colours', 'colors', 'contrast', 'ratio', 'border', 'borders',
  'background', 'foreground', 'against', 'requirement', 'requirements', 'required', 'requires',
  'wcag', 'criterion', 'criteria', 'accessible', 'accessibility', 'name', 'names', 'role', 'roles',
  'aria', 'attribute', 'attributes', 'focus', 'focusable', 'keyboard', 'screen', 'reader',
  'readers', 'visible', 'visibility', 'hidden', 'state', 'states', 'value', 'values', 'card',
  'cards', 'control', 'controls', 'fails', 'fail', 'failing', 'passes', 'below', 'above', 'level',
  'minimum', 'maximum', 'non', 'text', 'ui', 'ux', 'html', 'dom', 'css', 'span', 'div', 'class',
  'classes', 'selector', 'selectors', 'evidence', 'finding', 'findings', 'audit', 'render',
  'rendered', 'renders', 'rendering', 'site', 'website', 'deployed', 'live',
]);

/** Selector fragments so common they identify nothing. */
const GENERIC_CLASSES = new Set([
  'flex', 'grid', 'block', 'inline', 'hidden', 'relative', 'absolute', 'fixed', 'sticky', 'container',
  'row', 'col', 'wrapper', 'content', 'item', 'items', 'active', 'disabled', 'selected', 'open',
  'btn', 'button', 'card', 'text', 'title', 'header', 'footer', 'main', 'nav', 'group', 'left',
  'right', 'center', 'small', 'large', 'primary', 'secondary', 'default', 'w-full', 'h-full',
]);

/**
 * `token` is ordinary prose lifted from the summary. The other four are
 * *identifying* terms — something the auditor read off the element itself, or
 * off its selector, which a developer would have typed into the file. Only
 * those four can settle a location without adjudication: a file that matches
 * nothing but prose has matched the finding's vocabulary, not its subject.
 */
type TermKind = 'phrase' | 'id' | 'class' | 'name-token' | 'token';

const IDENTIFYING_KINDS: ReadonlySet<TermKind> = new Set<TermKind>([
  'phrase',
  'id',
  'class',
  'name-token',
]);

interface QueryTerm {
  /** The literal to search for. Matching is case-insensitive. */
  readonly text: string;
  readonly kind: TermKind;
  /** Weight before rarity is applied. */
  readonly base: number;
}

interface FindingQuery {
  readonly terms: readonly QueryTerm[];
  readonly selector: string | null;
  /** Stable key for caching a model verdict across identical findings. */
  readonly key: string;
}

const SELECTOR_LINE = /^Selector:\s*(.+)$/m;

function selectorOf(finding: LocatableFinding): string | null {
  const direct = finding.selector?.trim();
  if (direct) return direct;
  const match = finding.detail ? SELECTOR_LINE.exec(finding.detail) : null;
  return match ? match[1].trim() : null;
}

/** `\[var\(--x\)\]` in a CSS selector is `[var(--x)]` in the source. */
function unescapeSelector(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

const QUOTED = /["“”'‘’`]([^"“”'‘’`\n]{2,90})["“”'‘’`]/g;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}_'’-]{1,}/gu;

function buildQuery(finding: LocatableFinding): FindingQuery {
  const terms = new Map<string, QueryTerm>();
  const add = (text: string, kind: TermKind, base: number): void => {
    const cleaned = text.trim();
    if (cleaned.length < 2) return;
    const key = `${kind}:${cleaned.toLowerCase()}`;
    const existing = terms.get(key);
    if (!existing || existing.base < base) terms.set(key, { text: cleaned, kind, base });
  };

  const selector = selectorOf(finding);
  if (selector) {
    // Ids and test hooks are the strongest signal there is: they are unique by
    // construction and they are written verbatim in the source.
    for (const match of selector.matchAll(/#([\w-]+)/g)) add(match[1], 'id', 18);
    for (const match of selector.matchAll(
      /\[\s*(?:data-testid|data-test|data-cy|data-qa|id|name)\s*=\s*["']?([^"'\]]+)/g,
    )) {
      add(match[1], 'id', 18);
    }
    for (const match of selector.matchAll(/\.((?:[\w-]|\\.)+)/g)) {
      const className = unescapeSelector(match[1]);
      if (className.length < 3) continue;
      if (GENERIC_CLASSES.has(className.toLowerCase())) continue;
      add(className, 'class', 9);
    }
  }

  const prose = [finding.summary, finding.detail ?? ''].join('\n');

  // A quoted span in a finding is nearly always the accessible name or the
  // literal the auditor read off the page. Highest-value non-id term.
  for (const match of prose.matchAll(QUOTED)) {
    const phrase = match[1].trim();
    if (phrase.length < 3) continue;
    if (selector && phrase === selector) continue;
    add(phrase, 'phrase', 14);
    // An accessible name is often a concatenation of several rendered nodes —
    // "English EN" is `nativeLabel` next to `shortLabel` — so the whole phrase
    // may appear in no file at all while each half is distinctive.
    for (const word of phrase.matchAll(WORD)) add(word[0], 'name-token', 8);
  }

  for (const word of prose.matchAll(WORD)) {
    const raw = word[0];
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw.toLowerCase())) continue;
    if (/^\d+$/.test(raw)) continue;
    add(raw, 'token', 5);
  }

  const ordered = [...terms.values()].sort((a, b) => b.base - a.base).slice(0, 60);
  const key = [
    finding.criterion,
    selector ?? '',
    ordered.map((term) => `${term.kind}:${term.text.toLowerCase()}`).sort().join(','),
  ].join('|');

  return { terms: ordered, selector, key };
}

/* -------------------------------------------------------------------------- */
/* Literal scoring                                                            */
/* -------------------------------------------------------------------------- */

interface Candidate {
  readonly file: RepoFile;
  score: number;
  /**
   * The part of `score` earned from identifying terms — a quoted label, an id,
   * a class off the selector. Only this can make a match decisive.
   */
  identifyingScore: number;
  /** The same, before the path penalty. What import expansion carries across. */
  identifyingRaw: number;
  /** Terms that actually matched, best first. Drives the excerpt windows. */
  readonly matched: string[];
  /** Set when this file is the sole rendering importer of a matched data file. */
  soleRenderer: string | null;
  reason: string;
}

/**
 * Rarity is the whole trick. A term present in one file out of four hundred
 * identifies that file; a term present in a hundred identifies nothing. Rather
 * than curating a list of "distinctive" words, the repository is asked how
 * unusual each term is in *it*.
 */
function rarityWeight(documentFrequency: number, fileCount: number): number {
  if (documentFrequency === 0) return 0;
  if (documentFrequency > Math.max(12, fileCount * 0.25)) return 0;
  if (documentFrequency === 1) return 1.6;
  if (documentFrequency <= 3) return 1.15;
  if (documentFrequency <= 6) return 0.6;
  return 0.22;
}

function pathWeight(file: RepoFile): number {
  if (file.auxiliary) return 0.3;
  // A module that contains no markup can still be the right answer — a
  // constants file that holds an `aria-label` string, say — but it is far more
  // often the data behind the element than the element itself.
  return file.renders ? 1 : 0.4;
}

function scoreLiterally(index: RepoIndex, query: FindingQuery): Candidate[] {
  const fileCount = index.files.length;
  const candidates = new Map<string, Candidate>();

  for (const term of query.terms) {
    const needle = term.text.toLowerCase();
    const hits = index.files.filter((file) => file.lower.includes(needle));
    const weight = rarityWeight(hits.length, fileCount);
    if (weight === 0) continue;

    for (const file of hits) {
      const existing =
        candidates.get(file.path) ??
        {
          file,
          score: 0,
          identifyingScore: 0,
          identifyingRaw: 0,
          matched: [],
          soleRenderer: null,
          reason: '',
        };
      const contribution = term.base * weight;
      existing.score += contribution;
      if (IDENTIFYING_KINDS.has(term.kind)) {
        existing.identifyingScore += contribution;
        existing.identifyingRaw += contribution;
      }
      existing.matched.push(term.text);
      candidates.set(file.path, existing);
    }
  }

  for (const candidate of candidates.values()) {
    const weight = pathWeight(candidate.file);
    candidate.score *= weight;
    candidate.identifyingScore *= weight;
    candidate.reason = `matched ${candidate.matched.slice(0, 4).join(', ')}`;
  }

  return [...candidates.values()].sort((a, b) => b.score - a.score);
}

/* -------------------------------------------------------------------------- */
/* Import expansion                                                           */
/* -------------------------------------------------------------------------- */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The identifiers that link a data file to the component that renders it, in
 * two tiers of very different strength.
 *
 * `adjacent` are the object keys on the lines where the literal actually
 * matched: `nativeLabel: "Español"` yields `nativeLabel`. A component that
 * writes `entry.nativeLabel` is rendering *that* string — the connection
 * between the two files that no amount of searching for "Español" would find,
 * because the component never contains the word.
 *
 * `exported` are the module's exported names. Useful for ranking, far weaker as
 * evidence: half the application imports `copy` and `localized`.
 */
interface LinkingIdentifiers {
  readonly adjacent: readonly string[];
  readonly exported: readonly string[];
}

function linkingIdentifiers(file: RepoFile, matched: readonly string[]): LinkingIdentifiers {
  const exported = new Set<string>();
  for (const match of file.content.matchAll(
    /export\s+(?:default\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    exported.add(match[1]);
  }

  const adjacent = new Set<string>();
  const needles = matched.map((term) => term.toLowerCase());
  for (const line of file.lines) {
    const lower = line.toLowerCase();
    if (!needles.some((needle) => lower.includes(needle))) continue;
    for (const match of line.matchAll(/([A-Za-z_$][\w$]{2,})\s*:/g)) adjacent.add(match[1]);
  }

  const usable = (name: string): boolean => name.length >= 4 && !GENERIC_CLASSES.has(name.toLowerCase());
  return {
    adjacent: [...adjacent].filter(usable).slice(0, 24),
    exported: [...exported].filter(usable).slice(0, 24),
  };
}

function importersOf(index: RepoIndex, target: RepoFile): RepoFile[] {
  const withoutExtension = target.path.replace(/\.[^./]+$/, '');
  const basename = withoutExtension.split('/').pop() ?? withoutExtension;
  if (basename.length < 3) return [];

  // Match any module specifier whose tail is this file, however it is aliased:
  // `@/lib/i18n/locales`, `../../lib/i18n/locales`, `./locales`.
  const specifier = new RegExp(
    `(?:from|import|require)\\s*\\(?\\s*['"\`][^'"\`]*${escapeRegExp(basename)}(?:\\.[a-z]+)?['"\`]`,
    'i',
  );
  // `index.ts` is imported by its directory name, so fall back to that.
  const directory = basename === 'index' ? withoutExtension.split('/').slice(-2, -1)[0] ?? '' : '';
  const directorySpecifier = directory
    ? new RegExp(
        `(?:from|import|require)\\s*\\(?\\s*['"\`][^'"\`]*${escapeRegExp(directory)}['"\`]`,
        'i',
      )
    : null;

  return index.files.filter(
    (file) =>
      file.path !== target.path &&
      !file.auxiliary &&
      (specifier.test(file.content) || (directorySpecifier?.test(file.content) ?? false)),
  );
}

/**
 * Promote the renderers behind the data files the literal pass found.
 *
 * Only importers that both render markup and mention the linking identifiers
 * are admitted, and they enter at a fraction of the data file's score — enough
 * to reach the shortlist, not enough to win on their own.
 */
function expandThroughImports(index: RepoIndex, ranked: Candidate[]): Candidate[] {
  const byPath = new Map(ranked.map((candidate) => [candidate.file.path, candidate]));
  // Seeds are ranked by identifying evidence rather than by total score: the
  // question is "which data file holds the string the auditor read", and prose
  // overlap says nothing about that.
  const seeds = ranked
    .filter((candidate) => !candidate.file.renders && candidate.identifyingRaw > 0)
    .sort((a, b) => b.identifyingRaw - a.identifyingRaw)
    .slice(0, 4);

  for (const seed of seeds) {
    const identifiers = linkingIdentifiers(seed.file, seed.matched);
    if (identifiers.adjacent.length === 0 && identifiers.exported.length === 0) continue;

    const linked: { importer: RepoFile; adjacent: string[]; exported: string[] }[] = [];
    for (const importer of importersOf(index, seed.file)) {
      if (!importer.renders) continue;
      const adjacent = identifiers.adjacent.filter((name) => importer.content.includes(name));
      const exported = identifiers.exported.filter((name) => importer.content.includes(name));
      if (adjacent.length === 0 && exported.length === 0) continue;
      linked.push({ importer, adjacent, exported });
    }

    // The strong case: exactly one file in the repository both renders markup
    // and reads the very key the matched literal sits on. `nativeLabel` lives
    // in one data module and is displayed in one component, so there is nothing
    // left to be ambiguous about — this is the file, and it is an inference
    // about structure rather than a guess about names.
    const byAdjacent = linked.filter((entry) => entry.adjacent.length > 0);
    const sole =
      byAdjacent.length === 1 && seed.identifyingRaw >= SOLE_SEED_MINIMUM ? byAdjacent[0] : null;

    for (const entry of linked) {
      const strength =
        0.5 + Math.min(0.4, entry.adjacent.length * 0.2) + Math.min(0.2, entry.exported.length * 0.05);
      const bonus = seed.score * strength;
      const shared = [...entry.adjacent, ...entry.exported];
      const isSole = sole !== null && sole.importer.path === entry.importer.path;
      const note = `renders ${shared.slice(0, 3).join(', ')} from ${seed.file.path}`;

      const existing = byPath.get(entry.importer.path);
      const candidate: Candidate =
        existing ??
        {
          file: entry.importer,
          score: 0,
          identifyingScore: 0,
          identifyingRaw: 0,
          matched: [],
          soleRenderer: null,
          reason: `imports ${seed.file.path} and ${note}`,
        };

      candidate.score += bonus;
      candidate.matched.push(...shared);
      if (existing) candidate.reason += `; ${note}`;

      // Only the sole rendering reader inherits the seed's identifying
      // evidence. Every other importer gets rank, not standing: being one of
      // several files that import the module is a reason to be looked at, not
      // a reason to be patched.
      if (isSole) {
        // The seed's evidence, plus credit for the corroboration itself: using
        // the exact key the literal sits on is independent evidence, worth
        // about what a class name off the selector is worth.
        const transferred = seed.identifyingRaw + 6 * Math.min(2, entry.adjacent.length);
        candidate.identifyingScore += transferred;
        candidate.identifyingRaw += transferred;
        candidate.soleRenderer =
          `the only file that renders ${entry.adjacent.slice(0, 3).join(', ')} from ${seed.file.path}`;
      }

      byPath.set(entry.importer.path, candidate);
    }
  }

  return [...byPath.values()].sort((a, b) => b.score - a.score);
}

/* -------------------------------------------------------------------------- */
/* The locator agent                                                          */
/* -------------------------------------------------------------------------- */

const LOCATOR_INSTRUCTIONS = `You are the SOURCE LOCATOR for AccessiFix.

An accessibility audit ran against a deployed web page and found a problem on a
specific element. You are given the finding and excerpts from a shortlist of
files in the repository that built that page. Name the ONE file a developer
would open to fix it.

RULES
- Answer with a path copied character-for-character from the candidate list, or null.
- Choose the file that RENDERS the element — the one holding the markup, the
  className, the attribute or the tag that the finding is about. A file that
  merely defines the text, the data or the type the element displays is the
  wrong answer unless the fix genuinely belongs there.
- A wrong file is much worse than no file. It makes the repair agent rewrite an
  unrelated component. When two candidates are equally plausible, when no
  excerpt actually shows the element, or when you are reasoning from the file
  name rather than from what you can see, answer null.
- "high" confidence means the excerpt shows the element itself. "medium" means
  the excerpt shows the loop, the component or the container that produces it.
  Anything weaker is "low", and "low" is treated as null.
- Give a one-sentence reason naming the evidence you used.`;

const LOCATE_RESPONSE_FORMAT: ResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'accessifix_source_location',
    description: 'The repository file that renders the element a finding is about.',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['sourcePath', 'confidence', 'reason'],
      properties: {
        sourcePath: {
          anyOf: [{ type: 'string' }, { type: 'null' }],
          description: 'A path copied exactly from the candidate list, or null if unsure.',
        },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        reason: { type: 'string', description: 'One sentence naming the evidence used.' },
      },
    },
    strict: false,
  },
};

const LocateAnswerSchema = z.object({
  sourcePath: z.string().nullish(),
  confidence: z.enum(['high', 'medium', 'low']).nullish(),
  reason: z.string().nullish(),
});

type LocateAnswer = z.infer<typeof LocateAnswerSchema>;

function locatorSpec(model: string): AgentSpec {
  return {
    model: { name: model },
    instructions: LOCATOR_INSTRUCTIONS,
    response_format: LOCATE_RESPONSE_FORMAT,
    config: { iteration_limit: 6, sandbox: { enabled: false } },
  };
}

const MAX_EXCERPT_LINES = 72;
const MAX_LINE_CHARS = 220;
const MAX_PROMPT_CHARS = 45_000;

/**
 * Markup, not TypeScript. `<[A-Za-z]` looks like a tag but matches every
 * generic — `useState<SupportedLocale | null>` — which is how an excerpt ends
 * up being the top of the file instead of the element in question.
 */
const MARKUP_LINE =
  /className|class=|aria-|role=|\/>|<\/|<(?:button|div|span|a|p|li|ul|ol|input|label|select|option|textarea|section|nav|header|footer|main|form|img|table|tr|td|th|svg|h[1-6])/i;

/**
 * The most telling matched lines, plus their neighbours.
 *
 * Anchors are ranked rather than taken in file order, which matters more than
 * it sounds: a component's import block matches the same identifiers as the
 * markup a thousand lines below it, so taking the first matches spends the
 * whole budget on imports and shows the model nothing it can decide from. A
 * line that both matches and carries markup is what the question is about.
 */
function excerpt(candidate: Candidate): string {
  const needles = [...new Set(candidate.matched.map((term) => term.toLowerCase()))].slice(0, 16);
  const lines = candidate.file.lines;

  const anchors: { index: number; score: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const lower = lines[i].toLowerCase();
    const hits = needles.filter((needle) => lower.includes(needle)).length;
    if (hits === 0) continue;
    anchors.push({ index: i, score: hits * 3 + (MARKUP_LINE.test(lines[i]) ? 5 : 0) });
  }
  anchors.sort((a, b) => b.score - a.score || a.index - b.index);

  // Spread the budget over the file: five separate regions tell the model more
  // than one contiguous block, and the separation stops one dense area winning.
  const chosen: number[] = [];
  for (const anchor of anchors) {
    if (chosen.length >= 6) break;
    if (chosen.some((index) => Math.abs(index - anchor.index) < 10)) continue;
    chosen.push(anchor.index);
  }

  const keep = new Set<number>();
  for (const index of chosen) {
    for (let j = Math.max(0, index - 7); j <= Math.min(lines.length - 1, index + 7); j += 1) {
      keep.add(j);
    }
  }

  const numbers = [...keep].sort((a, b) => a - b).slice(0, MAX_EXCERPT_LINES);
  const out: string[] = [];
  let previous = -2;
  for (const number of numbers) {
    if (number !== previous + 1 && out.length > 0) out.push('        ...');
    out.push(`${String(number + 1).padStart(5)} | ${candidate.file.lines[number].slice(0, MAX_LINE_CHARS)}`);
    previous = number;
  }
  return out.join('\n');
}

function buildLocatePrompt(finding: LocatableFinding, shortlist: readonly Candidate[]): string {
  const parts: string[] = [
    'FINDING (observed on the deployed page, not in the source)',
    `- WCAG criterion: ${finding.criterion}`,
    `- Summary: ${finding.summary}`,
  ];
  if (finding.detail) parts.push(`- Detail: ${finding.detail.slice(0, 1200)}`);
  const selector = selectorOf(finding);
  if (selector) parts.push(`- CSS selector: ${selector}`);
  if (finding.pageUrl) parts.push(`- Page: ${finding.pageUrl}`);

  parts.push('', 'CANDIDATE FILES', '');
  for (let i = 0; i < shortlist.length; i += 1) {
    const candidate = shortlist[i];
    parts.push(`--- ${i + 1}. ${candidate.file.path}  (${candidate.reason})`);
    const body = excerpt(candidate);
    parts.push(body.length > 0 ? body : '        (no excerpt — matched on path and imports only)');
    parts.push('');
  }

  parts.push(
    'Which single candidate path renders the element this finding is about?',
    'Copy the path exactly, or answer null. Answer null rather than guessing.',
  );

  const prompt = parts.join('\n');
  return prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS)}\n[truncated]` : prompt;
}

/**
 * One model verdict per distinct (query, shortlist). Three findings on three
 * sibling buttons in the same component ask the same question three times;
 * this asks it once. Lives for the call, not the process — the shortlist
 * depends on the repository index, which does not change mid-run.
 */
type VerdictCache = Map<string, Promise<LocateAnswer | null>>;

async function askLocator(
  finding: LocatableFinding,
  shortlist: readonly Candidate[],
  signal: AbortSignal | undefined,
  onPrompt?: (prompt: string) => void,
): Promise<LocateAnswer | null> {
  const prompt = buildLocatePrompt(finding, shortlist);
  onPrompt?.(prompt);
  try {
    const result = await runAgentWithFallback<LocateAnswer>(
      locatorSpec(MODELS.anthropicSonnet),
      locatorSpec(MODELS.fireworksBulk),
      prompt,
      { schema: LocateAnswerSchema, signal, attempts: 2, timeoutMs: 180_000 },
    );
    return result.data;
  } catch {
    // The locator failing is not a reason to guess. It is a reason to say null.
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* The pass                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A literal match this strong, in a file that renders, needs no adjudication.
 * Calibrated so that one term unique to a single file in the repository clears
 * it — `name-token` 8 x rarity 1.6 = 12.8 — while prose overlap never does.
 */
const DECISIVE_SCORE = 12;
/** …and it must also be this far clear of the runner-up. */
const DECISIVE_MARGIN = 1.8;
/** The sole-renderer route carries its own uniqueness proof, so it needs less. */
const SOLE_RENDERER_MARGIN = 1.25;
/**
 * …but it is only offered when the data file itself matched something rare.
 * Without this, any module that happens to share a word with the finding could
 * hand its single rendering importer a decisive verdict.
 */
const SOLE_SEED_MINIMUM = 8;
/** Below this a candidate is noise; it never reaches the model. */
const MINIMUM_SCORE = 2.5;

/**
 * Locate the source file behind each finding.
 *
 * Findings that already carry a `sourcePath` are returned untouched. Everything
 * else is scored against the repository, expanded through imports, and — when
 * that is not decisive — put to the locator agent. Anything still unresolved
 * comes back `null`, which is what sends it to the human queue.
 */
export async function locateFindingSourcesDetailed(
  input: LocateFindingSourcesInput,
): Promise<LocatedSource[]> {
  const results: LocatedSource[] = [];
  const needsWork: LocatableFinding[] = [];

  for (const finding of input.findings) {
    const existing = finding.sourcePath?.trim();
    if (existing) {
      results.push({
        findingId: finding.id,
        sourcePath: existing,
        method: 'existing',
        confidence: 'high',
        candidates: [existing],
        reason: 'The finding already carried a source path.',
      });
    } else {
      needsWork.push(finding);
    }
  }

  if (needsWork.length === 0) return results;

  let index: RepoIndex;
  try {
    index = await getRepoIndex(input);
  } catch (error) {
    input.onLog?.(`Locator: could not index ${input.repoFullName} — ${(error as Error).message}`);
    for (const finding of needsWork) {
      results.push({
        findingId: finding.id,
        sourcePath: null,
        method: 'none',
        confidence: 'none',
        candidates: [],
        reason: `Repository could not be indexed: ${(error as Error).message}`,
      });
    }
    return results;
  }

  if (index.files.length === 0) {
    for (const finding of needsWork) {
      results.push({
        findingId: finding.id,
        sourcePath: null,
        method: 'none',
        confidence: 'none',
        candidates: [],
        reason: 'No readable source files in the repository.',
      });
    }
    return results;
  }

  const maxCandidates = input.maxCandidates ?? 6;
  const useModel = input.useModel !== false;
  const verdicts: VerdictCache = new Map();

  for (const finding of needsWork) {
    if (input.signal?.aborted) {
      results.push({
        findingId: finding.id,
        sourcePath: null,
        method: 'none',
        confidence: 'none',
        candidates: [],
        reason: 'The run was aborted before this finding was located.',
      });
      continue;
    }

    const query = buildQuery(finding);
    const ranked = expandThroughImports(index, scoreLiterally(index, query)).filter(
      (candidate) => candidate.score >= MINIMUM_SCORE,
    );
    const shortlist = ranked.slice(0, maxCandidates);
    const candidatePaths = shortlist.map((candidate) => candidate.file.path);

    if (input.debug) {
      const terms = query.terms.map((term) => `${term.kind}:${term.text}`).join(', ');
      const rows = ranked
        .slice(0, 8)
        .map(
          (candidate) =>
            `    ${candidate.score.toFixed(1)} (id ${candidate.identifyingScore.toFixed(1)}` +
            `${candidate.file.renders ? ', renders' : ''}` +
            `${candidate.soleRenderer ? ', SOLE' : ''}) ${candidate.file.path}`,
        );
      input.onLog?.([`Locator [${finding.id}] terms: ${terms}`, ...rows].join('\n'));
    }

    if (shortlist.length === 0) {
      results.push({
        findingId: finding.id,
        sourcePath: null,
        method: 'none',
        confidence: 'none',
        candidates: [],
        reason: 'Nothing in the repository matched anything distinctive in this finding.',
      });
      continue;
    }

    // Three conditions, and the middle one is the important one: the winning
    // evidence must be something the auditor read off the element — a label, an
    // id, a class — not the accessibility vocabulary every finding shares.
    // Otherwise a repository's own linting script wins every contrast finding.
    //
    // The margin is relaxed for the sole-renderer route because its qualifying
    // test has already done the disambiguation: it fired precisely because no
    // other file in the repository renders that key.
    const top = shortlist[0];
    const runnerUp = shortlist[1];
    const margin = top.soleRenderer ? SOLE_RENDERER_MARGIN : DECISIVE_MARGIN;
    const decisive =
      top.file.renders &&
      top.identifyingScore >= DECISIVE_SCORE &&
      (!runnerUp || top.score >= runnerUp.score * margin);

    if (decisive) {
      results.push({
        findingId: finding.id,
        sourcePath: top.file.path,
        method: 'literal',
        confidence: 'high',
        candidates: candidatePaths,
        reason: top.soleRenderer
          ? `Traced through imports: ${top.soleRenderer}.`
          : `Distinctive literal match in a file that renders markup (${top.reason}).`,
      });
      continue;
    }

    if (!useModel) {
      results.push({
        findingId: finding.id,
        sourcePath: null,
        method: 'none',
        confidence: 'none',
        candidates: candidatePaths,
        reason: 'Literal search was ambiguous and the model pass was disabled.',
      });
      continue;
    }

    const cacheKey = `${query.key}||${candidatePaths.join(',')}`;
    let pending = verdicts.get(cacheKey);
    if (!pending) {
      pending = askLocator(
        finding,
        shortlist,
        input.signal,
        input.debug ? (prompt) => input.onLog?.(`Locator prompt:
${prompt}`) : undefined,
      );
      verdicts.set(cacheKey, pending);
    }
    const answer = await pending;

    const chosen = answer?.sourcePath?.trim() ?? null;
    const confidence = answer?.confidence ?? 'low';

    // Three gates, all of which must pass: the model answered, it named a file
    // that was actually on the shortlist, and it was not hedging.
    if (!chosen || !index.byPath.has(chosen) || !candidatePaths.includes(chosen)) {
      results.push({
        findingId: finding.id,
        sourcePath: null,
        method: 'none',
        confidence: 'none',
        candidates: candidatePaths,
        reason: chosen
          ? `The locator named "${chosen}", which is not one of the candidates. Refused.`
          : 'The locator could not identify the rendering file.',
      });
      continue;
    }

    if (confidence === 'low') {
      results.push({
        findingId: finding.id,
        sourcePath: null,
        method: 'none',
        confidence: 'low',
        candidates: candidatePaths,
        reason: `The locator suggested ${chosen} but was not confident. Sent to the human queue.`,
      });
      continue;
    }

    results.push({
      findingId: finding.id,
      sourcePath: chosen,
      method: 'model',
      confidence,
      candidates: candidatePaths,
      reason: answer?.reason?.slice(0, 300) ?? `The locator chose ${chosen}.`,
    });
  }

  return results;
}

/**
 * The map form: finding id to repository-relative path, or `null`.
 *
 * This is what the fix phase wants — it copies the paths onto its in-memory
 * findings and hands them to `groupFindingsForFix`.
 */
export async function locateFindingSources(
  input: LocateFindingSourcesInput,
): Promise<Map<string, string | null>> {
  const located = await locateFindingSourcesDetailed(input);
  return new Map(located.map((item) => [item.findingId, item.sourcePath]));
}
