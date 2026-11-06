/**
 * Admin console (migration …015): who may call what, the guardrails, and the
 * effects of each control. See docs/ADMIN.md.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONFIG_FIELDS } from '../src/index.ts';
import { TestDb, anon, service, user } from '../src/testing/index.ts';
import { TIER, applyScores, createActiveRater, createNoteWriter, createPost, ledgerTotal, proposeNote, rate } from './helpers.ts';

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

async function createAdmin(options: { username?: string; email?: string } = {}): Promise<string> {
  const id = await db.createUser({ karma: TIER.contributor, ...options });
  await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [id]);
  return id;
}

async function createModerator(zone = 'on'): Promise<string> {
  const id = await db.createUser({ karma: TIER.contributor });
  await db.sql(`insert into public.zone_moderators (zone_id, user_id) values ($1, $2)`, [zone, id]);
  return id;
}

async function lastLog(action: string): Promise<Record<string, unknown>> {
  return db.sqlOne(`select * from public.mod_actions where action = $1 order by created_at desc limit 1`, [action]);
}

describe('access', () => {
  const READS = [
    `select public.admin_overview()`,
    `select public.admin_metrics(7)`,
    `select public.admin_people(null, 'all', 'newest', 0)`,
    `select public.admin_member('access_target')`,
    `select public.admin_content('post', null, null, null, 0)`,
    `select public.admin_mod_log(null, null, null, null, null)`,
    `select public.admin_team()`,
    `select public.admin_notes_health()`,
    `select public.admin_config()`,
    `select public.admin_config_history('notes.min_ratings')`,
    `select public.admin_system_status()`,
    `select public.admin_shield()`,
    `select public.admin_shield_test('hello')`,
    `select public.admin_member_reports()`,
    `select public.admin_tickets('open', null)`,
    `select public.admin_ticket(gen_random_uuid())`,
    `select public.mod_queue(null)`,
    `select public.open_appeals(null)`,
  ];
  const WRITES = [
    `select public.admin_set_role(gen_random_uuid(), true, 'promote')`,
    `select public.admin_restore_content('post', gen_random_uuid(), 'restore')`,
    `select public.admin_rename_user(gen_random_uuid(), 'new_name', 'rename')`,
    `select public.admin_revoke_strike(gen_random_uuid(), 'mistake')`,
    `select public.admin_clear_writing_lock(gen_random_uuid(), 'unlock')`,
    `select public.admin_end_founding(gen_random_uuid(), 'ended')`,
    `select public.admin_reveal_email(gen_random_uuid(), 'support')`,
    `select public.admin_find_by_email('someone@example.test')`,
    `select public.admin_set_note_hidden(gen_random_uuid(), true, 'doxxing')`,
    `select public.admin_set_pinned(gen_random_uuid(), true, 'read first')`,
    `select public.admin_set_comments_locked(gen_random_uuid(), true, 'heated')`,
    `select public.admin_upsert_category('new-cat', 'New', 'Nouveau', 'book', '', '', '{}', '{}', null, 0::smallint, 'new')`,
    `select public.admin_archive_category('basics', true, 'old')`,
    `select public.admin_upsert_city('new-city', 'on', 'Newtown', 0::smallint, 'new')`,
    `select public.admin_update_zone('on', 'Ontario', 'Ontario', 'ON', '', '', 'copy')`,
    `select public.admin_shield_add('domain', 'vendor.example', null, 'vendor')`,
    `select public.admin_shield_remove('domain', 'vendor.example', 'mistake')`,
    `select public.admin_set_config('notes.min_ratings', '6', 'more ratings')`,
    `select public.admin_resolve_member_reports(gen_random_uuid(), 'dismissed', 'checked')`,
    `select public.admin_reply_ticket(gen_random_uuid(), 'Thanks for writing in.')`,
    `select public.admin_set_ticket_closed(gen_random_uuid(), true)`,
  ];

  it('members and moderators are refused; admins need an MFA session', async () => {
    await db.createUser({ username: 'access_target' });
    const member = await db.createUser();
    const mod = await createModerator();
    const admin = await createAdmin();

    for (const sql of [...READS, ...WRITES]) {
      expect((await db.expectError(anon, sql)).code, `anon: ${sql}`).toMatch(/^(42501|PF401)$/);
      expect((await db.expectError(user(member, 'aal2'), sql)).message, `member: ${sql}`).toBe('not_admin');
      expect((await db.expectError(user(mod, 'aal2'), sql)).message, `moderator: ${sql}`).toBe('not_admin');
      expect((await db.expectError(user(admin, 'aal1'), sql)).code, `admin aal1: ${sql}`).toBe('PF428');
    }
    for (const sql of READS) {
      await expect(db.as(user(admin, 'aal2'), sql), sql).resolves.toBeDefined();
    }
  });

  it('the security self-audit stays clean and is visible to admins', async () => {
    const admin = await createAdmin();
    const { s } = await db.asOne<{ s: { security_audit: unknown[] } }>(user(admin, 'aal2'), `select public.admin_system_status() as s`);
    expect(s.security_audit).toEqual([]);
  });
});

describe('roles', () => {
  it('the owner grants and revokes admin, never their own, and it is logged', async () => {
    const a = await createAdmin();
    await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'owner')`, [a]);
    const b = await db.createUser();
    await db.as(user(a, 'aal2'), `select public.admin_set_role($1, true, 'Second admin for coverage')`, [b]);
    expect(await lastLog('grant_admin')).toMatchObject({ actor_id: a, target_user_id: b });

    expect((await db.expectError(user(a, 'aal2'), `select public.admin_set_role($1, false, 'Leaving')`, [a])).message).toBe('conflict_of_interest');
    await db.as(user(a, 'aal2'), `select public.admin_set_role($1, false, 'Rotation')`, [b]);
    const { n } = await db.sqlOne<{ n: number }>(`select count(*)::int as n from public.user_roles where user_id = $1`, [b]);
    expect(n).toBe(0);
    await db.sql(`delete from public.user_roles where role = 'owner'`);
  });

  it('requires a reason', async () => {
    const a = await createAdmin();
    const b = await db.createUser();
    expect((await db.expectError(user(a, 'aal2'), `select public.admin_set_role($1, true, ' ')`, [b])).message).toBe('reason_required');
  });

  it('ends a founding grant and renames an offensive username', async () => {
    const a = await createAdmin();
    const m = await db.createUser({ username: 'bad_name_1' });
    await db.as(user(a, 'aal2'), `select public.grant_founding_rater($1, now() + interval '30 days', 'Launch')`, [m]);
    await db.as(user(a, 'aal2'), `select public.admin_end_founding($1, 'Inactive')`, [m]);
    const { status } = await db.sqlOne<{ status: string }>(
      `select private.effective_rater_status(p) as status from public.profiles p where id = $1`, [m]);
    expect(status).not.toBe('founding');

    await db.as(user(a, 'aal2'), `select public.admin_rename_user($1, 'renamed_member', 'Slur in username')`, [m]);
    expect((await db.profile(m)).username).toBe('renamed_member');
    expect(await lastLog('rename_user')).toMatchObject({ metadata: { from: 'bad_name_1', to: 'renamed_member' } });
    expect((await db.expectError(user(a, 'aal2'), `select public.admin_rename_user($1, 'admin_fake', 'x x x')`, [m])).message).toBe('reserved_username');
  });

  it('removes a mistaken strike, restoring integrity', async () => {
    const a = await createAdmin();
    const mod = await createModerator();
    const m = await db.createUser({ karma: TIER.member });
    await db.as(user(mod, 'aal2'), `select public.apply_sanction($1, 'freeze', 'Wrong member', 3)`, [m]);
    expect(await db.integrity(m)).toBeLessThan(100);
    const { id } = await db.sqlOne<{ id: string }>(`select id from public.strikes where user_id = $1`, [m]);
    await db.as(user(a, 'aal2'), `select public.admin_revoke_strike($1, 'Applied to the wrong member')`, [id]);
    expect(await db.integrity(m)).toBe(100);
  });
});

describe('restore', () => {
  it('reverses a removal like an upheld appeal and closes the open appeal', async () => {
    const a = await createAdmin();
    const mod = await createModerator();
    const author = await db.createUser({ karma: TIER.member });
    const reporter = await db.createUser({ ageDays: 60 });
    const post = await createPost(db, author);
    await db.as(user(reporter), `select public.file_report('post', $1, 'spam')`, [post]);
    await db.as(user(mod, 'aal2'), `select public.resolve_reports('post', $1, 'remove', 'spam', 'Looks like spam')`, [post]);
    expect(await ledgerTotal(db, author, 'karma', 'mod_removal')).toBe(-25);
    expect(await ledgerTotal(db, reporter, 'mod_xp')).toBe(3);

    const { id: action } = await db.sqlOne<{ id: string }>(`select id from public.mod_actions where action = 'remove' and target_id = $1`, [post]);
    await db.as(user(author), `select public.submit_appeal($1, 'This was a genuine question, not spam.')`, [action]);

    await db.as(user(a, 'aal2'), `select public.admin_restore_content('post', $1, 'Not spam; restored')`, [post]);
    const { status } = await db.sqlOne<{ status: string }>(`select status from public.posts where id = $1`, [post]);
    expect(status).toBe('visible');
    expect(await ledgerTotal(db, author, 'karma', 'mod_removal') + await ledgerTotal(db, author, 'karma', 'admin_reversal')).toBe(0);
    expect(await ledgerTotal(db, reporter, 'mod_xp')).toBe(0);
    expect(await db.integrity(author)).toBe(100);
    const { status: appeal } = await db.sqlOne<{ status: string }>(`select status from public.appeals where mod_action_id = $1`, [action]);
    expect(appeal).toBe('upheld');
    expect(await lastLog('restore')).toMatchObject({ actor_id: a, target_id: post });
  });

  it('only restores removed content', async () => {
    const a = await createAdmin();
    const post = await createPost(db, await db.createUser({ karma: TIER.member }));
    expect((await db.expectError(user(a, 'aal2'), `select public.admin_restore_content('post', $1, 'restore')`, [post])).message).toBe('not_removed');
  });
});

describe('notes', () => {
  it('hiding an open Helpful note closes it with no payouts and no strike, and hides it everywhere', async () => {
    const a = await createAdmin();
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    const writer = await createNoteWriter(db);
    const note = await proposeNote(db, writer, post, 'misleading');
    for (let i = 0; i < 5; i++) await rate(db, await createActiveRater(db), note, 'helpful');
    await applyScores(db, [{ note_id: note, status: 'helpful' }]);

    await db.as(user(a, 'aal2'), `select public.admin_set_note_hidden($1, true, 'Note includes a personal phone number')`, [note]);
    const row = await db.sqlOne(`select status, locked_status, hidden_at is not null as hidden from public.notes where id = $1`, [note]);
    expect(row).toMatchObject({ status: 'needs_more_ratings', locked_status: 'needs_more_ratings', hidden: true });
    expect(await ledgerTotal(db, writer, 'mod_xp', 'note_written')).toBe(0);
    expect(await db.integrity(author)).toBe(100);

    const { notes } = await db.asOne<{ notes: unknown[] }>(user(author), `select public.get_post_notes($1) as notes`, [post]);
    expect(notes).toEqual([]);
    const [feed] = await db.as<{ has_helpful_note: boolean }>(anon, `select has_helpful_note from public.get_feed() where id = $1`, [post]);
    expect(feed?.has_helpful_note).toBe(false);
    expect(await lastLog('hide_note')).toMatchObject({ actor_id: a, target_id: note, target_user_id: writer });

    await db.as(user(a, 'aal2'), `select public.admin_set_note_hidden($1, false, 'Phone number was public info')`, [note]);
    const { notes: after } = await db.asOne<{ notes: unknown[] }>(user(author), `select public.get_post_notes($1) as notes`, [post]);
    expect(after).toHaveLength(1);
  });
});

describe('pins and comment locks', () => {
  it('pins lead their zone feed, two per zone', async () => {
    const a = await createAdmin();
    const author = await db.createUser({ karma: TIER.member });
    const posts = [];
    for (let i = 0; i < 3; i++) posts.push(await createPost(db, author, { zone: 'bc', title: `Pinned candidate number ${i}` }));
    await db.as(user(a, 'aal2'), `select public.admin_set_pinned($1, true, 'Read first')`, [posts[0]]);
    await db.as(user(a, 'aal2'), `select public.admin_set_pinned($1, true, 'Read first')`, [posts[1]]);
    expect((await db.expectError(user(a, 'aal2'), `select public.admin_set_pinned($1, true, 'Third')`, [posts[2]])).message).toBe('pin_limit');

    const feed = await db.as<{ id: string; pinned: boolean }>(anon, `select id, pinned from public.get_feed('bc', null, null, null, 'new')`);
    expect(feed.slice(0, 2).every((row) => row.pinned)).toBe(true);
    expect(new Set(feed.slice(0, 2).map((row) => row.id))).toEqual(new Set([posts[0], posts[1]]));
  });

  it('locked posts refuse new comments until unlocked', async () => {
    const a = await createAdmin();
    const post = await createPost(db, await db.createUser({ karma: TIER.member }));
    const member = await db.createUser();
    await db.as(user(a, 'aal2'), `select public.admin_set_comments_locked($1, true, 'Thread went off the rails')`, [post]);
    const error = await db.expectError(user(member), `select public.create_comment($1, 'One more thing')`, [post]);
    expect(error).toMatchObject({ code: 'PF403', message: 'comments_locked' });
    const [row] = await db.as<{ comments_locked: boolean }>(anon, `select comments_locked from public.get_post($1)`, [post]);
    expect(row?.comments_locked).toBe(true);
    await db.as(user(a, 'aal2'), `select public.admin_set_comments_locked($1, false, 'Calmer now')`, [post]);
    await expect(db.as(user(member), `select public.create_comment($1, 'One more thing')`, [post])).resolves.toBeDefined();
  });
});

describe('settings', () => {
  it('checks ranges and shapes, and keeps a history with reasons', async () => {
    const a = await createAdmin();
    const set = (key: string, value: unknown) =>
      db.expectError(user(a, 'aal2'), `select public.admin_set_config($1, $2::jsonb, 'Tuning')`, [key, JSON.stringify(value)]);

    expect((await set('notes.min_ratings', 1)).message).toBe('config_out_of_range');
    expect((await set('tiers.thresholds', [0, 100, 50, 3000, 10000])).message).toBe('config_out_of_range');
    expect((await set('tiers.thresholds', [0, 100, 1000])).message).toBe('config_out_of_range');
    expect((await set('rate_limit.vote', { limit: 10 })).message).toBe('config_out_of_range');
    expect((await set('scoring.mode', 'magic')).message).toBe('config_out_of_range');
    expect((await set('site.announcement', { en: 'x', fr: 'x', tone: 'loud', until: null })).message).toBe('config_out_of_range');

    await db.as(user(a, 'aal2'), `select public.admin_set_config('notes.min_ratings', '7', 'Ratings are plentiful now')`);
    await db.as(user(a, 'aal2'), `select public.admin_set_config('site.announcement', $1::jsonb, 'Maintenance tonight')`,
      [JSON.stringify({ en: 'Maintenance tonight', fr: 'Maintenance ce soir', tone: 'warn', until: '2026-12-01' })]);
    const { h } = await db.asOne<{ h: Array<{ old: unknown; new: unknown; reason: string }> }>(
      user(a, 'aal2'), `select public.admin_config_history('notes.min_ratings') as h`);
    expect(h[0]).toMatchObject({ old: 5, new: 7, reason: 'Ratings are plentiful now' });
  });

  it('every setting has a console field, and every current value is within its bounds', async () => {
    const rows = await db.sql<{ key: string; value: unknown; bounds: { min: number; max: number } | null }>(
      `select key, value, bounds from public.app_config`);
    expect(rows.map((r) => r.key).sort()).toEqual(CONFIG_FIELDS.map((field) => field.key).sort());
    for (const row of rows) {
      if (row.bounds && typeof row.value === 'number') {
        expect(row.value, row.key).toBeGreaterThanOrEqual(row.bounds.min);
        expect(row.value, row.key).toBeLessThanOrEqual(row.bounds.max);
      }
    }
  });
});

describe('people and privacy', () => {
  it('shows a masked email; the real one only through logged lookups', async () => {
    const a = await createAdmin();
    const m = await db.createUser({ username: 'private_person', email: 'private.person@example.test' });
    const { p } = await db.asOne<{ p: { account: { email_masked: string } } }>(user(a, 'aal2'), `select public.admin_member('private_person') as p`);
    expect(p.account.email_masked).toBe('p•••@example.test');
    expect(JSON.stringify(p)).not.toContain('private.person@');

    const { e } = await db.asOne<{ e: string }>(user(a, 'aal2'), `select public.admin_reveal_email($1, 'Privacy request #12') as e`, [m]);
    expect(e).toBe('private.person@example.test');
    expect(await lastLog('reveal_email')).toMatchObject({ actor_id: a, target_user_id: m, reason: 'Privacy request #12' });

    const { u } = await db.asOne<{ u: string }>(user(a, 'aal2'), `select public.admin_find_by_email('Private.Person@example.test') as u`);
    expect(u).toBe('private_person');
    expect(await lastLog('lookup_email')).toMatchObject({ actor_id: a, target_user_id: m, metadata: { matched: true } });
    const { u: none } = await db.asOne<{ u: string | null }>(user(a, 'aal2'), `select public.admin_find_by_email('nobody@example.test') as u`);
    expect(none).toBeNull();
    const log = JSON.stringify(await db.sql(`select * from public.mod_actions where action = 'lookup_email'`));
    expect(log).not.toContain('nobody@example.test');
  });

  it('filters and searches members (wildcards are literal)', async () => {
    const a = await createAdmin();
    await db.createUser({ username: 'search_alpha' });
    await db.createUser({ username: 'searchxbeta' });
    await db.createUser({ provider: 'google', providerMetadata: { full_name: 'G User' } });
    const { r } = await db.asOne<{ r: { rows: Array<{ username: string }> } }>(user(a, 'aal2'), `select public.admin_people('search_', 'all', 'newest', 0) as r`);
    expect(r.rows.map((x) => x.username)).toEqual(['search_alpha']);
    const { r: onboarding } = await db.asOne<{ r: { rows: Array<{ needs_onboarding: boolean }> } }>(
      user(a, 'aal2'), `select public.admin_people(null, 'onboarding', 'newest', 0) as r`);
    expect(onboarding.rows.length).toBeGreaterThan(0);
    expect(onboarding.rows.every((x) => x.needs_onboarding)).toBe(true);
  });

  it('moderators can leave staff notes; members cannot', async () => {
    const a = await createAdmin();
    const mod = await createModerator();
    const m = await db.createUser({ username: 'noted_member' });
    await db.as(user(mod, 'aal2'), `select public.add_staff_note($1, 'watch', 'Asked twice about sources in DMs')`, [m]);
    expect((await db.expectError(user(await db.createUser(), 'aal2'), `select public.add_staff_note($1, 'note', 'Hello there')`, [m])).message).toBe('not_moderator');
    const { p } = await db.asOne<{ p: { staff_notes: Array<{ label: string; body: string }> } }>(user(a, 'aal2'), `select public.admin_member('noted_member') as p`);
    expect(p.staff_notes[0]).toMatchObject({ label: 'watch', body: 'Asked twice about sources in DMs' });
    expect((await db.expectError(user(m), `select * from public.staff_notes`)).code).toBe('42501');
  });

  it('the mod log names who acted (admins only)', async () => {
    const a = await createAdmin();
    const mod = await createModerator();
    const target = await db.createUser();
    await db.as(user(mod, 'aal2'), `select public.apply_sanction($1, 'warning', 'Please label personal experience')`, [target]);
    const { log } = await db.asOne<{ log: Array<{ action: string; actor: string }> }>(user(a, 'aal2'), `select public.admin_mod_log('sanction', null, null, null, null) as log`);
    const { username } = await db.profile(mod) as { username: string };
    expect(log[0]).toMatchObject({ action: 'sanction', actor: username });
  });
});

describe('taxonomy', () => {
  it('creates, edits and archives categories and cities', async () => {
    const a = await createAdmin();
    await db.as(user(a, 'aal2'), `select public.admin_upsert_category('sleep', 'Sleep', 'Sommeil', 'moon', 'Sleep research', 'Recherche', '{"Cite sources"}', '{"Citez vos sources"}', null, 9::smallint, 'New topic')`);
    await db.as(user(a, 'aal2'), `select public.admin_upsert_category('sleep', 'Sleep & rest', 'Sommeil', 'moon', '', '', '{}', '{}', 7::smallint, 9::smallint, 'Rename')`);
    expect(await db.sqlOne(`select name_en, min_note_ratings from public.categories where id = 'sleep'`)).toEqual({ name_en: 'Sleep & rest', min_note_ratings: 7 });
    await db.as(user(a, 'aal2'), `select public.admin_archive_category('sleep', true, 'Merged into recovery')`);
    const author = await db.createUser({ karma: TIER.member });
    expect((await db.expectError(user(author), `select public.create_post('on', 'sleep', 'claim', 'A sufficiently descriptive title', 'Body')`)).message).toBe('invalid_category');

    await db.as(user(a, 'aal2'), `select public.admin_upsert_city('kingston', 'on', 'Kingston', 5::smallint, 'New city')`);
    expect((await db.expectError(user(a, 'aal2'), `select public.admin_upsert_city('Bad Id', 'on', 'X', 0::smallint, 'x x x')`)).message).toBe('invalid_id');
    expect((await lastLog('taxonomy_change')).metadata).toMatchObject({ kind: 'city', id: 'kingston' });
  });
});

describe('dashboards', () => {
  it('metrics come back as aligned daily series', async () => {
    const a = await createAdmin();
    await createPost(db, await db.createUser({ karma: TIER.member }));
    const { m } = await db.asOne<{ m: { days: string[]; series: Record<string, number[]>; totals: Record<string, { current: number }> } }>(
      user(a, 'aal2'), `select public.admin_metrics(30) as m`);
    expect(m.days).toHaveLength(30);
    for (const series of Object.values(m.series)) expect(series).toHaveLength(30);
    expect(m.totals.posts?.current).toBeGreaterThan(0);
    expect(m.totals.active?.current).toBeGreaterThan(0);
    expect((await db.expectError(user(a, 'aal2'), `select public.admin_metrics(12)`)).message).toBe('invalid_range');
  });

  it('the worker heartbeat is service-only and shows on the system page', async () => {
    const a = await createAdmin();
    expect((await db.expectError(user(a, 'aal2'), `select public.record_job_run('maintenance', now(), true)`)).code).toBe('42501');
    await db.as(service, `select public.record_job_run('maintenance', now() - interval '2 seconds', true, '{"uncollapsed": 1}')`);
    const { s } = await db.asOne<{ s: { jobs: Array<{ job: string; ok: boolean }> } }>(user(a, 'aal2'), `select public.admin_system_status() as s`);
    expect(s.jobs).toContainEqual(expect.objectContaining({ job: 'maintenance', ok: true }));
    const { o } = await db.asOne<{ o: { jobs: Record<string, { ok: boolean }> } }>(user(a, 'aal2'), `select public.admin_overview() as o`);
    expect(o.jobs.maintenance?.ok).toBe(true);
  });

  it('staff without two-factor sign-in are flagged', async () => {
    const a = await createAdmin();
    await createModerator('qc');
    await db.sql(`insert into auth.mfa_factors (user_id, status) values ($1, 'verified')`, [a]);
    const { s } = await db.asOne<{ s: { staff_without_mfa: string[] } }>(user(a, 'aal2'), `select public.admin_system_status() as s`);
    const { username } = await db.profile(a) as { username: string };
    expect(s.staff_without_mfa.length).toBeGreaterThan(0);
    expect(s.staff_without_mfa).not.toContain(username);
  });

  it('the public transparency report has aggregates only', async () => {
    const mod = await createModerator();
    const author = await db.createUser({ username: 'transparent_author', karma: TIER.member });
    const post = await createPost(db, author);
    await db.as(user(mod, 'aal2'), `select public.moderate_remove('post', $1, 'spam', 'Spam')`, [post]);
    const { t } = await db.asOne<{ t: { removals: Record<string, number>; months: string[] } }>(anon, `select public.transparency_stats(null) as t`);
    expect(t.removals.spam).toBeGreaterThan(0);
    expect(t.months.length).toBeGreaterThan(0);
    const json = JSON.stringify(t);
    expect(json).not.toContain('transparent_author');
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
