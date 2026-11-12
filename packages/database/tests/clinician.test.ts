/**
 * Clinician verification (migration …024): a member submits credentials, an
 * admin decides, the only public effect is a badge, and private details stay
 * private.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, user } from '../src/testing/index.ts';
import { TIER, createPost } from './helpers.ts';

let db: TestDb;
let admin: string;

type Mine = { badge: string | null; latest: { id: string; status: string; review_note: string; expires_at: string | null } | null };
type Queue = { rows: Array<{ id: string; member: string; registration_number: string; status: string; document_id: string }>; counts: Record<string, number> };

beforeAll(async () => {
  db = await TestDb.create();
  admin = await db.createUser({ karma: TIER.contributor, username: 'clin_admin' });
  await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [admin]);
});

afterAll(async () => {
  await db.close();
});

async function credential(member: string): Promise<string> {
  const { r } = await db.asOne<{ r: { id: string } }>(user(member), `select public.register_upload('credential', 'application/pdf', 240000) as r`);
  await db.as(user(member), `select public.confirm_upload($1)`, [r.id]);
  return r.id;
}
const submit = async (member: string, doc: string, profession = 'pharmacist') =>
  (await db.asOne<{ id: string }>(user(member), `select public.submit_clinician_verification($1, 'Ontario College of Pharmacists', 'CA', 'OCP-123456', $2, 'Community pharmacist since 2015.') as id`, [profession, doc])).id;
const mine = async (member: string) => (await db.asOne<{ r: Mine }>(user(member), `select public.my_clinician_verification() as r`)).r;
const queue = async (filter = 'pending') => (await db.asOne<{ r: Queue }>(user(admin, 'aal2'), `select public.admin_clinician_verifications($1) as r`, [filter])).r;
const review = (id: string, decision: 'approve' | 'reject', reason = 'Registration confirmed on the regulator’s public register') =>
  db.as(user(admin, 'aal2'), `select public.admin_review_clinician($1, $2, $3)`, [id, decision, reason]);
const profile = async (username: string) => (await db.asOne<{ p: { clinician: string | null } }>(anon, `select public.get_profile($1) as p`, [username])).p;

describe('submitting', () => {
  it('needs a private credential document and sane fields', async () => {
    const member = await db.createUser({ username: 'rx_sam' });
    expect((await db.expectError(user(member), `select public.submit_clinician_verification('pharmacist', 'OCP', 'CA', 'OCP-1', gen_random_uuid(), '')`)).code).toBe('PF404');
    const doc = await credential(member);
    expect((await db.expectError(user(member), `select public.submit_clinician_verification('wizard', 'OCP', 'CA', 'OCP-1', $1, '')`, [doc])).message).toBe('invalid_profession');
    expect((await db.expectError(user(member), `select public.submit_clinician_verification('pharmacist', 'OCP', 'Canada', 'OCP-1', $1, '')`, [doc])).message).toBe('invalid_country');

    // Someone else's document can't be used, even if they know its id.
    const other = await db.createUser();
    expect((await db.expectError(user(other), `select public.submit_clinician_verification('pharmacist', 'OCP', 'CA', 'OCP-1', $1, '')`, [doc])).code).toBe('PF404');

    const id = await submit(member, doc);
    expect(await mine(member)).toMatchObject({ badge: null, latest: { id, status: 'pending' } });
    expect((await db.expectError(user(member), `select public.submit_clinician_verification('pharmacist', 'OCP', 'CA', 'OCP-1', $1, '')`, [doc])).message).toBe('already_pending');

    // The document is visible to its owner and admins (MFA), to nobody else.
    const access = (actor: ReturnType<typeof user> | typeof anon) =>
      db.asOne<{ r: unknown }>(actor, `select public.get_media_access($1) as r`, [doc]);
    expect((await access(user(member))).r).not.toBeNull();
    expect((await access(user(admin, 'aal2'))).r).not.toBeNull();
    expect((await access(user(admin, 'aal1'))).r).toBeNull();
    expect((await access(user(other))).r).toBeNull();
    expect((await access(anon)).r).toBeNull();

    await db.as(user(member), `select public.withdraw_clinician_verification()`);
    expect((await mine(member)).latest?.status).toBe('withdrawn');
  });
});

describe('review', () => {
  it('approval shows a badge on profile, posts and comments; registration numbers stay with admins', async () => {
    const member = await db.createUser({ username: 'np_jules', karma: TIER.member });
    const doc = await credential(member);
    const id = await submit(member, doc, 'nurse_practitioner');
    const post = await createPost(db, member, { title: 'How I read a certificate of analysis' });
    const { id: comment } = await db.asOne<{ id: string }>(user(member), `select public.create_comment($1, 'Adding a detail.') as id`, [post]);

    const pending = await queue();
    expect(pending.rows.find((r) => r.id === id)).toMatchObject({ member: 'np_jules', registration_number: 'OCP-123456', document_id: doc });
    expect((await db.expectError(user(member, 'aal2'), `select public.admin_clinician_verifications('pending')`)).code).toBe('PF403');
    expect((await db.expectError(anon, `select * from public.clinician_verifications`)).code).toBe('42501');

    expect((await profile('np_jules')).clinician).toBeNull();
    await review(id, 'approve');
    expect((await profile('np_jules')).clinician).toBe('nurse_practitioner');
    expect((await db.asOne<{ c: string }>(anon, `select author_clinician as c from public.get_post($1)`, [post])).c).toBe('nurse_practitioner');
    expect((await db.as<{ c: string }>(anon, `select author_clinician as c from public.get_comments($1)`, [post]))[0]?.c).toBe('nurse_practitioner');
    void comment;

    const me = await mine(member);
    expect(me.badge).toBe('nurse_practitioner');
    expect(me.latest).toMatchObject({ status: 'approved', review_note: 'Registration confirmed on the regulator’s public register' });
    expect(me.latest).not.toHaveProperty('reviewed_by');
    expect((await queue('approved')).counts.approved).toBeGreaterThanOrEqual(1);

    // Logged and notified, without naming the admin.
    expect(await db.sql(`select 1 from public.mod_actions where action = 'clinician_approved' and target_user_id = $1`, [member])).toHaveLength(1);
    const notes = (await db.asOne<{ n: Array<{ kind: string; action: string; actor: string | null }> }>(user(member), `select public.my_notifications() as n`)).n;
    expect(notes).toEqual([expect.objectContaining({ kind: 'clinician_review', action: 'approved', actor: null })]);

    // Nothing in the trust system moved.
    expect((await db.profile(member)).karma).toBe(TIER.member);
    expect((await db.expectError(user(admin, 'aal2'), `select public.admin_review_clinician($1, 'approve', 'Again')`, [id])).message).toBe('not_pending');
  });

  it('rejection and revocation remove the badge and explain why', async () => {
    const member = await db.createUser({ username: 'dr_nope' });
    const doc = await credential(member);
    const id = await submit(member, doc, 'physician');
    await review(id, 'reject', 'Number not found on the CPSO register');
    expect((await mine(member)).latest).toMatchObject({ status: 'rejected', review_note: 'Number not found on the CPSO register' });
    expect((await profile('dr_nope')).clinician).toBeNull();

    const doc2 = await credential(member);
    const id2 = await submit(member, doc2, 'physician');
    await review(id2, 'approve');
    expect((await profile('dr_nope')).clinician).toBe('physician');
    await db.as(user(admin, 'aal2'), `select public.admin_revoke_clinician($1, 'Licence suspended by the regulator')`, [member]);
    expect((await profile('dr_nope')).clinician).toBeNull();
    expect((await mine(member)).latest).toMatchObject({ status: 'revoked' });
    expect((await db.expectError(user(admin, 'aal2'), `select public.admin_revoke_clinician($1, 'Twice')`, [member])).code).toBe('PF404');
  });

  it('lapses after the validity period and admins can’t review their own request', async () => {
    const member = await db.createUser({ username: 'old_badge' });
    const doc = await credential(member);
    const id = await submit(member, doc);
    await review(id, 'approve');
    await db.sql(`update public.clinician_verifications set expires_at = now() - interval '1 day' where id = $1`, [id]);
    expect((await profile('old_badge')).clinician).toBeNull();
    expect((await mine(member)).latest?.status).toBe('expired');
    // Renewal is allowed once lapsed.
    const doc2 = await credential(member);
    await submit(member, doc2);

    const adminDoc = await credential(admin);
    const own = await submit(admin, adminDoc);
    expect((await db.expectError(user(admin, 'aal2'), `select public.admin_review_clinician($1, 'approve', 'Approving myself')`, [own])).message).toBe('conflict_of_interest');
  });

  it('goes with the account', async () => {
    const member = await db.createUser({ username: 'leaving_rx' });
    const doc = await credential(member);
    await submit(member, doc);
    await db.as(user(member), `select public.request_account_deletion(false)`);
    expect(await db.sql(`select 1 from public.clinician_verifications where user_id = $1`, [member])).toEqual([]);
  });
});
