/**
 * The PAGES lane: five criteria that do not exist on a page.
 *
 * Every other lane is handed one page and asked what is wrong with it. These
 * five are comparative by definition — navigation that keeps its order,
 * controls that keep their names, help that keeps its place, a page reachable
 * more than one way — and none of them can be judged from a single page, which
 * is why this lane runs once, after the crawl is complete (A3.5).
 *
 * ---------------------------------------------------------------------------
 * FEWER THAN TWO PAGES IS NOT A PASS
 *
 * With one page there is nothing to compare and the honest answer is that
 * nothing was checked. The roster's own instructions tell the model to return
 * an empty findings array in that case, which is correct for the model and
 * dangerous for the lane: an empty findings array is exactly what a clean site
 * looks like. So the lane does not ask at all below two pages, and returns all
 * five criteria inconclusive with the page count in the reason.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL COMPARES; THE APPLICATION MEASURES
 *
 * Navigation order, the heading outline, the landmark inventory and the link
 * graph are all facts, and facts are cheaper and more reliable computed than
 * described. `summarisePage` and `buildLinkGraph` do that here, deterministically,
 * and the model is given the measurements rather than the trees (A9.2, A13.7).
 *
 * What is left for the model is the part that is genuinely a judgement: whether
 * two navigation orders are the *same* navigation reordered or two different
 * menus, whether "Search" and "Find" are the same function under two names,
 * whether a help link that moved between the header and the footer has actually
 * moved for the user. That is what it is asked, and nothing else.
 */

import { renderCriterionTable } from '@/lib/harness/criteria';

import { resolveLaneCapabilities, type LaneCapabilityOptions } from './lane-context';
import {
  collapse,
  inconclusiveResult,
  lanePolicy,
  runFindingsAgent,
  toClaims,
  truncate,
  type LaneInconclusive,
  type ModelFindingClaim,
  type ModelLaneResult,
} from './model-lane';
import type { AxNodeLike, AxTreeLike } from './tree';
import type { AuditPhase } from './types';

/* ========================================================================== */
/* Lane policy                                                                */
/* ========================================================================== */

/** The five, from the roster, checked against `criteriaForAgent('PAGES')`. */
export const PAGES_POLICY = lanePolicy('pages', 'PAGES');

/** Below this, there is nothing to compare and the lane does not ask. */
export const MIN_PAGES_TO_COMPARE = 2;

/** Pages described in one prompt. The crawl caps at 25; this matches it. */
export const MAX_PAGES_IN_PROMPT = 25;

const REDUNDANT_ENTRY_REASON =
  'Redundant entry is about the same information being asked for twice inside one flow. Establishing that needs the flow driven step by step, which the crawl does not do: it captures pages, not sessions.';

/* ========================================================================== */
/* Page summary                                                               */
/* ========================================================================== */

const NAV_ROLES: readonly string[] = ['navigation', 'banner', 'contentinfo'];

const LANDMARK_ROLES: readonly string[] = [
  'banner',
  'navigation',
  'main',
  'complementary',
  'contentinfo',
  'search',
  'form',
  'region',
];

const NAMED_CONTROL_ROLES: readonly string[] = [
  'link',
  'button',
  'menuitem',
  'tab',
  'combobox',
  'searchbox',
  'textbox',
];

/** What a help affordance looks like, in any of the words sites use for it. */
const HELP_PATTERN =
  /\b(help|support|contact|contact us|faqs?|frequently asked|live chat|chat with|get in touch|assistance|customer service|call us|phone|helpline)\b/i;

/** What a second route to a page looks like, other than the navigation menu. */
const SITEMAP_PATTERN = /\b(sitemap|site map|a[- ]?z|index of|all pages|directory)\b/i;

export interface NavigationGroup {
  readonly role: string;
  readonly name: string;
  /** Control names in tree order. The order is the whole point of 3.2.3. */
  readonly items: readonly string[];
}

export interface PageSummary {
  readonly pageUrl: string;
  readonly title: string | null;
  readonly landmarks: readonly string[];
  readonly navigation: readonly NavigationGroup[];
  readonly headings: readonly string[];
  /** Named controls anywhere on the page, for 3.2.4's identification check. */
  readonly controls: readonly string[];
  readonly help: readonly { readonly role: string; readonly name: string; readonly within: string }[];
  readonly hasSearch: boolean;
  readonly hasSitemapLink: boolean;
  readonly outboundLinks: readonly string[];
}

/**
 * Everything comparative about one page, measured.
 *
 * Walks the tree from each landmark so navigation items come back in document
 * order rather than in whatever order the node map happens to iterate — 3.2.3
 * is entirely about that order, and a summary that scrambled it would invent
 * failures on every site.
 */
export function summarisePage(
  pageUrl: string,
  tree: AxTreeLike | null | undefined,
  links: readonly string[] = [],
  title: string | null = null,
): PageSummary {
  const nodes = tree ?? {};
  const landmarks: string[] = [];
  const navigation: NavigationGroup[] = [];
  const headings: string[] = [];
  const controls: string[] = [];
  const help: { role: string; name: string; within: string }[] = [];
  let hasSearch = false;

  for (const [nodeId, node] of Object.entries(nodes)) {
    const role = (node.role ?? '').trim();
    const name = collapse(node.name ?? '');
    if (role.length === 0) continue;
    const lowered = role.toLowerCase();

    if (LANDMARK_ROLES.includes(lowered)) {
      landmarks.push(name.length > 0 ? `${lowered} "${truncate(name, 60)}"` : lowered);
    }
    if (lowered === 'search' || lowered === 'searchbox') hasSearch = true;
    if (lowered === 'heading' && name.length > 0) headings.push(truncate(name, 100));
    if (NAMED_CONTROL_ROLES.includes(lowered) && name.length > 0) {
      controls.push(`${lowered}: ${truncate(name, 80)}`);
    }

    if (NAV_ROLES.includes(lowered)) {
      const items = descendantControlNames(nodes, nodeId);
      if (items.length > 0) {
        navigation.push({
          role: lowered,
          name: name.length > 0 ? truncate(name, 60) : lowered,
          items,
        });
      }
    }

    if (name.length > 0 && HELP_PATTERN.test(name) && NAMED_CONTROL_ROLES.includes(lowered)) {
      help.push({
        role: lowered,
        name: truncate(name, 80),
        within: containingLandmark(nodes, nodeId) ?? 'page body',
      });
    }
  }

  const hasSitemapLink =
    controls.some((control) => SITEMAP_PATTERN.test(control)) ||
    links.some((link) => SITEMAP_PATTERN.test(link));

  return {
    pageUrl,
    title,
    landmarks: dedupe(landmarks).slice(0, 20),
    navigation: navigation.slice(0, 6),
    headings: headings.slice(0, 40),
    controls: dedupe(controls).slice(0, 80),
    help: help.slice(0, 10),
    hasSearch,
    hasSitemapLink,
    outboundLinks: dedupe(links.map(normaliseUrl)).slice(0, 200),
  };
}

/** Control names beneath one node, in document order, following `childIds`. */
function descendantControlNames(
  nodes: Readonly<Record<string, AxNodeLike>>,
  rootId: string,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [rootId];

  while (stack.length > 0 && names.length < 60) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);

    const node = nodes[id];
    if (!node) continue;

    const role = (node.role ?? '').trim().toLowerCase();
    const name = collapse(node.name ?? '');
    if (id !== rootId && NAMED_CONTROL_ROLES.includes(role) && name.length > 0) {
      names.push(truncate(name, 60));
    }

    const children = node.childIds ?? [];
    // Reversed, because the stack pops from the end: this preserves document
    // order, which is the only thing 3.2.3 is about.
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }

  return names;
}

/** The nearest landmark ancestor's role, for "where on the page" questions. */
function containingLandmark(
  nodes: Readonly<Record<string, AxNodeLike>>,
  nodeId: string,
): string | null {
  // The CDP tree carries children, not parents; build the one lookup we need.
  for (const [candidateId, node] of Object.entries(nodes)) {
    const role = (node.role ?? '').trim().toLowerCase();
    if (!LANDMARK_ROLES.includes(role)) continue;
    if (candidateId === nodeId) continue;
    const stack = [...(node.childIds ?? [])];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      if (id === nodeId) return role;
      const child = nodes[id];
      if (child) stack.push(...(child.childIds ?? []));
    }
  }
  return null;
}

/* ========================================================================== */
/* Link graph                                                                 */
/* ========================================================================== */

export interface LinkGraph {
  /** For each audited page, the audited pages that link to it. */
  readonly inbound: ReadonlyMap<string, readonly string[]>;
  /** Pages reached from fewer than two other audited pages. */
  readonly singleRoute: readonly string[];
  readonly siteHasSearch: boolean;
  readonly siteHasSitemap: boolean;
}

/**
 * Who links to whom, across the crawl.
 *
 * This is the measured half of 2.4.5. It is deliberately about *audited* pages
 * only: a link to a page the crawl never reached says nothing about whether
 * that page has two routes, and counting it would manufacture a pass.
 */
export function buildLinkGraph(summaries: readonly PageSummary[]): LinkGraph {
  const keys = new Map<string, string>();
  for (const summary of summaries) keys.set(normaliseUrl(summary.pageUrl), summary.pageUrl);

  const inbound = new Map<string, string[]>();
  for (const summary of summaries) inbound.set(summary.pageUrl, []);

  for (const summary of summaries) {
    for (const link of summary.outboundLinks) {
      const target = keys.get(link);
      if (!target || target === summary.pageUrl) continue;
      const list = inbound.get(target);
      if (list && !list.includes(summary.pageUrl)) list.push(summary.pageUrl);
    }
  }

  return {
    inbound,
    singleRoute: summaries
      .filter((summary) => (inbound.get(summary.pageUrl) ?? []).length < 2)
      .map((summary) => summary.pageUrl),
    siteHasSearch: summaries.some((summary) => summary.hasSearch),
    siteHasSitemap: summaries.some((summary) => summary.hasSitemapLink),
  };
}

/* ========================================================================== */
/* Input and output                                                           */
/* ========================================================================== */

export interface PagesPageCapture {
  readonly url?: string;
  readonly finalUrl?: string;
  readonly title?: string | null;
  readonly axTree?: AxTreeLike;
  readonly links?: readonly string[];
}

export interface PagesPageInput {
  readonly pageId?: string;
  readonly pageUrl: string;
  readonly capture: PagesPageCapture;
}

export interface PagesLaneInput extends LaneCapabilityOptions {
  readonly runId?: string;
  readonly phase?: AuditPhase;
  /** Every page of the crawl. PAGES cannot start before the crawl finishes. */
  readonly pages: readonly PagesPageInput[];
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface PagesLaneResult extends ModelLaneResult {
  readonly pagesCompared: number;
  readonly summaries: readonly PageSummary[];
  readonly linkGraph: LinkGraph | null;
}

/* ========================================================================== */
/* The lane                                                                   */
/* ========================================================================== */

/**
 * Compare the crawl against itself.
 *
 * Never throws. Fewer than two pages, or a pass that fails, leaves all five
 * criteria inconclusive.
 */
export async function runPagesLane(input: PagesLaneInput): Promise<PagesLaneResult> {
  const empty = (reason: string, over: Partial<PagesLaneResult> = {}): PagesLaneResult => ({
    ...inconclusiveResult(PAGES_POLICY.criteria, reason),
    pagesCompared: 0,
    summaries: [],
    linkGraph: null,
    ...over,
  });

  if (input.signal?.aborted) {
    return empty('The run was cancelled before PAGES compared the crawl.');
  }

  const pages = input.pages.slice(0, MAX_PAGES_IN_PROMPT);
  if (pages.length < MIN_PAGES_TO_COMPARE) {
    return empty(
      `PAGES compares pages against each other and the crawl produced ${pages.length}. With fewer than ${MIN_PAGES_TO_COMPARE} there is nothing to compare, so nothing was checked.`,
      { pagesCompared: pages.length },
    );
  }

  const summaries = pages.map((page) =>
    summarisePage(
      page.pageUrl,
      page.capture.axTree,
      page.capture.links ?? [],
      page.capture.title ?? null,
    ),
  );
  const linkGraph = buildLinkGraph(summaries);

  const capabilities = await resolveLaneCapabilities(input, input.signal);
  const answer = await runFindingsAgent({
    agent: 'pages',
    criteria: PAGES_POLICY.criteria,
    verdicts: PAGES_POLICY.verdicts,
    prompt: buildPagesPrompt(summaries, linkGraph),
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    ...capabilities,
  });

  if (answer.error !== null) {
    return empty(`The PAGES pass did not return a usable answer: ${answer.error}`, {
      sessionId: answer.sessionId,
      warnings: [`PAGES: ${answer.error}`],
      pagesCompared: pages.length,
      summaries,
      linkGraph,
    });
  }

  /*
   * PAGES claims span pages, so every claim needs its own page id — the
   * conductor's batch page id is meaningless here. The claim's `pageUrl` is
   * matched back to the crawl; a claim naming a page that was not crawled keeps
   * its URL and gets no id, which the ledger resolves the same way.
   */
  const idByUrl = new Map<string, string>();
  for (const page of pages) {
    if (page.pageId) idByUrl.set(normaliseUrl(page.pageUrl), page.pageId);
  }

  const findings: ModelFindingClaim[] = [];
  for (const claim of toClaims(PAGES_POLICY, answer.findings, {
    pageUrl: pages[0].pageUrl,
    source: 'pages:comparison',
    context: { model: answer.model, sessionId: answer.sessionId, pages: pages.length },
  })) {
    const cited = citedPage(claim.detail ?? claim.summary, summaries) ?? claim.pageUrl;
    findings.push({
      ...claim,
      pageUrl: cited,
      pageId: idByUrl.get(normaliseUrl(cited)) ?? null,
    });
  }

  const warnings: string[] = [];
  if (answer.usedFallback) {
    warnings.push(`PAGES answered on the fallback model ${answer.model} (A3.7).`);
  }
  if (input.pages.length > pages.length) {
    warnings.push(
      `The crawl produced ${input.pages.length} pages; PAGES compared the first ${pages.length}.`,
    );
  }

  const evaluated = PAGES_POLICY.criteria.filter((criterion) => criterion !== '3.3.7');
  const inconclusive: LaneInconclusive[] = [{ criterion: '3.3.7', reason: REDUNDANT_ENTRY_REASON }];

  return {
    findings,
    sessionId: answer.sessionId,
    evaluated,
    inconclusive,
    warnings,
    pagesCompared: pages.length,
    summaries,
    linkGraph,
  };
}

/**
 * The page a cross-page claim is actually about.
 *
 * PAGES names the pages it compared in prose, and a finding filed against the
 * wrong URL is a finding a developer cannot find. The first audited URL that
 * appears in the claim's own text wins; where none does, the caller's default
 * stands.
 */
function citedPage(text: string, summaries: readonly PageSummary[]): string | null {
  let best: { url: string; at: number } | null = null;
  for (const summary of summaries) {
    const at = text.indexOf(summary.pageUrl);
    if (at === -1) continue;
    if (!best || at < best.at) best = { url: summary.pageUrl, at };
  }
  if (best) return best.url;

  // Fall back to a path match: models routinely write `/apply`, not the origin.
  for (const summary of summaries) {
    const path = pathOf(summary.pageUrl);
    if (path.length > 1 && text.includes(path)) return summary.pageUrl;
  }
  return null;
}

/* ========================================================================== */
/* Prompt                                                                     */
/* ========================================================================== */

function buildPagesPrompt(summaries: readonly PageSummary[], graph: LinkGraph): string {
  const lines: string[] = [
    `PAGES IN THIS CRAWL (${summaries.length})`,
    'Each block is one page, measured from its accessibility tree. Navigation items are in document order — that order is what 3.2.3 is about, so compare the sequences literally.',
    '',
  ];

  summaries.forEach((summary, index) => {
    lines.push(
      `=== [${index + 1}] ${summary.pageUrl} ===`,
      `title: ${summary.title ?? '<none>'}`,
      `landmarks: ${summary.landmarks.length > 0 ? summary.landmarks.join(', ') : '<none>'}`,
    );
    for (const group of summary.navigation) {
      lines.push(`${group.role} "${group.name}": ${group.items.join(' | ')}`);
    }
    if (summary.navigation.length === 0) {
      lines.push('navigation: <no navigation, banner or contentinfo landmark exposes any controls>');
    }
    lines.push(
      `headings: ${summary.headings.length > 0 ? summary.headings.slice(0, 12).join(' / ') : '<none>'}`,
      `help affordances: ${
        summary.help.length > 0
          ? summary.help.map((item) => `${item.role} "${item.name}" in ${item.within}`).join('; ')
          : '<none named on this page>'
      }`,
      `search on page: ${summary.hasSearch ? 'yes' : 'no'}  sitemap link: ${summary.hasSitemapLink ? 'yes' : 'no'}`,
      `named controls: ${summary.controls.slice(0, 30).join(' | ') || '<none>'}`,
      '',
    );
  });

  lines.push(
    'MEASURED ROUTES BETWEEN THESE PAGES',
    'Counted from links on the audited pages only. A link to a page the crawl never reached is not a route to anything you can see, and is not counted.',
  );
  for (const summary of summaries) {
    const inbound = graph.inbound.get(summary.pageUrl) ?? [];
    lines.push(
      `- ${summary.pageUrl}: linked from ${inbound.length} audited page(s)${inbound.length > 0 ? ` (${inbound.slice(0, 5).join(', ')})` : ''}`,
    );
  }
  lines.push(
    `site-wide: search present on at least one page: ${graph.siteHasSearch ? 'yes' : 'no'}; sitemap link seen: ${graph.siteHasSitemap ? 'yes' : 'no'}`,
    graph.singleRoute.length > 0
      ? `pages linked from fewer than two audited pages: ${graph.singleRoute.join(', ')}`
      : 'every audited page is linked from at least two other audited pages',
    '',
    `CRITERIA YOU OWN (${PAGES_POLICY.criteria.length})`,
    renderCriterionTable(PAGES_POLICY.criteria),
    '',
    'WHAT TO REPORT',
    '- Always name the specific pages you compared, by their full URL as written above. "Navigation is inconsistent" is not a finding; "the nav on /apply lists Home, Apply, Help and on /status lists Apply, Home, Help — Home and Apply are transposed" is.',
    '- 3.2.3 is about surviving items keeping their relative order. Items added or removed between pages are fine; reshuffled ones are not.',
    '- 3.2.4 is about the same function keeping the same name. Cite both pages and both names.',
    '- 3.2.6 is about help keeping its relative position, not about help being on every page.',
    '- 2.4.5 asks for two independent routes. Use the measured counts above, and remember that a step inside a linear process is exempt — say so rather than filing against a checkout step.',
    '- 3.3.7 needs a flow driven step by step, which this crawl did not do. Report it only if the same information is plainly requested twice in the material above; otherwise leave it alone.',
    '- Put the full URL of the page the finding is filed against in `detail`. The application reads it back to attach the finding to the right page.',
  );

  return truncate(lines.join('\n'), 120_000);
}

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Origin plus path, lower-cased, no trailing slash, no query and no fragment. */
function normaliseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return raw.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  }
}

function pathOf(raw: string): string {
  try {
    return new URL(raw).pathname;
  } catch {
    return raw;
  }
}
