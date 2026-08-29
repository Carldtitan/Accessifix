/**
 * Register the AccessiFix Skill packs on TrueForge (A13.1).
 *
 *   npx tsx skills/register-skills.ts            register everything, then verify
 *   npx tsx skills/register-skills.ts --dry-run  print the manifests, write nothing
 *   npx tsx skills/register-skills.ts --verify   verify only, no writes
 *
 * TrueForge skills are git-backed: `POST/PUT /api/v1/settings/skills` accepts a
 * manifest of `{ type: "git", name, url, path, ref, description }` and takes no
 * inline body. The skill text therefore lives in this repository under
 * `skills/<name>/SKILL.md` and TrueForge clones it into the sandbox on demand.
 *
 * `description` is not written here. It is read out of each SKILL.md's YAML
 * frontmatter, so the one line that stays in an agent's context permanently and
 * the body it pulls on demand can never drift apart.
 *
 * PUT is a full upsert keyed by name, so this script is idempotent.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { SKILL_CRITERIA, SKILL_NAMES } from "../lib/harness/agents";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Public repository TrueForge clones the skills from. */
const SKILL_REPO_URL = process.env.ACCESSIFIX_SKILL_REPO_URL ?? "https://github.com/Carldtitan/Accessifix";
/** Branch, tag or SHA. A tag or SHA pins the pack for a reproducible audit. */
const SKILL_REPO_REF = process.env.ACCESSIFIX_SKILL_REPO_REF ?? "main";
/** Directory inside the repository that holds one directory per skill. */
const SKILL_ROOT = "skills";

const BASE_URL = (process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790").replace(/\/+$/, "");
const API_KEY = (process.env.TRUEFORGE_API_KEY ?? "").trim();

/** `ResourceName` in the TrueForge OpenAPI schema. Checked here so a bad name fails locally. */
const RESOURCE_NAME = /^[a-z](?:[a-z0-9._-]{0,62}[a-z0-9])$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillManifest {
  readonly type: "git";
  readonly name: string;
  readonly url: string;
  readonly path: string;
  readonly ref: string;
  readonly description: string;
}

interface ConfiguredSkill {
  readonly name: string;
  readonly manifest: SkillManifest;
}

// ---------------------------------------------------------------------------
// Reading the packs off disk
// ---------------------------------------------------------------------------

const skillsDir = resolve(__dirname);

/** `name` and `description` out of the SKILL.md YAML frontmatter. */
function readFrontmatter(path: string): { name: string; description: string } {
  const text = readFileSync(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) throw new Error(`${path}: no YAML frontmatter`);
  const fields = new Map<string, string>();
  let key: string | null = null;
  for (const rawLine of match[1].split(/\r?\n/)) {
    const start = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(rawLine);
    if (start) {
      key = start[1];
      fields.set(key, start[2].trim());
    } else if (key !== null && /^\s+\S/.test(rawLine)) {
      // Folded continuation line.
      fields.set(key, `${fields.get(key) ?? ""} ${rawLine.trim()}`.trim());
    }
  }
  const name = unquote(fields.get("name") ?? "");
  const description = unquote(fields.get("description") ?? "");
  if (name.length === 0) throw new Error(`${path}: frontmatter has no \`name\``);
  if (description.length === 0) throw new Error(`${path}: frontmatter has no \`description\``);
  return { name, description };
}

function unquote(value: string): string {
  if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function discoverSkills(): SkillManifest[] {
  const manifests: SkillManifest[] = [];
  for (const entry of readdirSync(skillsDir).sort()) {
    const dir = join(skillsDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const skillFile = join(dir, "SKILL.md");
    let front: { name: string; description: string };
    try {
      front = readFrontmatter(skillFile);
    } catch (error) {
      throw new Error(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (front.name !== entry) {
      throw new Error(`${entry}/SKILL.md declares name "${front.name}"; it must match the directory name`);
    }
    if (!RESOURCE_NAME.test(front.name)) {
      throw new Error(`"${front.name}" is not a valid TrueForge resource name`);
    }
    manifests.push({
      type: "git",
      name: front.name,
      url: SKILL_REPO_URL,
      path: `${SKILL_ROOT}/${front.name}`,
      ref: SKILL_REPO_REF,
      description: front.description,
    });
  }
  return manifests;
}

/** Every pack the roster expects must exist on disk, and vice versa. */
function checkAgainstRoster(manifests: readonly SkillManifest[]): string[] {
  const onDisk = new Set(manifests.map((m) => m.name));
  const problems: string[] = [];
  for (const name of SKILL_NAMES) {
    if (!onDisk.has(name)) problems.push(`roster expects "${name}" but skills/${name}/SKILL.md is missing`);
  }
  for (const name of onDisk) {
    if (!(name in SKILL_CRITERIA)) problems.push(`skills/${name} exists but the roster does not know it`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// TrueForge
// ---------------------------------------------------------------------------

function headers(): Record<string, string> {
  const base: Record<string, string> = { "content-type": "application/json" };
  if (API_KEY.length > 0) base.authorization = `Bearer ${API_KEY}`;
  return base;
}

async function putSkill(manifest: SkillManifest): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/v1/settings/skills`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ manifest }),
  });
  if (!response.ok) {
    throw new Error(`PUT /settings/skills ${manifest.name} -> ${response.status} ${await response.text()}`);
  }
}

async function listSkills(): Promise<ConfiguredSkill[]> {
  const response = await fetch(`${BASE_URL}/api/v1/settings/skills`, { headers: headers() });
  if (!response.ok) {
    throw new Error(`GET /settings/skills -> ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { data: ConfiguredSkill[] };
  return body.data;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const verifyOnly = argv.includes("--verify");

  const manifests = discoverSkills();
  console.log(`AccessiFix skills — ${BASE_URL}`);
  console.log(`repository        ${SKILL_REPO_URL} @ ${SKILL_REPO_REF}`);
  console.log(`packs on disk     ${manifests.length}\n`);

  const problems = checkAgainstRoster(manifests);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  x ${problem}`);
    return 1;
  }

  if (!verifyOnly) {
    for (const manifest of manifests) {
      const criteria = SKILL_CRITERIA[manifest.name] ?? [];
      const scope = criteria.length > 0 ? `${criteria.length} criteria` : "procedure";
      if (dryRun) {
        console.log(`  = ${manifest.name.padEnd(34)} ${scope.padEnd(13)} (would PUT)`);
        continue;
      }
      await putSkill(manifest);
      console.log(`  + ${manifest.name.padEnd(34)} ${scope.padEnd(13)} ${manifest.path}`);
    }
    if (dryRun) return 0;
  }

  const configured = await listSkills();
  const byName = new Map(configured.map((skill) => [skill.name, skill]));
  let missing = 0;
  console.log(`\nGET /api/v1/settings/skills -> ${configured.length} skill(s)`);
  for (const manifest of manifests) {
    const found = byName.get(manifest.name);
    if (!found) {
      console.error(`  x ${manifest.name} is not configured`);
      missing += 1;
      continue;
    }
    console.log(`  ok ${manifest.name.padEnd(34)} ${found.manifest.description.slice(0, 70)}...`);
  }
  return missing === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`\nregister-skills failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
