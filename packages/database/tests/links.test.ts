/**
 * Link review: an admin approves every link (migration …018).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, user } from '../src/testing/index.ts';
import { TIER, createPost, ledgerTotal } from './helpers.ts';

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

const row = async (table: 'posts' | 'comments', id: string) =>
  db.sqlOne<{ status: string; links_pending: string[] | null; removal_reason: string | null }>(
    `select status, links_pending, removal_reason from public.${table} where id = $1`, [id]);

const hosts = async (text: string) =>
  (await db.sqlOne<{ h: string[] }>(`select private.link_hosts($1) as h`, [text])).h;

const decide = (kind: 'post' | 'comment', id: string, decision: 'approve' | 'decline') =>
  db.as(user(admin, 'aal2'), `select public.admin_link_decide($1, $2, $3, 'Checked the link')`, [kind, id, decision]);

const site = (host: string, decision: 'approve' | 'block' | 'unapprove') =>
  db.asOne<{ n: number }>(user(admin, 'aal2'), `select public.admin_link_site($1, $2, 'Checked the site') as n`, [host, decision]);

async function linkPost(author: string, url: string): Promise<string> {
  return createPost(db, author, { type: 'resource', body: '', link: url });
}

describe('finding links', () => {
  it('reads the host of every http, https and www link', async () => {
    expect(await hosts('See https://PubMed.ncbi.nlm.nih.gov/123, or www.Example.org/page. Also http://user@shop.test:8080/x'))
      .toEqual(['example.org', 'pubmed.ncbi.nlm.nih.gov', 'shop.test']);
    expect(await hosts('(https://www.canada.ca/en), "https://a.ca"; https://b.ca!')).toEqual(['a.ca', 'b.ca', 'canada.ca']);
    expect(await hosts('No links here: BPC-157 vs. TB-500, e.g. 5.5 mg, node.js')).toEqual([]);
  });

  it("counts hosts that aren't plain ASCII", async () => {
    expect(await hosts('https://vendör.example/x')).toEqual(['vendör.example']);
  });
});

describe('holding', () => {
  it('holds a link post for an admin, visible only to its author and staff', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await linkPost(author, 'https://www.cochranelibrary.com/cdsr/doi/10.1002/14651858');
    expect(await row('posts', post)).toMatchObject({ status: 'held', links_pending: ['cochranelibrary.com'] });

    expect(await db.as(anon, `select id from public.get_feed() where id = $1`, [post])).toEqual([]);
    expect(await db.as(user(author), `select id from public.get_post($1)`, [post])).toHaveLength(1);

    const { r } = await db.asOne<{ r: { pending: Array<{ target_id: string; hosts: string[]; urls: string[] }> } }>(
      user(admin, 'aal2'), `select public.admin_links() as r`);
    expect(r.pending.find((i) => i.target_id === post)).toMatchObject({
      hosts: ['cochranelibrary.com'], urls: ['https://www.cochranelibrary.com/cdsr/doi/10.1002/14651858'],
    });
  });

  it('holds text posts and comments with a link in the body, but not ones without', async () => {
    const author = await db.createUser();
    const plain = await createPost(db, author, { body: 'No links, just a question about trial design.' });
    expect((await row('posts', plain)).status).toBe('visible');

    const withLink = await createPost(db, author, { body: 'Found this: www.example-clinic.ca/peptides' });
    expect(await row('posts', withLink)).toMatchObject({ status: 'held', links_pending: ['example-clinic.ca'] });

    const { id } = await db.asOne<{ id: string }>(user(author), `select public.create_comment($1, 'Source: https://pubmed.ncbi.nlm.nih.gov/1') as id`, [plain]);
    expect(await row('comments', id)).toMatchObject({ status: 'held', links_pending: ['pubmed.ncbi.nlm.nih.gov'] });
    expect(await db.as(anon, `select id from public.get_comments($1) where id = $2`, [plain, id])).toEqual([]);
  });

  it('exempts moderators and admins, and can be switched off', async () => {
    const mod = await db.createUser({ karma: TIER.contributor });
    await db.sql(`insert into public.zone_moderators (zone_id, user_id) values ('on', $1)`, [mod]);
    expect((await row('posts', await linkPost(mod, 'https://staff-link.example/a'))).status).toBe('visible');
    expect((await row('posts', await linkPost(admin, 'https://staff-link.example/b'))).status).toBe('visible');

    await db.sql(`update public.app_config set value = 'false' where key = 'links.require_approval'`);
    const author = await db.createUser({ karma: TIER.member });
    expect((await row('posts', await linkPost(author, 'https://review-off.example/a'))).status).toBe('visible');
    await db.sql(`update public.app_config set value = 'true' where key = 'links.require_approval'`);
  });

  it('still refuses blocked domains before looking at links', async () => {
    await db.sql(`insert into public.shield_domains (domain) values ('blocked-vendor.example')`);
    const error = await db.expectError(user(await db.createUser({ karma: TIER.member })),
      `select public.create_post('on', 'research', 'resource', 'A link to a vendor here', '', 'https://shop.blocked-vendor.example/x')`);
    expect(error.message).toBe('blocked_by_shield');
  });
});

describe('deciding one item', () => {
  it('approve publishes it, and later edits keep the approved link', async () => {
    const author = await db.createUser();
    const post = await createPost(db, author, { body: 'Read https://one-off.example/report first.' });
    await decide('post', post, 'approve');
    expect(await row('posts', post)).toMatchObject({ status: 'visible', links_pending: null });

    await db.as(user(author), `select public.edit_post($1, $2, $3, null)`,
      [post, 'A sufficiently descriptive title', 'Read https://one-off.example/report first. Edited for clarity.']);
    expect((await row('posts', post)).status).toBe('visible');

    await db.as(user(author), `select public.edit_post($1, $2, $3, null)`,
      [post, 'A sufficiently descriptive title', 'Now also https://new-link.example/x']);
    expect(await row('posts', post)).toMatchObject({ status: 'held', links_pending: ['new-link.example'] });
  });

  it('decline removes it with no karma penalty or strike', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const before = await ledgerTotal(db, author, 'karma');
    const post = await linkPost(author, 'https://doubtful.example/buy');
    await decide('post', post, 'decline');
    expect(await row('posts', post)).toMatchObject({ status: 'removed', removal_reason: 'link_declined' });
    expect(await ledgerTotal(db, author, 'karma')).toBe(before);
    expect((await db.sqlOne<{ n: number }>(`select count(*)::int as n from public.strikes where user_id = $1`, [author])).n).toBe(0);
    const log = await db.sqlOne(`select action, actor_id from public.mod_actions where target_id = $1 order by created_at desc limit 1`, [post]);
    expect(log).toEqual({ action: 'link_declined', actor_id: admin });
  });

  it('refuses items that are not waiting', async () => {
    const post = await createPost(db, await db.createUser(), { body: 'No link at all.' });
    const error = await db.expectError(user(admin, 'aal2'), `select public.admin_link_decide('post', $1, 'approve', 'Checked')`, [post]);
    expect(error).toMatchObject({ code: 'PF409', message: 'not_pending' });
  });
});

describe('deciding a whole site', () => {
  it('approve publishes every waiting item from it, and future links to it and its subdomains pass', async () => {
    const a = await linkPost(await db.createUser({ karma: TIER.member }), 'https://www.trusted-journal.example/a');
    const b = await createPost(db, await db.createUser(), { body: 'See https://sub.trusted-journal.example/b and https://other.example/c' });
    const { n } = await site('https://www.trusted-journal.example/a', 'approve');
    expect(n).toBe(1);
    expect((await row('posts', a)).status).toBe('visible');
    // b still links to an unapproved site.
    expect(await row('posts', b)).toMatchObject({ status: 'held', links_pending: ['other.example'] });

    const c = await linkPost(await db.createUser({ karma: TIER.member }), 'https://trusted-journal.example/c');
    expect((await row('posts', c)).status).toBe('visible');

    await site('trusted-journal.example', 'unapprove');
    const d = await linkPost(await db.createUser({ karma: TIER.member }), 'https://trusted-journal.example/d');
    expect((await row('posts', d)).status).toBe('held');
  });

  it('block declines every waiting item from it and refuses new ones', async () => {
    const author = await db.createUser({ karma: TIER.member });
    const post = await linkPost(author, 'https://spam-vendor.example/deal');
    const { n } = await site('spam-vendor.example', 'block');
    expect(n).toBe(1);
    expect(await row('posts', post)).toMatchObject({ status: 'removed', removal_reason: 'link_declined' });
    const error = await db.expectError(user(author),
      `select public.create_post('on', 'research', 'resource', 'Another vendor link here', '', 'https://spam-vendor.example/2')`);
    expect(error.message).toBe('blocked_by_shield');
  });
});

describe('with the shield', () => {
  it('publishes only when both the shield hold and the link are cleared', async () => {
    const mod = await db.createUser({ karma: TIER.contributor });
    await db.sql(`insert into public.zone_moderators (zone_id, user_id) values ('on', $1)`, [mod]);
    const post = await createPost(db, await db.createUser(), { body: 'DM me, or see https://both-holds.example/x' });
    expect(await db.sqlOne(`select status, held_reason, links_pending from public.posts where id = $1`, [post]))
      .toEqual({ status: 'held', held_reason: 'dm me', links_pending: ['both-holds.example'] });

    // The moderator keeps it: it leaves their queue but waits for the link.
    await db.as(user(mod, 'aal2'), `select public.resolve_reports('post', $1, 'keep', null, 'Context is fine')`, [post]);
    expect((await row('posts', post)).status).toBe('held');
    const { q } = await db.asOne<{ q: Array<{ target_id: string }> }>(user(mod, 'aal2'), `select public.mod_queue('on') as q`);
    expect(q.some((i) => i.target_id === post)).toBe(false);

    await decide('post', post, 'approve');
    expect((await row('posts', post)).status).toBe('visible');
  });

  it('keeps link-only holds out of the moderators’ queue and the shield counts', async () => {
    const post = await linkPost(await db.createUser({ karma: TIER.member }), 'https://queue-check.example/x');
    const { q } = await db.asOne<{ q: Array<{ target_id: string }> }>(user(admin, 'aal2'), `select public.mod_queue(null) as q`);
    expect(q.some((i) => i.target_id === post)).toBe(false);
    const { o } = await db.asOne<{ o: { links_pending: number } }>(user(admin, 'aal2'), `select public.admin_overview() as o`);
    expect(o.links_pending).toBeGreaterThan(0);
  });

  it('a restored decline goes back to link review instead of going live', async () => {
    const post = await linkPost(await db.createUser({ karma: TIER.member }), 'https://restore-check.example/x');
    await decide('post', post, 'decline');
    await db.as(user(admin, 'aal2'), `select public.admin_restore_content('post', $1, 'Declined by mistake')`, [post]);
    expect(await row('posts', post)).toMatchObject({ status: 'held', links_pending: ['restore-check.example'] });
  });
});

describe('access', () => {
  it('only admins in an MFA session can read or decide', async () => {
    const member = await db.createUser({ karma: TIER.contributor });
    const post = await linkPost(await db.createUser({ karma: TIER.member }), 'https://access-check.example/x');
    for (const actor of [anon, user(member, 'aal2'), user(admin, 'aal1')]) {
      await expect(db.as(actor, `select public.admin_links()`)).rejects.toThrow();
      await expect(db.as(actor, `select public.admin_link_decide('post', $1, 'approve', 'Checked')`, [post])).rejects.toThrow();
      await expect(db.as(actor, `select public.admin_link_site('access-check.example', 'approve', 'Checked')`)).rejects.toThrow();
    }
    const error = await db.expectError(user(admin, 'aal2'), `select public.admin_link_decide('post', $1, 'approve', '')`, [post]);
    expect(error.message).toBe('reason_required');
  });
});
