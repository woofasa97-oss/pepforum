import type { PriceCatalog, PriceOffer, PriceVendor } from '@pepforum/database';
import { describe, expect, it } from 'vitest';

import {
  compare, discountMinor, formatCad, indexRows, lowestOf, mixLabel, startingVariant, tierAt, toCad, usdToCad, variantsOf, vendorQuote,
} from '@/lib/prices/model';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const FRESH = '2026-11-10T06:00:00Z';
const OLD = '2026-11-07T06:00:00Z';

let n = 0;
const offer = (vendor: string, over: Partial<PriceOffer> = {}): PriceOffer => ({
  id: `o${++n}`, vendor, compound: 'bpc-157', product_name: 'BPC-157 10mg', variant_label: null, currency: 'CAD', price_minor: 5000,
  list_price_minor: null, on_sale: false, price_kind: 'per_pack', mg_per_vial: 10, vials_per_pack: 1, total_mg: 10, per_mg_minor_e4: 5_000_000,
  availability: 'in_stock', observed_at: FRESH, price_changed_at: FRESH, recipe_key: null, is_blend: false, ...over,
});
const vendor = (slug: string, over: Partial<PriceVendor> = {}): PriceVendor => ({
  slug, name: slug, domain: `${slug}.ca`, origin_country: 'CA', ships_to: ['CA'], native_currency: 'CAD', coa_scope: 'unknown',
  last_ingested_at: FRESH, is_affiliate: false, code: null, coas: [], quantity_tiers: [], ...over,
});
const catalog = (offers: PriceOffer[], vendors: PriceVendor[]): PriceCatalog => ({
  stale_hours: 48, lead_vials: 10, publication: { published_at: FRESH, run_finished_at: FRESH },
  rates: [{ base: 'USD', quote: 'CAD', rate: 1.4, provider: 'ECB', rate_date: '2026-11-09' }],
  compounds: [
    { slug: 'bpc-157', name: 'BPC-157', type: 'Single compound', aliases: [], formulation: 'Lyophilized powder', blend_components: null },
    { slug: 'bpc-157-tb-500', name: 'BPC-157 + TB-500', type: 'Blend', aliases: [], formulation: 'Lyophilized powder', blend_components: null },
  ],
  vendors, offers,
});
const ctx = { rate: { rate: 1.4, date: '2026-11-09', provider: 'ECB' }, staleHours: 48, now: NOW };
const tier = (vials: number, percent: number, blends = false) => ({ vials, percent, blends, any_product: false, checked: '2026-11-01' });

describe('currency', () => {
  it('uses the dated USD→CAD rate, or the inverse when only CAD→USD is held', () => {
    expect(usdToCad([{ base: 'USD', quote: 'CAD', rate: 1.4, provider: 'ECB', rate_date: '2026-11-09' }])).toEqual({ rate: 1.4, date: '2026-11-09', provider: 'ECB' });
    expect(usdToCad([{ base: 'CAD', quote: 'USD', rate: 0.8, provider: 'ECB', rate_date: '2026-11-09' }])?.rate).toBeCloseTo(1.25);
    expect(usdToCad([])).toBeNull();
  });

  it('leaves CAD alone, converts USD, and refuses what it cannot convert', () => {
    expect(toCad(5000, 'CAD', null)).toBe(5000);
    expect(toCad(5000, 'USD', ctx.rate)).toBe(7000);
    expect(toCad(5000, 'USD', null)).toBeNull();
    expect(toCad(5000, 'EUR', ctx.rate)).toBeNull();
  });

  it('formats CAD for both languages', () => {
    expect(formatCad(123456, 'en')).toBe('$1,234.56');
    expect(formatCad(123456, 'fr').replace(/\s/g, ' ')).toBe('1 234,56 $');
  });
});

describe('multipack discounts', () => {
  it('applies the largest tier reached, and a blend only when the vendor says so', () => {
    const tiers = [tier(3, 10), tier(10, 30, true)];
    expect(tierAt(tiers, 2, false)).toBeNull();
    expect(tierAt(tiers, 5, false)?.percent).toBe(10);
    expect(tierAt(tiers, 10, false)?.percent).toBe(30);
    expect(tierAt(tiers, 5, true)).toBeNull();
    expect(tierAt(tiers, 10, true)?.percent).toBe(30);
  });

  it('rounds the discount once, on the whole order', () => {
    expect(discountMinor(49_990, 10)).toBe(4999);
    expect(discountMinor(3 * 3333, 12.5)).toBe(1250);
  });
});

describe('a vendor\'s price for N vials', () => {
  it('is N single vials less its own discount', () => {
    const v = vendor('north', { quantity_tiers: [tier(10, 20)] });
    const q = vendorQuote(v, [offer('north')], 'mg:10', 10, ctx)!;
    expect(q).toMatchObject({ kit: false, totalMinor: 40_000, totalCad: 40_000, perVialCad: 4000, perMgCad: 400, current: true });
    expect(q.tier?.percent).toBe(20);
    expect(vendorQuote(v, [offer('north')], 'mg:10', 1, ctx)).toMatchObject({ totalMinor: 5000, tier: null });
  });

  it('uses a real kit of exactly that quantity when it is cheaper, and never applies the discount to it', () => {
    const v = vendor('north', { quantity_tiers: [tier(10, 10)] });
    const kit = offer('north', { vials_per_pack: 10, price_minor: 40_000, product_name: 'BPC-157 10mg ×10' });
    const q = vendorQuote(v, [offer('north'), kit], 'mg:10', 10, ctx)!;
    expect(q).toMatchObject({ kit: true, totalMinor: 40_000, tier: null });
    expect(q.offer.id).toBe(kit.id);
    // A dearer kit loses to discounted singles (45,000).
    const dear = vendorQuote(v, [offer('north'), { ...kit, price_minor: 46_000 }], 'mg:10', 10, ctx)!;
    expect(dear).toMatchObject({ kit: false, totalMinor: 45_000 });
    // A kit of another size is not this order.
    expect(vendorQuote(v, [offer('north'), kit], 'mg:10', 5, ctx)).toMatchObject({ kit: false });
  });

  it('prefers the orderable listing, converts USD once, and is null when the vendor cannot fill the order', () => {
    const v = vendor('south');
    const out = offer('south', { price_minor: 3000, availability: 'out_of_stock' });
    const usd = offer('south', { currency: 'USD', price_minor: 4000 });
    const q = vendorQuote(v, [out, usd], 'mg:10', 1, ctx)!;
    expect(q.offer.id).toBe(usd.id);
    expect(q).toMatchObject({ currency: 'USD', totalMinor: 4000, totalCad: 5600, current: true });
    expect(vendorQuote(v, [out, usd], 'mg:5', 1, ctx)).toBeNull();
    expect(vendorQuote(v, [offer('south', { currency: 'EUR' })], 'mg:10', 1, ctx)).toBeNull();
  });

  it('marks a price not checked within the limit as stale, not current', () => {
    const q = vendorQuote(vendor('north'), [offer('north', { observed_at: OLD })], 'mg:10', 1, ctx)!;
    expect(q).toMatchObject({ stale: true, current: false });
  });
});

describe('the comparison table', () => {
  const vendors = [vendor('north'), vendor('south'), vendor('west'), vendor('east', { is_affiliate: true })];

  it('ranks current offers by price per mg, then lists out-of-stock and stale ones', () => {
    const c = catalog([
      offer('north', { price_minor: 5000 }),
      offer('south', { price_minor: 4200 }),
      offer('west', { price_minor: 1000, availability: 'out_of_stock' }),
      offer('east', { price_minor: 900, observed_at: OLD }),
    ], vendors);
    const variant = startingVariant(variantsOf(c.offers, 48, NOW))!;
    const table = compare(c, 'bpc-157', variant, 1, NOW);
    expect(table.quotes.map((q) => q.vendor.slug)).toEqual(['south', 'north', 'east', 'west']);
    expect([...table.lowest]).toEqual(['south']);
  });

  it('an affiliate vendor gets no advantage: order and "lowest" follow price alone', () => {
    const c = catalog([offer('east', { price_minor: 5000 }), offer('north', { price_minor: 4000 })], vendors);
    const table = compare(c, 'bpc-157', startingVariant(variantsOf(c.offers, 48, NOW))!, 1, NOW);
    expect(table.quotes.map((q) => q.vendor.slug)).toEqual(['north', 'east']);
    expect([...table.lowest]).toEqual(['north']);
  });

  it('"lowest" needs two current vendors, and a tie to the cent names both', () => {
    const one = catalog([offer('north'), offer('south', { availability: 'out_of_stock' })], vendors);
    expect(compare(one, 'bpc-157', startingVariant(variantsOf(one.offers, 48, NOW))!, 1, NOW).lowest.size).toBe(0);
    const tie = catalog([offer('north', { price_minor: 5000 }), offer('south', { price_minor: 5001 }), offer('west', { price_minor: 6000 })], vendors);
    // Per mg: 500.0 and 500.1 cents both show as $5.00.
    expect([...compare(tie, 'bpc-157', startingVariant(variantsOf(tie.offers, 48, NOW))!, 1, NOW).lowest].sort()).toEqual(['north', 'south']);
    expect(lowestOf([])).toEqual(new Set());
  });

  it('starts on the strength the most current vendors carry', () => {
    const c = catalog([
      offer('north', { mg_per_vial: 5 }), offer('north', { mg_per_vial: 10 }), offer('south', { mg_per_vial: 10 }),
      offer('west', { mg_per_vial: 5, availability: 'out_of_stock' }),
    ], vendors);
    const variants = variantsOf(c.offers, 48, NOW);
    expect(variants.map((v) => [v.key, v.vendors])).toEqual([['mg:5', 1], ['mg:10', 2]]);
    expect(startingVariant(variants)?.key).toBe('mg:10');
  });
});

describe('blends', () => {
  const mix = 'bpc-157:10+tb-500:10';
  const blend = (v: string, over: Partial<PriceOffer> = {}) =>
    offer(v, { compound: 'bpc-157-tb-500', is_blend: true, recipe_key: mix, mg_per_vial: 20, per_mg_minor_e4: null, ...over });
  const vendors = [vendor('north'), vendor('south')];

  it('are compared per vial within one exact mix, never per mg', () => {
    const c = catalog([blend('north', { price_minor: 9000 }), blend('south', { price_minor: 8000 })], vendors);
    const variants = variantsOf(c.offers, 48, NOW);
    expect(variants.map((v) => v.kind)).toEqual(['mix']);
    const table = compare(c, 'bpc-157-tb-500', variants[0]!, 1, NOW);
    expect(table.quotes[0]).toMatchObject({ perMgCad: null, perVialCad: 8000 });
    expect([...table.lowest]).toEqual(['south']);
  });

  it('a mix that is not stated is listed but never called lowest', () => {
    const c = catalog([blend('north', { recipe_key: null }), blend('south', { recipe_key: null, price_minor: 100 })], vendors);
    const variants = variantsOf(c.offers, 48, NOW);
    expect(variants.map((v) => v.kind)).toEqual(['unstated']);
    expect(compare(c, 'bpc-157-tb-500', variants[0]!, 1, NOW).lowest.size).toBe(0);
  });

  it('names a mix from its key', () => {
    expect(mixLabel(mix, new Map([['bpc-157', 'BPC-157'], ['tb-500', 'TB-500']]))).toBe('BPC-157 10 mg + TB-500 10 mg');
  });
});

describe('the index', () => {
  it('lists compounds that have offers with their lowest current single-vial price', () => {
    const c = catalog([
      offer('north', { price_minor: 5000 }), offer('south', { price_minor: 3000, availability: 'out_of_stock' }),
      offer('south', { currency: 'USD', price_minor: 3000 }),
    ], [vendor('north'), vendor('south')]);
    const rows = indexRows(c, NOW);
    expect(rows).toHaveLength(1);
    // 30.00 USD × 1.4 = 42.00 CAD for 10 mg.
    expect(rows[0]).toMatchObject({ vendors: 2, fromCad: 420, unit: 'mg' });
  });
});
