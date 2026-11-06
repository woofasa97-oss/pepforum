/**
 * Profile pictures and following (migration …027).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, service, user } from '../src/testing/index.ts';
import { TIER } from './helpers.ts';

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

type Profile = { avatar: string | null; followers: number; following: number; is_following: boolean; follows_you: boolean };
type Follow = { username: string; friend: boolean; is_me: boolean; avatar: string | null };
type Actor = ReturnType<typeof user> | typeof anon;

const usernameOf = async (id: string) => (await db.profile(id)).username as string;
const profile = async (actor: Actor, id: string) =>
  (await db.asOne<{ p: Profile }>(actor, `select public.get_profile($1) as p`, [await usernameOf(id)])).p;

/** Registers, "uploads" (no Storage in PGlite) and confirms a picture; returns its media id. */
async function uploadAvatar(member: string): Promise<string> {
  const { r } = await db.asOne<{ r: { id: string; path: string } }>(user(member), `select public.register_upload('avatar', 'image/webp', 9000) as r`);
  expect(r.path).toBe(`avatar/${member}/${r.id}.webp`);
  await db.as(user(member), `select public.confirm_upload($1, 256, 256)`, [r.id]);
  return r.id;
}
const setAvatar = (member: string, media: string | null) => db.as(user(member), `select public.set_avatar($1)`, [media]);
const access = async (actor: Actor, id: string) =>
  (await db.asOne<{ r: { public: boolean } | null }>(actor, `select public.get_media_access($1) as r`, [id])).r;
const mediaStatus = async (id: string) => (await db.sqlOne<{ status: string }>(`select status from public.media where id = $1`, [id])).status;

describe('profile pictures', () => {
  it('any member can set one; it is public while current, and replacing it removes the old one', async () => {
    const newcomer = await db.createUser();
    const first = await uploadAvatar(newcomer);
    // Uploaded but not set yet: only the owner sees it.
    expect(await access(anon, first)).toBeNull();
    await setAvatar(newcomer, first);
    expect((await profile(anon, newcomer)).avatar).toBe(first);
    expect(await access(anon, first)).toMatchObject({ public: true });
    expect((await db.asOne<{ s: { avatar: string } }>(user(newcomer), `select public.my_standing() as s`)).s.avatar).toBe(first);

    const second = await uploadAvatar(newcomer);
    await setAvatar(newcomer, second);
    expect((await profile(anon, newcomer)).avatar).toBe(second);
    expect(await mediaStatus(first)).toBe('removed');
    expect(await access(anon, first)).toBeNull();

    await setAvatar(newcomer, null);
    expect((await profile(anon, newcomer)).avatar).toBeNull();
    expect(await mediaStatus(second)).toBe('removed');
  });

  it('only your own ready picture can be set', async () => {
    const a = await db.createUser();
    const b = await db.createUser({ karma: TIER.trusted });
    const theirs = await uploadAvatar(b);
    expect((await db.expectError(user(a), `select public.set_avatar($1)`, [theirs])).code).toBe('PF404');

    const { r: postImage } = await db.asOne<{ r: { id: string } }>(user(b), `select public.register_upload('post_image', 'image/jpeg', 9000) as r`);
    await db.as(user(b), `select public.confirm_upload($1, 10, 10)`, [postImage.id]);
    expect((await db.expectError(user(b), `select public.set_avatar($1)`, [postImage.id])).code).toBe('PF404');

    const { r: pending } = await db.asOne<{ r: { id: string } }>(user(a), `select public.register_upload('avatar', 'image/png', 9000) as r`);
    expect((await db.expectError(user(a), `select public.set_avatar($1)`, [pending.id])).code).toBe('PF404');
    expect((await db.expectError(user(a), `select public.register_upload('avatar', 'application/pdf', 9000)`)).message).toBe('unsupported_file_type');
    expect((await db.expectError(anon, `select public.set_avatar(null)`)).code).toMatch(/^(42501|PF401)$/);
  });

  it('admins can take an offensive picture down; unused pictures are purged', async () => {
    const member = await db.createUser();
    const pic = await uploadAvatar(member);
    await setAvatar(member, pic);
    await db.as(user(admin, 'aal2'), `select public.admin_remove_media($1, 'Vendor logo')`, [pic]);
    expect((await profile(anon, member)).avatar).toBeNull();

    const unused = await uploadAvatar(member);
    const current = await uploadAvatar(member);
    await setAvatar(member, current);
    await db.sql(`update public.media set created_at = now() - interval '2 days' where id = any($1::uuid[])`, [[unused, current]]);
    await db.asOne(service, `select public.media_to_purge(100) as r`);
    expect(await mediaStatus(unused)).toBe('removed');
    expect(await mediaStatus(current)).toBe('ready');
  });

  it('is rate limited', async () => {
    const member = await db.createUser();
    for (let i = 0; i < 10; i++) await setAvatar(member, null);
    expect(await db.expectError(user(member), `select public.set_avatar(null)`)).toMatchObject({ code: 'PF429', detail: 'avatar' });
  });
});

describe('following', () => {
  const follow = (a: string, b: string, on = true) =>
    db.asOne<{ r: { following: boolean; followers: number; friends: boolean } }>(user(a), `select public.set_follow($1, $2) as r`, [b, on]);

  it('counts, flags, friends and one notification per follower', async () => {
    const alice = await db.createUser({ username: 'alice_follows' });
    const bob = await db.createUser({ username: 'bob_followed' });

    expect((await follow(alice, 'Bob_Followed')).r).toEqual({ following: true, followers: 1, friends: false });
    expect(await profile(user(alice), bob)).toMatchObject({ followers: 1, following: 0, is_following: true, follows_you: false });
    expect(await profile(user(bob), alice)).toMatchObject({ following: 1, is_following: false, follows_you: true });
    expect(await profile(anon, bob)).toMatchObject({ followers: 1, is_following: false, follows_you: false });

    // Following back makes them friends.
    expect((await follow(bob, 'alice_follows')).r.friends).toBe(true);
    const followers = (await db.asOne<{ r: Follow[] }>(anon, `select public.get_follows('bob_followed', 'followers') as r`)).r;
    expect(followers).toEqual([expect.objectContaining({ username: 'alice_follows', friend: true, is_me: false })]);

    // Unfollow and follow again: still one notification.
    await follow(alice, 'bob_followed', false);
    expect((await profile(anon, bob)).followers).toBe(0);
    await follow(alice, 'bob_followed');
    await follow(alice, 'bob_followed'); // idempotent
    const { n } = await db.sqlOne<{ n: number }>(
      `select count(*)::int as n from public.notifications where user_id = $1 and kind = 'new_follower' and actor_id = $2`, [bob, alice]);
    expect(n).toBe(1);
  });

  it('refuses yourself, unknown members and anonymous visitors; the table stays private', async () => {
    const me = await db.createUser({ username: 'lonely_one' });
    expect((await db.expectError(user(me), `select public.set_follow('lonely_one', true)`)).message).toBe('follow_self');
    expect((await db.expectError(user(me), `select public.set_follow('nobody_at_all', true)`)).code).toBe('PF404');
    expect((await db.expectError(anon, `select public.set_follow('lonely_one', true)`)).code).toMatch(/^(42501|PF401)$/);
    expect((await db.expectError(user(me), `select public.get_follows('lonely_one', 'enemies')`)).message).toBe('invalid_kind');
    expect((await db.asOne<{ r: unknown }>(anon, `select public.get_follows('nobody_at_all', 'followers') as r`)).r).toBeNull();
    for (const actor of [anon, user(me)]) {
      expect((await db.expectError(actor, `select * from public.follows`)).code).toBe('42501');
    }
  });

  it('is rate limited', async () => {
    const busy = await db.createUser();
    const target = await usernameOf(await db.createUser());
    for (let i = 0; i < 60; i++) await follow(busy, target, i % 2 === 0);
    expect(await db.expectError(user(busy), `select public.set_follow($1, true)`, [target])).toMatchObject({ code: 'PF429', detail: 'follow' });
  });
});

describe('privacy', () => {
  it('the export lists follows; deleting the account clears the picture and every follow', async () => {
    const leaver = await db.createUser({ username: 'leaving_soon' });
    const friend = await db.createUser({ username: 'stays_here' });
    await db.as(user(leaver), `select public.set_follow('stays_here', true)`);
    await db.as(user(friend), `select public.set_follow('leaving_soon', true)`);
    const pic = await uploadAvatar(leaver);
    await setAvatar(leaver, pic);

    const { data } = await db.asOne<{ data: { following: Array<{ username: string }>; followers: Array<{ username: string }> } }>(
      user(leaver), `select public.export_my_data() as data`);
    expect(data.following.map((f) => f.username)).toEqual(['stays_here']);
    expect(data.followers.map((f) => f.username)).toEqual(['stays_here']);

    await db.as(user(leaver), `select public.request_account_deletion(false)`);
    const { n } = await db.sqlOne<{ n: number }>(`select count(*)::int as n from public.follows where follower_id = $1 or followee_id = $1`, [leaver]);
    expect(n).toBe(0);
    expect(await mediaStatus(pic)).toBe('removed');
    expect((await db.sqlOne<{ a: string | null }>(`select avatar_media_id as a from public.profiles where id = $1`, [leaver])).a).toBeNull();
    expect((await profile(anon, friend)).following).toBe(0);
  });
});
