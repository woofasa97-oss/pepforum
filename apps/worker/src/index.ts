/**
 * Render cron entry point (render.yaml → pepforum-worker, every 10 minutes).
 * Runs each job independently and exits non-zero if any failed, so Render
 * marks the run failed and alerts.
 *
 *   node src/index.ts            score, maintain, process deletions
 *   node src/index.ts --dry-run  score only, print planned transitions, write nothing
 */
import type { JobName, Json } from '@pepforum/database';

import { loadEnv } from './config.ts';
import { maintenanceJob } from './jobs/maintenance.ts';
import { processDeletionsJob } from './jobs/process-deletions.ts';
import { scoreNotesJob } from './jobs/score-notes.ts';
import { createLogger } from './logger.ts';
import { SupabaseStore } from './stores/supabase-store.ts';

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const log = createLogger({ service: 'pepforum-worker' });
  const env = loadEnv();
  const store = new SupabaseStore(env);

  // Each job returns a small summary of counts for the /admin/system heartbeat.
  const jobs: Array<[JobName, () => Promise<Record<string, Json>>]> = [
    ['score_notes', async () => {
      const report = await scoreNotesJob(store, log, { windowDays: env.SCORING_WINDOW_DAYS, dryRun });
      return { mode: report.mode, notes: report.notes, ratings: report.ratings, transitions: report.plannedTransitions.length };
    }],
  ];
  if (!dryRun) {
    jobs.push(['maintenance', () => maintenanceJob(store, log)]);
    jobs.push(['process_deletions', async () => ({ ...(await processDeletionsJob(store, log, env.DELETIONS_BATCH_SIZE)) })]);
  }

  let failures = 0;
  for (const [name, run] of jobs) {
    const startedAt = new Date().toISOString();
    let ok = true;
    let summary: Record<string, Json> = {};
    try {
      summary = await run();
    } catch (error) {
      ok = false;
      failures += 1;
      log.error('job failed', { job: name, error: (error as Error).message });
    }
    if (!dryRun) {
      try {
        await store.recordJobRun(name, startedAt, ok, summary);
      } catch (error) {
        // A missing heartbeat must never fail the job itself (e.g. before migration 015).
        log.warn('heartbeat not recorded', { job: name, error: (error as Error).message });
      }
    }
  }
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(JSON.stringify({ level: 'error', message: 'worker crashed', error: (error as Error).message }));
    process.exit(1);
  },
);
