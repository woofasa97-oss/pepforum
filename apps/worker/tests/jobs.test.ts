/**
 * End-to-end: real migrations + the local seed in PGlite, the real jobs, the
 * PGlite-backed store. Proves the worker and the SQL agree on the contract.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, user } from '@pepforum/database/testing';

import { parseScoringInput } from '../src/config.ts';
import { maintenanceJob } from '../src/jobs/maintenance.ts';
import { processDeletionsJob } from '../src/jobs/process-deletions.ts';
import { purgeMediaJob } from '../src/jobs/purge-media.ts';
import { type PushSender, pushJob, pushPayload } from '../src/jobs/push.ts';
import { scoreNotesJob } from '../src/jobs/score-notes.ts';
import { settleAdsJob } from '../src/jobs/settle-ads.ts';
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

describe('push delivery (…022)', () => {
  const KEY = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';

  it('sends one payload per registered browser and drops dead endpoints', async () => {
    const author = await db.createUser({ username: 'push_author', karma: 100 });
    const replier = await db.createUser({ username: 'push_replier' });
    await db.as(user(author), `select public.save_push_subscription('https://push.example.test/ok', $1, 'tBHItJI5svbpez7KI4CCXg', 'Firefox')`, [KEY]);
    await db.as(user(author), `select public.save_push_subscription('https://push.example.test/gone', $1, 'tBHItJI5svbpez7KI4CCXg', 'Old phone')`, [KEY]);
    const { id: post } = await db.asOne<{ id: string }>(user(author), `select public.create_post('basics', 'question', 'Does anyone push?', 'Testing push delivery.', null) as id`);
    await db.as(user(replier), `select public.create_comment($1, 'Yes.')`, [post]);

    const sent: Array<{ endpoint: string; payload: string }> = [];
    const sender: PushSender = {
      async send(subscription, payload) {
        sent.push({ endpoint: subscription.endpoint, payload });
        if (subscription.endpoint.endsWith('/gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
      },
    };
    const report = await pushJob(store, silentLogger, sender, { batchSize: 100, siteUrl: 'https://pepforum.test' });
    expect(report).toMatchObject({ sent: 1, failed: 1, dropped: 1 });
    expect(sent.map((s) => s.endpoint).sort()).toEqual(['https://push.example.test/gone', 'https://push.example.test/ok']);
    const payload = JSON.parse(sent[0]?.payload ?? '{}') as { title: string; url: string; body: string };
    expect(payload.title).toBe('New comment on your post');
    expect(payload.url).toMatch(/^https:\/\/pepforum\.test\/post\//);
    expect(payload.body).toBe('Does anyone push?');

    // Nothing left to push; the dead browser is gone.
    expect(await store.pendingPush(100)).toEqual([]);
    expect(await db.sql(`select 1 from public.push_subscriptions where endpoint like '%/gone'`)).toEqual([]);
  });

  it('words the payload in the member’s language', () => {
    const item = { id: 'x', kind: 'team_reply' as const, locale: 'fr' as const, post_title: null, url: '/contact/abc', subscriptions: [] };
    expect(JSON.parse(pushPayload(item, 'https://pepforum.test'))).toMatchObject({ title: 'L’équipe Pepforums a répondu', url: 'https://pepforum.test/contact/abc' });
  });
});

describe('media purge and ad settlement (…023, …025)', () => {
  it('deletes removed uploads from storage, then marks them purged', async () => {
    const owner = await db.createUser({ karma: 1000 });
    const { r } = await db.asOne<{ r: { id: string; path: string } }>(user(owner), `select public.register_upload('post_image', 'image/png', 1000) as r`);
    await db.as(user(owner), `select public.confirm_upload($1)`, [r.id]);
    await db.as(user(owner), `select public.delete_my_media($1)`, [r.id]);
    const report = await purgeMediaJob(store, silentLogger);
    expect(report.purged).toBeGreaterThanOrEqual(1);
    expect(store.deletedObjects).toContain(r.path);
    expect((await db.sqlOne<{ purged: boolean }>(`select purged_at is not null as purged from public.media where id = $1`, [r.id])).purged).toBe(true);
  });

  it('settles ads idempotently', async () => {
    const first = await settleAdsJob(store, silentLogger);
    expect(first).toMatchObject({ days_settled: 0, completed: 0 });
    expect(await settleAdsJob(store, silentLogger)).toMatchObject({ days_settled: 0 });
  });
});
