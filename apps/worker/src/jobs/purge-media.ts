/**
 * Deletes the bytes of removed and abandoned uploads (…023). The database
 * decides what goes (media_to_purge); a row is marked purged only once its
 * object is gone, so a Storage hiccup is retried next run.
 */
import type { Logger } from '../logger.ts';
import type { WorkerStore } from '../store.ts';

export interface PurgeReport {
  readonly purged: number;
  readonly failed: number;
}

export async function purgeMediaJob(store: WorkerStore, log: Logger, batchSize = 100): Promise<PurgeReport> {
  const items = await store.mediaToPurge(batchSize);
  let purged = 0;
  let failed = 0;
  const byBucket = new Map<string, typeof items>();
  for (const item of items) byBucket.set(item.bucket, [...(byBucket.get(item.bucket) ?? []), item]);
  for (const [bucket, group] of byBucket) {
    try {
      await store.deleteStorageObjects(bucket, group.map((g) => g.path));
      purged += await store.markMediaPurged(group.map((g) => g.id));
    } catch (error) {
      failed += group.length;
      log.error('media purge failed; will retry next run', { bucket, count: group.length, error: (error as Error).message });
    }
  }
  log.info('media purged', { purged, failed });
  return { purged, failed };
}
