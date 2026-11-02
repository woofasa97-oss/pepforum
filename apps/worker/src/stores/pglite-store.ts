/**
 * Development/test store backed by the PGlite harness: the real migrations,
 * the real SQL functions, executed as service_role. Never used in production.
 */
import { type TestDb, service } from '@pepforum/database/testing';

import { type ApplyScoresRequest, type ApplyScoresResult, type WorkerStore, toResultsPayload } from '../store.ts';

export class PgliteStore implements WorkerStore {
  private readonly db: TestDb;

  constructor(db: TestDb) {
    this.db = db;
  }

  async loadScoringInput(windowDays: number): Promise<unknown> {
    const { input } = await this.db.asOne<{ input: unknown }>(service, `select public.scoring_input($1) as input`, [windowDays]);
    return input;
  }

  async applyScores(request: ApplyScoresRequest): Promise<ApplyScoresResult> {
    const { result } = await this.db.asOne<{ result: ApplyScoresResult }>(
      service,
      `select public.apply_note_scores($1, $2::timestamptz, $3, $4::jsonb, $5::jsonb) as result`,
      [request.runId, request.snapshot, request.mode, JSON.stringify(toResultsPayload(request.results)), JSON.stringify(request.shadow)],
    );
    return result;
  }

  async runMaintenance(): Promise<Record<string, number>> {
    const { result } = await this.db.asOne<{ result: Record<string, number> }>(service, `select public.run_maintenance() as result`);
    return result;
  }

  async pendingAccountDeletions(limit: number): Promise<string[]> {
    const rows = await this.db.as<{ user_id: string }>(
      service,
      `select user_id from public.account_deletions where processed_at is null order by requested_at limit $1`,
      [limit],
    );
    return rows.map((r) => r.user_id);
  }

  async deleteAuthUser(userId: string): Promise<void> {
    await this.db.sql(`delete from auth.users where id = $1`, [userId]);
  }

  async markAccountDeletionProcessed(userId: string): Promise<void> {
    await this.db.as(service, `update public.account_deletions set processed_at = now() where user_id = $1`, [userId]);
  }
}
