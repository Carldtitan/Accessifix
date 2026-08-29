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

let cached: CachedCapabilities | null = null;

/**
 * Ask the server what it can do, once per five minutes.
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

  const now = Date.now();
  if (cached && now - cached.at < CAPABILITY_TTL_MS) {
    return { ...cached.value, ...explicit };
  }

  const client = input.client ?? safeClient();
  if (!client) return explicit;

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

  cached = { at: now, value: probed };
  return { ...probed, ...explicit };
}

/** Forget the probe. For tests, and for a TrueForge that was restarted. */
export function resetLaneCapabilities(): void {
  cached = null;
}

function safeClient(): TrueForgeClient | null {
  try {
    return getTrueForgeClient();
  } catch {
    return null;
  }
}
