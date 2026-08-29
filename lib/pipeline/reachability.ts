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
 *
 * ---------------------------------------------------------------------------
 * SSRF
 *
 * This is the one place the application fetches a URL a user typed. Without a
 * guard it is a probe into whatever the server can reach: `127.0.0.1:6379`,
 * `10.0.0.5`, or `169.254.169.254` and the cloud metadata credentials behind
 * it.
 *
 * So the destination is resolved and checked *before* a connection is made,
 * and redirects are followed by hand rather than by `fetch`, because
 * `redirect: 'follow'` would let a public first hop bounce the request
 * anywhere. Every hop is re-validated as if the user had typed it.
 * ---------------------------------------------------------------------------
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const TIMEOUT_MS = 15_000;

/** Redirect hops followed by hand. Each one is re-validated before it is taken. */
const MAX_REDIRECTS = 5;

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

/* -------------------------------------------------------------------------- */
/* Address ranges that must never be fetched                                  */
/* -------------------------------------------------------------------------- */

interface Block {
  /** First address of the range, as an unsigned 32-bit integer. */
  base: number;
  /** Prefix length in bits. */
  bits: number;
  why: string;
}

function v4(a: number, b: number, c: number, d: number): number {
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

/**
 * Everything that is not a public destination: the IANA special-purpose
 * registry, plus the ranges that actually matter in practice — loopback, the
 * RFC 1918 private space, carrier-grade NAT, and the link-local block that
 * carries the cloud metadata service.
 */
const BLOCKED_V4: readonly Block[] = [
  { base: v4(0, 0, 0, 0), bits: 8, why: 'is in "this network" space' },
  { base: v4(10, 0, 0, 0), bits: 8, why: 'is a private address (RFC 1918)' },
  { base: v4(100, 64, 0, 0), bits: 10, why: 'is in carrier-grade NAT space' },
  { base: v4(127, 0, 0, 0), bits: 8, why: 'is the loopback interface' },
  {
    base: v4(169, 254, 0, 0),
    bits: 16,
    why: 'is link-local, the range that carries the cloud metadata service',
  },
  { base: v4(172, 16, 0, 0), bits: 12, why: 'is a private address (RFC 1918)' },
  { base: v4(192, 0, 0, 0), bits: 24, why: 'is in IETF protocol assignment space' },
  { base: v4(192, 0, 2, 0), bits: 24, why: 'is in documentation space' },
  { base: v4(192, 88, 99, 0), bits: 24, why: 'is the deprecated 6to4 relay anycast block' },
  { base: v4(192, 168, 0, 0), bits: 16, why: 'is a private address (RFC 1918)' },
  { base: v4(198, 18, 0, 0), bits: 15, why: 'is in benchmarking space' },
  { base: v4(198, 51, 100, 0), bits: 24, why: 'is in documentation space' },
  { base: v4(203, 0, 113, 0), bits: 24, why: 'is in documentation space' },
  { base: v4(224, 0, 0, 0), bits: 4, why: 'is multicast' },
  { base: v4(240, 0, 0, 0), bits: 4, why: 'is reserved' },
];

function parseV4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** Expand an IPv6 literal to its sixteen bytes, or `null` when it is not one. */
function parseV6(address: string): number[] | null {
  const zone = address.indexOf('%');
  const bare = zone === -1 ? address : address.slice(0, zone);

  const halves = bare.split('::');
  if (halves.length > 2) return null;

  const expand = (part: string): number[] | null => {
    if (!part) return [];
    const bytes: number[] = [];
    for (const group of part.split(':')) {
      if (group.includes('.')) {
        // A trailing IPv4 literal, as in `::ffff:127.0.0.1`.
        const embedded = parseV4(group);
        if (embedded === null) return null;
        bytes.push(
          (embedded >>> 24) & 0xff,
          (embedded >>> 16) & 0xff,
          (embedded >>> 8) & 0xff,
          embedded & 0xff,
        );
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      const word = Number.parseInt(group, 16);
      bytes.push((word >> 8) & 0xff, word & 0xff);
    }
    return bytes;
  };

  const head = expand(halves[0] ?? '');
  const tail = halves.length === 2 ? expand(halves[1] ?? '') : [];
  if (!head || !tail) return null;

  if (halves.length === 2) {
    const gap = 16 - head.length - tail.length;
    if (gap < 0) return null;
    return [...head, ...Array<number>(gap).fill(0), ...tail];
  }

  return head.length === 16 ? head : null;
}

/**
 * Why this address may not be fetched, or `null` when it is a public one.
 *
 * IPv4-mapped, IPv4-compatible, 6to4 and NAT64 IPv6 addresses are unwrapped and
 * checked as IPv4: `::ffff:127.0.0.1` is the loopback with a costume on.
 */
export function blockedAddressReason(address: string): string | null {
  const family = isIP(address);

  if (family === 4) {
    const value = parseV4(address);
    if (value === null) return 'is not a parseable address';
    if (value === 0xffffffff) return 'is the broadcast address';
    for (const block of BLOCKED_V4) {
      const mask = block.bits === 0 ? 0 : (0xffffffff << (32 - block.bits)) >>> 0;
      if (((value & mask) >>> 0) === ((block.base & mask) >>> 0)) return block.why;
    }
    return null;
  }

  if (family === 6) {
    const bytes = parseV6(address);
    if (!bytes) return 'is not a parseable address';

    if (bytes.every((byte) => byte === 0)) return 'is the unspecified address';
    if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) {
      return 'is the IPv6 loopback';
    }

    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d).
    const embedsV4 =
      bytes.slice(0, 10).every((byte) => byte === 0) &&
      ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0));
    if (embedsV4) {
      return (
        blockedAddressReason(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`) ??
        null
      );
    }

    // 6to4: 2002:a.b.c.d::/16 embeds an IPv4 address.
    if (bytes[0] === 0x20 && bytes[1] === 0x02) {
      return blockedAddressReason(`${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`);
    }

    // NAT64 well-known prefix 64:ff9b::/96.
    if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
      return blockedAddressReason(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
    }

    if ((bytes[0] & 0xfe) === 0xfc) return 'is in unique-local space';
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'is link-local';
    if (bytes[0] === 0xff) return 'is multicast';
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
      return 'is in documentation space';
    }
    if (bytes[0] === 0x01 && bytes[1] === 0x00 && bytes.slice(2, 8).every((byte) => byte === 0)) {
      return 'is in the discard-only block';
    }
    return null;
  }

  return 'is not an IP address';
}

/** `[::1]` comes back from `URL` with the brackets. DNS and `isIP` want it bare. */
function hostnameOf(url: URL): string {
  const host = url.hostname.toLowerCase();
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Reject anything that is not a public http(s) URL before a request is made. */
export function validateDeployedUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; reason: string } {
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

  // Credentials in the URL are a redirect-laundering trick and are never needed
  // for a publicly reachable deployment.
  if (url.username || url.password) {
    return {
      ok: false,
      reason:
        'The deployed URL must not carry credentials. AccessiFix audits publicly reachable pages.',
    };
  }

  const host = hostnameOf(url);

  if (host === 'localhost' || host.endsWith('.localhost') || host === 'localhost.localdomain') {
    return {
      ok: false,
      reason:
        `"${host}" is this server, not your deployment. AccessiFix audits a publicly ` +
        'reachable URL — use the preview or production address.',
    };
  }

  // A literal address is settled here; a name is settled by DNS in
  // `resolveToPublicAddresses`, because only DNS knows where it points.
  if (isIP(host)) {
    const blocked = blockedAddressReason(host);
    if (blocked) {
      return {
        ok: false,
        reason:
          `${host} ${blocked}, so it is not a publicly reachable deployment. ` +
          'AccessiFix will not fetch it.',
      };
    }
  }

  return { ok: true, url: url.toString() };
}

export interface AddressCheck {
  ok: boolean;
  addresses: string[];
  reason: string;
}

/**
 * Resolve a hostname and refuse the whole name if *any* address it answers with
 * is private.
 *
 * All-or-nothing on purpose. A name that resolves to one public address and one
 * loopback address is a rebinding attempt, and picking the public one would be
 * picking the answer the attacker wants us to see.
 */
export async function resolveToPublicAddresses(host: string): Promise<AddressCheck> {
  if (isIP(host)) {
    const blocked = blockedAddressReason(host);
    return blocked
      ? { ok: false, addresses: [host], reason: `${host} ${blocked}.` }
      : { ok: true, addresses: [host], reason: `${host} is a public address.` };
  }

  let records: { address: string }[];
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, addresses: [], reason: `"${host}" does not resolve (${message}).` };
  }

  if (records.length === 0) {
    return { ok: false, addresses: [], reason: `"${host}" resolved to no addresses.` };
  }

  for (const record of records) {
    const blocked = blockedAddressReason(record.address);
    if (blocked) {
      return {
        ok: false,
        addresses: records.map((entry) => entry.address),
        reason:
          `"${host}" resolves to ${record.address}, which ${blocked}. AccessiFix only ` +
          'fetches publicly reachable deployments, so this URL is refused.',
      };
    }
  }

  return {
    ok: true,
    addresses: records.map((entry) => entry.address),
    reason: `"${host}" resolves to ${records.length} public address(es).`,
  };
}

/**
 * Full pre-flight for one hop: syntax, then DNS.
 *
 * NOTE: the resolution here and the one the socket performs are two separate
 * lookups, so a hostile authoritative server answering with a one-second TTL
 * can still reply differently to the second (classic DNS rebinding). Closing
 * that window needs a pinned-socket dispatcher, which is a dependency this
 * project does not carry; the request below is a single unauthenticated `GET`
 * whose body is never returned to the caller, so the residual exposure is a
 * status code.
 */
async function vetHop(raw: string): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
  const validated = validateDeployedUrl(raw);
  if (!validated.ok) return validated;

  const url = new URL(validated.url);
  const resolution = await resolveToPublicAddresses(hostnameOf(url));
  if (!resolution.ok) return { ok: false, reason: resolution.reason };

  return { ok: true, url };
}

/**
 * Fetch the deployed URL and report whether a run may start.
 *
 * Never throws: a network failure is a *result* with a stated reason, because
 * the caller's job is to explain the refusal, not to handle an exception.
 */
export async function checkDeployedUrl(raw: string): Promise<ReachabilityResult> {
  const started = Date.now();
  const entry = typeof raw === 'string' ? raw.trim() : '';

  const refuse = (
    reason: string,
    url = entry,
    status: number | null = null,
  ): ReachabilityResult => ({
    ok: false,
    url,
    finalUrl: null,
    status,
    contentType: null,
    reason,
    elapsedMs: Date.now() - started,
  });

  const first = await vetHop(entry);
  if (!first.ok) return refuse(first.reason);

  const requested = first.url.toString();
  let current = first.url;
  const deadline = started + TIMEOUT_MS;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return refuse(`${current.toString()} did not respond within ${TIMEOUT_MS / 1000}s.`, requested);
    }

    let response: Response;
    try {
      response = await fetch(current, {
        method: 'GET',
        // Redirects are followed by hand so every destination is re-validated.
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(remaining),
        headers: {
          // Some hosts serve a different (or no) body to an unidentified client.
          'user-agent': 'AccessiFix/0.1 (+accessibility audit; reachability check)',
          accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        },
      });
    } catch (error) {
      return refuse(describeNetworkError(error, current.toString()), requested);
    }

    if (isRedirect(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        return refuse(
          `${current.toString()} answered ${response.status} with no Location header, so there is nowhere to follow.`,
          requested,
          response.status,
        );
      }

      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        return refuse(
          `${current.toString()} redirected to "${location}", which is not a URL.`,
          requested,
          response.status,
        );
      }

      if (hop === MAX_REDIRECTS) {
        return refuse(
          `${requested} redirected more than ${MAX_REDIRECTS} times. The last hop was ${next}.`,
          requested,
          response.status,
        );
      }

      // The whole point: a public first hop does not buy a private second one.
      const vetted = await vetHop(next);
      if (!vetted.ok) {
        return refuse(
          `${current.toString()} redirected to ${next}, which was refused: ${vetted.reason}`,
          requested,
          response.status,
        );
      }

      current = vetted.url;
      continue;
    }

    const contentType = response.headers.get('content-type');
    const finalUrl = current.toString();
    const elapsedMs = Date.now() - started;

    if (!response.ok) {
      return {
        ok: false,
        url: requested,
        finalUrl,
        status: response.status,
        contentType,
        reason: describeStatus(response.status, finalUrl),
        elapsedMs,
      };
    }

    // 2xx with a non-HTML body is reachable but not auditable.
    if (contentType && !/(text\/html|application\/xhtml)/i.test(contentType)) {
      return {
        ok: false,
        url: requested,
        finalUrl,
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
      url: requested,
      finalUrl,
      status: response.status,
      contentType,
      reason: `${response.status} ${response.statusText || 'OK'}.`,
      elapsedMs,
    };
  }

  return refuse(`${requested} redirected more than ${MAX_REDIRECTS} times.`, requested);
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
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
