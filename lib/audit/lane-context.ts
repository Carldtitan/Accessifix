/**
 * What a lane needs to know about the TrueForge it is talking to.
 *
 * The roster describes seven agents; the server decides which models it can
 * serve, whether a sandbox provider is configured, and which skill packs are
 * mounted. Those three facts change how the A3.7 fallback manifest is built —
 * rebuild one without them and the fallback silently becomes a different agent,
 * dropping the WCAG skill packs the primary had (A13.2, A13.3).
 *
 * Every lane therefore accepts them, and none of them requires the caller to
 * supply them: the conductor calls a lane with a page and nothing else. When
 * they are absent the lane asks the server once and caches the answer, and when
 * the server cannot be asked it degrades to the roster's own defaults rather
 * than failing the page.
 */

import { getTrueForgeClient, type TrueForgeClient } from '@/lib/harness/client';

/**
 * Largest screenshot a lane will send, in decoded bytes.
 *
 * Full-page PNGs of long pages get big and a provider rejecting the image
 * wastes the whole pass. Over this the pass is skipped and the criteria come
 * back inconclusive — a degraded page, not a failed one. Same figure as
 * `MAX_SCREENSHOT_BYTES` in `lib/vision/candidates.ts`, measured against the
 * same providers.
 */
export const MAX_LANE_SCREENSHOT_BYTES = 4_500_000;

/** The server-shaped options every lane forwards to the harness. */
export interface LaneCapabilityOptions {
  readonly client?: TrueForgeClient;
  /** Model FQNs this TrueForge can serve, from `GET /models`. */
  readonly availableModels?: readonly string[];
  /** Skill names configured on this TrueForge, from `GET /settings/skills`. */
  readonly availableSkills?: readonly string[];
  /** Whether a sandbox provider is configured, from `GET /capabilities`. */
  readonly sandboxAvailable?: boolean;
}

/** Exactly the subset `runFindingsAgent` takes. */
export interface ResolvedLaneCapabilities {
  readonly client?: TrueForgeClient;
  readonly availableModels?: readonly string[];
  readonly availableSkills?: readonly string[];
  readonly sandboxAvailable?: boolean;
}

export function buildLaneCapabilityOptions(
  input: LaneCapabilityOptions,
): ResolvedLaneCapabilities {
  return {
    ...(input.client ? { client: input.client } : {}),
    ...(input.availableModels ? { availableModels: input.availableModels } : {}),
    ...(input.availableSkills ? { availableSkills: input.availableSkills } : {}),
    ...(input.sandboxAvailable === undefined
      ? {}
      : { sandboxAvailable: input.sandboxAvailable }),
  };
}

interface CachedCapabilities {
  readonly at: number;
  readonly value: ResolvedLaneCapabilities;
}

/** Long enough that a whole run costs one probe; short enough to notice a restart. */
const CAPABILITY_TTL_MS = 5 * 60_000;

/**
 * One entry per client, keyed by the client object itself.
 *
 * A single module-global entry was wrong in a way that only shows up once a
 * second TrueForge is in play: every lane accepts a `client`, so a lane pointed
 * at another server — a second tenant, a local harness beside the deployed one,
 * a test double — would be handed the first client's models, skills and sandbox
 * flag for the next five minutes. The A3.7 fallback manifest is built from those
 * three facts, so the consequence is not a stale display value: it is a fallback
 * agent asking for a model the active server cannot serve, or dropping the WCAG
 * skill packs (A13.2, A13.3) that server does mount.
 *
 * A `WeakMap` rather than a keyed record because the key *is* the identity that
 * matters — two clients built against the same base URL may still carry
 * different credentials — and because an entry then dies with the client it
 * describes instead of pinning it in memory. The process-default client is a
 * singleton (`getTrueForgeClient`), so it gets exactly one entry of its own.
 */
let cache = new WeakMap<TrueForgeClient, CachedCapabilities>();

/**
 * Ask the server what it can do, once per five minutes per client.
 *
 * Returns whatever the caller already supplied untouched — an explicit value is
 * always the answer. Never throws: a probe that fails leaves the fields absent,
 * which is exactly what a lane called with nothing would have had anyway.
 */
export async function resolveLaneCapabilities(
  input: LaneCapabilityOptions = {},
  signal?: AbortSignal,
): Promise<ResolvedLaneCapabilities> {
  const explicit = buildLaneCapabilityOptions(input);
  if (
    explicit.availableModels !== undefined &&
    explicit.availableSkills !== undefined &&
    explicit.sandboxAvailable !== undefined
  ) {
    return explicit;
  }

  // The client is chosen *before* the cache is consulted, because the cache is
  // keyed by it. Reading a cached answer first is what let one server's reply
  // stand in for another's.
  const client = input.client ?? safeClient();
  if (!client) return explicit;

  const now = Date.now();
  const cached = cache.get(client);
  if (cached && now - cached.at < CAPABILITY_TTL_MS) {
    return { ...cached.value, ...explicit };
  }

  const probed: {
    availableModels?: readonly string[];
    availableSkills?: readonly string[];
    sandboxAvailable?: boolean;
  } = {};

  const [models, skills, capabilities] = await Promise.all([
    client.listModels(signal).catch(() => null),
    client.listSkills(signal).catch(() => null),
    client.getCapabilities(signal).catch(() => null),
  ]);

  if (models) probed.availableModels = models.map((model) => model.name);
  if (skills) probed.availableSkills = skills.map((skill) => skill.name);
  if (capabilities) probed.sandboxAvailable = capabilities.sandbox.enabled;

  // A probe where nothing answered is not an answer. Storing it would hold the
  // lane at the roster defaults for five minutes over what may have been one
  // unreachable moment, so it is left uncached and the next lane asks again.
  if (models || skills || capabilities) {
    cache.set(client, { at: now, value: probed });
  }

  return { ...probed, ...explicit };
}

/** Forget every probe. For tests, and for a TrueForge that was restarted. */
export function resetLaneCapabilities(): void {
  cache = new WeakMap();
}

function safeClient(): TrueForgeClient | null {
  try {
    return getTrueForgeClient();
  } catch {
    return null;
  }
}
