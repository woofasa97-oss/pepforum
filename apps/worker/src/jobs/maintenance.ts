/**
 * Housekeeping: revert un-reviewed collapses, purge expired rate-limit rows
 * and stale rating assignments.
 */
import type { Logger } from '../logger.ts';
import type { WorkerStore } from '../store.ts';

export async function maintenanceJob(store: WorkerStore, log: Logger): Promise<Record<string, number>> {
  const result = await store.runMaintenance();
  log.info('maintenance complete', result);
  return result;
}
