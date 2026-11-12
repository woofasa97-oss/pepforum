/**
 * The Stores directory (…035, ADR-0011): every listed store with its latest public-information audit, and
 * the laboratories. Closed to API roles, hidden while `features.stores` is off except as an admin preview,
 * audits append-only, links resolved by the database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, user } from '../src/testing/index.ts';
import { TIER } from './helpers.ts';

let db: TestDb;
let admin: string;
let member: string;
const ids = { listed: '', delisted: '', audit: '', check: '', evidence: '' };

type Directory = {
  preview: boolean;
  stores: Array<{ slug: string; country: string | null; kind: string; ships_worldwide: boolean; has_prices: boolean;
                  audit: { audited_on: string; results: Record<string, string> } | null }>;
  labs: Array<{ slug: string; tier: string; has_website: boolean }>;
};
type Store = {
  preview: boolean;
  slug: string;
  audits: number;
  audit: { audited_on: string; standard_version: string; checks: Array<{ id: string; criterion: string; result: string; quote: string | null; has_source: boolean }> } | null;
};

async function addVendor(slug: string, country: string | null, status = 'pending'): Promise<string> {
  const { id } = await db.sqlOne<{ id: string }>(
    `insert into prices.vendors (slug, name, website_url, canonical_domain, origin_country, status, kind, ships_worldwide)
     values ($1, initcap(replace($1, '-', ' ')), 'https://' || $1 || '.example', $1 || '.example', $2, $3, 'store', true) returning id`,
    [slug, country, status]);
  return id;
}

async function addAudit(vendor: string, on: string, checks: Array<[string, string, string | null, string | null]>): Promise<string> {
  const { id } = await db.sqlOne<{ id: string }>(
    `insert into prices.store_audits (vendor_id, standard_version, audited_on, pages_read)
     values ($1, '0.9', $2::date, array['https://x.example/']) returning id`, [vendor, on]);
  for (const [criterion, result, url, quote] of checks) {
    await db.sql(`insert into prices.store_audit_checks (audit_id, criterion, result, source_url, quote, quote_verified_on)
                  values ($1, $2, $3, $4, $5, case when $5::text is null then null else current_date end)`,
                 [id, criterion, result, url, quote]);
  }
  return id;
}

beforeAll(async () => {
  db = await TestDb.create();
  admin = await db.createUser({ karma: TIER.contributor });
  member = await db.createUser({ karma: TIER.member });
  await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [admin]);

  ids.listed = await addVendor('thai-peptide-lab', 'TH');
  ids.delisted = await addVendor('gone-labs', 'US', 'delisted');
  await addVendor('unaudited-labs', null);
  await addAudit(ids.listed, '2026-01-10', [['identity_name', 'not_found', null, null]]);
  ids.audit = await addAudit(ids.listed, '2026-11-12', [
    ['identity_country', 'met', 'https://thai-peptide-lab.example/contact', 'We are based in Bangkok, Thailand.'],
    ['coa_published', 'partly', 'https://thai-peptide-lab.example/coa', 'Certificates of analysis for every product'],
    ['no_human_use_claims', 'met', null, null],
  ]);
  await addAudit(ids.delisted, '2026-11-12', [['identity_name', 'met', 'https://gone-labs.example/', 'Gone Labs LLC']]);
  await db.sql(`insert into prices.labs (slug, name, website_url, country, tier, checked_on)
                values ('acme-analytical', 'Acme Analytical', 'https://acme-lab.example', 'CZ', 'recognised', '2026-11-12')`);
});

afterAll(async () => {
  await db.close();
});

describe('who sees the directory', () => {
  it('is hidden from members and visitors while the switch is off, and a preview for admins', async () => {
    for (const actor of [anon, user(member)]) {
      expect((await db.asOne<{ d: Directory | null }>(actor, `select public.get_store_directory() as d`)).d).toBeNull();
      expect((await db.asOne<{ s: Store | null }>(actor, `select public.get_store('thai-peptide-lab') as s`)).s).toBeNull();
      expect((await db.asOne<{ u: string | null }>(actor, `select public.price_link('store', 'thai-peptide-lab') as u`)).u).toBeNull();
    }
    const { d } = await db.asOne<{ d: Directory }>(user(admin), `select public.get_store_directory() as d`);
    expect(d.preview).toBe(true);
    expect((await db.asOne<{ s: Store }>(user(admin), `select public.get_store('thai-peptide-lab') as s`)).s.preview).toBe(true);
  });

  it('is public once the switch is on', async () => {
    await db.setConfig('features.stores', true);
    const { d } = await db.asOne<{ d: Directory }>(anon, `select public.get_store_directory() as d`);
    expect(d.preview).toBe(false);
    // The directory also holds the stores loaded by …036; these tests look at their own.
    const slugs = d.stores.map((s) => s.slug);
    expect(slugs).toEqual(expect.arrayContaining(['thai-peptide-lab', 'unaudited-labs']));
    expect(slugs).not.toContain('gone-labs');
    expect(d.labs).toContainEqual(expect.objectContaining({ slug: 'acme-analytical', tier: 'recognised', has_website: true }));
  });
});

describe('what it shows', () => {
  it('lists every store but delisted ones, with the latest audit only', async () => {
    const { d } = await db.asOne<{ d: Directory }>(anon, `select public.get_store_directory() as d`);
    const thai = d.stores.find((s) => s.slug === 'thai-peptide-lab');
    expect(thai).toMatchObject({ country: 'TH', kind: 'store', ships_worldwide: true, has_prices: false });
    expect(thai?.audit?.audited_on).toBe('2026-11-12');
    expect(thai?.audit?.results).toEqual({ identity_country: 'met', coa_published: 'partly', no_human_use_claims: 'met' });
    expect(d.stores.find((s) => s.slug === 'unaudited-labs')?.audit).toBeNull();
    expect((await db.asOne<{ s: Store | null }>(anon, `select public.get_store('gone-labs') as s`)).s).toBeNull();
  });

  it('gives one store its checks, with the quote but never the address', async () => {
    const { s } = await db.asOne<{ s: Store }>(anon, `select public.get_store('thai-peptide-lab') as s`);
    expect(s.audits).toBe(2);
    expect(s.audit?.standard_version).toBe('0.9');
    const country = s.audit?.checks.find((c) => c.criterion === 'identity_country');
    expect(country).toMatchObject({ result: 'met', quote: 'We are based in Bangkok, Thailand.', has_source: true });
    expect(JSON.stringify(s)).not.toContain('https://');
    ids.evidence = country?.id ?? '';
  });

  it('resolves store, evidence and lab links, and counts store visits', async () => {
    expect((await db.asOne<{ u: string }>(anon, `select public.price_link('store', 'thai-peptide-lab') as u`)).u).toBe('https://thai-peptide-lab.example');
    expect((await db.asOne<{ u: string }>(anon, `select public.price_link('evidence', $1) as u`, [ids.evidence])).u).toBe('https://thai-peptide-lab.example/contact');
    expect((await db.asOne<{ u: string }>(anon, `select public.price_link('lab', 'acme-analytical') as u`)).u).toBe('https://acme-lab.example');
    expect((await db.asOne<{ u: string | null }>(anon, `select public.price_link('store', 'gone-labs') as u`)).u).toBeNull();
    expect((await db.asOne<{ u: string | null }>(anon, `select public.price_link('evidence', 'not-a-uuid') as u`)).u).toBeNull();
    // A store link is not a price link: the Prices switch stays off and 'vendor' still says nothing.
    expect((await db.asOne<{ u: string | null }>(anon, `select public.price_link('vendor', 'thai-peptide-lab') as u`)).u).toBeNull();
    expect(await db.sqlOne(`select clicks from prices.click_daily_stats where vendor_id = $1`, [ids.listed])).toEqual({ clicks: 1 });
  });
});

describe('integrity', () => {
  it('keeps the directory tables closed to API roles', async () => {
    for (const actor of [anon, user(member), user(admin, 'aal2')]) {
      for (const sql of [
        `select * from prices.store_audits`,
        `select * from prices.labs`,
        `insert into prices.store_audit_checks (audit_id, criterion, result) values ('${ids.audit}', 'ships_to', 'met')`,
      ]) {
        expect((await db.expectError(actor, sql)).code).toBe('42501');
      }
    }
  });

  it('never changes an audit: a correction is a new one', async () => {
    for (const sql of [
      `update prices.store_audit_checks set result = 'met' where audit_id = '${ids.audit}'`,
      `delete from prices.store_audit_checks where audit_id = '${ids.audit}'`,
      `update prices.store_audits set audited_on = '2026-11-13' where id = '${ids.audit}'`,
      `delete from prices.store_audits where id = '${ids.audit}'`,
      `truncate prices.store_audit_checks`,
    ]) {
      await expect(db.sql(sql)).rejects.toThrow();
    }
  });

  it('accepts any ISO country or none, any ISO currency, and rejects the rest', async () => {
    await expect(addVendor('kiwi-peptides', 'NZ')).resolves.toBeTruthy();
    for (const bad of [`origin_country = 'EU1'`, `origin_country = 'usa'`, `native_currency = 'US$'`]) {
      await expect(db.sql(`update prices.vendors set ${bad} where slug = 'kiwi-peptides'`)).rejects.toThrow();
    }
    await db.sql(`update prices.vendors set native_currency = 'THB' where slug = 'thai-peptide-lab'`);
    await expect(db.sql(`insert into prices.store_audit_checks (audit_id, criterion, result, quote) values ($1, 'ships_to', 'met', 'no page')`, [ids.audit])).rejects.toThrow();
  });

  it('lets an admin save a store in any country, or none', async () => {
    const save = `select public.admin_price_vendor_save($1, 'Seoul Peptides', 'https://seoulpeptides.example', $2, null, 'Found in the worldwide sweep')`;
    expect((await db.asOne<{ admin_price_vendor_save: string }>(user(admin, 'aal2'), save, ['seoul-peptides', 'kr'])).admin_price_vendor_save).toBe('seoul-peptides');
    expect(await db.sqlOne(`select origin_country from prices.vendors where slug = 'seoul-peptides'`)).toEqual({ origin_country: 'KR' });
    await db.as(user(admin, 'aal2'), save, ['seoul-peptides', '']);
    expect(await db.sqlOne(`select origin_country from prices.vendors where slug = 'seoul-peptides'`)).toEqual({ origin_country: null });
    expect((await db.expectError(user(admin, 'aal2'), save, ['seoul-peptides', 'Korea'])).message).toBe('invalid_vendor_country');
    expect((await db.expectError(user(member, 'aal2'), save, ['seoul-peptides', 'KR'])).message).toBe('not_admin');
  });

  it('the security self-audit stays clean', async () => {
    expect(await db.sql(`select * from private.security_audit()`)).toEqual([]);
  });
});
