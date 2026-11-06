/**
 * Image uploads (migration …023): the database owns every upload — who may
 * start one, which post it belongs to, who may see it, and when its bytes go.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, service, user } from '../src/testing/index.ts';
import { TIER, createPost } from './helpers.ts';

let db: TestDb;
let admin: string;

type Registered = { id: string; bucket: string; path: string };
type PostImage = { id: string; alt: string; width: number | null };

beforeAll(async () => {
  db = await TestDb.create();
  admin = await db.createUser({ karma: TIER.contributor, username: 'media_admin' });
  await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [admin]);
});

afterAll(async () => {
  await db.close();
});

const register = async (member: string, type = 'image/jpeg', bytes = 120_000, kind = 'post_image') =>
  (await db.asOne<{ r: Registered }>(user(member), `select public.register_upload($1, $2, $3) as r`, [kind, type, bytes])).r;
const confirm = (member: string, id: string) => db.as(user(member), `select public.confirm_upload($1, 1200, 800)`, [id]);
const postImages = async (actor: ReturnType<typeof user> | typeof anon, post: string) =>
  (await db.asOne<{ r: PostImage[] }>(actor, `select public.get_post_media($1) as r`, [post])).r;
const access = async (actor: ReturnType<typeof user> | typeof anon, id: string) =>
  (await db.asOne<{ r: { path: string; public: boolean } | null }>(actor, `select public.get_media_access($1) as r`, [id])).r;

describe('starting an upload', () => {
  it('is a Trusted capability with size and type limits', async () => {
    const newcomer = await db.createUser();
    const trusted = await db.createUser({ karma: TIER.trusted });
    const denied = await db.expectError(user(newcomer), `select public.register_upload('post_image', 'image/png', 1000)`);
    expect(denied).toMatchObject({ code: 'PF403', message: 'capability_denied', detail: 'upload_image:tier:2' });

    const r = await register(trusted);
    expect(r.bucket).toBe('media');
    expect(r.path).toBe(`post_image/${trusted}/${r.id}.jpg`);

    expect((await db.expectError(user(trusted), `select public.register_upload('post_image', 'image/gif', 1000)`)).message).toBe('unsupported_file_type');
    expect((await db.expectError(user(trusted), `select public.register_upload('post_image', 'application/pdf', 1000)`)).message).toBe('unsupported_file_type');
    expect((await db.expectError(user(trusted), `select public.register_upload('post_image', 'image/png', 50000000)`)).message).toBe('file_too_large');

    // The standing view explains the gate.
    const standing = (await db.asOne<{ s: { capabilities: Record<string, string | null> } }>(user(newcomer), `select public.my_standing() as s`)).s;
    expect(standing.capabilities.upload_image).toBe('tier:2');
    expect((await db.asOne<{ s: { capabilities: Record<string, string | null> } }>(user(trusted), `select public.my_standing() as s`)).s.capabilities.upload_image).toBeNull();
  });

  it('a pending upload is uploadable only by its owner at its exact path', async () => {
    const owner = await db.createUser({ karma: TIER.trusted });
    const other = await db.createUser({ karma: TIER.trusted });
    const r = await register(owner);
    expect((await db.asOne<{ ok: boolean }>(user(owner), `select private.media_uploadable($1) as ok`, [r.path])).ok).toBe(true);
    expect((await db.asOne<{ ok: boolean }>(user(other), `select private.media_uploadable($1) as ok`, [r.path])).ok).toBe(false);
    expect((await db.asOne<{ ok: boolean }>(user(owner), `select private.media_uploadable('post_image/x/y.jpg') as ok`)).ok).toBe(false);
    await confirm(owner, r.id);
    expect((await db.asOne<{ ok: boolean }>(user(owner), `select private.media_uploadable($1) as ok`, [r.path])).ok).toBe(false);
    expect((await db.expectError(user(other), `select public.confirm_upload($1)`, [r.id])).code).toBe('PF404');
  });
});

describe('attaching images to a post', () => {
  it('shows them to whoever can see the post, in order, with alt text', async () => {
    const author = await db.createUser({ karma: TIER.trusted });
    const post = await createPost(db, author, { title: 'My lab report, redacted' });
    const a = await register(author);
    const b = await register(author);
    await confirm(author, a.id);
    await confirm(author, b.id);
    expect((await db.asOne<{ r: unknown[] }>(user(author), `select public.my_pending_media() as r`)).r).toHaveLength(2);

    await db.as(user(author), `select public.attach_post_media($1, $2::uuid[], $3::text[])`, [post, [b.id, a.id], ['Second page', 'First page']]);
    expect(await postImages(anon, post)).toEqual([
      expect.objectContaining({ id: b.id, alt: 'Second page', width: 1200 }),
      expect.objectContaining({ id: a.id, alt: 'First page' }),
    ]);
    expect(await access(anon, a.id)).toEqual(expect.objectContaining({ path: a.path, public: true }));
    expect((await db.asOne<{ r: unknown[] }>(user(author), `select public.my_pending_media() as r`)).r).toHaveLength(0);

    // Leaving one out detaches and removes it.
    await db.as(user(author), `select public.attach_post_media($1, $2::uuid[], null)`, [post, [a.id]]);
    expect((await postImages(anon, post)).map((x) => x.id)).toEqual([a.id]);
    expect(await access(anon, b.id)).toBeNull();

    // Removed post: images are no longer public, but the author still sees them.
    await db.sql(`update public.posts set status = 'removed' where id = $1`, [post]);
    expect(await postImages(anon, post)).toEqual([]);
    expect(await access(anon, a.id)).toBeNull();
    expect(await access(user(author), a.id)).toEqual(expect.objectContaining({ public: false }));
  });

  it("can't use someone else's upload, exceed the limit, or target someone else's post", async () => {
    const author = await db.createUser({ karma: TIER.trusted });
    const other = await db.createUser({ karma: TIER.trusted });
    const post = await createPost(db, author);
    const theirs = await register(other);
    await confirm(other, theirs.id);
    expect((await db.expectError(user(author), `select public.attach_post_media($1, $2::uuid[], null)`, [post, [theirs.id]])).code).toBe('PF404');
    expect((await db.expectError(user(other), `select public.attach_post_media($1, $2::uuid[], null)`, [post, [theirs.id]])).code).toBe('PF404');

    await db.setConfig('uploads.max_per_post', 1);
    const one = await register(author);
    const two = await register(author);
    await confirm(author, one.id);
    await confirm(author, two.id);
    expect((await db.expectError(user(author), `select public.attach_post_media($1, $2::uuid[], null)`, [post, [one.id, two.id]])).message).toBe('too_many_images');
    await db.setConfig('uploads.max_per_post', 4);
  });
});

describe('removal and purge', () => {
  it('admins remove with a reason and a log entry; the worker purges bytes', async () => {
    const author = await db.createUser({ karma: TIER.trusted, username: 'media_owner' });
    const post = await createPost(db, author);
    const img = await register(author);
    await confirm(author, img.id);
    await db.as(user(author), `select public.attach_post_media($1, $2::uuid[], null)`, [post, [img.id]]);

    const list = (await db.asOne<{ r: { rows: Array<{ id: string; owner: string; post: { id: string } }>; counts: { ready: number } } }>(
      user(admin, 'aal2'), `select public.admin_media('ready', 0) as r`)).r;
    expect(list.rows.find((x) => x.id === img.id)).toMatchObject({ owner: 'media_owner', post: { id: post } });
    expect((await db.expectError(user(author, 'aal2'), `select public.admin_media('ready', 0)`)).code).toBe('PF403');

    await db.as(user(admin, 'aal2'), `select public.admin_remove_media($1, 'Before/after photo')`, [img.id]);
    expect(await postImages(anon, post)).toEqual([]);
    expect(await db.sql(`select 1 from public.mod_actions where action = 'media_removed' and target_id = $1 and target_user_id = $2`, [img.id, author])).toHaveLength(1);
    expect((await db.expectError(user(admin, 'aal2'), `select public.admin_remove_media($1, 'Twice')`, [img.id])).message).toBe('already_removed');

    for (const actor of [anon, user(author), user(admin, 'aal2')]) {
      expect((await db.expectError(actor, `select public.media_to_purge(10)`)).code).toBe('42501');
      expect((await db.expectError(actor, `select * from public.media`)).code).toBe('42501');
    }
    const purge = (await db.asOne<{ r: Array<{ id: string; path: string }> }>(service, `select public.media_to_purge(100) as r`)).r;
    expect(purge.find((x) => x.id === img.id)).toMatchObject({ path: img.path });
    expect((await db.asOne<{ n: number }>(service, `select public.mark_media_purged($1::uuid[]) as n`, [[img.id]])).n).toBe(1);
    expect((await db.asOne<{ r: Array<{ id: string }> }>(service, `select public.media_to_purge(100) as r`)).r.some((x) => x.id === img.id)).toBe(false);
  });

  it('abandoned uploads and a deleted account’s images are purged too', async () => {
    const author = await db.createUser({ karma: TIER.trusted });
    const stale = await register(author);
    await db.sql(`update public.media set created_at = now() - interval '2 days' where id = $1`, [stale.id]);
    const purge = (await db.asOne<{ r: Array<{ id: string }> }>(service, `select public.media_to_purge(100) as r`)).r;
    expect(purge.some((x) => x.id === stale.id)).toBe(true);

    const leaver = await db.createUser({ karma: TIER.trusted });
    const post = await createPost(db, leaver);
    const img = await register(leaver);
    await confirm(leaver, img.id);
    await db.as(user(leaver), `select public.attach_post_media($1, $2::uuid[], null)`, [post, [img.id]]);
    await db.as(user(leaver), `select public.request_account_deletion(false)`);
    expect(await postImages(anon, post)).toEqual([]);
    expect((await db.sqlOne<{ status: string; removed_reason: string }>(`select status, removed_reason from public.media where id = $1`, [img.id])))
      .toEqual({ status: 'removed', removed_reason: 'account_deleted' });
  });
});
