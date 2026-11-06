/**
 * Member reports (migration …019): members report another member; admins
 * get the reports as tickets, grouped per reported member.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, user } from '../src/testing/index.ts';
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

type Tickets = {
  open: Array<{ username: string; reports: Array<{ reason: string; details: string; reporter: string }>; actioned_before: number }>;
  recent: Array<{ username: string; outcome: string; reason: string; reports: number; by: string }>;
  actioned_30d: number;
};

const report = (reporter: string, username: string, reason = 'harassment', details = '') =>
  db.as(user(reporter), `select public.report_member($1, $2, $3)`, [username, reason, details]);

const tickets = async () => (await db.asOne<{ r: Tickets }>(user(admin, 'aal2'), `select public.admin_member_reports() as r`)).r;

const resolve = (target: string, outcome: 'actioned' | 'dismissed', reason = 'Looked into it') =>
  db.asOne<{ n: number }>(user(admin, 'aal2'), `select public.admin_resolve_member_reports($1, $2, $3) as n`, [target, outcome, reason]);

const usernameOf = async (id: string) => (await db.profile(id)).username as string;

describe('reporting a member', () => {
  it('files a private ticket that admins see grouped per member', async () => {
    const target = await db.createUser({ username: 'reported_one' });
    const a = await db.createUser();
    const b = await db.createUser();
    await report(a, 'Reported_One', 'sourcing', 'Keeps DMing people a vendor link.');
    await report(b, 'reported_one', 'spam');

    const ticket = (await tickets()).open.find((t) => t.username === 'reported_one');
    expect(ticket?.reports.map((r) => r.reason)).toEqual(['sourcing', 'spam']);
    expect(ticket?.reports[0]).toMatchObject({ details: 'Keeps DMing people a vendor link.', reporter: await usernameOf(a) });

    // Nobody reads the table directly: not the reporter, not the reported member.
    for (const actor of [anon, user(a), user(target)]) {
      expect((await db.expectError(actor, `select * from public.member_reports`)).code).toBe('42501');
    }
  });

  it('refuses yourself, unknown or deleted members, bad reasons and duplicates', async () => {
    const me = await db.createUser({ username: 'self_reporter' });
    expect((await db.expectError(user(me), `select public.report_member('self_reporter', 'spam')`)).message).toBe('report_self');
    expect((await db.expectError(user(me), `select public.report_member('nobody_here', 'spam')`)).code).toBe('PF404');
    expect((await db.expectError(user(me), `select public.report_member('admin_x', 'rude')`)).code).toBe('PF404');

    await db.createUser({ username: 'dup_target' });
    expect((await db.expectError(user(me), `select public.report_member('dup_target', 'rude')`)).message).toBe('invalid_reason');
    expect((await db.expectError(user(me), `select public.report_member('dup_target', 'other', $1)`, ['x'.repeat(1001)])).message)
      .toBe('invalid_details');
    await report(me, 'dup_target');
    expect((await db.expectError(user(me), `select public.report_member('dup_target', 'spam')`)).message).toBe('already_reported');

    expect((await db.expectError(anon, `select public.report_member('dup_target', 'spam')`)).code).toMatch(/^(42501|PF401)$/);
    const unconfirmed = await db.createUser({ emailConfirmed: false });
    expect((await db.expectError(user(unconfirmed), `select public.report_member('dup_target', 'spam')`)).detail)
      .toBe('report:email_unconfirmed');
  });

  it('is rate limited per reporter', async () => {
    const reporter = await db.createUser();
    for (let i = 0; i < 5; i++) {
      const target = await db.createUser();
      await report(reporter, await usernameOf(target));
    }
    const sixth = await db.createUser();
    const error = await db.expectError(user(reporter), `select public.report_member($1, 'spam')`, [await usernameOf(sixth)]);
    expect(error).toMatchObject({ code: 'PF429', detail: 'report_member' });
  });
});

describe('resolving tickets', () => {
  it('closes every open report about the member at once, logs it, and lets members report again', async () => {
    const target = await db.createUser({ username: 'resolve_me' });
    const a = await db.createUser();
    await report(a, 'resolve_me');
    await report(await db.createUser(), 'resolve_me', 'impersonation');

    expect((await resolve(target, 'actioned', 'Suspended for a week')).n).toBe(2);
    const t = await tickets();
    expect(t.open.some((x) => x.username === 'resolve_me')).toBe(false);
    expect(t.recent[0]).toMatchObject({ username: 'resolve_me', outcome: 'actioned', reason: 'Suspended for a week', reports: 2 });
    expect(t.actioned_30d).toBeGreaterThan(0);

    // Reporting again opens a new ticket that remembers the earlier action.
    await report(a, 'resolve_me');
    expect((await tickets()).open.find((x) => x.username === 'resolve_me')?.actioned_before).toBe(1);

    expect((await resolve(target, 'dismissed')).n).toBe(1);
    expect((await db.expectError(user(admin, 'aal2'), `select public.admin_resolve_member_reports($1, 'dismissed', 'Again')`, [target])).message)
      .toBe('not_pending');
  });

  it('needs a reason, a valid outcome, and an admin who is not the subject', async () => {
    const target = await db.createUser();
    await report(await db.createUser(), await usernameOf(target));
    expect((await db.expectError(user(admin, 'aal2'), `select public.admin_resolve_member_reports($1, 'actioned', ' ')`, [target])).message)
      .toBe('reason_required');
    expect((await db.expectError(user(admin, 'aal2'), `select public.admin_resolve_member_reports($1, 'ignored', 'Hmm')`, [target])).message)
      .toBe('invalid_outcome');

    await report(await db.createUser(), await usernameOf(admin));
    expect((await db.expectError(user(admin, 'aal2'), `select public.admin_resolve_member_reports($1, 'dismissed', 'Not me')`, [admin])).message)
      .toBe('conflict_of_interest');
  });

  it('only admins in an MFA session can read or resolve', async () => {
    const member = await db.createUser({ karma: TIER.contributor });
    const mod = await db.createUser({ karma: TIER.contributor });
    await db.sql(`insert into public.zone_moderators (zone_id, user_id) values ('on', $1)`, [mod]);
    const target = await db.createUser();
    for (const actor of [anon, user(member, 'aal2'), user(mod, 'aal2'), user(admin, 'aal1')]) {
      await expect(db.as(actor, `select public.admin_member_reports()`)).rejects.toThrow();
      await expect(db.as(actor, `select public.admin_resolve_member_reports($1, 'dismissed', 'Checked')`, [target])).rejects.toThrow();
    }
  });
});

describe('privacy', () => {
  it('the reporter’s export lists their reports without the admin who resolved them', async () => {
    const reporter = await db.createUser();
    const target = await db.createUser();
    await report(reporter, await usernameOf(target), 'privacy', 'Posted my address.');
    await resolve(target, 'actioned');
    const { data } = await db.asOne<{ data: { member_reports_filed: Array<Record<string, unknown>> } }>(
      user(reporter), `select public.export_my_data() as data`);
    expect(data.member_reports_filed).toHaveLength(1);
    expect(data.member_reports_filed[0]).toMatchObject({ reason: 'privacy', details: 'Posted my address.', status: 'actioned' });
    expect(data.member_reports_filed[0]).not.toHaveProperty('resolved_by');

    const theirs = await db.asOne<{ data: { member_reports_filed: unknown[] } }>(user(target), `select public.export_my_data() as data`);
    expect(theirs.data.member_reports_filed).toEqual([]);
  });
});
