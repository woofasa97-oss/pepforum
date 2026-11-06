/**
 * Verified social accounts and the capped audience bonus (migration …028).
 */
import { createHmac } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, user } from '../src/testing/index.ts';
import { TIER, ledgerTotal } from './helpers.ts';

let db: TestDb;
let admin: string;
const KEY = 'test-attestation-key-0123456789abcdef-0123';

beforeAll(async () => {
  db = await TestDb.create();
  admin = await db.createUser({ karma: TIER.contributor });
  await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [admin]);
});

afterAll(async () => {
  await db.close();
});

type Account = { platform: string; externalId: string; handle: string; audience: number; url?: string; metrics?: string; issuedAt?: number };

const now = () => Math.floor(Date.now() / 1000);

/** What apps/web/src/lib/socials.ts signs. */
function sign(member: string, a: Account, key = KEY): string {
  const message = ['pepforum-social-v1', member, a.platform, a.externalId, a.handle, String(a.audience),
    a.url ?? `https://x.com/${a.handle}`, a.metrics ?? '{}', String(a.issuedAt ?? now())].join('|');
  return createHmac('sha256', key).update(message).digest('hex');
}

const args = (a: Account, signature: string) =>
  [a.platform, a.externalId, a.handle, a.audience, a.url ?? `https://x.com/${a.handle}`, a.metrics ?? '{}', a.issuedAt ?? now(), signature];

const LINK = `select public.link_social_account($1, $2, $3, $4, $5, $6, $7, $8) as r`;
const link = async (member: string, a: Account) =>
  (await db.asOne<{ r: { bonus: number } }>(user(member), LINK, args(a, sign(member, a)))).r;
const linkError = (member: string, a: Account, signature = sign(member, a)) => db.expectError(user(member), LINK, args(a, signature));
const socials = async (member: string) =>
  (await db.asOne<{ p: { socials: Array<{ platform: string; handle: string; audience: number }> } }>(
    anon, `select public.get_profile($1) as p`, [(await db.profile(member)).username])).p.socials;

describe('signatures', () => {
  it('the SQL HMAC matches Node’s, for short and long keys', async () => {
    for (const key of ['k', KEY, 'x'.repeat(100)]) {
      const { h } = await db.sqlOne<{ h: string }>(
        `select encode(private.hmac_sha256(convert_to($1, 'UTF8'), convert_to($2, 'UTF8')), 'hex') as h`, [key, 'héllo|world']);
      expect(h).toBe(createHmac('sha256', key).update('héllo|world').digest('hex'));
    }
  });

  it('nothing is accepted until the owner sets the attestation key', async () => {
    const member = await db.createUser();
    expect((await linkError(member, { platform: 'x', externalId: '1', handle: 'early', audience: 5000 })).message).toBe('socials_not_configured');
    await db.sql(`insert into private.app_secrets (name, value) values ('social_attestation', $1)`, [KEY]);
    expect((await db.asOne<{ r: { configured: boolean } }>(user(member), `select public.my_social_accounts() as r`)).r.configured).toBe(true);
  });
});

describe('verifying an account', () => {
  it('shows a badge and pays a one-time, capped bonus for the largest audience', async () => {
    const member = await db.createUser({ username: 'big_audience' });
    expect((await link(member, { platform: 'x', externalId: 'x-100', handle: 'bigaud', audience: 999 })).bonus).toBe(0);
    expect((await link(member, { platform: 'x', externalId: 'x-100', handle: 'bigaud', audience: 1_000 })).bonus).toBe(25);
    expect((await link(member, { platform: 'youtube', externalId: 'UC1', handle: 'Big Aud', audience: 15_000, url: 'https://www.youtube.com/channel/UC1' })).bonus).toBe(50);
    expect((await link(member, { platform: 'reddit', externalId: 't2_1', handle: 'bigaud', audience: 250_000, url: 'https://www.reddit.com/user/bigaud' })).bonus).toBe(75);
    expect((await link(member, { platform: 'tiktok', externalId: 'tt1', handle: 'bigaud', audience: 50_000_000, url: 'https://www.tiktok.com/@bigaud' })).bonus).toBe(100);

    expect(await ledgerTotal(db, member, 'karma')).toBe(100);
    const reasons = await db.sql<{ reason: string }>(`select distinct reason from public.ledger_events where user_id = $1`, [member]);
    expect(reasons.map((r) => r.reason)).toEqual(['social_verified']);
    expect((await socials(member)).map((s) => s.platform)).toEqual(['tiktok', 'reddit', 'youtube', 'x']);

    // Removing the biggest one recomputes from what's left.
    expect((await db.asOne<{ n: number }>(user(member), `select public.unlink_social_account('tiktok') as n`)).n).toBe(75);
    expect(await ledgerTotal(db, member, 'karma')).toBe(75);
  });

  it('refuses forged, tampered, borrowed and stale attestations', async () => {
    const member = await db.createUser();
    const other = await db.createUser();
    const a: Account = { platform: 'instagram', externalId: 'ig-7', handle: 'faker', audience: 2_000_000, url: 'https://www.instagram.com/faker' };

    expect((await linkError(member, a, sign(member, a, 'wrong-key-wrong-key-wrong-key-123'))).message).toBe('invalid_attestation');
    expect((await linkError(member, a, 'deadbeef')).message).toBe('invalid_attestation');
    // Signed for 2,000 followers, claimed 2,000,000.
    expect((await linkError(member, a, sign(member, { ...a, audience: 2_000 }))).message).toBe('invalid_attestation');
    // Signed for someone else.
    expect((await linkError(member, a, sign(other, a))).message).toBe('invalid_attestation');
    // Too old.
    const old = { ...a, issuedAt: now() - 3600 };
    expect((await linkError(member, old)).message).toBe('attestation_expired');
    expect((await linkError(member, { ...a, platform: 'myspace' })).message).toBe('invalid_kind');
    expect(await ledgerTotal(db, member, 'karma')).toBe(0);

    expect((await db.expectError(anon, LINK, args(a, sign(member, a)))).code).toMatch(/^(42501|PF401)$/);
    for (const actor of [anon, user(member)]) {
      expect((await db.expectError(actor, `select * from public.social_accounts`)).code).toBe('42501');
    }
  });

  it('one network account backs one Pepforum account', async () => {
    const first = await db.createUser();
    const second = await db.createUser();
    const a: Account = { platform: 'x', externalId: 'x-shared', handle: 'shared', audience: 10_000 };
    await link(first, a);
    expect((await linkError(second, a)).message).toBe('social_taken');
  });

  it('is rate limited', async () => {
    const member = await db.createUser();
    for (let i = 0; i < 10; i++) await link(member, { platform: 'x', externalId: `x-rl-${member}`, handle: 'rl', audience: i });
    expect(await linkError(member, { platform: 'x', externalId: `x-rl-${member}`, handle: 'rl', audience: 11 }))
      .toMatchObject({ code: 'PF429', detail: 'social_link' });
  });
});

describe('admins', () => {
  it('can take a verified account off a profile; the bonus goes with it and it is logged', async () => {
    const vendor = await db.createUser();
    await link(vendor, { platform: 'instagram', externalId: 'ig-vendor', handle: 'peptide_shop', audience: 80_000, url: 'https://www.instagram.com/peptide_shop' });
    expect(await ledgerTotal(db, vendor, 'karma')).toBe(50);

    const member = await db.createUser();
    expect((await db.expectError(user(member, 'aal2'), `select public.admin_unlink_social($1, 'instagram', 'Vendor')`, [vendor])).message).toBe('not_admin');
    await db.as(user(admin, 'aal2'), `select public.admin_unlink_social($1, 'instagram', 'Vendor account')`, [vendor]);
    expect(await ledgerTotal(db, vendor, 'karma')).toBe(0);
    expect(await socials(vendor)).toEqual([]);
    expect(await db.sqlOne(`select action, reason, metadata from public.mod_actions where target_user_id = $1 order by created_at desc limit 1`, [vendor]))
      .toEqual({ action: 'social_unlinked', reason: 'Vendor account', metadata: { platform: 'instagram', handle: 'peptide_shop' } });
  });
});

describe('privacy', () => {
  it('the export lists verified accounts; deleting the account releases them', async () => {
    const leaver = await db.createUser();
    const a: Account = { platform: 'reddit', externalId: 't2_leaver', handle: 'leaver', audience: 3_000, url: 'https://www.reddit.com/user/leaver' };
    await link(leaver, a);
    const { data } = await db.asOne<{ data: { social_accounts: Array<Record<string, unknown>> } }>(user(leaver), `select public.export_my_data() as data`);
    expect(data.social_accounts).toEqual([expect.objectContaining({ platform: 'reddit', handle: 'leaver', audience: 3000 })]);
    expect(data.social_accounts[0]).not.toHaveProperty('user_id');

    await db.as(user(leaver), `select public.request_account_deletion(false)`);
    const newcomer = await db.createUser();
    expect((await link(newcomer, a)).bonus).toBe(25);
  });
});
