/**
 * Notifications and web push (migration …022): created by triggers inside the
 * database, read and marked by the member, delivered by the worker only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, service, user } from '../src/testing/index.ts';
import { TIER, createNoteWriter, createPost, proposeNote } from './helpers.ts';

let db: TestDb;
let admin: string;

type Item = {
  id: string; kind: string; read: boolean; actor: string | null; post: { id: string; title: string } | null;
  comment_excerpt: string | null; note_status: string | null; action: string | null; reason: string | null; ticket: { subject: string } | null;
};

beforeAll(async () => {
  db = await TestDb.create();
  admin = await db.createUser({ karma: TIER.contributor, username: 'notif_admin' });
  await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [admin]);
});

afterAll(async () => {
  await db.close();
});

const mine = async (member: string) => (await db.asOne<{ r: Item[] }>(user(member), `select public.my_notifications() as r`)).r;
const unread = async (member: string) =>
  (await db.asOne<{ s: { notifications_unread: number } }>(user(member), `select public.my_standing() as s`)).s.notifications_unread;
const comment = async (author: string, post: string, body: string, parent: string | null = null) =>
  (await db.asOne<{ id: string }>(user(author), `select public.create_comment($1, $2, $3) as id`, [post, body, parent])).id;

describe('replies', () => {
  it('notify the post author and the parent comment author, never yourself', async () => {
    const op = await db.createUser({ karma: TIER.member, username: 'notif_op' });
    const replier = await db.createUser({ username: 'notif_replier' });
    const third = await db.createUser({ username: 'notif_third' });
    const post = await createPost(db, op, { title: 'Does anyone have the CMAJ reference?' });

    const c1 = await comment(replier, post, 'Yes, it is in the 2024 supplement.');
    await comment(op, post, 'Thanks, found it.', c1);           // reply to replier
    await comment(op, post, 'Bumping my own post.');             // self: nothing
    const c3 = await comment(third, post, 'Same question here.');
    void c3;

    const opItems = await mine(op);
    expect(opItems.map((n) => [n.kind, n.actor])).toEqual([['reply_post', 'notif_third'], ['reply_post', 'notif_replier']]);
    expect(opItems[1]).toMatchObject({ post: { id: post, title: 'Does anyone have the CMAJ reference?' }, comment_excerpt: 'Yes, it is in the 2024 supplement.', read: false });
    expect(await mine(replier)).toEqual([expect.objectContaining({ kind: 'reply_comment', actor: 'notif_op', comment_excerpt: 'Thanks, found it.' })]);
    expect(await unread(op)).toBe(2);

    // Nobody reads the tables directly.
    for (const actor of [anon, user(op), user(admin, 'aal2')]) {
      expect((await db.expectError(actor, `select * from public.notifications`)).code).toBe('42501');
      expect((await db.expectError(actor, `select * from public.push_subscriptions`)).code).toBe('42501');
    }
  });

  it('respect the member’s preferences and can be marked read', async () => {
    const op = await db.createUser({ karma: TIER.member });
    const replier = await db.createUser();
    await db.as(user(op), `select public.set_notification_settings(false, true, true, true, false)`);
    const post = await createPost(db, op);
    await comment(replier, post, 'You will not hear about this.');
    expect(await mine(op)).toEqual([]);

    await db.as(user(op), `select public.set_notification_settings(true, true, true, true, false)`);
    await comment(replier, post, 'But you will hear about this.');
    const [item] = await mine(op);
    expect(item?.read).toBe(false);
    expect((await db.asOne<{ n: number }>(user(op), `select public.mark_notifications_read(array[$1]::uuid[]) as n`, [item?.id])).n).toBe(1);
    expect((await mine(op))[0]?.read).toBe(true);
    expect(await unread(op)).toBe(0);
    expect((await db.asOne<{ n: number }>(user(op), `select public.mark_notifications_read(null) as n`)).n).toBe(0);
  });
});

describe('notes, moderation and the team', () => {
  it('tell the writer the outcome and the post author about a helpful note, without naming anyone', async () => {
    const op = await db.createUser({ karma: TIER.member });
    const writer = await createNoteWriter(db);
    const post = await createPost(db, op, { title: 'Claim with a wrong figure' });
    const note = await proposeNote(db, writer, post);
    await db.sql(`update public.notes set locked_at = now(), locked_status = 'helpful', status = 'helpful' where id = $1`, [note]);

    expect(await mine(writer)).toEqual([expect.objectContaining({ kind: 'note_outcome', note_status: 'helpful', actor: null })]);
    expect(await mine(op)).toEqual([expect.objectContaining({ kind: 'note_on_post', actor: null, post: { id: post, title: 'Claim with a wrong figure' } })]);
  });

  it('tell a sanctioned member what happened and why, not who did it', async () => {
    const member = await db.createUser();
    await db.as(user(admin, 'aal2'), `select public.apply_sanction($1, 'warning', 'Please keep vendor names out of posts', null)`, [member]);
    const items = await mine(member);
    expect(items).toEqual([expect.objectContaining({ kind: 'mod_action', action: 'sanction', reason: 'Please keep vendor names out of posts', actor: null })]);
    const exported = (await db.asOne<{ e: { notifications: Array<Record<string, unknown>> } }>(user(member), `select public.export_my_data() as e`)).e;
    expect(exported.notifications).toHaveLength(1);
    expect(exported.notifications[0]).not.toHaveProperty('actor_id');
  });

  it('tell a member the team replied to their ticket', async () => {
    const member = await db.createUser();
    const { id } = await db.asOne<{ id: string }>(user(member), `select public.open_ticket('bug', 'Dark mode bug', 'The notes page ignores the theme.', null, null) as id`);
    await db.as(user(admin, 'aal2'), `select public.admin_reply_ticket($1, 'Fixed in tonight’s deploy, thank you.', false)`, [id]);
    expect(await mine(member)).toEqual([expect.objectContaining({ kind: 'team_reply', ticket: { id, subject: 'Dark mode bug' } })]);
  });
});

describe('web push', () => {
  const ENDPOINT = 'https://push.example.test/send/abc123';
  const subscribe = (member: string, endpoint = ENDPOINT) =>
    db.asOne<{ id: string }>(user(member), `select public.save_push_subscription($1, $2, $3, $4) as id`,
      [endpoint, 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', 'tBHItJI5svbpez7KI4CCXg', 'test browser']);
  const settings = async (member: string) =>
    (await db.asOne<{ s: { push: boolean; subscriptions: number } }>(user(member), `select public.my_notification_settings() as s`)).s;

  it('is opt-in per browser and the worker delivers it', async () => {
    const op = await db.createUser({ karma: TIER.member });
    const replier = await db.createUser();
    expect(await settings(op)).toMatchObject({ push: false, subscriptions: 0 });

    await subscribe(op);
    expect(await settings(op)).toMatchObject({ push: true, subscriptions: 1 });
    expect((await db.expectError(user(op), `select public.save_push_subscription('http://insecure', 'k', 'a', '')`)).message).toBe('invalid_push_endpoint');

    const post = await createPost(db, op);
    await comment(replier, post, 'Push this.');

    for (const actor of [anon, user(op), user(admin, 'aal2')]) {
      expect((await db.expectError(actor, `select public.pending_push(10)`)).code).toBe('42501');
    }
    const pending = (await db.asOne<{ p: Array<{ id: string; kind: string; locale: string; url: string; subscriptions: Array<{ id: string; endpoint: string }> }> }>(
      service, `select public.pending_push(100) as p`)).p;
    const item = pending.find((x) => x.subscriptions.some((s) => s.endpoint === ENDPOINT));
    expect(item).toMatchObject({ kind: 'reply_post', locale: 'en' });
    expect(item?.url).toMatch(new RegExp(`^/post/${post}#c-`));

    const results = (await db.asOne<{ r: { sent: number; dropped: number } }>(service, `select public.record_push_results($1::jsonb) as r`,
      [JSON.stringify([{ notification_id: item?.id, subscription_id: item?.subscriptions[0]?.id, ok: true, gone: false }])])).r;
    expect(results).toEqual({ sent: 1, dropped: 0 });
    // Delivered: not pending any more.
    const again = (await db.asOne<{ p: Array<{ id: string }> }>(service, `select public.pending_push(100) as p`)).p;
    expect(again.some((x) => x.id === item?.id)).toBe(false);
  });

  it('drops dead endpoints and turns push off when the last browser is gone', async () => {
    const op = await db.createUser({ karma: TIER.member });
    const replier = await db.createUser();
    const { id: sid } = await subscribe(op, 'https://push.example.test/send/gone-soon');
    const post = await createPost(db, op);
    await comment(replier, post, 'Push this too.');
    const pending = (await db.asOne<{ p: Array<{ id: string; subscriptions: Array<{ id: string }> }> }>(service, `select public.pending_push(100) as p`)).p;
    const item = pending.find((x) => x.subscriptions.some((s) => s.id === sid));
    await db.as(service, `select public.record_push_results($1::jsonb)`,
      [JSON.stringify([{ notification_id: item?.id, subscription_id: sid, ok: false, gone: true }])]);
    expect(await settings(op)).toMatchObject({ push: false, subscriptions: 0 });
  });

  it('can be revoked by the member, and goes with the account', async () => {
    const op = await db.createUser();
    await subscribe(op, 'https://push.example.test/send/revoke-me');
    await db.as(user(op), `select public.delete_push_subscription('https://push.example.test/send/revoke-me')`);
    expect(await settings(op)).toMatchObject({ push: false, subscriptions: 0 });

    await subscribe(op, 'https://push.example.test/send/leaving');
    await db.as(user(op), `select public.request_account_deletion(false)`);
    expect(await db.sql(`select 1 from public.push_subscriptions where user_id = $1`, [op])).toEqual([]);
    expect(await db.sql(`select 1 from public.notification_settings where user_id = $1`, [op])).toEqual([]);
  });

  it('purges old notifications during maintenance', async () => {
    const op = await db.createUser({ karma: TIER.member });
    const replier = await db.createUser();
    const post = await createPost(db, op);
    await comment(replier, post, 'Old news.');
    await db.sql(`update public.notifications set created_at = now() - interval '200 days' where user_id = $1`, [op]);
    const result = (await db.asOne<{ r: { notifications_purged: number } }>(service, `select public.run_maintenance() as r`)).r;
    expect(result.notifications_purged).toBeGreaterThanOrEqual(1);
    expect(await mine(op)).toEqual([]);
  });
});
