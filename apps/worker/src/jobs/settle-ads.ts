/**
 * Daily advertising settlement (…025): the database charges every finished
 * day once (idempotent per campaign and day), completes ended flights and
 * releases what is left of their reservations.
 */
import type { SettleAdsResult } from '@pepforum/database';

import type { Logger } from '../logger.ts';
import type { WorkerStore } from '../store.ts';

export async function settleAdsJob(store: WorkerStore, log: Logger): Promise<SettleAdsResult> {
  const result = await store.settleAds();
  log.info('ads settled', { ...result });
  return result;
}
