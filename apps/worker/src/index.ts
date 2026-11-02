/**
 * Render cron entry point (render.yaml → pepforum-worker, every 10 minutes).
 * Runs each job independently and exits non-zero if any failed, so Render
 * marks the run failed and alerts.
 *
 *   node src/index.ts            score, maintain, process deletions
 *   node src/index.ts --dry-run  score only, print planned transitions, write nothing
 */
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

  const jobs: Array<[string, () => Promise<unknown>]> = [
    ['score-notes', () => scoreNotesJob(store, log, { windowDays: env.SCORING_WINDOW_DAYS, dryRun })],
  ];
  if (!dryRun) {
    jobs.push(['maintenance', () => maintenanceJob(store, log)]);
    jobs.push(['process-deletions', () => processDeletionsJob(store, log, env.DELETIONS_BATCH_SIZE)]);
  }

  let failures = 0;
  for (const [name, run] of jobs) {
    try {
      await run();
    } catch (error) {
      failures += 1;
      log.error('job failed', { job: name, error: (error as Error).message });
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
