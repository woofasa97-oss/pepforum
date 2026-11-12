/**
 * Community reports, moderator actions, sanctions, appeals and admin controls.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, service, user } from '../src/testing/index.ts';
import { TIER, createPost, ledgerTotal } from './helpers.ts';

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

async function report(reporter: string, postId: string, reason = 'sourcing') {
  return db.asOne<{ r: { collapsed: boolean } }>(user(reporter), `select public.file_report('post', $1, $2, '') as r`, [postId, reason]);
}

async function createModerator(): Promise<string> {
  const id = await db.createUser({ karma: TIER.contributor });
  await db.sql(`insert into public.moderators (user_id) values ($1)`, [id]);
  return id;
}

async function postStatus(id: string): Promise<string> {
  return (await db.sqlOne<{ status: string }>(`select status from public.posts where id = $1`, [id])).status;
}

describe('community reports', () => {
  it('collapse content only when enough established reporters agree', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);

    expect((await report(await db.createUser({ ageDays: 60 }), post)).r.collapsed).toBe(false);
    expect((await report(await db.createUser({ ageDays: 60 }), post)).r.collapsed).toBe(false);
    // A fresh account's report is recorded but does not count toward collapse.
    expect((await report(await db.createUser({ ageDays: 3 }), post)).r.collapsed).toBe(false);
    expect(await postStatus(post)).toBe('visible');

    expect((await report(await db.createUser({ ageDays: 60 }), post)).r.collapsed).toBe(true);
    expect(await postStatus(post)).toBe('collapsed');
    const log = await db.sql(`select action, actor_id from public.mod_actions where target_id = $1`, [post]);
    expect(log).toEqual([{ action: 'auto_collapse', actor_id: null }]);
  });

  it('established authors (Trusted+) can only be collapsed with a Steward among the reporters', async () => {
    const author = await db.createUser({ karma: TIER.trusted });
    const post = await createPost(db, author);
    for (let i = 0; i < 4; i++) await report(await db.createUser({ ageDays: 60 }), post);
    expect(await postStatus(post)).toBe('visible');

    const steward = await db.createUser({ ageDays: 400, karma: TIER.steward });
    await db.sql(`select private.reconcile('test_xp', $1, 'mod_xp', 'test', 'test', null, 200)`, [steward]);
    expect((await report(steward, post)).r.collapsed).toBe(true);
  });

  it('members cannot report their own content or report twice', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    expect((await db.expectError(user(author), `select public.file_report('post', $1, 'spam')`, [post])).message).toBe('own_content');
    const reporter = await db.createUser();
    await report(reporter, post);
    expect((await db.expectError(user(reporter), `select public.file_report('post', $1, 'spam')`, [post])).message).toBe('already_reported');
  });

  it('un-reviewed collapses revert after the review window', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    for (let i = 0; i < 3; i++) await report(await db.createUser({ ageDays: 60 }), post);
    expect(await postStatus(post)).toBe('collapsed');

    await db.sql(`update public.posts set status_changed_at = now() - interval '49 hours' where id = $1`, [post]);
    await db.as(service, `select public.run_maintenance()`);
    expect(await postStatus(post)).toBe('visible');
  });
});

describe('moderator decisions', () => {
  it('require a moderator (site-wide, …034) with an MFA session', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    const mod = await createModerator();
    const member = await db.createUser();
    const call = `select public.resolve_reports('post', $1, 'keep')`;

    expect((await db.expectError(user(mod, 'aal1'), call, [post])).code).toBe('PF428');
    expect((await db.expectError(user(member, 'aal2'), call, [post])).code).toBe('PF403');
    await db.as(user(mod, 'aal2'), call, [post]);
  });

  it('removal penalises the author (karma, strike, freeze) and rewards the reporters', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    const reporters = [await db.createUser({ ageDays: 60 }), await db.createUser({ ageDays: 60 })];
    for (const r of reporters) await report(r, post, 'medical_advice');
    const mod = await createModerator();

    await db.as(user(mod, 'aal2'), `select public.resolve_reports('post', $1, 'remove', 'medical_advice', 'dosing instructions')`, [post]);

    expect(await postStatus(post)).toBe('removed');
    expect(await ledgerTotal(db, author, 'karma', 'mod_removal')).toBe(-25);
    expect(await db.integrity(author)).toBe(85);
    const capability = await db.expectError(user(author), `select public.create_post('basics', 'claim', 'Another title right here', 'x')`);
    expect(capability.detail).toBe('post_text:frozen');
    for (const r of reporters) expect(await ledgerTotal(db, r, 'mod_xp', 'report_upheld')).toBe(3);
  });

  it('sourcing is the hard line: -100 karma', async () => {
    const author = await db.createUser({ karma: TIER.trusted });
    const post = await createPost(db, author);
    const mod = await createModerator();
    await db.as(user(mod, 'aal2'), `select public.moderate_remove('post', $1, 'sourcing', 'DM-for-source offer')`, [post]);
    expect(await ledgerTotal(db, author, 'karma', 'mod_removal')).toBe(-100);
    expect(await db.integrity(author)).toBe(60);
  });

  it('keeping content dismisses reports at no cost, except reports marked abusive', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    const honest = await db.createUser({ ageDays: 60 });
    const abusive = await db.createUser({ ageDays: 60 });
    await report(honest, post, 'misinformation');
    await report(abusive, post, 'harassment');
    const { id: abusiveReport } = await db.sqlOne<{ id: string }>(`select id from public.reports where reporter_id = $1`, [abusive]);
    const mod = await createModerator();

    await db.as(user(mod, 'aal2'), `select public.resolve_reports('post', $1, 'keep', null, 'disagreement is allowed', array[$2]::uuid[])`, [post, abusiveReport]);
    expect(await ledgerTotal(db, honest, 'mod_xp')).toBe(0);
    expect(await ledgerTotal(db, abusive, 'mod_xp', 'report_abusive')).toBe(-2);
  });

  it('a removal must name its violation (NULL is not a loophole)', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    const mod = await createModerator();
    const error = await db.expectError(user(mod, 'aal2'), `select public.resolve_reports('post', $1, 'remove', null, 'no reason')`, [post]);
    expect(error).toMatchObject({ code: 'PF422', message: 'invalid_violation' });
    expect(await postStatus(post)).toBe('visible');
  });

  it('moderators cannot act on their own content', async () => {
    const mod = await createModerator();
    const post = await createPost(db, mod);
    const error = await db.expectError(user(mod, 'aal2'), `select public.moderate_remove('post', $1, 'spam', 'x')`, [post]);
    expect(error.message).toBe('conflict_of_interest');
  });
});

describe('appeals', () => {
  it('are decided by a different moderator, and an upheld appeal reverses every effect', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    const actingMod = await createModerator();
    const reviewer = await createModerator();
    const karmaBefore = (await db.profile(author)).karma;

    await db.as(user(actingMod, 'aal2'), `select public.moderate_remove('post', $1, 'spam', 'looked like spam')`, [post]);
    const { id: actionId } = await db.sqlOne<{ id: string }>(`select id from public.mod_actions where target_id = $1 and action = 'remove'`, [post]);
    const { id: appealId } = await db.asOne<{ id: string }>(user(author),
      `select public.submit_appeal($1, 'This was a genuine question about my own bloodwork.') as id`, [actionId]);

    expect((await db.expectError(user(actingMod, 'aal2'), `select public.decide_appeal($1, true, 'x')`, [appealId])).message)
      .toBe('conflict_of_interest');

    await db.as(user(reviewer, 'aal2'), `select public.decide_appeal($1, true, 'Not spam.')`, [appealId]);

    expect(await postStatus(post)).toBe('visible');
    expect((await db.profile(author)).karma).toBe(karmaBefore);
    expect(await db.integrity(author)).toBe(100);
    await expect(createPost(db, author, { title: 'Posting again after a successful appeal' })).resolves.toBeTruthy();
    // The reversal is itself on the record.
    const removalLedger = await db.sql(`select delta::int from public.ledger_events where event_key = $1 order by id`, [`removal:${post}`]);
    expect(removalLedger).toEqual([{ delta: -25 }, { delta: 25 }]);
  });
});

describe('sanctions and admin', () => {
  it('moderators can freeze but only admins can suspend or ban', async () => {
    const target = await db.createUser({ karma: TIER.member });
    const mod = await createModerator();
    await db.as(user(mod, 'aal2'), `select public.apply_sanction($1, 'freeze', 'Repeated dosing advice', 7)`, [target]);
    expect((await db.expectError(user(mod, 'aal2'), `select public.apply_sanction($1, 'ban', 'Vendor account')`, [target])).message).toBe('not_admin');

    const admin = await db.createUser();
    await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [admin]);
    await db.as(user(admin, 'aal2'), `select public.apply_sanction($1, 'suspension', 'Ban evasion', 30)`, [target]);
    expect((await db.expectError(user(target), `select public.cast_vote('post', gen_random_uuid(), 1::smallint)`)).detail).toBe('vote:sanctioned');
  });

  it('config changes need an admin with MFA, keep their type, and are logged', async () => {
    const admin = await db.createUser();
    await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [admin]);
    const mod = await createModerator();

    expect((await db.expectError(user(mod, 'aal2'), `select public.admin_set_config('notes.min_ratings', '8', 'tuning')`)).message).toBe('not_admin');
    expect((await db.expectError(user(admin, 'aal2'), `select public.admin_set_config('notes.min_ratings', '"eight"', 'tuning')`)).message).toBe('config_type_mismatch');

    await db.as(user(admin, 'aal2'), `select public.admin_set_config('notes.min_ratings', '8', 'More raters joined; raise the bar')`);
    expect((await db.sqlOne(`select value from public.app_config where key = 'notes.min_ratings'`)).value).toBe(8);
    const history = await db.sql(`select old_value, new_value from public.app_config_history where key = 'notes.min_ratings' order by id desc limit 1`);
    expect(history).toEqual([{ old_value: 5, new_value: 8 }]);
    await db.setConfig('notes.min_ratings', 5);
  });

  it('founding rater grants are admin-only, expiring, and logged', async () => {
    const admin = await db.createUser();
    await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [admin]);
    const clinician = await db.createUser();
    await db.as(user(admin, 'aal2'), `select public.grant_founding_rater($1, now() + interval '120 days', 'Verified RN, launch cohort')`, [clinician]);
    expect((await db.profile(clinician)).rater_status).toBe('founding');
    const log = await db.sql(`select action from public.mod_actions where target_user_id = $1`, [clinician]);
    expect(log).toEqual([{ action: 'grant_founding_rater' }]);
  });
});
