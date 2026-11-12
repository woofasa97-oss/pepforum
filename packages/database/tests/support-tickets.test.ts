/**
 * Contact the team (migration …020): members open private tickets
 * (suggestions, reports, help) and talk with the admins in one thread.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, user } from '../src/testing/index.ts';
import { TIER } from './helpers.ts';

let db: TestDb;
let admin: string;

beforeAll(async () => {
  db = await TestDb.create();
  admin = await db.createUser({ karma: TIER.contributor, username: 'inbox_admin' });
  await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [admin]);
});

afterAll(async () => {
  await db.close();
});

type Summary = { id: string; status: string; unread: boolean; messages: number; subject: string };
type Thread = { status: string; closed_by_team: boolean; about_username: string | null; messages: Array<Record<string, unknown>> };
type Inbox = {
  tickets: Array<{ id: string; member: string; kind: string; preview: string; last_from_staff: boolean; about: string | null }>;
  counts: { open: number; answered: number; closed_30d: number };
  open_by_kind: Record<string, number>;
};
type AdminThread = {
  status: string; is_self: boolean; closed_by: string | null; closed_by_member: boolean;
  member: { username: string }; messages: Array<{ body: string; from_staff: boolean; author: string }>;
};

const open = async (member: string, kind = 'suggestion', subject = 'Dark mode on the notes page', body = 'The notes page ignores the dark theme setting.',
  about: string | null = null, url: string | null = null) =>
  (await db.asOne<{ id: string }>(user(member), `select public.open_ticket($1, $2, $3, $4, $5) as id`, [kind, subject, body, about, url])).id;

const mine = async (member: string) => (await db.asOne<{ r: Summary[] }>(user(member), `select public.my_tickets() as r`)).r;
const thread = async (member: string, id: string) =>
  (await db.asOne<{ r: Thread | null }>(user(member), `select public.my_ticket($1) as r`, [id])).r;
const inbox = async (status = 'open', kind: string | null = null) =>
  (await db.asOne<{ r: Inbox }>(user(admin, 'aal2'), `select public.admin_tickets($1, $2) as r`, [status, kind])).r;
const adminThread = async (id: string) =>
  (await db.asOne<{ r: AdminThread }>(user(admin, 'aal2'), `select public.admin_ticket($1) as r`, [id])).r;
const reply = (id: string, body: string, close = false) =>
  db.as(user(admin, 'aal2'), `select public.admin_reply_ticket($1, $2, $3)`, [id, body, close]);
const unread = async (member: string) =>
  (await db.asOne<{ s: { support_unread: number } }>(user(member), `select public.my_standing() as s`)).s.support_unread;

describe('opening a ticket', () => {
  it('lands in the admin inbox and nowhere else', async () => {
    const member = await db.createUser({ username: 'has_an_idea' });
    const id = await open(member);

    expect(await mine(member)).toEqual([expect.objectContaining({ id, status: 'open', unread: false, messages: 1 })]);
    const row = (await inbox()).tickets.find((x) => x.id === id);
    expect(row).toMatchObject({ member: 'has_an_idea', kind: 'suggestion', preview: 'The notes page ignores the dark theme setting.', last_from_staff: false });
    expect((await inbox('open', 'bug')).tickets.some((x) => x.id === id)).toBe(false);

    // Nobody reads the tables directly, and other members can't open it.
    for (const actor of [anon, user(member), user(admin, 'aal2')]) {
      expect((await db.expectError(actor, `select * from public.support_tickets`)).code).toBe('42501');
      expect((await db.expectError(actor, `select * from public.support_messages`)).code).toBe('42501');
    }
    const stranger = await db.createUser();
    expect(await thread(stranger, id)).toBeNull();
    expect((await db.expectError(user(stranger), `select public.reply_ticket($1, 'Me too')`, [id])).code).toBe('PF404');
    expect((await db.expectError(user(stranger), `select public.close_my_ticket($1)`, [id])).code).toBe('PF404');
  });

  it('a report about a member names them for the admins', async () => {
    const member = await db.createUser();
    await db.createUser({ username: 'pushy_seller' });
    const id = await open(member, 'report_member', 'Selling in DMs', 'They message newcomers with a price list.', 'Pushy_Seller',
      'https://pepforums.com/u/pushy_seller');
    expect((await thread(member, id))?.about_username).toBe('pushy_seller');
    expect((await inbox()).tickets.find((x) => x.id === id)?.about).toBe('pushy_seller');
  });

  it('checks every field', async () => {
    const me = await db.createUser({ username: 'careful_writer' });
    const fail = async (args: unknown[]) =>
      (await db.expectError(user(me), `select public.open_ticket($1, $2, $3, $4, $5)`, args)).message;
    const body = 'Enough words to explain the problem.';
    expect(await fail(['praise', 'Hello there', body, null, null])).toBe('invalid_kind');
    expect(await fail(['bug', 'Hi', body, null, null])).toBe('invalid_subject');
    expect(await fail(['bug', 'Broken page', 'Too short', null, null])).toBe('invalid_body');
    expect(await fail(['bug', 'Broken page', body, null, 'http://pepforums.com/x'])).toBe('invalid_url');
    expect(await fail(['report_member', 'Report', body, 'careful_writer', null])).toBe('report_self');
    expect((await db.expectError(user(me), `select public.open_ticket('report_member', 'Report', $1, 'nobody_here')`, [body])).code).toBe('PF404');
    expect((await db.expectError(user(me), `select public.open_ticket('report_member', 'Report', $1)`, [body])).code).toBe('PF404');

    expect((await db.expectError(anon, `select public.open_ticket('bug', 'Broken page', $1)`, [body])).code).toMatch(/^(42501|PF401)$/);
    expect((await db.expectError(anon, `select public.my_tickets()`)).code).toMatch(/^(42501|PF401)$/);
    const unconfirmed = await db.createUser({ emailConfirmed: false });
    expect((await db.expectError(user(unconfirmed), `select public.open_ticket('bug', 'Broken page', $1)`, [body])).detail)
      .toBe('report:email_unconfirmed');
  });

  it('is rate limited per member', async () => {
    const member = await db.createUser();
    for (let i = 0; i < 5; i++) await open(member, 'suggestion', `Idea number ${i}`);
    const error = await db.expectError(user(member), `select public.open_ticket('suggestion', 'One more idea', 'And another thing to add.')`);
    expect(error).toMatchObject({ code: 'PF429', detail: 'open_ticket' });
  });
});

describe('the conversation', () => {
  it('admins answer as the team, members are told, and replying hands it back', async () => {
    const member = await db.createUser();
    const id = await open(member, 'account', 'Change my email', 'How do I change the email on my account?');

    await reply(id, 'Go to Settings, then Account.');
    expect(await unread(member)).toBe(1);
    expect((await mine(member))[0]).toMatchObject({ id, status: 'answered', unread: true, messages: 2 });
    expect((await inbox('answered')).tickets.some((x) => x.id === id)).toBe(true);

    // The member sees "the team", never which admin.
    const t = await thread(member, id);
    expect(t?.messages[1]).toEqual({ id: expect.any(String), body: 'Go to Settings, then Account.', from_staff: true, created_at: expect.any(String) });
    expect(await unread(member)).toBe(0);
    // Admins do see who wrote what.
    expect((await adminThread(id)).messages.map((m) => m.author)).toEqual([(await db.profile(member)).username, 'inbox_admin']);

    await db.as(user(member), `select public.reply_ticket($1, 'Found it, thanks!')`, [id]);
    expect((await adminThread(id)).status).toBe('open');
    expect((await db.expectError(user(member), `select public.reply_ticket($1, '   ')`, [id])).message).toBe('invalid_body');
  });

  it('closing: by the member, by an admin with or without a reply, and reopening', async () => {
    const member = await db.createUser();
    const a = await open(member, 'bug', 'Search is slow', 'Searching for BPC takes ten seconds.');
    await reply(a, 'Fixed in today’s update.', true);
    expect(await thread(member, a)).toMatchObject({ status: 'closed', closed_by_team: true });
    expect((await adminThread(a)).closed_by).toBe('inbox_admin');
    expect((await db.expectError(user(member), `select public.reply_ticket($1, 'Still slow')`, [a])).message).toBe('ticket_closed');

    // Reopening hands it to whoever speaks next: the team spoke last, so the member.
    await db.as(user(admin, 'aal2'), `select public.admin_set_ticket_closed($1, false)`, [a]);
    expect((await adminThread(a)).status).toBe('answered');
    await db.as(user(member), `select public.reply_ticket($1, 'Still slow on my phone.')`, [a]);
    await db.as(user(admin, 'aal2'), `select public.admin_set_ticket_closed($1, true)`, [a]);
    await db.as(user(admin, 'aal2'), `select public.admin_set_ticket_closed($1, true)`, [a]); // twice changes nothing
    await db.as(user(admin, 'aal2'), `select public.admin_set_ticket_closed($1, false)`, [a]);
    expect((await adminThread(a)).status).toBe('open');

    const b = await open(member, 'other', 'Never mind', 'I worked it out on my own, sorry.');
    await db.as(user(member), `select public.close_my_ticket($1)`, [b]);
    expect(await adminThread(b)).toMatchObject({ status: 'closed', closed_by_member: true });
    expect(await thread(member, b)).toMatchObject({ closed_by_team: false });
    expect((await db.expectError(user(member), `select public.close_my_ticket($1)`, [b])).message).toBe('ticket_closed');
    const closed = await inbox('closed');
    expect(closed.tickets.map((x) => x.id)).toContain(b);
    expect(closed.tickets.map((x) => x.id)).not.toContain(a);
    expect(closed.counts.closed_30d).toBeGreaterThanOrEqual(1);
  });

  it('an admin can’t answer or close their own ticket', async () => {
    const id = await open(admin, 'suggestion', 'Weekly digest', 'An email digest of the week’s top notes.');
    expect((await adminThread(id)).is_self).toBe(true);
    expect((await db.expectError(user(admin, 'aal2'), `select public.admin_reply_ticket($1, 'Sure!')`, [id])).message).toBe('conflict_of_interest');
    expect((await db.expectError(user(admin, 'aal2'), `select public.admin_set_ticket_closed($1, true)`, [id])).message).toBe('conflict_of_interest');
  });

  it('the admin overview counts tickets waiting for the team', async () => {
    const before = (await db.asOne<{ o: { tickets_open: number } }>(user(admin, 'aal2'), `select public.admin_overview() as o`)).o.tickets_open;
    const id = await open(await db.createUser());
    const after = await db.asOne<{ o: { tickets_open: number; tickets_oldest: string } }>(user(admin, 'aal2'), `select public.admin_overview() as o`);
    expect(after.o.tickets_open).toBe(before + 1);
    expect(after.o.tickets_oldest).not.toBeNull();
    await reply(id, 'Thanks, noted.');
    expect((await db.asOne<{ o: { tickets_open: number } }>(user(admin, 'aal2'), `select public.admin_overview() as o`)).o.tickets_open).toBe(before);
  });
});

describe('privacy', () => {
  it('the export includes the member’s tickets, without which admin replied', async () => {
    const member = await db.createUser();
    const id = await open(member, 'account', 'Data question', 'What do you keep about me?');
    await reply(id, 'Everything is listed in the privacy policy.', true);
    const { data } = await db.asOne<{ data: { support_tickets: Array<Record<string, unknown> & { messages: unknown[] }> } }>(
      user(member), `select public.export_my_data() as data`);
    expect(data.support_tickets).toHaveLength(1);
    expect(data.support_tickets[0]).toMatchObject({ subject: 'Data question', status: 'closed' });
    expect(data.support_tickets[0]).not.toHaveProperty('closed_by');
    expect(data.support_tickets[0]?.messages).toEqual([
      { body: 'What do you keep about me?', from_team: false, created_at: expect.any(String) },
      { body: 'Everything is listed in the privacy policy.', from_team: true, created_at: expect.any(String) },
    ]);
  });

  it('deleting the account deletes the member’s tickets', async () => {
    const member = await db.createUser();
    const id = await open(member, 'bug', 'Typo on the home page', 'The French home page says “forumm”.');
    await reply(id, 'Thanks!');
    await db.as(user(member), `select public.request_account_deletion(false)`);
    const { n } = await db.sqlOne<{ n: number }>(
      `select (select count(*) from public.support_tickets where id = $1) + (select count(*) from public.support_messages where ticket_id = $1) as n`, [id]);
    expect(Number(n)).toBe(0);
  });
});
