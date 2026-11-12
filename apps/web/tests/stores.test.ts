import type { StoreListItem } from '@pepforum/database';
import { describe, expect, it } from 'vitest';

import { currencyExponent, filterStores, formatMinor, formatPerMg, monogram, parseStoreFilters, resultCounts, resultTone, sizeText, storeFiltersQuery } from '@/lib/stores';

const store = (slug: string, over: Partial<StoreListItem> = {}): StoreListItem => ({
  slug, name: slug.replace(/-/g, ' '), domain: `${slug}.example`, kind: 'store', country: 'US', ships_to: [], ships_worldwide: false,
  currency: 'USD', has_prices: false, listings: 0, compounds: [], documents: 0, audit: null, ...over,
});
const audited = (results: NonNullable<StoreListItem['audit']>['results']) => ({ audited_on: '2026-11-12', standard_version: '0.9', reachable: true, results });

const stores = [
  store('alpha-peptides', { country: 'CA', ships_to: ['CA', 'US'], compounds: ['bpc-157'], audit: audited({ coa_published: 'met', coa_verifiable: 'met', no_human_use_claims: 'met' }) }),
  store('bravo-labs', { country: 'GB', ships_worldwide: true, kind: 'manufacturer', audit: audited({ coa_published: 'partly', no_human_use_claims: 'not_met' }) }),
  store('peptidos-mexico', { name: 'Péptidos México', country: null, audit: audited({ coa_published: 'not_found' }) }),
  store('delta'),
];

describe('directory filters', () => {
  it('reads the address bar and ignores what it does not know', () => {
    expect(parseStoreFilters({})).toEqual({ q: '', country: null, shipsTo: null, kind: null, sells: null, certificates: false, verifiable: false, noClaims: false, page: 1 });
    const f = parseStoreFilters({ q: '  maple ', country: 'ca', ships: 'XX', kind: 'pharmacy', coa: '1', verify: 'yes', claims: '1', page: '3' });
    expect(f).toEqual({ q: 'maple', country: 'CA', shipsTo: null, kind: null, sells: null, certificates: true, verifiable: false, noClaims: true, page: 3 });
    expect(parseStoreFilters({ page: '-2' }).page).toBe(1);
    expect(parseStoreFilters({ country: ['FR', 'DE'] }).country).toBe('FR');
  });

  it('writes the same filters back, and a page only when past the first', () => {
    const f = parseStoreFilters({ q: 'a b', country: 'CA', coa: '1' });
    expect(storeFiltersQuery(f)).toBe('?q=a+b&country=CA&coa=1');
    expect(storeFiltersQuery(f, 2)).toBe('?q=a+b&country=CA&coa=1&page=2');
    expect(storeFiltersQuery(parseStoreFilters({}))).toBe('');
  });

  it('filters by name without accents, country, shipping, type and what the audit found', () => {
    const slugs = (p: Record<string, string>) => filterStores(stores, parseStoreFilters(p)).map((s) => s.slug);
    expect(slugs({ q: 'peptidos mexico' })).toEqual(['peptidos-mexico']);
    expect(slugs({ q: 'bravo-labs.example' })).toEqual(['bravo-labs']);
    expect(slugs({ country: 'CA' })).toEqual(['alpha-peptides']);
    expect(slugs({ ships: 'US' })).toEqual(['alpha-peptides', 'bravo-labs']); // bravo ships worldwide
    expect(slugs({ kind: 'manufacturer' })).toEqual(['bravo-labs']);
    expect(slugs({ coa: '1' })).toEqual(['alpha-peptides', 'bravo-labs']);
    expect(slugs({ verify: '1' })).toEqual(['alpha-peptides']);
    expect(slugs({ claims: '1' })).toEqual(['alpha-peptides']);
  });

  it('counts results and colours them', () => {
    expect(resultCounts({ coa_published: 'met', coa_verifiable: 'met', ships_to: 'not_found' })).toEqual({ met: 2, partly: 0, not_met: 0, not_found: 1, unchecked: 0 });
    expect([resultTone('met'), resultTone('partly'), resultTone('not_met'), resultTone('not_found'), resultTone(undefined)]).toEqual(['green', 'amber', 'red', '', '']);
  });

  it('filters by a peptide the store lists', () => {
    expect(filterStores(stores, parseStoreFilters({ sells: 'bpc-157' })).map((s) => s.slug)).toEqual(['alpha-peptides']);
    expect(parseStoreFilters({ sells: '../x' }).sells).toBeNull();
  });
});

describe('store page helpers', () => {
  it('formats a listed price in its own currency, minor units as the pipeline counts them', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(formatMinor(4999, 'USD', 'en')).toBe('$49.99');
    expect(formatMinor(4999, 'JPY', 'en')).toContain('4,999');
    expect(formatMinor(150000, 'THB', 'fr')).toMatch(/1[\s\u202f\u00a0]500,00/);
    expect(formatMinor(4700, 'CAD', 'en')).toBe('CA$47.00');
    expect(formatPerMg(49990000, 'USD', 'en')).toBe('$49.99');
  });

  it('describes a size, and gives a store without a logo its initials', () => {
    expect(sizeText({ mg_per_vial: 10, vials_per_pack: 1, variant_label: null })).toBe('10 mg');
    expect(sizeText({ mg_per_vial: 5, vials_per_pack: 10, variant_label: null })).toBe('10 × 5 mg');
    expect(sizeText({ mg_per_vial: null, vials_per_pack: null, variant_label: 'Kit' })).toBe('Kit');
    expect(monogram('Maple Research Labs').initials).toBe('MA'); // generic words (research, labs) are skipped
    expect(monogram('Alpha BioMed').initials).toBe('AB');
    expect(monogram('Peptides').initials).toBe('PE');
    expect(monogram('Maple Research Labs').hue).toBe(monogram('Maple Research Labs').hue);
  });
});
