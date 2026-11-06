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
import { purgeMediaJob } from './jobs/purge-media.ts';
import { type PushSender, pushJob } from './jobs/push.ts';
import { scoreNotesJob } from './jobs/score-notes.ts';
import { settleAdsJob } from './jobs/settle-ads.ts';
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
    jobs.push(['purge_media', async () => ({ ...(await purgeMediaJob(store, log)) })]);
    jobs.push(['settle_ads', async () => ({ ...(await settleAdsJob(store, log)) })]);
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
      const sender = await createWebPushSender(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
      jobs.push(['push', async () => ({ ...(await pushJob(store, log, sender, { batchSize: env.PUSH_BATCH_SIZE, siteUrl: env.SITE_URL })) })]);
    } else {
      log.info('push skipped: VAPID keys not configured');
    }
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

/** The `web-push` library, loaded only when keys are configured. */
async function createWebPushSender(subject: string, publicKey: string, privateKey: string): Promise<PushSender> {
  const webPush = await import('web-push');
  webPush.setVapidDetails(subject, publicKey, privateKey);
  return {
    async send(subscription, payload) {
      await webPush.sendNotification(subscription, payload, { TTL: 60 * 60 * 24, urgency: 'normal' });
    },
  };
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(JSON.stringify({ level: 'error', message: 'worker crashed', error: (error as Error).message }));
    process.exit(1);
  },
);
