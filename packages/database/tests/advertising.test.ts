/**
 * Advertising (migration …025): prepaid credit on an append-only ledger,
 * reserve-on-submit, admin review, dedup'd impressions, daily settlement.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, service, user } from '../src/testing/index.ts';
import { TIER } from './helpers.ts';

let db: TestDb;
let admin: string;

const CAD = 1_000_000; // microCAD
type Workspace = {
  id: string; status: string; balance: number; reserved: number; available: number;
  campaigns: Array<{ id: string; status: string; reserved: number; spent: number; cpm: number; impressions: number; clicks: number; review_note: string; ends_on: string | null;
                     days: Array<{ day: string; impressions: number; charged: number; settled: boolean }> }>;
  ledger: Array<{ kind: string; amount: number; reference: string }>;
};
type Ad = { id: string; headline: string; body: string; cta: string; advertiser: string } | null;

beforeAll(async () => {
  db = await TestDb.create();
  admin = await db.createUser({ karma: TIER.contributor, username: 'ads_admin' });
  await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [admin]);
  await db.setConfig('ads.enabled', true);
});

afterAll(async () => {
  await db.close();
});

const A2 = () => user(admin, 'aal2');
const createAdvertiser = async (member: string, name = 'Maple Labs Inc.', site = 'https://maplelabs.example') =>
  (await db.asOne<{ id: string }>(user(member), `select public.create_advertiser($1, $2, 'billing@maplelabs.example', '1 Bay St', 'CA') as id`, [name, site])).id;
const workspace = async (member: string) => (await db.asOne<{ w: Workspace | null }>(user(member), `select public.my_advertiser() as w`)).w;
const pay = (advertiser: string, cad: number, reference: string) =>
  db.asOne<{ id: number }>(A2(), `select public.admin_record_ad_payment($1, $2, $3, 'Invoice paid by e-transfer') as id`, [advertiser, cad * CAD, reference]);
const upsert = async (member: string, fields: Record<string, unknown> = {}) => {
  const f = {
    id: null, name: 'Spring awareness', package: 'category', category: 'research', budget: 2000 * CAD,
    headline: 'Free CoA literacy workshop', body: 'A two-hour evening session on reading certificates of analysis. No products sold.', cta: 'Reserve a seat',
    headline_fr: 'Atelier gratuit sur les certificats', body_fr: 'Une séance de deux heures en soirée sur la lecture des certificats d’analyse. Rien à vendre.', cta_fr: 'Réserver une place', landing: 'https://maplelabs.example/workshop', image: null, ...fields,
  };
  return (await db.asOne<{ id: string }>(user(member), `select public.upsert_campaign($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) as id`,
    [f.id, f.name, f.package, f.category, f.budget, f.headline, f.body, f.cta, f.headline_fr, f.body_fr, f.cta_fr, f.landing, f.image])).id;
};
const submit = (member: string, id: string) => db.as(user(member), `select public.submit_campaign($1)`, [id]);
const review = (id: string, decision: 'approve' | 'reject', reason = 'Copy and landing page checked: no sales, no claims') =>
  db.as(A2(), `select public.admin_review_campaign($1, $2, $3)`, [id, decision, reason]);
const getAd = async (pkg: string, target: string | null, visitor: string, locale = 'en') =>
  (await db.asOne<{ ad: Ad }>(anon, `select public.get_ad($1, $2, $3, $4) as ad`, [pkg, target, visitor, locale])).ad;
const settle = async (until: string) => (await db.asOne<{ r: Record<string, number> }>(service, `select public.settle_ads($1::date) as r`, [until])).r;

describe('advertiser organisations', () => {
  it('start pending, are approved by an admin, and keep one ledger', async () => {
    const owner = await db.createUser({ username: 'maple_marketing' });
    const id = await createAdvertiser(owner);
    expect(await workspace(owner)).toMatchObject({ id, status: 'pending', balance: 0, available: 0 });
    expect((await db.expectError(user(owner), `select public.create_advertiser('Twice', 'https://x.example', 'a@b.co', '', 'CA')`)).message).toBe('already_advertiser');

    // Direct table access is impossible; the ledger is append-only even for the owner role.
    for (const actor of [anon, user(owner), A2()]) {
      expect((await db.expectError(actor, `select * from public.advertisers`)).code).toBe('42501');
      expect((await db.expectError(actor, `select * from public.ad_ledger`)).code).toBe('42501');
    }
    await db.as(A2(), `select public.admin_review_advertiser($1, 'approve', 'Registered Ontario business, non-vendor')`, [id]);
    expect((await workspace(owner))?.status).toBe('active');

    await pay(id, 2500, 'INV-2026-001');
    expect((await db.expectError(A2(), `select public.admin_record_ad_payment($1, $2, 'INV-2026-001', 'Paid again?')`, [id, 10 * CAD])).message).toBe('duplicate_reference');
    expect(await workspace(owner)).toMatchObject({ balance: 2500 * CAD, available: 2500 * CAD });
    await expect(db.sql(`update public.ad_ledger set amount_microcad = 1 where advertiser_id = $1`, [id])).rejects.toThrow(/append_only/);
    expect(await db.sql(`select 1 from public.mod_actions where action = 'ad_payment_recorded' and target_id = $1`, [id])).toHaveLength(1);
  });

  it('refuse vendor domains the sourcing shield blocks', async () => {
    const owner = await db.createUser();
    await db.as(A2(), `select public.admin_shield_add('domain', 'cheap-peptides.example', null, 'Vendor')`);
    expect((await db.expectError(user(owner), `select public.create_advertiser('Cheap Peptides', 'https://cheap-peptides.example', 'a@b.co', '', 'CA')`)).message).toBe('blocked_by_shield');
  });
});

describe('campaigns', () => {
  let owner: string;
  let advertiser: string;

  beforeAll(async () => {
    owner = await db.createUser({ username: 'campaign_owner' });
    advertiser = await createAdvertiser(owner, 'Prairie Pharmacy Education', 'https://ppe.example');
    await db.as(A2(), `select public.admin_review_advertiser($1, 'approve', 'Non-profit education, verified')`, [advertiser]);
  });

  it('need the minimum budget, French where required, and no blocked landing page', async () => {
    expect((await db.expectError(user(owner), `select public.upsert_campaign(null, 'Tiny', 'category', 'research', 100, 'Headline here', 'Body text that is long enough.', 'Go', 'Titre ici', 'Un texte assez long pour passer.', 'Aller', 'https://ppe.example', null)`)).message).toBe('budget_below_minimum');
    expect((await db.expectError(user(owner), `select public.upsert_campaign(null, 'Site-wide', 'national', null, 2000000000, 'Headline here', 'Body text that is long enough.', 'Go', '', '', '', 'https://ppe.example', null)`)).message).toBe('french_required');
    expect((await db.expectError(user(owner), `select public.upsert_campaign(null, 'Category', 'category', 'research', 2000000000, 'Headline here', 'Body text that is long enough.', 'Go', '', '', '', 'https://ppe.example', null)`)).message).toBe('french_required');
    expect((await db.expectError(user(owner), `select public.upsert_campaign(null, 'Vendor', 'category', 'research', 2000000000, 'Headline here', 'Body text that is long enough.', 'Go', 'Titre ici', 'Un texte assez long pour passer.', 'Aller', 'https://cheap-peptides.example/buy', null)`)).message).toBe('blocked_by_shield');
    expect((await db.expectError(user(owner), `select public.upsert_campaign(null, 'Wrong category', 'category', 'nope', 2000000000, 'Headline here', 'Body text that is long enough.', 'Go', 'Titre ici', 'Un texte assez long pour passer.', 'Aller', 'https://ppe.example', null)`)).message).toBe('invalid_category');
  });

  it('reserve their budget on submission, run after approval, and are charged per settled day', async () => {
    const id = await upsert(owner);
    expect((await db.expectError(user(owner), `select public.submit_campaign($1)`, [id])).message).toBe('insufficient_credit');
    await pay(advertiser, 3000, 'INV-PPE-1');
    await submit(owner, id);
    let w = await workspace(owner);
    expect(w).toMatchObject({ balance: 3000 * CAD, reserved: 2000 * CAD, available: 1000 * CAD });
    expect(w?.campaigns[0]).toMatchObject({ id, status: 'review', reserved: 2000 * CAD, cpm: 22 * CAD });
    expect((await db.expectError(user(owner), `select public.upsert_campaign($1, 'Edit', 'category', 'research', 2000000000, 'Headline here', 'Body text that is long enough.', 'Go', 'Titre ici', 'Un texte assez long pour passer.', 'Aller', 'https://ppe.example', null)`, [id])).message).toBe('campaign_locked');

    // Not served before approval; served after, once per visitor per hour, with the French copy when asked.
    expect(await getAd('category', 'research', 'visitor-aaaaaaaa')).toBeNull();
    await review(id, 'approve');
    w = await workspace(owner);
    expect(w?.campaigns[0]).toMatchObject({ status: 'active' });
    expect(await getAd('category', 'basics', 'visitor-aaaaaaaa')).toBeNull();
    expect(await getAd('national', null, 'visitor-aaaaaaaa')).toBeNull();
    const ad = await getAd('category', 'research', 'visitor-aaaaaaaa');
    expect(ad).toMatchObject({ id, headline: 'Free CoA literacy workshop', cta: 'Reserve a seat', advertiser: 'Prairie Pharmacy Education' });
    await getAd('category', 'research', 'visitor-aaaaaaaa');          // same hour: not counted again
    await getAd('category', 'research', 'visitor-bbbbbbbb');
    await getAd('category', 'research', 'short');                     // bad visitor token: served, not counted
    expect((await workspace(owner))?.campaigns[0]?.impressions).toBe(2);

    const landing = (await db.asOne<{ u: string | null }>(anon, `select public.ad_click($1) as u`, [id])).u;
    expect(landing).toBe('https://maplelabs.example/workshop');
    expect((await workspace(owner))?.campaigns[0]?.clicks).toBe(1);

    // Settlement charges yesterday's impressions only; today stays open.
    await db.sql(`update public.ad_daily_stats set day = current_date - 1 where campaign_id = $1`, [id]);
    for (const actor of [anon, user(owner), A2()]) {
      expect((await db.expectError(actor, `select public.settle_ads(current_date)`)).code).toBe('42501');
    }
    const first = await settle(new Date().toISOString().slice(0, 10));
    expect(first).toMatchObject({ days_settled: 1, charged_microcad: Math.floor((2 * 22 * CAD) / 1000), completed: 0 });
    const second = await settle(new Date().toISOString().slice(0, 10));
    expect(second.days_settled).toBe(0);                     // idempotent
    w = await workspace(owner);
    expect(w?.campaigns[0]).toMatchObject({ spent: 44_000, reserved: 2000 * CAD - 44_000 });
    expect(w?.ledger.find((l) => l.kind === 'charge')).toMatchObject({ amount: -44_000, reference: `charge:${id}:${w?.campaigns[0]?.days[0]?.day}` });
    expect(w).toMatchObject({ balance: 3000 * CAD - 44_000, reserved: 2000 * CAD - 44_000 });

    // The flight ends: the unspent reservation returns to available credit.
    await db.sql(`update public.ad_campaigns set ends_on = current_date - 1 where id = $1`, [id]);
    expect((await settle(new Date().toISOString().slice(0, 10))).completed).toBe(1);
    w = await workspace(owner);
    expect(w?.campaigns[0]).toMatchObject({ status: 'completed', reserved: 0 });
    expect(w).toMatchObject({ reserved: 0, available: 3000 * CAD - 44_000 });
    expect(await getAd('category', 'research', 'visitor-cccccccc')).toBeNull();
  });

  it('rejection releases the reservation; owners can withdraw and pause', async () => {
    const id = await upsert(owner, { name: 'Will be rejected' });
    await submit(owner, id);
    await review(id, 'reject', 'Landing page lists prices');
    let w = await workspace(owner);
    expect(w?.campaigns.find((c) => c.id === id)).toMatchObject({ status: 'rejected', reserved: 0, review_note: 'Landing page lists prices' });
    expect(w?.reserved).toBe(0);
    // Editing a rejected campaign returns it to draft; withdrawing deletes it.
    await upsert(owner, { id, name: 'Fixed' });
    expect((await workspace(owner))?.campaigns.find((c) => c.id === id)?.status).toBe('draft');
    await db.as(user(owner), `select public.withdraw_campaign($1)`, [id]);
    expect((await workspace(owner))?.campaigns.some((c) => c.id === id)).toBe(false);

    const running = await upsert(owner, { name: 'Pausable' });
    await submit(owner, running);
    await review(running, 'approve');
    await db.as(user(owner), `select public.set_campaign_paused($1, true)`, [running]);
    expect(await getAd('category', 'research', 'visitor-dddddddd')).toBeNull();
    await db.as(user(owner), `select public.set_campaign_paused($1, false)`, [running]);
    expect((await getAd('category', 'research', 'visitor-dddddddd'))?.id).toBe(running);

    // Decisions are logged and notified; admins can't review their own.
    expect(await db.sql(`select 1 from public.mod_actions where action in ('ad_approved', 'ad_rejected') and target_user_id = $1`, [owner])).toHaveLength(3);
    const notes = (await db.asOne<{ n: Array<{ kind: string; action: string }> }>(user(owner), `select public.my_notifications() as n`)).n;
    expect(notes.filter((n) => n.kind === 'ad_review').map((n) => n.action)).toEqual(expect.arrayContaining(['ad_approved', 'ad_rejected', 'advertiser_approved']));
    w = await workspace(owner);
    void w;
  });

  it('members report ads; admins resolve or suspend, releasing credit', async () => {
    const member = await db.createUser({ username: 'ad_watcher' });
    const running = (await workspace(owner))?.campaigns.find((c) => c.status === 'active');
    await db.as(user(member), `select public.report_ad($1, 'vendor', 'The landing page sells vials')`, [running?.id]);
    expect((await db.expectError(user(member), `select public.report_ad($1, 'vendor', 'Again')`, [running?.id])).message).toBe('already_reported');

    const console = (await db.asOne<{ a: { reports: Array<{ campaign_id: string; reporter: string }>; totals: { open_reports: number; campaigns_in_review: number } } }>(
      A2(), `select public.admin_ads() as a`)).a;
    expect(console.reports).toEqual([expect.objectContaining({ campaign_id: running?.id, reporter: 'ad_watcher' })]);
    expect((await db.expectError(user(owner, 'aal2'), `select public.admin_ads()`)).code).toBe('PF403');

    await db.as(A2(), `select public.admin_suspend_campaign($1, 'Vendor landing page confirmed')`, [running?.id]);
    const w = await workspace(owner);
    expect(w?.campaigns.find((c) => c.id === running?.id)).toMatchObject({ status: 'suspended', reserved: 0 });
    expect(w?.reserved).toBe(0);
    expect(await getAd('category', 'research', 'visitor-eeeeeeee')).toBeNull();
    expect((await db.asOne<{ a: { totals: { open_reports: number } } }>(A2(), `select public.admin_ads() as a`)).a.totals.open_reports).toBe(0);

    // A refund can't exceed available credit.
    const available = w?.available ?? 0;
    expect((await db.expectError(A2(), `select public.admin_ad_adjustment($1, $2, 'REF-1', 'Refund everything and more')`, [advertiser, -(available + 1)])).message).toBe('insufficient_credit');
    await db.as(A2(), `select public.admin_ad_adjustment($1, $2, 'REF-1', 'Refund after suspension')`, [advertiser, -available]);
    expect((await workspace(owner))?.available).toBe(0);
  });

  it('a suspended advertiser cannot book; ads vanish when the switch is off', async () => {
    const other = await db.createUser();
    const adv = await createAdvertiser(other, 'Suspended Co', 'https://suspended.example');
    await db.as(A2(), `select public.admin_review_advertiser($1, 'suspend', 'Undisclosed vendor affiliation')`, [adv]);
    expect((await db.expectError(user(other), `select public.upsert_campaign(null, 'Nope', 'category', 'research', 2000000000, 'Headline here', 'Body text that is long enough.', 'Go', 'Titre ici', 'Un texte assez long pour passer.', 'Aller', 'https://suspended.example', null)`)).message).toBe('advertiser_suspended');

    await db.setConfig('ads.enabled', false);
    expect(await getAd('category', 'research', 'visitor-ffffffff')).toBeNull();
    await db.setConfig('ads.enabled', true);
  });
});
