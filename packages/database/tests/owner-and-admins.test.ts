/**
 * The site owner and admins' standing (migration …019): only the owner adds
 * and removes admins; admins pass every karma gate without touching karma.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, user } from '../src/testing/index.ts';
import { TIER, createPost, ledgerTotal } from './helpers.ts';

let db: TestDb;

beforeAll(async () => {
  db = await TestDb.create();
});

afterAll(async () => {
  await db.close();
});

async function createAdmin(options: { owner?: boolean; karma?: number } = {}): Promise<string> {
  const id = await db.createUser(options.karma ? { karma: options.karma } : {});
  await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [id]);
  if (options.owner) await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'owner')`, [id]);
  return id;
}

const setRole = (actor: string, target: string, admin: boolean) =>
  db.as(user(actor, 'aal2'), `select public.admin_set_role($1, $2, 'Team change')`, [target, admin]);

const isAdmin = async (id: string) =>
  (await db.sqlOne<{ v: boolean }>(`select private.is_admin($1) as v`, [id])).v;

describe('the site owner', () => {
  let owner: string;

  beforeAll(async () => {
    owner = await createAdmin({ owner: true });
  });

  it('is the only one who adds and removes admins', async () => {
    const helper = await db.createUser();
    await setRole(owner, helper, true);
    expect(await isAdmin(helper)).toBe(true);
    expect(await db.sqlOne(`select action, actor_id, target_user_id from public.mod_actions where action = 'grant_admin' order by created_at desc limit 1`))
      .toEqual({ action: 'grant_admin', actor_id: owner, target_user_id: helper });

    // Another admin can do everything else, but not this.
    const third = await db.createUser();
    expect((await db.expectError(user(helper, 'aal2'), `select public.admin_set_role($1, true, 'Adding a friend')`, [third])).message)
      .toBe('owner_only');
    expect((await db.expectError(user(helper, 'aal2'), `select public.admin_set_role($1, false, 'Taking over')`, [owner])).message)
      .toBe('owner_only');
    expect(await isAdmin(owner)).toBe(true);

    // The owner can't demote themselves, and removes others.
    expect((await db.expectError(user(owner, 'aal2'), `select public.admin_set_role($1, false, 'Stepping down')`, [owner])).message)
      .toBe('conflict_of_interest');
    await setRole(owner, helper, false);
    expect(await isAdmin(helper)).toBe(false);
  });

  it('is shown in the overview, and only one account can hold it', async () => {
    const other = await createAdmin();
    const ownerName = (await db.profile(owner)).username;
    const mine = await db.asOne<{ o: { owner: string; is_owner: boolean } }>(user(owner, 'aal2'), `select public.admin_overview() as o`);
    expect(mine.o).toMatchObject({ owner: ownerName, is_owner: true });
    const theirs = await db.asOne<{ o: { owner: string; is_owner: boolean } }>(user(other, 'aal2'), `select public.admin_overview() as o`);
    expect(theirs.o).toMatchObject({ owner: ownerName, is_owner: false });

    await expect(db.sql(`insert into public.user_roles (user_id, role) values ($1, 'owner')`, [other])).rejects.toThrow();
  });

  it('means nothing without the admin role', async () => {
    const id = await db.createUser();
    await db.sql(`delete from public.user_roles where role = 'owner'`);
    await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'owner')`, [id]);
    expect((await db.sqlOne<{ v: boolean }>(`select private.is_owner($1) as v`, [id])).v).toBe(false);
    await db.sql(`delete from public.user_roles where role = 'owner'`);
    await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'owner')`, [owner]);
  });
});

describe('admins at the top of the progression', () => {
  it('pass every karma gate while their karma stays untouched', async () => {
    const admin = await createAdmin();
    const member = await db.createUser();
    for (const capability of ['post_text', 'post_link', 'rate_notes', 'write_notes', 'steward']) {
      expect((await db.sqlOne<{ r: string | null }>(`select private.capability_check($1, $2) as r`, [admin, capability])).r, capability).toBeNull();
    }
    expect((await db.sqlOne<{ r: string | null }>(`select private.capability_check($1, 'write_notes') as r`, [member])).r).not.toBeNull();

    // No newcomer limit: a fourth post in a day goes through.
    for (let i = 0; i < 4; i++) await createPost(db, admin, { body: `Admin update ${i}` });
    const link = await createPost(db, admin, { type: 'resource', body: '', link: 'https://www.canada.ca/en/health-canada.html' });
    expect((await db.sqlOne<{ status: string }>(`select status from public.posts where id = $1`, [link])).status).toBe('visible');

    expect(await ledgerTotal(db, admin, 'karma')).toBe(0);
    expect((await db.profile(admin)).tier).toBe(0);
  });

  it('get the top tier’s protection from report collapses', async () => {
    const admin = await createAdmin();
    const post = await createPost(db, admin, { body: 'Forum rules update.' });
    for (let i = 0; i < 4; i++) {
      await db.as(user(await db.createUser({ ageDays: 60 })), `select public.file_report('post', $1, 'other', '')`, [post]);
    }
    expect((await db.sqlOne<{ status: string }>(`select status from public.posts where id = $1`, [post])).status).toBe('visible');
  });

  it('are named on their public profile', async () => {
    const admin = await createAdmin({ karma: TIER.member });
    const member = await db.createUser();
    const profile = async (id: string) =>
      (await db.asOne<{ p: { is_admin: boolean } }>(anon, `select public.get_profile($1) as p`, [(await db.profile(id)).username])).p;
    expect((await profile(admin)).is_admin).toBe(true);
    expect((await profile(member)).is_admin).toBe(false);
  });
});
