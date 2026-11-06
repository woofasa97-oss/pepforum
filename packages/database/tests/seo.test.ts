/**
 * SEO (migration …021): sitemaps list only public content, managed redirects
 * are admin-only and never hijack reserved routes, renamed members keep their
 * old profile links.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, user } from '../src/testing/index.ts';
import { TIER, createPost } from './helpers.ts';

let db: TestDb;
let admin: string;

beforeAll(async () => {
  db = await TestDb.create();
  admin = await db.createUser({ karma: TIER.contributor, username: 'seo_admin' });
  await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [admin]);
});

afterAll(async () => {
  await db.close();
});

const resolve = async (path: string) =>
  (await db.asOne<{ r: { to: string; permanent: boolean } | null }>(anon, `select public.resolve_redirect($1) as r`, [path])).r;
const setRedirect = (from: string, to: string, permanent = true, reason = 'Moved during the relaunch') =>
  db.as(user(admin, 'aal2'), `select public.admin_set_redirect($1, $2, $3, $4)`, [from, to, permanent, reason]);

describe('sitemaps', () => {
  it('list visible posts and profiles with posts, and nothing hidden', async () => {
    const author = await db.createUser({ karma: TIER.member, username: 'sitemap_author' });
    const lurker = await db.createUser({ username: 'sitemap_lurker' });
    const visible = await createPost(db, author, { title: 'A post search engines may index' });
    const removed = await createPost(db, author, { title: 'A post a moderator removed' });
    await db.sql(`update public.posts set status = 'removed' where id = $1`, [removed]);

    const posts = await db.as<{ path: string }>(anon, `select path from public.sitemap_entries('posts', 0)`);
    expect(posts.map((p) => p.path)).toContain(`/post/${visible}`);
    expect(posts.map((p) => p.path)).not.toContain(`/post/${removed}`);

    const profiles = await db.as<{ path: string }>(anon, `select path from public.sitemap_entries('profiles', 0)`);
    expect(profiles.map((p) => p.path)).toContain('/u/sitemap_author');
    expect(profiles.map((p) => p.path)).not.toContain('/u/sitemap_lurker');
    void lurker;

    const counts = (await db.asOne<{ c: Record<string, number> }>(anon, `select public.sitemap_counts() as c`)).c;
    expect(counts.posts).toBeGreaterThanOrEqual(1);
    expect(counts.page_size).toBe(5000);
    expect(await db.as(anon, `select path from public.sitemap_entries('posts', 1)`)).toEqual([]);
  });
});

describe('managed redirects', () => {
  it('are set by admins, resolved by anyone, and logged', async () => {
    expect(await resolve('/old-guide')).toBeNull();
    await setRedirect('/Old-Guide/', '/legal/community-guidelines');
    expect(await resolve('/old-guide')).toEqual({ to: '/legal/community-guidelines', permanent: true });
    expect(await resolve('/old-guide/')).toEqual({ to: '/legal/community-guidelines', permanent: true });

    await setRedirect('/old-guide', 'https://example.org/guide', false);
    expect(await resolve('/old-guide')).toEqual({ to: 'https://example.org/guide', permanent: false });

    const list = (await db.asOne<{ r: Array<{ from: string; to: string; by: string }> }>(user(admin, 'aal2'), `select public.admin_redirects() as r`)).r;
    expect(list).toEqual([expect.objectContaining({ from: '/old-guide', to: 'https://example.org/guide', by: 'seo_admin' })]);
    const log = await db.sql<{ action: string }>(`select action from public.mod_actions where target_kind = 'redirect' order by created_at`);
    expect(log.map((l) => l.action)).toEqual(['redirect_set', 'redirect_set']);

    await db.as(user(admin, 'aal2'), `select public.admin_delete_redirect('/old-guide', 'No longer needed')`);
    expect(await resolve('/old-guide')).toBeNull();
    expect((await db.expectError(user(admin, 'aal2'), `select public.admin_delete_redirect('/old-guide', 'Twice')`)).code).toBe('PF404');
  });

  it('refuse reserved routes, loops and bad targets', async () => {
    const admin2 = user(admin, 'aal2');
    expect((await db.expectError(admin2, `select public.admin_set_redirect('/admin/people', '/', true, 'Hijack attempt')`)).message).toBe('reserved_path');
    expect((await db.expectError(admin2, `select public.admin_set_redirect('/loop', '/loop', true, 'Loop')`)).message).toBe('redirect_loop');
    expect((await db.expectError(admin2, `select public.admin_set_redirect('/x', 'http://insecure.example', true, 'Bad')`)).message).toBe('invalid_url');
    expect((await db.expectError(admin2, `select public.admin_set_redirect('/x', 'javascript:alert(1)', true, 'Bad')`)).message).toBe('invalid_url');
    await setRedirect('/a', '/b');
    expect((await db.expectError(admin2, `select public.admin_set_redirect('/b', '/a', true, 'Loop')`)).message).toBe('redirect_loop');
  });

  it('are not writable or readable directly, nor by non-admins', async () => {
    const member = await db.createUser();
    expect((await db.expectError(user(member, 'aal2'), `select public.admin_set_redirect('/m', '/n', true, 'Nope')`)).code).toBe('PF403');
    expect((await db.expectError(user(admin, 'aal1'), `select public.admin_set_redirect('/m', '/n', true, 'No MFA')`)).code).toBe('PF428');
    expect((await db.expectError(anon, `select * from public.redirects`)).code).toBe('42501');
    expect((await db.expectError(user(member, 'aal2'), `select public.admin_redirects()`)).code).toBe('PF403');
  });
});

describe('username history', () => {
  const resolveName = async (old: string) => (await db.asOne<{ r: string | null }>(anon, `select public.resolve_username($1) as r`, [old])).r;

  it('redirects an old username to the new one after an admin rename', async () => {
    const member = await db.createUser({ username: 'Before_Rename' });
    await db.as(user(admin, 'aal2'), `select public.admin_rename_user($1, 'after_rename', 'Impersonation complaint')`, [member]);
    expect(await resolveName('before_rename')).toBe('after_rename');
    expect(await resolveName('never_existed')).toBeNull();
    expect((await db.expectError(anon, `select * from public.username_history`)).code).toBe('42501');
  });

  it('stops redirecting when a new member takes the old name or the account is deleted', async () => {
    const member = await db.createUser({ username: 'first_owner' });
    await db.as(user(admin, 'aal2'), `select public.admin_rename_user($1, 'moved_on', 'Requested')`, [member]);
    expect(await resolveName('first_owner')).toBe('moved_on');

    await db.createUser({ username: 'first_owner', email: 'second_first_owner@example.test' });
    expect(await resolveName('first_owner')).toBeNull();

    const other = await db.createUser({ username: 'leaving_soon' });
    await db.as(user(admin, 'aal2'), `select public.admin_rename_user($1, 'left_already', 'Requested')`, [other]);
    await db.as(user(other), `select public.request_account_deletion(false)`);
    expect(await resolveName('leaving_soon')).toBeNull();
  });
});
