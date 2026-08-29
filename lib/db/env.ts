/**
 * Dependency-free `.env.local` loader.
 *
 * Next.js loads `.env.local` for us at runtime, but `drizzle-kit` and `tsx`
 * scripts (`lib/db/seed.ts`) do not. Rather than add `dotenv`, this reads and
 * parses the file itself. Real process environment always wins, so nothing here
 * can shadow a value injected by Vercel or the shell.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_FILES = ['.env.local', '.env'] as const;

/** `KEY=value`, optionally `export `-prefixed, optionally quoted. */
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function unquote(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = raw.slice(1, -1);
      return first === '"' ? inner.replace(/\n/g, '\n').replace(/\\"/g, '"') : inner;
    }
  }
  // Unquoted values may carry a trailing `# comment`.
  const hash = raw.indexOf(' #');
  return (hash === -1 ? raw : raw.slice(0, hash)).trim();
}

let loaded = false;

/**
 * Populate `process.env` from `.env.local` then `.env`. Idempotent, and never
 * overwrites a variable that is already set.
 */
export function loadEnvLocal(cwd: string = process.cwd()): void {
  if (loaded) return;
  loaded = true;

  for (const file of ENV_FILES) {
    const path = resolve(cwd, file);
    if (!existsSync(path)) continue;

    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const match = LINE.exec(line);
      if (!match) continue;

      const key = match[1];
      if (process.env[key] !== undefined) continue;
      process.env[key] = unquote(match[2]);
    }
  }
}

/** Read a required variable, or fail loudly with a message that names it. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/**
 * Supabase's session pooler requires TLS; a local Postgres normally does not.
 * `'require'` is postgres-js's equivalent of `sslmode=require`.
 */
export function sslModeFor(connectionString: string): 'require' | false {
  try {
    const host = new URL(connectionString).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '') {
      return false;
    }
  } catch {
    // Not a parseable URL - assume a managed host and keep TLS on.
  }
  return 'require';
}
