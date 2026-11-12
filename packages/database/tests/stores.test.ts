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

describe('what a store sells (…037)', () => {
  const cat = { read: '', listing: '', document: '' };
  beforeAll(async () => {
    const { id: compound } = await db.sqlOne<{ id: string }>(
      `insert into prices.compounds (slug, name, type) values ('bpc-157-test', 'BPC-157 (test)', 'Single compound') returning id`);
    const { id: read } = await db.sqlOne<{ id: string }>(
      `insert into prices.store_catalogue_reads (vendor_id, observed_on, source, complete, products_seen)
       values ($1, '2026-11-12', 'woo_store_api', true, 12) returning id`, [ids.listed]);
    cat.read = read;
    const { id: listing } = await db.sqlOne<{ id: string }>(
      `insert into prices.store_listings (read_id, compound_id, product_name, form, mg_per_vial, vials_per_pack, total_mg, currency, price_minor, per_mg_minor_e4, availability, product_url, raw_price_text)
       values ($1, $2, 'BPC-157 10mg', 'vial', 10, 1, 10, 'THB', 150000, 150000000, 'in_stock', 'https://thai-peptide-lab.example/product/bpc-157', '1,500.00') returning id`, [read, compound]);
    cat.listing = listing;
    const { id: doc } = await db.sqlOne<{ id: string }>(
      `insert into prices.store_documents (vendor_id, url, label, compound_id, found_on)
       values ($1, 'https://thai-peptide-lab.example/coa/bpc-157.pdf', 'BPC-157 COA', $2, '2026-11-12') returning id`, [ids.listed, compound]);
    cat.document = doc;
  });

  it('shows the latest read and the documents, never an address', async () => {
    const { s } = await db.asOne<{ s: { catalogue: { observed_on: string; complete: boolean; listings: Array<Record<string, unknown>> }; documents: Array<Record<string, unknown>> } }>(
      anon, `select public.get_store('thai-peptide-lab') as s`);
    expect(s.catalogue).toMatchObject({ observed_on: '2026-11-12', complete: true });
    expect(s.catalogue.listings).toEqual([expect.objectContaining({ id: cat.listing, compound: 'bpc-157-test', currency: 'THB', price_minor: 150000, has_url: true })]);
    expect(s.documents).toEqual([expect.objectContaining({ id: cat.document, label: 'BPC-157 COA', compound: 'bpc-157-test' })]);
    expect(JSON.stringify(s)).not.toContain('https://');
    const { d } = await db.asOne<{ d: { stores: Array<{ slug: string; listings: number; compounds: string[]; documents: number }>; compounds: Array<{ slug: string }> } }>(
      anon, `select public.get_store_directory() as d`);
    expect(d.stores.find((x) => x.slug === 'thai-peptide-lab')).toMatchObject({ listings: 1, compounds: ['bpc-157-test'], documents: 1 });
    expect(d.compounds).toContainEqual(expect.objectContaining({ slug: 'bpc-157-test' }));
  });

  it('resolves product and document links, and counts a product visit', async () => {
    const before = (await db.sqlOne<{ clicks: number }>(`select clicks from prices.click_daily_stats where vendor_id = $1`, [ids.listed])).clicks;
    expect((await db.asOne<{ u: string }>(anon, `select public.price_link('listing', $1) as u`, [cat.listing])).u).toBe('https://thai-peptide-lab.example/product/bpc-157');
    expect((await db.asOne<{ u: string }>(anon, `select public.price_link('document', $1) as u`, [cat.document])).u).toBe('https://thai-peptide-lab.example/coa/bpc-157.pdf');
    expect((await db.sqlOne<{ clicks: number }>(`select clicks from prices.click_daily_stats where vendor_id = $1`, [ids.listed])).clicks).toBe(before + 1);
    expect((await db.asOne<{ u: string | null }>(anon, `select public.price_link('listing', 'nope') as u`)).u).toBeNull();
  });

  it('keeps reads append-only and every new table closed to API roles', async () => {
    await expect(db.sql(`update prices.store_listings set price_minor = 1 where id = $1`, [cat.listing])).rejects.toThrow();
    await expect(db.sql(`delete from prices.store_catalogue_reads where id = $1`, [cat.read])).rejects.toThrow();
    for (const actor of [anon, user(member), user(admin, 'aal2')]) {
      for (const table of ['store_catalogue_reads', 'store_listings', 'store_documents']) {
        expect((await db.expectError(actor, `select * from prices.${table}`)).code).toBe('42501');
      }
    }
    expect(await db.sql(`select * from private.security_audit()`)).toEqual([]);
  });
});

describe('the generated data migrations', () => {
  it('load on top of the schema, and the security self-audit stays clean', async () => {
    const full = await TestDb.create({ withData: true });
    try {
      const { n } = await full.sqlOne<{ n: number }>(`select count(*)::int as n from prices.vendors`);
      expect(n).toBeGreaterThan(400);
      const loaded = await full.sqlOne<{ listings: number; documents: number; compounds: number }>(
        `select (select count(*)::int from prices.store_listings) as listings, (select count(*)::int from prices.store_documents) as documents,
                (select count(*)::int from prices.compounds) as compounds`);
      expect(loaded.listings).toBeGreaterThan(5000);
      expect(loaded.documents).toBeGreaterThan(1000);
      expect(loaded.compounds).toBeGreaterThan(50);
      expect(await full.sql(`select * from private.security_audit()`)).toEqual([]);
    } finally {
      await full.close();
    }
  }, 120_000);
});
