/**
 * Production store: Supabase via the secret key (bypasses RLS). The key never
 * leaves this process; nothing here is reachable from the web.
 */
import type { Database, JobName, Json, MediaToPurge, PendingPush, PushResult, SettleAdsResult } from '@pepforum/database';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';

import type { WorkerEnv } from '../config.ts';
import { type ApplyScoresRequest, type ApplyScoresResult, type WorkerStore, toResultsPayload } from '../store.ts';

export class SupabaseStore implements WorkerStore {
  private readonly client: SupabaseClient<Database>;

  constructor(env: WorkerEnv) {
    this.client = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { 'x-client-info': 'pepforum-worker' } },
    });
  }

  async loadScoringInput(windowDays: number): Promise<unknown> {
    const { data, error } = await this.client.rpc('scoring_input', { p_window_days: windowDays });
    if (error) throw new Error(`scoring_input failed: ${error.message}`);
    return data;
  }

  async applyScores(request: ApplyScoresRequest): Promise<ApplyScoresResult> {
    const { data, error } = await this.client.rpc('apply_note_scores', {
      p_run_id: request.runId,
      p_snapshot: request.snapshot,
      p_mode: request.mode,
      p_results: toResultsPayload(request.results),
      p_shadow: request.shadow,
    });
    if (error) throw new Error(`apply_note_scores failed: ${error.code ?? ''} ${error.message}`);
    return data;
  }

  async recordJobRun(job: JobName, startedAt: string, ok: boolean, summary: Json): Promise<void> {
    const { error } = await this.client.rpc('record_job_run', { p_job: job, p_started_at: startedAt, p_ok: ok, p_summary: summary });
    if (error) throw new Error(`record_job_run failed: ${error.message}`);
  }

  async runMaintenance(): Promise<Record<string, number>> {
    const { data, error } = await this.client.rpc('run_maintenance');
    if (error) throw new Error(`run_maintenance failed: ${error.message}`);
    return data;
  }

  async pendingAccountDeletions(limit: number): Promise<string[]> {
    const { data, error } = await this.client
      .from('account_deletions')
      .select('user_id')
      .is('processed_at', null)
      .order('requested_at')
      .limit(limit);
    if (error) throw new Error(`account_deletions query failed: ${error.message}`);
    return data.map((row) => row.user_id);
  }

  async deleteAuthUser(userId: string): Promise<void> {
    const { error } = await this.client.auth.admin.deleteUser(userId);
    // Already gone (e.g. deleted from the dashboard) counts as done.
    if (error && error.status !== 404) throw new Error(`auth user deletion failed: ${error.message}`);
  }

  async pendingPush(limit: number): Promise<PendingPush[]> {
    const { data, error } = await this.client.rpc('pending_push', { p_limit: limit });
    if (error) throw new Error(`pending_push failed: ${error.message}`);
    return data;
  }

  async recordPushResults(results: readonly PushResult[]): Promise<{ sent: number; dropped: number }> {
    const { data, error } = await this.client.rpc('record_push_results', { p_results: [...results] });
    if (error) throw new Error(`record_push_results failed: ${error.message}`);
    return data;
  }

  async mediaToPurge(limit: number): Promise<MediaToPurge[]> {
    const { data, error } = await this.client.rpc('media_to_purge', { p_limit: limit });
    if (error) throw new Error(`media_to_purge failed: ${error.message}`);
    return data;
  }

  async deleteStorageObjects(bucket: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    const { error } = await this.client.storage.from(bucket).remove([...paths]);
    if (error) throw new Error(`storage remove failed: ${error.message}`);
  }

  async markMediaPurged(ids: readonly string[]): Promise<number> {
    const { data, error } = await this.client.rpc('mark_media_purged', { p_ids: [...ids] });
    if (error) throw new Error(`mark_media_purged failed: ${error.message}`);
    return data;
  }

  async settleAds(): Promise<SettleAdsResult> {
    const { data, error } = await this.client.rpc('settle_ads', {});
    if (error) throw new Error(`settle_ads failed: ${error.message}`);
    return data;
  }

  async markAccountDeletionProcessed(userId: string): Promise<void> {
    const { error } = await this.client
      .from('account_deletions')
      .update({ processed_at: new Date().toISOString() })
      .eq('user_id', userId);
    if (error) throw new Error(`account_deletions update failed: ${error.message}`);
  }
}
