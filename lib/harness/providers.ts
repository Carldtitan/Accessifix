/**
 * Model provider registration.
 *
 * TrueForge derives the provider's resource name from `manifest.type`, so
 * there is exactly one `anthropic` provider and one `fireworks` provider per
 * tenant, and models surface as `anthropic/claude-opus-5`. That makes this
 * idempotent by construction: create when absent, merge models when present,
 * touch nothing when everything the roster needs is already there.
 *
 * Anthropic carries the demo-critical path — VIS, ACT, FIX. Fireworks carries
 * the bulk lanes — PAGES, CODE, VERIFY — and is optional. Without a Fireworks
 * key the roster still boots; those three agents resolve to their Anthropic
 * fallback model instead.
 *
 * Model ids below were read from `GET /api/v1/catalogs/model-providers`.
 */

import {
  TrueForgeError,
  getTrueForgeClient,
  type ConfiguredModel,
  type ConfiguredModelProvider,
  type ModelProviderManifest,
  type ModelProviderType,
  type TrueForgeClient,
} from "./client";

export type ManagedProviderType = Extract<ModelProviderType, "anthropic" | "fireworks">;

interface ProviderPlan {
  readonly type: ManagedProviderType;
  readonly envVar: string;
  readonly purpose: string;
  readonly models: readonly ConfiguredModel[];
}

const PROVIDER_PLANS: readonly ProviderPlan[] = [
  {
    type: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    purpose: "VIS, ACT, MEDIA and FIX — the demo-critical path",
    models: [
      {
        model_id: "claude-opus-5",
        name: "claude-opus-5",
        properties: { context_length: 1_000_000, max_output_tokens: 128_000 },
      },
      {
        model_id: "claude-sonnet-5",
        name: "claude-sonnet-5",
        properties: { context_length: 1_000_000, max_output_tokens: 128_000 },
      },
    ],
  },
  {
    type: "fireworks",
    envVar: "FIREWORKS_API_KEY",
    purpose: "PAGES, CODE and VERIFY — the bulk lanes",
    models: [
      {
        model_id: "accounts/fireworks/models/kimi-k3",
        name: "kimi-k3",
        properties: { context_length: 1_048_576 },
      },
      {
        model_id: "accounts/fireworks/models/kimi-k2p7-code",
        name: "kimi-k2p7-code",
        properties: { context_length: 262_144 },
      },
    ],
  },
];

export type ProviderAction = "created" | "updated" | "unchanged" | "skipped";

export interface ProviderEnsureResult {
  readonly provider: ManagedProviderType;
  readonly action: ProviderAction;
  /** Model FQNs this provider exposes after the call. */
  readonly models: readonly string[];
  /** Present when `action` is `skipped`, or when a model had to be added. */
  readonly reason?: string;
}

export interface EnsureProvidersResult {
  readonly results: readonly ProviderEnsureResult[];
  /** Every model FQN available across all providers, read back from the server. */
  readonly availableModels: readonly string[];
}

export interface EnsureProvidersOptions {
  client?: TrueForgeClient;
  /** Overrides `ANTHROPIC_API_KEY`. */
  anthropicApiKey?: string;
  /** Overrides `FIREWORKS_API_KEY`. Absent or empty means the lane is skipped. */
  fireworksApiKey?: string;
  /** Throw when Anthropic cannot be configured. Default true — nothing works without it. */
  requireAnthropic?: boolean;
  /**
   * Rewrite the stored API key from the environment even when the provider
   * already has every model the roster needs. Off by default so a warm start
   * makes no writes, and so a key configured by hand in the TrueForge UI is
   * not silently replaced by a stale one from the shell.
   */
  rotateKeys?: boolean;
  signal?: AbortSignal;
}

/**
 * Model FQNs that would exist once `ensureProviders` has run, given which keys
 * are set. Lets a dry run report the roster it would produce rather than the
 * one that happens to be registered now.
 */
export function plannedProviderModels(
  options: Pick<EnsureProvidersOptions, "anthropicApiKey" | "fireworksApiKey"> = {},
): string[] {
  const keys: Record<ManagedProviderType, string> = {
    anthropic: (options.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? "").trim(),
    fireworks: (options.fireworksApiKey ?? process.env.FIREWORKS_API_KEY ?? "").trim(),
  };
  return PROVIDER_PLANS.filter((plan) => keys[plan.type].length > 0).flatMap((plan) =>
    plan.models.map((model) => `${plan.type}/${model.name}`),
  );
}

/**
 * Registers the providers the roster needs. Safe to call on every boot: a warm
 * start makes no writes at all.
 */
export async function ensureProviders(
  options: EnsureProvidersOptions = {},
): Promise<EnsureProvidersResult> {
  const client = options.client ?? getTrueForgeClient();
  const keys: Record<ManagedProviderType, string> = {
    anthropic: (options.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? "").trim(),
    fireworks: (options.fireworksApiKey ?? process.env.FIREWORKS_API_KEY ?? "").trim(),
  };

  const existing = await client.listModelProviders(options.signal);
  const byType = new Map<string, ConfiguredModelProvider>(
    existing.map((provider) => [provider.manifest.type, provider]),
  );

  const results: ProviderEnsureResult[] = [];
  for (const plan of PROVIDER_PLANS) {
    results.push(
      await ensureOneProvider(client, plan, keys[plan.type], byType.get(plan.type), options),
    );
  }

  if (options.requireAnthropic !== false) {
    const anthropic = results.find((result) => result.provider === "anthropic");
    if (anthropic && anthropic.action === "skipped") {
      throw new Error(
        `Anthropic is not configured on TrueForge and ANTHROPIC_API_KEY is not set. ` +
          `VIS, ACT, MEDIA and FIX have no model. ${anthropic.reason ?? ""}`.trim(),
      );
    }
  }

  const available = await client.listModels(options.signal);
  return { results, availableModels: available.map((model) => model.name) };
}

async function ensureOneProvider(
  client: TrueForgeClient,
  plan: ProviderPlan,
  apiKey: string,
  existing: ConfiguredModelProvider | undefined,
  options: EnsureProvidersOptions,
): Promise<ProviderEnsureResult> {
  const wanted = plan.models;

  if (!existing) {
    if (apiKey.length === 0) {
      return {
        provider: plan.type,
        action: "skipped",
        models: [],
        reason: `${plan.envVar} is not set, so the ${plan.type} lane (${plan.purpose}) is unavailable.`,
      };
    }
    const manifest: ModelProviderManifest = {
      type: plan.type,
      auth: { api_key: apiKey },
      models: [...wanted],
    };
    const created = await createOrUpdate(client, manifest, options.signal);
    return {
      provider: plan.type,
      action: created.action,
      models: fqns(created.provider),
    };
  }

  // Already configured. Keep every model that is there and add only what the
  // roster is missing, so a hand-tuned provider is never clobbered.
  const present = new Set(existing.manifest.models.map((model) => model.name));
  const missing = wanted.filter((model) => !present.has(model.name));
  const rotate = options.rotateKeys === true && apiKey.length > 0;
  if (missing.length === 0 && !rotate) {
    return { provider: plan.type, action: "unchanged", models: fqns(existing) };
  }

  if (apiKey.length === 0) {
    return {
      provider: plan.type,
      action: "skipped",
      models: fqns(existing),
      reason:
        `${plan.envVar} is not set, so ${missing.map((m) => m.name).join(", ")} could not be added ` +
        `to the existing ${plan.type} provider. Updating requires a key.`,
    };
  }

  const manifest: ModelProviderManifest = {
    type: plan.type,
    auth: { api_key: apiKey },
    models: [...existing.manifest.models, ...missing],
    ...(existing.manifest.base_url ? { base_url: existing.manifest.base_url } : {}),
  };
  const updated = await client.updateModelProvider(manifest, options.signal);
  const notes = [
    missing.length > 0 ? `added ${missing.map((model) => model.name).join(", ")}` : null,
    rotate ? `rotated the key from ${plan.envVar}` : null,
  ].filter((note): note is string => note !== null);
  return {
    provider: plan.type,
    action: "updated",
    models: fqns(updated),
    reason: notes.join("; "),
  };
}

/**
 * POST, falling back to PUT on 409. Another process may have registered the
 * provider between our list and our create; that is a race, not an error.
 */
async function createOrUpdate(
  client: TrueForgeClient,
  manifest: ModelProviderManifest,
  signal?: AbortSignal,
): Promise<{ provider: ConfiguredModelProvider; action: ProviderAction }> {
  try {
    return { provider: await client.createModelProvider(manifest, signal), action: "created" };
  } catch (error) {
    if (error instanceof TrueForgeError && error.status === 409) {
      return { provider: await client.updateModelProvider(manifest, signal), action: "updated" };
    }
    throw error;
  }
}

function fqns(provider: ConfiguredModelProvider): string[] {
  return provider.manifest.models.map((model) => `${provider.name}/${model.name}`);
}

/** One line per provider, for the boot log. */
export function describeProviderResult(result: ProviderEnsureResult): string {
  const head = `${result.provider.padEnd(10)} ${result.action}`;
  const models = result.models.length > 0 ? ` — ${result.models.join(", ")}` : "";
  const reason = result.reason ? ` (${result.reason})` : "";
  return `${head}${models}${reason}`;
}
