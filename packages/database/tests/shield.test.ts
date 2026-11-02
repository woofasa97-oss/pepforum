/**
 * Sourcing shield and the all-zones queue (migration …016).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, user } from '../src/testing/index.ts';
import { TIER, createNoteWriter, createPost, proposeNote } from './helpers.ts';

let db: TestDb;
let admin: string;

beforeAll(async () => {
  db = await TestDb.create();
  admin = await db.createUser({ karma: TIER.contributor });
  await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [admin]);
});

afterAll(async () => {
  await db.close();
});

async function createModerator(zone = 'on'): Promise<string> {
  const id = await db.createUser({ karma: TIER.contributor });
  await db.sql(`insert into public.zone_moderators (zone_id, user_id) values ($1, $2)`, [zone, id]);
  return id;
}

const status = async (table: 'posts' | 'comments', id: string) =>
  (await db.sqlOne<{ status: string }>(`select status from public.${table} where id = $1`, [id])).status;

describe('hold', () => {
  it('holds a post with a watched phrase until a moderator keeps it', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author, { body: 'Great results. DM me for details.' });
    expect(await status('posts', post)).toBe('held');

    expect(await db.as(anon, `select id from public.get_feed() where id = $1`, [post])).toEqual([]);
    expect(await db.as(user(await db.createUser()), `select id from public.get_post($1)`, [post])).toEqual([]);
    expect(await db.as(user(author), `select id from public.get_post($1)`, [post])).toHaveLength(1);

    const mod = await createModerator();
    const { q } = await db.asOne<{ q: Array<{ target_id: string; held_reason: string; report_count: number }> }>(
      user(mod, 'aal2'), `select public.mod_queue('on') as q`);
    expect(q.find((item) => item.target_id === post)).toMatchObject({ held_reason: 'dm me', report_count: 0 });

    await db.as(user(mod, 'aal2'), `select public.resolve_reports('post', $1, 'keep', null, 'Asking about clinic hours, fine')`, [post]);
    expect(await status('posts', post)).toBe('visible');
  });

  it('never reopens held content on its own', async () => {
    const post = await createPost(db, await db.createUser({ karma: TIER.member }), { body: 'Message me on Telegram.' });
    await db.sql(`update public.posts set status_changed_at = now() - interval '30 days' where id = $1`, [post]);
    await db.sql(`select public.expire_stale_collapses()`);
    expect(await status('posts', post)).toBe('held');
  });

  it('hides held comments from everyone but the author and moderators', async () => {
    const post = await createPost(db, await db.createUser({ karma: TIER.member }));
    const author = await db.createUser();
    const { id } = await db.asOne<{ id: string }>(user(author), `select public.create_comment($1, 'Use promo code PEP10') as id`, [post]);
    expect(await status('comments', id)).toBe('held');
    expect(await db.as(anon, `select id from public.get_comments($1) where id = $2`, [post, id])).toEqual([]);
    expect(await db.as(user(author), `select id from public.get_comments($1) where id = $2`, [post, id])).toHaveLength(1);
    expect(await db.as(user(await createModerator(), 'aal2'), `select id from public.get_comments($1) where id = $2`, [post, id])).toHaveLength(1);
  });

  it('matches whole words only and records the hold, never the text', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const fine = await createPost(db, author, { body: 'Old telegrams from the 1920s mention insulin trials.' });
    expect(await status('posts', fine)).toBe('visible');
    await createPost(db, author, { body: 'Ping me on WhatsApp!' });
    const hit = await db.sqlOne(`select rule, user_id from public.shield_hits order by id desc limit 1`);
    expect(hit).toEqual({ rule: 'whatsapp', user_id: author });
  });

  it('exempts moderators', async () => {
    const mod = await createModerator();
    const post = await createPost(db, mod, { body: 'Warning: a "telegram" channel is impersonating our moderators.' });
    expect(await status('posts', post)).toBe('visible');
  });
});

describe('block', () => {
  it('rejects posts, comments and note sources that point at a blocked domain', async () => {
    await db.as(user(admin, 'aal2'), `select public.admin_shield_add('domain', 'https://www.Peptide-Shop.example/buy', null, 'Vendor')`);
    const { s } = await db.asOne<{ s: { domains: Array<{ domain: string }> } }>(user(admin, 'aal2'), `select public.admin_shield() as s`);
    expect(s.domains.map((d) => d.domain)).toContain('peptide-shop.example');

    const author = await db.createUser({ karma: TIER.trusted });
    for (const options of [
      { type: 'resource' as const, link: 'https://eu.peptide-shop.example/bpc' },
      { body: 'They sell it at peptide-shop.example, cheap.' },
    ]) {
      const error = await db.expectError(user(author),
        `select public.create_post('on', 'basics', $1, 'A sufficiently descriptive title', $2, $3)`,
        [options.type ?? 'claim', options.body ?? 'Body', options.link ?? null]);
      expect(error).toMatchObject({ code: 'PF422', message: 'blocked_by_shield' });
    }
    expect(await status('posts', await createPost(db, author, { body: 'Not-peptide-shop.examples is unrelated text.' }))).toBe('visible');

    const post = await createPost(db, author);
    const writer = await createNoteWriter(db);
    const error = await db.expectError(user(writer), `select public.propose_note($1, 'missing_context', 'See the vendor page for the claimed purity data.', $2::jsonb)`,
      [post, JSON.stringify([{ url: 'https://peptide-shop.example/coa/1', kind: 'other' }])]);
    expect(error.message).toBe('blocked_by_shield');
    await expect(proposeNote(db, writer, post)).resolves.toBeDefined();
  });

  it('blocks phrases set to block, and the test box records nothing', async () => {
    await db.as(user(admin, 'aal2'), `select public.admin_shield_add('phrase', '  Wickr   ME ', 'block', 'Always sourcing')`);
    const post = await createPost(db, await db.createUser({ karma: TIER.member }));
    const error = await db.expectError(user(await db.createUser()), `select public.create_comment($1, 'wickr me for more')`, [post]);
    expect(error.message).toBe('blocked_by_shield');

    const before = await db.sqlOne<{ n: number }>(`select count(*)::int as n from public.shield_hits`);
    const { m } = await db.asOne<{ m: Array<{ rule: string; action: string }> }>(user(admin, 'aal2'),
      `select public.admin_shield_test('DM me or wickr me') as m`);
    expect(m).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'dm me', action: 'hold' }),
      expect.objectContaining({ rule: 'wickr me', action: 'block' }),
    ]));
    expect(await db.sqlOne(`select count(*)::int as n from public.shield_hits`)).toEqual(before);

    await db.as(user(admin, 'aal2'), `select public.admin_shield_remove('phrase', 'wickr me', 'Too broad')`);
    expect(await db.as(user(await db.createUser()), `select public.create_comment($1, 'wickr me for more')`, [post])).toHaveLength(1);
    expect((await db.sqlOne(`select metadata from public.mod_actions where action = 'shield_rule_removed' order by created_at desc limit 1`)).metadata)
      .toMatchObject({ kind: 'phrase', value: 'wickr me' });
  });
});

describe('admin queue', () => {
  it('lists every zone for admins and includes sanction appeals that belong to no zone', async () => {
    const bc = await createPost(db, await db.createUser({ karma: TIER.member }), { zone: 'bc', body: 'coupon code inside' });
    const qc = await createPost(db, await db.createUser({ karma: TIER.member }), { zone: 'qc', body: 'discount code inside' });
    const { q } = await db.asOne<{ q: Array<{ target_id: string; zone_id: string }> }>(user(admin, 'aal2'), `select public.mod_queue(null) as q`);
    expect(q.map((item) => item.target_id)).toEqual(expect.arrayContaining([bc, qc]));

    const target = await db.createUser();
    const { s } = await db.asOne<{ s: string }>(user(admin, 'aal2'), `select public.apply_sanction($1, 'suspension', 'Ban evasion', 7) as s`, [target]);
    const { id } = await db.sqlOne<{ id: string }>(`select mod_action_id as id from public.sanctions where id = $1`, [s]);
    await db.as(user(target), `select public.submit_appeal($1, 'I am not the same person as the banned account.')`, [id]);
    const { a } = await db.asOne<{ a: Array<{ zone_id: string | null; can_decide: boolean }> }>(user(admin, 'aal2'), `select public.open_appeals(null) as a`);
    expect(a).toContainEqual(expect.objectContaining({ zone_id: null, can_decide: false }));
  });
});
