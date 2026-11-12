/**
 * No zones (migration …034, ADR-0010): the zone tables and columns are gone,
 * nothing in the database still refers to them, existing data is carried over,
 * and moderators are site-wide.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, user } from '../src/testing/index.ts';
import { TIER, createPost } from './helpers.ts';

const ZONES_MIGRATION = '20261112000034';

describe('migrating an existing database', () => {
  let db: TestDb;
  afterAll(async () => {
    await db.close();
  });

  it('carries zone moderators, pins, advertisers and settings over', async () => {
    db = await TestDb.create({ stopBefore: ZONES_MIGRATION });
    const [onMod, twoZoneMod, author, owner] = [await db.createUser(), await db.createUser(), await db.createUser({ karma: TIER.member }), await db.createUser()];
    await db.sql(`insert into public.zone_moderators (zone_id, user_id) values ('on', $1), ('bc', $2), ('qc', $2)`, [onMod, twoZoneMod]);
    const posts: string[] = [];
    for (const [i, zone] of ['national', 'bc', 'qc', 'on'].entries()) {
      const { id } = await db.sqlOne<{ id: string }>(
        `insert into public.posts (author_id, zone_id, category_id, post_type, title, body, pinned_at)
         values ($1, $2, 'basics', 'claim', 'A sufficiently descriptive title', 'Body', now() - make_interval(hours => $3)) returning id`,
        [author, zone, 10 - i]);
      posts.push(id);
    }
    await db.sql(`insert into public.advertisers (owner_id, name, website, billing_email, billing_address, billing_province)
                  values ($1, 'Maple Labs', 'https://maple.example', 'billing@maple.example', '1 Bay St', 'ON')`, [owner]);

    await db.applyMigrationsFrom(ZONES_MIGRATION);

    const mods = await db.sql<{ user_id: string }>(`select user_id from public.moderators order by user_id`);
    expect(mods.map((m) => m.user_id).sort()).toEqual([onMod, twoZoneMod].sort());
    // Two pins for the whole site: the two most recent survive.
    const pinned = await db.sql<{ id: string }>(`select id from public.posts where pinned_at is not null order by pinned_at desc`);
    expect(pinned.map((p) => p.id)).toEqual([posts[3], posts[2]]);
    expect(await db.sqlOne(`select billing_country from public.advertisers where owner_id = $1`, [owner])).toEqual({ billing_country: 'CA' });
    expect(await db.sql(`select key from public.app_config where key in ('features.regions', 'ads.cpm.zone')`)).toEqual([]);
  });
});

describe('after the migration', () => {
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

  it('has no zone tables or columns', async () => {
    const tables = await db.sql<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name in ('zones', 'cities', 'zone_moderators')`);
    expect(tables).toEqual([]);
    const columns = await db.sql<{ col: string }>(
      `select table_name || '.' || column_name as col from information_schema.columns
       where table_schema = 'public' and column_name in ('zone_id', 'city_id', 'home_zone_id', 'province_id', 'billing_province')`);
    expect(columns).toEqual([]);
  });

  it('no function still refers to a zone, city, home zone or province', async () => {
    // A function the migration missed would only fail when someone used it, so check every body.
    const offenders = await db.sql<{ fn: string }>(
      `select n.nspname || '.' || p.proname as fn
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private', 'prices')
         and p.prosrc ~* '(zone_id|city_id|zone_moderators|is_zone_mod|require_zone_mod|home_zone|province|public\\.zones|public\\.cities)'
       order by 1`);
    expect(offenders).toEqual([]);
  });

  it('admins appoint and remove site-wide moderators; others cannot', async () => {
    const member = await db.createUser();
    const target = await db.createUser();
    const call = `select public.set_moderator($1, $2, 'Active and accurate reporter')`;
    expect((await db.expectError(user(member, 'aal2'), call, [target, true])).message).toBe('not_admin');
    expect((await db.expectError(user(admin, 'aal1'), call, [target, true])).code).toBe('PF428');
    expect((await db.expectError(user(admin, 'aal2'), call, [admin, true])).message).toBe('conflict_of_interest');
    expect((await db.expectError(anon, call, [target, true])).code).toMatch(/^(42501|PF401)$/);

    await db.as(user(admin, 'aal2'), call, [target, true]);
    expect((await db.asOne<{ s: { is_moderator: boolean } }>(user(target), `select public.my_standing() as s`)).s.is_moderator).toBe(true);
    const name = (await db.profile(target)).username as string;
    expect((await db.asOne<{ p: { is_moderator: boolean } }>(anon, `select public.get_profile($1) as p`, [name])).p.is_moderator).toBe(true);
    expect(await db.sqlOne(`select action, target_user_id from public.mod_actions where actor_id = $1 order by created_at desc limit 1`, [admin]))
      .toEqual({ action: 'appoint_moderator', target_user_id: target });

    await db.as(user(admin, 'aal2'), call, [target, false]);
    expect((await db.asOne<{ s: { is_moderator: boolean } }>(user(target), `select public.my_standing() as s`)).s.is_moderator).toBe(false);
  });

  it('the moderators table is not readable through the API', async () => {
    for (const actor of [anon, user(await db.createUser())]) {
      expect((await db.expectError(actor, `select * from public.moderators`)).code).toBe('42501');
    }
  });

  it('a moderator acts on any post, and removal appeals go to another moderator', async () => {
    const [mod, other] = [await db.createUser(), await db.createUser()];
    await db.sql(`insert into public.moderators (user_id) values ($1), ($2)`, [mod, other]);
    const author = await db.createUser({ karma: TIER.member });
    const post = await createPost(db, author);
    await db.as(user(mod, 'aal2'), `select public.moderate_remove('post', $1, 'spam', 'Affiliate link')`, [post]);
    const { id } = await db.sqlOne<{ id: string }>(`select id from public.mod_actions where target_id = $1 and action = 'remove'`, [post]);
    const { appeal } = await db.asOne<{ appeal: string }>(user(author), `select public.submit_appeal($1, 'It was a link to a registry, not a shop.') as appeal`, [id]);

    expect((await db.expectError(user(mod, 'aal2'), `select public.decide_appeal($1, true, 'Mine')`, [appeal])).message).toBe('conflict_of_interest');
    const { a } = await db.asOne<{ a: Array<{ id: string; can_decide: boolean }> }>(user(other, 'aal2'), `select public.open_appeals() as a`);
    expect(a.find((x) => x.id === appeal)?.can_decide).toBe(true);
    await db.as(user(other, 'aal2'), `select public.decide_appeal($1, true, 'Registry link, restored')`, [appeal]);
  });

  it('two pins for the whole site', async () => {
    await db.sql(`update public.posts set pinned_at = null where pinned_at is not null`);
    const author = await db.createUser({ karma: TIER.member });
    const posts = [await createPost(db, author), await createPost(db, author), await createPost(db, author)];
    await db.as(user(admin, 'aal2'), `select public.admin_set_pinned($1, true, 'Read first')`, [posts[0]]);
    await db.as(user(admin, 'aal2'), `select public.admin_set_pinned($1, true, 'Read first')`, [posts[1]]);
    expect((await db.expectError(user(admin, 'aal2'), `select public.admin_set_pinned($1, true, 'Third')`, [posts[2]])).message).toBe('pin_limit');
  });

  it('the security self-audit stays clean', async () => {
    expect(await db.sql(`select * from private.security_audit()`)).toEqual([]);
  });
});
