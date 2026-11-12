/**
 * Price tracking (…030–…033): the `prices` schema is closed to every API
 * role, the site sees only published offers of active vendors, publishing
 * needs a passing run, certificates are admin-only, links are plain (no affiliate terms).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestDb, anon, service, user } from '../src/testing/index.ts';
import { TIER } from './helpers.ts';

let db: TestDb;
let admin: string;
let member: string;

type Catalog = {
  stale_hours: number;
  lead_vials: number;
  publication: { published_at: string } | null;
  rates: Array<{ base: string; quote: string; rate: number }>;
  compounds: Array<{ slug: string }>;
  vendors: Array<{ slug: string; domain: string; coa_scope: string; coas: Array<Record<string, unknown>> }>;
  offers: Array<{ id: string; vendor: string; compound: string; price_minor: number } & Record<string, unknown>>;
};

const ids = { bpc: '', north: '', south: '', hidden: '', run: '', offer: '', offerSouth: '' };

/** Runs SQL as the pipeline's login, with the search_path its role sets. */
async function asPipeline<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.sql(`set role pepforum_prices`);
  await db.sql(`set search_path = prices, pg_catalog`);
  try {
    return await db.sql<T>(sql, params);
  } finally {
    await db.sql(`reset role`);
    await db.sql(`reset search_path`);
  }
}

async function addOffer(vendor: string, runId: string, priceMinor: number, overrides: Record<string, unknown> = {}): Promise<string> {
  const row = {
    product_key: `k:${vendor}:${priceMinor}`, product_url: 'https://example.ca/product/bpc-157', product_name: 'BPC-157 10mg',
    currency: 'CAD', mg: 10, comparable: true, availability: 'in_stock', ...overrides,
  };
  const { id } = await db.sqlOne<{ id: string }>(
    `insert into prices.offers (vendor_id, compound_id, product_key, product_url, product_name, source_system, price_source,
        native_currency, price_minor, mg_per_vial, vials_per_pack, total_mg, comparable, per_mg_minor_e4, availability,
        raw_price_text, extraction_confidence, observed_at, price_changed_at, run_id)
     values ($1, $2, $3, $4, $5, 'woocommerce', 'woo_store_api', $6, $7::bigint, $8::numeric, 1, $8::numeric, $9::boolean,
             case when $9::boolean then ($7::numeric / $8::numeric * 10000)::bigint end, $10, 'raw', 'high', now(), now(), $11)
     returning id`,
    [vendor, ids.bpc, row.product_key, row.product_url, row.product_name, row.currency, priceMinor, row.mg, row.comparable, row.availability, runId],
  );
  await db.sql(
    `insert into prices.offer_observations (vendor_id, compound_id, product_key, product_name, source_system, price_source,
        native_currency, price_minor, mg_per_vial, vials_per_pack, total_mg, comparable, per_mg_minor_e4, availability,
        raw_price_text, extraction_confidence, observed_at, price_changed_at, run_id, offer_id, run_label)
     select vendor_id, compound_id, product_key, product_name, source_system, price_source, native_currency, price_minor,
        mg_per_vial, vials_per_pack, total_mg, comparable, per_mg_minor_e4, availability, raw_price_text,
        extraction_confidence, observed_at, price_changed_at, run_id, id, 'test'
     from prices.offers where id = $1`, [id]);
  return id;
}

async function catalog(actor = anon): Promise<Catalog | null> {
  const { c } = await db.asOne<{ c: Catalog | null }>(actor, `select public.get_price_catalog() as c`);
  return c;
}

beforeAll(async () => {
  db = await TestDb.create();
  admin = await db.createUser({ karma: TIER.contributor });
  await db.sql(`insert into public.user_roles (user_id, role) values ($1, 'admin')`, [admin]);
  member = await db.createUser();

  ids.bpc = (await db.sqlOne<{ id: string }>(
    `insert into prices.compounds (slug, name, type) values ('bpc-157', 'BPC-157', 'Single compound') returning id`)).id;
  const vendor = async (slug: string, status: string) => (await db.sqlOne<{ id: string }>(
    `insert into prices.vendors (slug, name, website_url, canonical_domain, origin_country, native_currency, status)
     values ($1, $1, 'https://' || $1 || '.example.ca', $1 || '.example.ca', 'CA', 'CAD', $2) returning id`, [slug, status])).id;
  ids.north = await vendor('north', 'active');
  ids.south = await vendor('south', 'active');
  ids.hidden = await vendor('hidden', 'paused');
  await db.sql(`insert into prices.fx_rates (base_currency, quote_currency, rate, provider, rate_date)
                values ('CAD', 'USD', 0.72, 'test', current_date), ('USD', 'CAD', 1.39, 'test', current_date)`);
});

afterAll(async () => {
  await db.close();
});

describe('the prices schema is closed to API roles', () => {
  it('passes the security self-audit', async () => {
    expect(await db.sql(`select * from private.security_audit()`)).toEqual([]);
  });

  it.each([
    ['select * from prices.offers'],
    ['select * from prices.vendors'],
    ['select * from prices.published_offers'],
    ['select * from prices.coa_documents'],
    [`insert into prices.vendors (slug, name, website_url, canonical_domain, origin_country) values ('x', 'x', 'https://x.ca', 'x.ca', 'CA')`],
    [`select prices.publish_offers(gen_random_uuid())`],
    [`select prices.quarantine_offers('{}', 'x', null)`],
  ])('anon, members and the worker cannot run: %s', async (statement) => {
    for (const actor of [anon, user(member), service]) {
      expect((await db.expectError(actor, statement)).code).toBe('42501');
    }
  });
});

describe('the pipeline login', () => {
  it('can write a run and offers, but cannot delete, publish a failing run or touch the forum', async () => {
    const [run] = await asPipeline<{ id: string }>(
      `insert into refresh_runs (run_label, mode, dry_run, status) values ('run-1', 'feeds', false, 'committed') returning id`);
    ids.run = run!.id;

    expect((await asPipeline(`select 1 from compounds`)).length).toBe(1);
    await expect(asPipeline(`delete from offers`)).rejects.toThrow(/permission denied/);
    await expect(asPipeline(`update vendors set status = 'active'`)).rejects.toThrow(/permission denied/);
    await expect(asPipeline(`insert into coa_documents (vendor_id, url, status) values ($1, 'https://x.ca/coa.pdf', 'published')`, [ids.north]))
      .rejects.toThrow(/permission denied/);
    await expect(asPipeline(`select * from public.profiles`)).rejects.toThrow(/permission denied/);
    await expect(asPipeline(`select publish_offers($1)`, [ids.run])).rejects.toThrow(/not a committed PASS run/);
  });

  it('the price log is append-only', async () => {
    ids.offer = await addOffer(ids.north, ids.run, 5000);
    await expect(db.sql(`update prices.offer_observations set price_minor = 1`)).rejects.toThrow(/append_only/);
    await expect(db.sql(`delete from prices.offer_observations`)).rejects.toThrow(/append_only/);
  });
});

describe('what the site can read', () => {
  it('returns nothing while the feature is off', async () => {
    expect(await catalog()).toBeNull();
    const { h } = await db.asOne<{ h: unknown }>(anon, `select public.get_price_history('bpc-157') as h`);
    expect(h).toBeNull();
    const { url } = await db.asOne<{ url: string | null }>(anon, `select public.price_link('vendor', 'north') as url`);
    expect(url).toBeNull();
  });

  it('shows only published offers of active vendors, without any store address', async () => {
    await db.setConfig('features.prices', true);
    ids.offerSouth = await addOffer(ids.south, ids.run, 4200);
    await addOffer(ids.hidden, ids.run, 100);
    await addOffer(ids.north, ids.run, 9900, { product_key: 'capsules', comparable: false });

    // Not yet passed: nothing is published.
    expect((await catalog())?.offers).toEqual([]);

    await db.sql(`update prices.refresh_runs set verdict = 'pass' where id = $1`, [ids.run]);
    const [published] = await asPipeline<{ r: { offers: number; vendors: number } }>(`select publish_offers($1) as r`, [ids.run]);
    expect(published!.r).toMatchObject({ offers: 3, vendors: 3 });

    const c = (await catalog())!;
    expect(c.offers.map((o) => o.vendor).sort()).toEqual(['north', 'south']);
    expect(c.vendors.map((v) => v.slug)).toEqual(['north', 'south']);
    expect(c.compounds.map((x) => x.slug)).toEqual(['bpc-157']);
    expect(c.publication).not.toBeNull();
    expect(c).toMatchObject({ stale_hours: 48, lead_vials: 10 });
    expect(JSON.stringify(c)).not.toContain('https://');
    // Members see exactly what anonymous visitors see.
    expect(await catalog(user(member))).toEqual(c);
  });

  it('a held run changes nothing that is published', async () => {
    const [held] = await asPipeline<{ id: string }>(
      `insert into refresh_runs (run_label, mode, dry_run, status, verdict) values ('run-held', 'feeds', false, 'held', 'hold') returning id`);
    await db.sql(`update prices.offers set price_minor = 1, run_id = $2 where id = $1`, [ids.offer, held!.id]);
    await asPipeline(`select publish_offers($1)`, [ids.run]);
    const c = (await catalog())!;
    expect(c.offers.find((o) => o.id === ids.offer)?.price_minor).toBe(5000);
  });

  it('delisting a vendor hides it at once', async () => {
    await db.as(user(admin, 'aal2'), `select public.admin_price_vendor_set_status('south', 'delisted', null, 'Asked to be removed')`);
    const c = (await catalog())!;
    expect(c.vendors.map((v) => v.slug)).toEqual(['north']);
    expect(c.offers.every((o) => o.vendor === 'north')).toBe(true);
    await db.as(user(admin, 'aal2'), `select public.admin_price_vendor_set_status('south', 'active', null, 'Back after review')`);
  });

  it('history lists only passing runs', async () => {
    const { h } = await db.asOne<{ h: Array<{ vendor: string; per_mg_minor_e4: number }> }>(
      anon, `select public.get_price_history('bpc-157') as h`);
    expect(h.map((x) => x.vendor).sort()).toEqual(['north', 'south']);
    expect(h.find((x) => x.vendor === 'north')?.per_mg_minor_e4).toBe(5_000_000);
  });
});

describe('admin: vendors', () => {
  it('needs an admin with MFA and a reason', async () => {
    const call = `select public.admin_price_vendor_save('maple-labs', 'Maple Labs', 'https://www.maplelabs.ca/', 'CA', 'About page', 'New Canadian vendor')`;
    expect((await db.expectError(anon, call)).code).toBe('42501');
    expect((await db.expectError(user(member, 'aal2'), call)).message).toBe('not_admin');
    expect((await db.expectError(user(admin, 'aal1'), call)).code).toBe('PF428');
    expect((await db.expectError(user(admin, 'aal2'),
      `select public.admin_price_vendor_save('maple-labs', 'Maple Labs', 'https://www.maplelabs.ca', 'CA', null, '')`)).message).toBe('reason_required');
    expect((await db.expectError(user(member, 'aal2'), `select public.admin_price_overview()`)).message).toBe('not_admin');
  });

  it('adds a vendor as pending, validates input and logs the change', async () => {
    await db.as(user(admin, 'aal2'),
      `select public.admin_price_vendor_save('maple-labs', 'Maple Labs', 'https://www.maplelabs.ca/', 'CA', 'About page', 'New Canadian vendor')`);
    const v = await db.sqlOne<Record<string, unknown>>(`select * from prices.vendors where slug = 'maple-labs'`);
    expect(v).toMatchObject({ status: 'pending', canonical_domain: 'maplelabs.ca', website_url: 'https://www.maplelabs.ca', origin_country: 'CA' });

    for (const [args, message] of [
      [`'Bad Slug', 'x', 'https://x.ca', 'CA'`, 'invalid_vendor_slug'],
      [`'ok', 'x', 'http://x.ca', 'CA'`, 'invalid_vendor_url'],
      [`'ok', 'x', 'https://x.ca', 'CAN'`, 'invalid_vendor_country'],
    ] as const) {
      const error = await db.expectError(user(admin, 'aal2'), `select public.admin_price_vendor_save(${args}, null, 'Testing input')`);
      expect(error.message).toBe(message);
    }
    const log = await db.sqlOne<{ action: string; target_kind: string }>(
      `select action, target_kind from public.mod_actions where action like 'price_vendor%' order by created_at desc limit 1`);
    expect(log).toEqual({ action: 'price_vendor_saved', target_kind: 'price_vendor' });

    const { o } = await db.asOne<{ o: { vendors: Array<{ slug: string; status: string }>; enabled: boolean } }>(
      user(admin, 'aal2'), `select public.admin_price_overview() as o`);
    expect(o.enabled).toBe(true);
    expect(o.vendors.find((x) => x.slug === 'maple-labs')?.status).toBe('pending');
  });
});

describe('certificates of analysis', () => {
  let coa = '';

  it('the pipeline can only file candidates, which the site never shows', async () => {
    const [filed] = await asPipeline<{ ok: boolean }>(
      `select file_coa_candidate($1, $2, $3, 'https://north.example.ca/coa/bpc-157-lot42.pdf') as ok`, [ids.north, ids.bpc, ids.offer]);
    expect(filed!.ok).toBe(true);
    const [again] = await asPipeline<{ ok: boolean }>(
      `select file_coa_candidate($1, $2, $3, 'https://north.example.ca/coa/bpc-157-lot42.pdf') as ok`, [ids.north, ids.bpc, ids.offer]);
    expect(again!.ok).toBe(false);
    const [bad] = await asPipeline<{ ok: boolean }>(`select file_coa_candidate($1, $2, null, 'http://insecure.example/coa.pdf') as ok`, [ids.north, ids.bpc]);
    expect(bad!.ok).toBe(false);
    expect((await catalog())!.vendors.find((v) => v.slug === 'north')?.coas).toEqual([]);
    coa = (await db.sqlOne<{ id: string }>(`select id from prices.coa_documents`)).id;
  });

  it('cannot be published until it names the lab and the stated purity', async () => {
    const error = await db.expectError(user(admin, 'aal2'), `select public.admin_price_coa_set_status($1, 'published', 'Looks fine')`, [coa]);
    expect(error.message).toBe('coa_incomplete');
    expect((await db.expectError(user(member, 'aal2'), `select public.admin_price_coa_set_status($1, 'published', 'Looks fine')`, [coa])).message)
      .toBe('not_admin');
    expect((await db.expectError(user(admin, 'aal2'),
      `select public.admin_price_coa_save($1, 'north', 'bpc-157', 'https://north.example.ca/coa/bpc-157-lot42.pdf', 'batch', null, 'Lab', null, 'hplc', null, 99.1, null, 'Read the PDF')`,
      [coa])).message).toBe('coa_batch_required');
    expect((await db.expectError(user(admin, 'aal2'),
      `select public.admin_price_coa_save($1, 'north', 'bpc-157', 'https://north.example.ca/coa/bpc-157-lot42.pdf', 'product', null, 'Lab', null, 'hplc', null, 101, null, 'Read the PDF')`,
      [coa])).message).toBe('invalid_coa_purity');
  });

  it('an admin records what it states and publishes it; the site shows it without the address', async () => {
    await db.as(user(admin, 'aal2'),
      `select public.admin_price_coa_save($1, 'north', 'bpc-157', 'https://north.example.ca/coa/bpc-157-lot42.pdf', 'batch', 'LOT42',
         'Northern Analytical', 'ISO/IEC 17025', 'hplc_ms', current_date - 20, 99.2, 'Purity (HPLC): 99.2%', 'Read the PDF')`, [coa]);
    await db.as(user(admin, 'aal2'), `select public.admin_price_coa_set_status($1, 'published', 'Complete and legible')`, [coa]);

    const c = (await catalog())!;
    const north = c.vendors.find((v) => v.slug === 'north')!;
    expect(north.coa_scope).toBe('batch');
    expect(north.coas).toHaveLength(1);
    expect(north.coas[0]).toMatchObject({
      id: coa, compound: 'bpc-157', scope: 'batch', batch: 'LOT42', lab: 'Northern Analytical',
      lab_accreditation: 'ISO/IEC 17025', method: 'hplc_ms', stated_purity_pct: 99.2,
    });
    expect(JSON.stringify(c)).not.toContain('https://');

    const { url } = await db.asOne<{ url: string }>(anon, `select public.price_link('coa', $1) as url`, [coa]);
    expect(url).toBe('https://north.example.ca/coa/bpc-157-lot42.pdf');
  });

  it('withdrawing it removes it and resets the vendor scope', async () => {
    await db.as(user(admin, 'aal2'), `select public.admin_price_coa_set_status($1, 'withdrawn', 'Vendor replaced the file')`, [coa]);
    const north = (await catalog())!.vendors.find((v) => v.slug === 'north')!;
    expect(north.coas).toEqual([]);
    expect(north.coa_scope).toBe('unknown');
    const { url } = await db.asOne<{ url: string | null }>(anon, `select public.price_link('coa', $1) as url`, [coa]);
    expect(url).toBeNull();
  });
});

describe('links to stores', () => {
  it('sends a visitor to the listing over https and counts the click per vendor only', async () => {
    const { url } = await db.asOne<{ url: string }>(anon, `select public.price_link('offer', $1) as url`, [ids.offer]);
    expect(url).toBe('https://example.ca/product/bpc-157');
    const { v } = await db.asOne<{ v: string }>(user(member), `select public.price_link('vendor', 'north') as v`);
    expect(v).toBe('https://north.example.ca');

    const stats = await db.sql<{ clicks: number }>(`select clicks from prices.click_daily_stats where vendor_id = $1`, [ids.north]);
    expect(stats).toEqual([{ clicks: 2 }]);
    const columns = await db.sql<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'prices' and table_name = 'click_daily_stats' order by 1`);
    expect(columns.map((c) => c.column_name)).toEqual(['clicks', 'day', 'vendor_id']);
  });

  it('returns nothing for unknown ids, hidden vendors and unpublished offers', async () => {
    for (const [kind, id] of [['offer', crypto.randomUUID()], ['offer', 'not-a-uuid'], ['vendor', 'hidden'], ['vendor', 'maple-labs'], ['nope', 'north']]) {
      const { url } = await db.asOne<{ url: string | null }>(anon, `select public.price_link($1, $2) as url`, [kind, id]);
      expect(url, `${kind}:${id}`).toBeNull();
    }
  });

  it('links are plain: no affiliate table, address, tag or code exists anywhere (ADR-0009)', async () => {
    const tables = await db.sql<{ table_name: string }>(`select table_name from information_schema.tables where table_schema = 'prices' order by 1`);
    expect(tables.map((x) => x.table_name)).not.toContain('vendor_links');
    const fns = await db.sql<{ proname: string }>(`select proname from pg_proc where proname like '%affiliate%' or proname in ('admin_price_link_save', 'admin_price_link_remove')`);
    expect(fns).toEqual([]);
    const north = (await catalog())!.vendors.find((v) => v.slug === 'north')!;
    expect(north).not.toHaveProperty('is_affiliate');
    expect(north).not.toHaveProperty('code');
    const { l } = await db.asOne<{ l: { clicks: Array<{ vendor: string; clicks_30d: number }> } }>(
      user(admin, 'aal2'), `select public.admin_price_links() as l`);
    expect(Object.keys(l)).toEqual(['clicks']);
    expect(l.clicks.find((x) => x.vendor === 'north')?.clicks_30d).toBeGreaterThanOrEqual(2);
    expect((await db.expectError(user(member, 'aal2'), `select public.admin_price_links()`)).message).toBe('not_admin');
  });
});
