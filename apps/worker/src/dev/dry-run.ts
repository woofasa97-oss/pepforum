/**
 * Local dry run without a Supabase project: boots PGlite with the real
 * migrations and the demo seed, runs one scoring pass in dry-run mode and
 * prints what would change.
 *
 *   pnpm --filter @pepforum/worker dry-run
 */
import { TestDb } from '@pepforum/database/testing';

import { scoreNotesJob } from '../jobs/score-notes.ts';
import { createLogger } from '../logger.ts';
import { PgliteStore } from '../stores/pglite-store.ts';

const db = await TestDb.create();
try {
  await db.applySeed();
  const log = createLogger({ service: 'pepforum-worker', env: 'dry-run' });
  const report = await scoreNotesJob(new PgliteStore(db), log, { windowDays: 180, dryRun: true });

  console.log('\nPlanned transitions:');
  if (report.plannedTransitions.length === 0) console.log('  (none)');
  for (const t of report.plannedTransitions) console.log(`  ${t.noteId}  ${t.from} → ${t.to}`);
  console.log(`\nMode: ${report.mode}  ·  shadow agreement: ${(report.agreement * 100).toFixed(0)}%  ·  ratings: ${report.ratings}`);
} finally {
  await db.close();
}
