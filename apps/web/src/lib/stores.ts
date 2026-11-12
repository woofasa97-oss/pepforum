import { COUNTRIES, STORE_AUDIT_CRITERIA, STORE_AUDIT_RESULTS, STORE_KINDS } from '@pepforum/database';
import type { StoreAuditResult, StoreKind, StoreListItem } from '@pepforum/database';

/** The directory's filters, from the address bar (…035). Unknown values are ignored, never trusted. */
export type StoreFilters = {
  q: string;
  country: string | null;
  shipsTo: string | null;
  kind: StoreKind | null;
  certificates: boolean;
  verifiable: boolean;
  noClaims: boolean;
  page: number;
};

export const STORES_PER_PAGE = 50;

const countries = new Set<string>(COUNTRIES);
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));

export function parseStoreFilters(params: Record<string, string | string[] | undefined>): StoreFilters {
  const country = one(params.country).toUpperCase();
  const shipsTo = one(params.ships).toUpperCase();
  const kind = one(params.kind);
  const page = Number.parseInt(one(params.page), 10);
  return {
    q: one(params.q).trim().slice(0, 80),
    country: countries.has(country) ? country : null,
    shipsTo: countries.has(shipsTo) ? shipsTo : null,
    kind: (STORE_KINDS as readonly string[]).includes(kind) ? (kind as StoreKind) : null,
    certificates: one(params.coa) === '1',
    verifiable: one(params.verify) === '1',
    noClaims: one(params.claims) === '1',
    page: Number.isFinite(page) && page > 1 ? Math.min(page, 1000) : 1,
  };
}

/** The query string for these filters, page 1 unless given; '' when none is set. */
export function storeFiltersQuery(f: StoreFilters, page = 1): string {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.country) p.set('country', f.country);
  if (f.shipsTo) p.set('ships', f.shipsTo);
  if (f.kind) p.set('kind', f.kind);
  if (f.certificates) p.set('coa', '1');
  if (f.verifiable) p.set('verify', '1');
  if (f.noClaims) p.set('claims', '1');
  if (page > 1) p.set('page', String(page));
  const s = p.toString();
  return s ? `?${s}` : '';
}

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Ships to a country: the store says so for that country, or says it ships worldwide. */
export const shipsTo = (s: StoreListItem, country: string) => s.ships_worldwide || s.ships_to.includes(country);

export function filterStores(stores: StoreListItem[], f: StoreFilters): StoreListItem[] {
  const q = fold(f.q);
  return stores.filter((s) => {
    const r = s.audit?.results ?? {};
    if (q && !fold(s.name).includes(q) && !s.domain.includes(q)) return false;
    if (f.country && s.country !== f.country) return false;
    if (f.shipsTo && !shipsTo(s, f.shipsTo)) return false;
    if (f.kind && s.kind !== f.kind) return false;
    if (f.certificates && r.coa_published !== 'met' && r.coa_published !== 'partly') return false;
    if (f.verifiable && r.coa_verifiable !== 'met') return false;
    if (f.noClaims && r.no_human_use_claims !== 'met') return false;
    return true;
  });
}

/** How many of an audit's checks have each result. */
export function resultCounts(results: Partial<Record<string, StoreAuditResult>>): Record<StoreAuditResult, number> {
  const counts = Object.fromEntries(STORE_AUDIT_RESULTS.map((r) => [r, 0])) as Record<StoreAuditResult, number>;
  for (const c of STORE_AUDIT_CRITERIA) {
    const r = results[c];
    if (r) counts[r] += 1;
  }
  return counts;
}

/** The pill colour for a result: green met, amber partly, red not met, grey otherwise. */
export function resultTone(r: StoreAuditResult | undefined): '' | 'green' | 'amber' | 'red' {
  return r === 'met' ? 'green' : r === 'partly' ? 'amber' : r === 'not_met' ? 'red' : '';
}
