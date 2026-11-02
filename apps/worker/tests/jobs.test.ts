/**
 * End-to-end: real migrations + the local seed in PGlite, the real jobs, the
 * PGlite-backed store. Proves the worker and the SQL agree on the contract.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, user } from '@pepforum/database/testing';

import { parseScoringInput } from '../src/config.ts';
import { maintenanceJob } from '../src/jobs/maintenance.ts';
import { processDeletionsJob } from '../src/jobs/process-deletions.ts';
import { scoreNotesJob } from '../src/jobs/score-notes.ts';
import { silentLogger } from '../src/logger.ts';
import { PgliteStore } from '../src/stores/pglite-store.ts';

let db: TestDb;
let store: PgliteStore;

beforeAll(async () => {
  db = await TestDb.create();
  await db.applySeed();
  store = new PgliteStore(db);
});

afterAll(async () => {
  await db.close();
});

const noteStatus = async (titlePrefix: string) =>
  (await db.sqlOne<{ status: string }>(
    `select n.status from public.notes n join public.posts p on p.id = n.post_id where p.title like $1 || '%'`,
    [titlePrefix],
  )).status;

describe('scoring_input contract', () => {
  it('parses cleanly and excludes zero-weight ratings', async () => {
    const input = parseScoringInput(await store.loadScoringInput(180));
    expect(input.config.mode).toBe('bootstrap');
    expect(input.openNotes.length).toBe(3);
    expect(input.ratings.every((r) => r.weight > 0)).toBe(true);
  });
});

describe('score-notes job', () => {
  it('dry run plans transitions without writing', async () => {
    const report = await scoreNotesJob(store, silentLogger, { windowDays: 180, dryRun: true });
    expect(report.plannedTransitions).toEqual([
      expect.objectContaining({ from: 'needs_more_ratings', to: 'helpful' }),
    ]);
    expect(report.applied).toBeNull();
    expect(await noteStatus('New study claims GLP-1')).toBe('needs_more_ratings');
  });

  it('applies the unanimous seed note as Helpful and leaves split notes open', async () => {
    const report = await scoreNotesJob(store, silentLogger, { windowDays: 180 });
    expect(report.applied).toMatchObject({ transitions: 1, skipped_stale: 0 });
    expect(await noteStatus('New study claims GLP-1')).toBe('helpful');
    expect(await noteStatus('Is BPC-157')).toBe('needs_more_ratings');
    expect(await noteStatus('Got a purity report')).toBe('needs_more_ratings');
  });

  it('is idempotent per run id', async () => {
    const runId = '00000000-0000-4000-8000-0000000000aa';
    await scoreNotesJob(store, silentLogger, { windowDays: 180, runId });
    const again = await scoreNotesJob(store, silentLogger, { windowDays: 180, runId });
    expect(again.applied).toMatchObject({ already_applied: true });
  });

  it('settles a note once its status has held for the lock window', async () => {
    await db.sql(`update public.notes set status_since = now() - interval '73 hours' where status = 'helpful'`);
    const report = await scoreNotesJob(store, silentLogger, { windowDays: 180 });
    expect(report.applied?.locked).toBe(1);

    const writer = await db.sqlOne<{ karma: number; mod_xp: string }>(
      `select karma, mod_xp from public.profiles where username = 'peptide_analyst'`);
    // Writers are paid on the private moderation track: 15 + 1 per helpful rating.
    expect(writer.karma).toBe(12400);
    expect(Number(writer.mod_xp)).toBe(180 + 15 + 5);
    // Missing-context notes never penalise the post author.
    const author = await db.sqlOne<{ karma: number }>(`select karma from public.profiles where username = 'maple_you'`);
    expect(author.karma).toBeGreaterThanOrEqual(2480);
  });
});

describe('maintenance and deletions', () => {
  it('runs maintenance', async () => {
    const result = await maintenanceJob(store, silentLogger);
    expect(result).toEqual(expect.objectContaining({ uncollapsed: 0 }));
  });

  it('removes the auth user for a requested deletion and marks it processed', async () => {
    const leaving = await db.createUser({ username: 'leaving_member' });
    await db.as(user(leaving), `select public.request_account_deletion(false)`);

    const report = await processDeletionsJob(store, silentLogger, 10);
    expect(report).toEqual({ processed: 1, failed: 0 });
    expect(await db.sql(`select 1 from auth.users where id = $1`, [leaving])).toEqual([]);
    expect(await store.pendingAccountDeletions(10)).toEqual([]);
  });
});
