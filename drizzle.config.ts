import { defineConfig } from 'drizzle-kit';

import { loadEnvLocal, requireEnv, sslModeFor } from './lib/db/env';

// drizzle-kit does not read .env.local the way Next.js does.
loadEnvLocal();

const url = requireEnv('DATABASE_URL');

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./lib/db/schema.ts', './lib/pipeline/schema.ts'],
  out: './lib/db/migrations',
  dbCredentials: {
    url,
    // Supabase's session pooler requires TLS; a local Postgres normally does not.
    ssl: sslModeFor(url),
  },
  strict: true,
  verbose: true,
});
