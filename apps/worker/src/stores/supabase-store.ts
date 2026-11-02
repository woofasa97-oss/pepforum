/**
 * Production store: Supabase via the secret key (bypasses RLS). The key never
 * leaves this process; nothing here is reachable from the web.
 */
import type { Database } from '@pepforum/database';
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

  async markAccountDeletionProcessed(userId: string): Promise<void> {
    const { error } = await this.client
      .from('account_deletions')
      .update({ processed_at: new Date().toISOString() })
      .eq('user_id', userId);
    if (error) throw new Error(`account_deletions update failed: ${error.message}`);
  }
}
