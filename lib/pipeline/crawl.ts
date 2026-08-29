/**
 * Phase 0: the same-origin crawl (A2.2, design "Runtime Flow" step 2).
 *
 * The crawl is not just a link walk — it is the *capture* pass. Provisioning a
 * browser sandbox is the slow part of a run, so each page is opened once and
 * everything downstream needs is taken while it is open: the accessibility
 * tree, a full-page screenshot, the axe-core violations, the title, and the
 * outgoing links. TREE, VIS, MEDIA, CODE and PAGES then all read from that one
 * capture instead of re-opening the page five times.
 *
 * Cross-origin is refused, not followed. `https://app.example.com` and
 * `https://example.com` are different origins and a run scoped to one must not
 * wander into the other — the user connected one deployed URL, and auditing
 * anything else is auditing a site they did not consent to.
 */
import { and, eq } from 'drizzle-orm';

import type { PageCapture } from '@/lib/browser/types';
import { capturePage } from '@/lib/browser/runner';
import { db } from '@/lib/db';
import { pages, type Page } from '@/lib/db/schema';
import { MAX_PAGES_PER_CRAWL } from '@/lib/sandbox/config';

import { emitEvent } from './events';

/* -------------------------------------------------------------------------- */
/* URL normalisation                                                          */
/* -------------------------------------------------------------------------- */

/** Extensions that are never an HTML page. Following them wastes a sandbox. */
const NON_PAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp',
  '.pdf', '.zip', '.gz', '.tar', '.rar', '.7z',
  '.mp3', '.mp4', '.webm', '.ogg', '.wav', '.mov', '.avi',
  '.css', '.js', '.mjs', '.map', '.json', '.xml', '.txt', '.rss', '.atom',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv',
]);

/** Query parameters that identify a campaign, not a page. Stripped before dedupe. */
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'ref', 'referrer', '_ga',
];

function extensionOf(pathname: string): string {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot === -1 ? '' : last.slice(dot).toLowerCase();
}

/**
 * Canonical form of a URL, or `null` when it is not a crawlable page.
 *
 * Normalisation rules, in order:
 *   - resolved against `base` when relative
 *   - `http`/`https` only — `mailto:`, `tel:`, `javascript:`, `data:` are dropped
 *   - fragment removed: `/a#top` and `/a` are the same page
 *   - host lowercased, default port removed
 *   - tracking parameters removed, the rest sorted so parameter order does not
 *     produce two rows for one page
 *   - trailing slash removed, except on the root
 *   - obvious asset extensions rejected
 */
export function normaliseUrl(raw: string, base?: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  let url: URL;
  try {
    url = base ? new URL(trimmed, base) : new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (NON_PAGE_EXTENSIONS.has(extensionOf(url.pathname))) return null;

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }

  for (const param of TRACKING_PARAMS) url.searchParams.delete(param);
  const entries = [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [key, value] of entries) url.searchParams.append(key, value);

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  }

  return url.toString();
}

/** Scheme, host and port must all match. Subdomains are a different origin. */
export function isSameOrigin(candidate: string, origin: string): boolean {
  try {
    return new URL(candidate).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** The origin a crawl is confined to, or `null` when the start URL is unusable. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Crawl                                                                      */
/* -------------------------------------------------------------------------- */

export interface CrawledPage {
  /** The `pages` row id. Findings point at it. */
  pageId: string;
  /**
   * The page's identity: the URL the browser actually ended on, normalised.
   *
   * Not the URL that was requested. A request for `/blog` that redirects to
   * `/blog/latest` captured the latter, and recording the former would file
   * every finding against a page that was never opened - and would resolve the
   * page's own links against the wrong base.
   */
  url: string;
  /** What the crawler asked for. Differs from `url` when the page redirected. */
  requestedUrl: string;
  title: string | null;
  /** Everything the audit lanes need, taken while the page was open. */
  capture: PageCapture;
  /** Breadth-first distance from the start URL. 0 is the deployed URL itself. */
  depth: number;
}

export interface CrawlResult {
  pages: CrawledPage[];
  /** Same-origin URLs discovered but not visited because the cap was reached. */
  skipped: string[];
  /** Cross-origin URLs seen and refused, for the run log. */
  rejectedCrossOrigin: string[];
  /** Pages whose capture failed. The crawl continues past them. */
  failures: { url: string; reason: string }[];
  /** Requests that landed somewhere else, for the run log. */
  redirects: { from: string; to: string }[];
  origin: string;
  cap: number;
}

export interface CrawlOptions {
  /** Page cap. Defaults to `MAX_PAGES_PER_CRAWL` (25). */
  maxPages?: number;
  /** How many pages are opened at once. The sandbox pool is the real ceiling. */
  concurrency?: number;
  signal?: AbortSignal;
  /** Called as each page lands, so the run view can fill in live. */
  onPage?: (page: CrawledPage) => void;
}

export class CrawlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrawlError';
  }
}

/**
 * Breadth-first, same-origin, capped.
 *
 * Breadth-first rather than depth-first on purpose: with a hard cap of 25, the
 * pages one click from the landing page are far more representative of the site
 * than 25 pages down one branch of a wizard.
 *
 * A page that fails to capture is recorded and stepped over. One dead route
 * must not cost the baseline.
 */
export async function crawl(
  runId: string,
  startUrl: string,
  options: CrawlOptions = {},
): Promise<CrawlResult> {
  const cap = Math.max(1, Math.min(options.maxPages ?? MAX_PAGES_PER_CRAWL, MAX_PAGES_PER_CRAWL));
  const concurrency = Math.max(1, options.concurrency ?? 4);

  const start = normaliseUrl(startUrl);
  if (!start) throw new CrawlError(`"${startUrl}" is not a crawlable http(s) URL.`);

  const origin = originOf(start);
  if (!origin) throw new CrawlError(`Could not determine the origin of "${startUrl}".`);

  const result: CrawlResult = {
    pages: [],
    skipped: [],
    rejectedCrossOrigin: [],
    failures: [],
    redirects: [],
    origin,
    cap,
  };

  /** URLs already asked for. Stops the same request being queued twice. */
  const seen = new Set<string>([start]);
  /**
   * URLs actually captured, after redirects. Two different requests can land on
   * one page - `/` and `/index.html`, say - and that page is audited once. The
   * first request to land wins, which is deterministic because the frontier is
   * ordered and `allSettled` preserves it.
   */
  const captured = new Set<string>();
  let frontier: { url: string; depth: number }[] = [{ url: start, depth: 0 }];

  await emitEvent({
    runId,
    type: 'phase',
    capability: 'sandbox',
    summary: `Crawling ${origin} (cap ${cap} pages).`,
    data: { phase: 'crawl', origin, cap },
  });

  while (frontier.length > 0 && result.pages.length < cap) {
    if (options.signal?.aborted) throw new CrawlError('The crawl was aborted.');

    const budget = cap - result.pages.length;
    const batch = frontier.slice(0, Math.min(concurrency, budget));
    const rest = frontier.slice(batch.length);
    const discovered: { url: string; depth: number }[] = [];

    const settled = await Promise.allSettled(
      batch.map((entry) => visit(runId, entry.url, entry.depth, origin)),
    );

    for (let i = 0; i < settled.length; i += 1) {
      const outcome = settled[i];
      const entry = batch[i];

      if (outcome.status === 'rejected') {
        const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        result.failures.push({ url: entry.url, reason });
        await emitEvent({
          runId,
          type: 'error',
          capability: 'sandbox',
          summary: `Could not capture ${entry.url}.`,
          detail: reason,
          data: { phase: 'crawl', url: entry.url },
        });
        continue;
      }

      const visited = outcome.value;

      /*
       * A same-origin URL that redirects off the origin is refused, not
       * captured. The consent the user gave was for one deployment; following
       * a redirect out of it audits a site they did not connect, and files the
       * result under a URL that never served it.
       */
      if (visited.kind === 'cross-origin') {
        if (!result.rejectedCrossOrigin.includes(visited.finalUrl)) {
          result.rejectedCrossOrigin.push(visited.finalUrl);
        }
        result.redirects.push({ from: visited.requestedUrl, to: visited.finalUrl });
        await emitEvent({
          runId,
          type: 'log',
          capability: 'sandbox',
          summary: `${visited.requestedUrl} redirected off the crawl origin.`,
          detail:
            `It landed on ${visited.finalUrl}, which is not ${origin}. The page was not ` +
            'recorded: a run is scoped to the deployment the user connected.',
          data: { phase: 'crawl', url: visited.requestedUrl, finalUrl: visited.finalUrl },
        });
        continue;
      }

      const page = visited.page;

      if (page.url !== page.requestedUrl) {
        result.redirects.push({ from: page.requestedUrl, to: page.url });
      }

      // Two requests can land on one page. It is captured once, under the URL
      // that actually served it.
      if (captured.has(page.url)) {
        await emitEvent({
          runId,
          type: 'log',
          capability: 'sandbox',
          summary: `${page.requestedUrl} redirected to ${page.url}, which was already captured.`,
          detail: 'The page is audited once, under the URL the browser ended on.',
          data: { phase: 'crawl', url: page.requestedUrl, finalUrl: page.url },
        });
        continue;
      }

      captured.add(page.url);
      seen.add(page.url);
      result.pages.push(page);
      options.onPage?.(page);

      for (const link of page.capture.links) {
        const normalised = normaliseUrl(link, page.url);
        if (!normalised) continue;

        if (!isSameOrigin(normalised, origin)) {
          if (!result.rejectedCrossOrigin.includes(normalised)) {
            result.rejectedCrossOrigin.push(normalised);
          }
          continue;
        }
        if (seen.has(normalised)) continue;

        seen.add(normalised);
        discovered.push({ url: normalised, depth: page.depth + 1 });
      }
    }

    frontier = [...rest, ...discovered];
  }

  // Anything still queued when the cap was hit is reported, not silently lost.
  result.skipped = frontier.map((entry) => entry.url);

  await emitEvent({
    runId,
    type: 'phase',
    capability: 'sandbox',
    summary:
      `Crawl complete: ${result.pages.length} page(s) captured` +
      (result.skipped.length > 0 ? `, ${result.skipped.length} left at the cap` : '') +
      (result.failures.length > 0 ? `, ${result.failures.length} failed` : '') +
      (result.redirects.length > 0 ? `, ${result.redirects.length} redirected` : '') +
      '.',
    data: {
      phase: 'crawl',
      captured: result.pages.length,
      skipped: result.skipped.length,
      failed: result.failures.length,
      crossOriginRejected: result.rejectedCrossOrigin.length,
      redirects: result.redirects.length,
    },
  });

  if (result.pages.length === 0) {
    throw new CrawlError(
      `No page on ${origin} could be captured. ` +
        (result.failures[0]?.reason ?? 'The browser sandbox returned nothing.'),
    );
  }

  return result;
}

/**
 * What one visit produced: a page, or a redirect that left the crawl's origin.
 */
type VisitOutcome =
  | { kind: 'captured'; page: CrawledPage }
  | { kind: 'cross-origin'; requestedUrl: string; finalUrl: string };

/**
 * Open one page, write its `pages` row, hand back the capture.
 *
 * The page's identity is `capture.finalUrl`, not the URL that was requested.
 * The browser reports where it actually ended, and ignoring that had two
 * consequences, both silent: a page was filed under a URL that never served it,
 * and its links were resolved against the wrong base, so a redirect to another
 * directory turned every relative link on the page into a wrong one.
 *
 * A redirect that leaves the crawl origin is refused rather than captured. The
 * origin check on discovered links is not enough on its own - a same-origin
 * link can redirect anywhere, and only the final URL says where it went.
 */
async function visit(
  runId: string,
  url: string,
  depth: number,
  origin: string,
): Promise<VisitOutcome> {
  const capture = await capturePage(url, {
    labels: { runId, phase: 'crawl' },
    // A11.1: the live environments grid needs the sandbox id as it is created,
    // not after the page has been captured.
    onSandbox: (sandboxId: string) => {
      void emitEvent({
        runId,
        type: 'sandbox',
        capability: 'sandbox',
        summary: `Browser sandbox opened for ${url}.`,
        data: { sandboxId, url, phase: 'crawl' },
      });
    },
  });

  /*
   * `finalUrl` is normalised through the same rules as a discovered link, so
   * `/a/` and `/a` are one page however the redirect spelled it. A finalUrl the
   * normaliser refuses (an asset extension, a non-http scheme) leaves the
   * requested URL standing: the capture is real, and there is nothing better to
   * call it.
   */
  const landed = normaliseUrl(capture.finalUrl || url) ?? url;

  if (!isSameOrigin(landed, origin)) {
    return { kind: 'cross-origin', requestedUrl: url, finalUrl: landed };
  }

  const pageId = await upsertPage(runId, landed, capture.title || null);

  return {
    kind: 'captured',
    page: {
      pageId,
      url: landed,
      requestedUrl: url,
      title: capture.title || null,
      capture,
      depth,
    },
  };
}

/**
 * Idempotent `pages` insert.
 *
 * A resumed crawl re-visits pages it already recorded; the unique index on
 * `(run_id, url)` makes that a no-op rather than a duplicate row, and the
 * follow-up select recovers the id either way.
 */
export async function upsertPage(
  runId: string,
  url: string,
  title: string | null,
): Promise<string> {
  const [inserted] = await db
    .insert(pages)
    .values({ runId, url, title })
    .onConflictDoNothing({ target: [pages.runId, pages.url] })
    .returning({ id: pages.id });

  if (inserted) return inserted.id;

  const [existing] = await db
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.runId, runId), eq(pages.url, url)))
    .limit(1);

  if (!existing) throw new CrawlError(`Could not record page ${url} for run ${runId}.`);
  return existing.id;
}

/** Pages already recorded for a run. A resumed run starts from these. */
export async function listPages(runId: string): Promise<Page[]> {
  return db.select().from(pages).where(eq(pages.runId, runId));
}
