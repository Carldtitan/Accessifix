/**
 * Boot script: register the model providers and the seven agents.
 *
 *   npm run agents:init                  create anything missing, leave the rest alone
 *   npm run agents:init -- --update      rewrite every manifest from the roster
 *   npm run agents:init -- --rotate-keys re-send the provider keys from the environment
 *   npm run agents:init -- --dry-run     say what it would do, change nothing
 *
 * Idempotent by design. A cold start creates all seven; a warm start creates
 * none and makes no writes. No agent identifier ever enters the environment —
 * agents are looked up by roster name.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  AGENT_DEFINITIONS,
  buildAgentSpec,
  describeRoster,
  resolveModel,
  type AgentDefinition,
} from "./agents";
import { TrueForgeClient, TrueForgeError, type Agent } from "./client";
import { describeProviderResult, ensureProviders, plannedProviderModels } from "./providers";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Minimal `.env` reader. The keys live one directory above the Next.js app in
 * this repository, which `next dev` would not pick up, and the project has no
 * dotenv dependency. Existing `process.env` values always win.
 */
function loadEnvFiles(paths: readonly string[]): string[] {
  const loaded: string[] = [];
  for (const path of paths) {
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      const match = line.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined && process.env[key] !== "") continue;
      let value = rawValue.trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
    loaded.push(path);
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const log = {
  section: (title: string) => console.log(`\n${title}\n${"-".repeat(title.length)}`),
  info: (message: string) => console.log(`  ${message}`),
  ok: (message: string) => console.log(`  + ${message}`),
  skip: (message: string) => console.log(`  = ${message}`),
  warn: (message: string) => console.warn(`  ! ${message}`),
  fail: (message: string) => console.error(`  x ${message}`),
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Flags {
  update: boolean;
  dryRun: boolean;
  rotateKeys: boolean;
}

function parseFlags(argv: readonly string[]): Flags {
  return {
    update: argv.includes("--update"),
    dryRun: argv.includes("--dry-run"),
    rotateKeys: argv.includes("--rotate-keys"),
  };
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const cwd = process.cwd();
  const loaded = loadEnvFiles([
    resolve(cwd, ".env.local"),
    resolve(cwd, "..", ".env.local"),
    resolve(cwd, ".env"),
  ]);

  const client = new TrueForgeClient();

  log.section("AccessiFix — TrueForge boot");
  log.info(`TrueForge   ${client.baseUrl}`);
  log.info(`env files   ${loaded.length > 0 ? loaded.join(", ") : "none (using process.env)"}`);
  if (flags.dryRun) log.warn("dry run — nothing will be written");

  // -- reachability and capabilities ---------------------------------------

  let sandboxAvailable = false;
  let skillsAvailable = false;
  try {
    const capabilities = await client.getCapabilities();
    sandboxAvailable = capabilities.sandbox.enabled;
    skillsAvailable = capabilities.skill.enabled;
    log.info(`sandbox     ${sandboxAvailable ? "configured" : "not configured"}`);
    log.info(
      `skills      ${skillsAvailable ? "available" : `unavailable — ${capabilities.skill.reason ?? "no reason given"}`}`,
    );
  } catch (error) {
    log.fail(
      `Could not reach TrueForge at ${client.baseUrl}. Is it running? ${errorMessage(error)}`,
    );
    return 1;
  }

  // -- providers ------------------------------------------------------------

  log.section("Model providers");
  let availableModels: readonly string[] = [];
  try {
    if (flags.dryRun) {
      const current = (await client.listModels()).map((model) => model.name);
      const planned = plannedProviderModels();
      availableModels = [...new Set([...current, ...planned])];
      log.info(`would ensure ${[...new Set(planned.map((name) => name.split("/")[0]))].join(", ") || "nothing"}`);
    } else {
      const providers = await ensureProviders({ client, rotateKeys: flags.rotateKeys });
      availableModels = providers.availableModels;
      for (const result of providers.results) log.info(describeProviderResult(result));
    }
    log.info(`models      ${availableModels.length > 0 ? availableModels.join(", ") : "none"}`);
  } catch (error) {
    log.fail(`Provider registration failed: ${errorMessage(error)}`);
    return 1;
  }

  // -- skills ---------------------------------------------------------------

  let configuredSkills: string[] = [];
  if (skillsAvailable) {
    try {
      configuredSkills = (await client.listSkills()).map((skill) => skill.name);
    } catch (error) {
      log.warn(`Could not list skills: ${errorMessage(error)}`);
    }
  }

  const wantedSkills = new Set(AGENT_DEFINITIONS.flatMap((def) => def.skills));
  const missingSkills = [...wantedSkills].filter((name) => !configuredSkills.includes(name));
  if (missingSkills.length > 0) {
    log.section("Skills");
    log.warn(
      `${missingSkills.length} roster skill(s) are not configured on this TrueForge and will not be mounted: ${missingSkills.join(", ")}`,
    );
    log.info(
      "WCAG criterion knowledge stays in the prompts until these are registered via POST /api/v1/settings/skills (requires a sandbox provider).",
    );
  }

  // -- agents ---------------------------------------------------------------

  log.section("Agents");
  let existing: Agent[];
  try {
    existing = await client.listAgents();
  } catch (error) {
    log.fail(`Could not list agents: ${errorMessage(error)}`);
    return 1;
  }
  const byName = new Map(existing.map((agent) => [agent.name, agent]));

  const specOptions = {
    availableModels,
    sandboxAvailable,
    availableSkills: configuredSkills,
  };

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const definition of AGENT_DEFINITIONS) {
    const model = resolveModel(definition, availableModels);
    if (model !== definition.model) {
      log.warn(
        `${definition.name}: ${definition.model} is not available, falling back to ${model}`,
      );
    }
    if (availableModels.length > 0 && !availableModels.includes(model)) {
      log.fail(`${definition.name}: no available model (wanted ${definition.model})`);
      failed += 1;
      continue;
    }

    const current = byName.get(definition.name);
    const spec = buildAgentSpec(definition, specOptions);

    try {
      if (!current) {
        if (flags.dryRun) {
          log.ok(`${describe(definition, model)}  (would create)`);
        } else {
          const agent = await client.createAgent(definition.name, spec);
          log.ok(`${describe(definition, model)}  created as ${agent.id}`);
        }
        created += 1;
      } else if (flags.update) {
        if (flags.dryRun) {
          log.ok(`${describe(definition, model)}  (would update ${current.id})`);
        } else {
          await client.updateAgent(current.id, spec);
          log.ok(`${describe(definition, model)}  updated ${current.id}`);
        }
        updated += 1;
      } else {
        log.skip(`${describe(definition, model)}  exists as ${current.id}`);
        skipped += 1;
      }
    } catch (error) {
      log.fail(`${definition.name}: ${errorMessage(error)}`);
      failed += 1;
    }
  }

  // -- summary --------------------------------------------------------------

  log.section("Roster");
  for (const line of describeRoster(availableModels)) log.info(line);

  log.section("Summary");
  log.info(
    `${created} created, ${updated} updated, ${skipped} already present, ${failed} failed ` +
      `(${AGENT_DEFINITIONS.length} agents in the roster)`,
  );
  if (failed > 0) return 1;
  if (created === 0 && updated === 0) log.info("Nothing to do — TrueForge already has the roster.");
  return 0;
}

function describe(definition: AgentDefinition, model: string): string {
  const scope =
    definition.criteria.length > 0 ? `${definition.criteria.length} criteria` : definition.lane;
  return `${definition.name.padEnd(7)} ${model.padEnd(34)} ${scope}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof TrueForgeError) {
    return error.status ? `${error.message}` : `${error.kind}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`\nagents:init failed unexpectedly: ${errorMessage(error)}`);
    if (error instanceof Error && error.stack) console.error(error.stack);
    process.exitCode = 1;
  });
