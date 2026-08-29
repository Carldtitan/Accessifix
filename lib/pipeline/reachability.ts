/**
 * A1.3: the deployed URL is fetched, and a non-2xx response refuses the run
 * with a stated reason.
 *
 * The reason matters as much as the refusal. "Could not start" is useless to a
 * developer; "404 Not Found — the deployment exists but that path does not" is
 * something they can act on. Every failure mode below produces prose.
 *
 * `GET`, not `HEAD`: too many hosts answer `HEAD` with a 405 while serving the
 * page perfectly well, and a 405 on a healthy site is exactly the false refusal
 * this check must not produce.
 */

const TIMEOUT_MS = 15_000;

export interface ReachabilityResult {
  ok: boolean;
  /** The URL actually reached, after redirects. */
  url: string;
  finalUrl: string | null;
  status: number | null;
  contentType: string | null;
  /** Prose. Shown to the user verbatim when `ok` is false. */
  reason: string;
  elapsedMs: number;
}

/** Reject anything that is not a public http(s) URL before a request is made. */
export function validateDeployedUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return { ok: false, reason: 'No deployed URL was supplied.' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      reason: `"${trimmed}" is not a URL. Include the scheme, for example https://example.com.`,
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      reason: `${url.protocol} is not supported. The deployed URL must be http or https.`,
    };
  }

  if (!url.hostname) {
    return { ok: false, reason: 'The deployed URL has no hostname.' };
  }

  return { ok: true, url: url.toString() };
}

/**
 * Fetch the deployed URL and report whether a run may start.
 *
 * Never throws: a network failure is a *result* with a stated reason, because
 * the caller's job is to explain the refusal, not to handle an exception.
 */
export async function checkDeployedUrl(raw: string): Promise<ReachabilityResult> {
  const started = Date.now();
  const validated = validateDeployedUrl(raw);

  if (!validated.ok) {
    return {
      ok: false,
      url: typeof raw === 'string' ? raw.trim() : '',
      finalUrl: null,
      status: null,
      contentType: null,
      reason: validated.reason,
      elapsedMs: Date.now() - started,
    };
  }

  const url = validated.url;

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        // Some hosts serve a different (or no) body to an unidentified client.
        'user-agent': 'AccessiFix/0.1 (+accessibility audit; reachability check)',
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      },
    });

    const contentType = response.headers.get('content-type');
    const elapsedMs = Date.now() - started;

    if (!response.ok) {
      return {
        ok: false,
        url,
        finalUrl: response.url || null,
        status: response.status,
        contentType,
        reason: describeStatus(response.status, response.url || url),
        elapsedMs,
      };
    }

    // 2xx with a non-HTML body is reachable but not auditable.
    if (contentType && !/(text\/html|application\/xhtml)/i.test(contentType)) {
      return {
        ok: false,
        url,
        finalUrl: response.url || null,
        status: response.status,
        contentType,
        reason:
          `The URL answered ${response.status} but served ${contentType}, not HTML. ` +
          'Point AccessiFix at a page, not at an API endpoint or a file.',
        elapsedMs,
      };
    }

    return {
      ok: true,
      url,
      finalUrl: response.url || url,
      status: response.status,
      contentType,
      reason: `${response.status} ${response.statusText || 'OK'}.`,
      elapsedMs,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      finalUrl: null,
      status: null,
      contentType: null,
      reason: describeNetworkError(error, url),
      elapsedMs: Date.now() - started,
    };
  }
}

function describeStatus(status: number, url: string): string {
  if (status === 401 || status === 403) {
    return (
      `${url} answered ${status}. The deployment is behind authentication, so AccessiFix ` +
      'cannot load it. Use a publicly reachable preview or production URL.'
    );
  }
  if (status === 404) {
    return `${url} answered 404. The host is up but that path does not exist.`;
  }
  if (status === 429) {
    return `${url} answered 429. The host is rate-limiting; try again shortly.`;
  }
  if (status >= 500) {
    return `${url} answered ${status}. The deployment is erroring, so there is nothing to audit yet.`;
  }
  return `${url} answered ${status}, not a 2xx. A run needs a reachable deployed URL (A1.3).`;
}

function describeNetworkError(error: unknown, url: string): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);

  if (name === 'TimeoutError' || /timeout/i.test(message)) {
    return `${url} did not respond within ${TIMEOUT_MS / 1000}s.`;
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return `The hostname in ${url} does not resolve. Check the domain.`;
  }
  if (/ECONNREFUSED/i.test(message)) {
    return `${url} refused the connection. Nothing is listening on that host and port.`;
  }
  if (/certificate|CERT_|SSL|TLS/i.test(message)) {
    return `${url} has a TLS certificate problem: ${message}`;
  }
  return `${url} could not be fetched: ${message}`;
}
