/**
 * Second phase of account deletion (PIPEDA / Loi 25): the profile was
 * tombstoned when the member asked; here the auth user — email, password hash,
 * sessions — is removed. Each account is handled independently so one failure
 * doesn't block the rest, and the request is only marked processed once the
 * auth user is really gone.
 */
import type { Logger } from '../logger.ts';
import type { WorkerStore } from '../store.ts';

export interface DeletionReport {
  readonly processed: number;
  readonly failed: number;
}

export async function processDeletionsJob(store: WorkerStore, log: Logger, batchSize: number): Promise<DeletionReport> {
  const pending = await store.pendingAccountDeletions(batchSize);
  let processed = 0;
  let failed = 0;
  for (const userId of pending) {
    try {
      await store.deleteAuthUser(userId);
      await store.markAccountDeletionProcessed(userId);
      processed += 1;
    } catch (error) {
      failed += 1;
      log.error('account deletion failed; will retry next run', { error: (error as Error).message });
    }
  }
  log.info('account deletions processed', { processed, failed });
  return { processed, failed };
}
