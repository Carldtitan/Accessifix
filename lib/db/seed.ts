/**
 * Seed the WCAG criteria reference table.
 *
 *     npm run db:push    # create the tables
 *     npm run db:seed    # load the 55
 *
 * Idempotent: upserts all 55 rows and removes anything in the table that is no
 * longer one of them, so the database always mirrors `lib/db/criteria.ts`
 * exactly. Safe to re-run after every schema push.
 */
import { notInArray, sql } from 'drizzle-orm';

import { CRITERIA_TOTALS, WCAG_CRITERIA } from './criteria';
import { loadEnvLocal } from './env';
import { criteria, type NewCriterionRow } from './schema';

function toRow(criterion: (typeof WCAG_CRITERIA)[number]): NewCriterionRow {
  return {
    id: criterion.id,
    name: criterion.name,
    level: criterion.level,
    principle: criterion.principle,
    plainEnglish: criterion.plainEnglish,
    verdict: criterion.verdict,
    agent: criterion.agent,
    capabilities: [...criterion.capabilities],
    stateDependent: criterion.stateDependent,
    updatedAt: new Date(),
  };
}

async function main(): Promise<void> {
  // drizzle-kit and tsx do not read .env.local the way Next.js does.
  loadEnvLocal();

  // Imported after the environment is loaded: the client reads DATABASE_URL
  // at module scope.
  const { db, closeDb } = await import('./index');

  const rows = WCAG_CRITERIA.map(toRow);
  const ids = rows.map((row) => row.id);

  try {
    await db
      .insert(criteria)
      .values(rows)
      .onConflictDoUpdate({
        target: criteria.id,
        set: {
          name: sql`excluded.name`,
          level: sql`excluded.level`,
          principle: sql`excluded.principle`,
          plainEnglish: sql`excluded.plain_english`,
          verdict: sql`excluded.verdict`,
          agent: sql`excluded.agent`,
          capabilities: sql`excluded.capabilities`,
          stateDependent: sql`excluded.state_dependent`,
          updatedAt: new Date(),
        },
      });

    const removed = await db.delete(criteria).where(notInArray(criteria.id, ids)).returning({
      id: criteria.id,
    });

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(criteria);

    console.log(`Seeded ${rows.length} WCAG 2.2 success criteria.`);
    console.log(
      `  ${CRITERIA_TOTALS.levelA} Level A, ${CRITERIA_TOTALS.levelAA} Level AA` +
        ` | ${CRITERIA_TOTALS.decide} DECIDE, ${CRITERIA_TOTALS.flag} FLAG,` +
        ` ${CRITERIA_TOTALS.blocked} BLOCKED | ${CRITERIA_TOTALS.stateDependent} state-dependent`,
    );
    if (removed.length > 0) {
      console.log(`  Removed ${removed.length} stale row(s): ${removed.map((r) => r.id).join(', ')}`);
    }

    if (total !== CRITERIA_TOTALS.total) {
      throw new Error(`criteria table holds ${total} rows, expected ${CRITERIA_TOTALS.total}.`);
    }
    console.log(`  criteria table verified at ${total} rows.`);
  } finally {
    await closeDb();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exitCode = 1;
});
