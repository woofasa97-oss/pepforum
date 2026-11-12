import { COUNTRIES, STORE_AUDIT_CRITERIA, STORE_AUDIT_RESULTS, STORE_KINDS } from '@pepforum/database';
import type { StoreAuditResult, StoreKind, StoreListItem } from '@pepforum/database';

import brands from './stores/brands.json';

/** The directory's filters, from the address bar (…035). Unknown values are ignored, never trusted. */
export type StoreFilters = {
  q: string;
  country: string | null;
  shipsTo: string | null;
  kind: StoreKind | null;
  /** A compound slug the store lists. */
  sells: string | null;
  certificates: boolean;
  verifiable: boolean;
  noClaims: boolean;
  page: number;
};

export const STORES_PER_PAGE = 48;

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
    sells: /^[a-z0-9]+(-[a-z0-9]+)*$/.test(one(params.sells)) && one(params.sells).length <= 60 ? one(params.sells) : null,
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
  if (f.sells) p.set('sells', f.sells);
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
    if (f.sells && !s.compounds.includes(f.sells)) return false;
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

// ── Brand tiles ─────────────────────────────────────────────────────────────
export type Brand = { w: number; h: number; kind: 'logo' | 'icon'; bg: 'light' | 'dark' | 'image' };
const BRANDS = brands as Record<string, Brand>;

/** The store's logo, served from /brands/<slug>.webp (stores:brand), or null. */
export function brandOf(slug: string): (Brand & { src: string }) | null {
  const b = BRANDS[slug];
  return b ? { ...b, src: `/brands/${slug}.webp` } : null;
}

const TILE_HUES = [212, 168, 262, 24, 340, 190, 128, 290, 46, 0];

/** Initials and a stable colour for a store without a logo. */
export function monogram(name: string): { initials: string; hue: number } {
  const words = name.replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter((w) => w && !/^(?:the|peptides?|labs?|research|inc|llc|ltd)$/i.test(w));
  const [first = name, second] = words;
  const initials = (second ? `${first.charAt(0)}${second.charAt(0)}` : first.slice(0, 2)).toUpperCase();
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { initials, hue: TILE_HUES[h % TILE_HUES.length] ?? 212 };
}

// ── Money ───────────────────────────────────────────────────────────────────
/** ISO 4217 currencies without minor units, as the price pipeline counts them (apps/prices/src/money.ts). */
const ZERO_EXPONENT = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'PYG', 'RWF', 'UGX', 'VUV', 'XAF', 'XOF', 'XPF']);
export const currencyExponent = (currency: string) => (ZERO_EXPONENT.has(currency.toUpperCase()) ? 0 : 2);

/** A listed price in the store's own currency, in the reader's language. */
export function formatMinor(minor: number, currency: string, locale: string): string {
  const digits = currencyExponent(currency);
  try {
    // 'symbol' in en-US / fr-FR keeps currencies apart: $ and CA$ and A$; $US and $CA.
    return new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-US', { style: 'currency', currency, currencyDisplay: 'symbol', minimumFractionDigits: digits, maximumFractionDigits: digits })
      .format(minor / 10 ** digits);
  } catch {
    return `${(minor / 10 ** digits).toFixed(digits)} ${currency}`;
  }
}

/** Per mg, from minor units per mg × 10^4. */
export const formatPerMg = (perMgE4: number, currency: string, locale: string) => formatMinor(Math.round(perMgE4 / 1e4 * 100) / 100, currency, locale);

/** A listing's size: "10 mg", "5 × 10 mg", or the variant label when the size is not known. */
export function sizeText(l: { mg_per_vial: number | null; vials_per_pack: number | null; variant_label: string | null }): string {
  const mg = l.mg_per_vial === null ? null : `${Number(l.mg_per_vial).toLocaleString('en', { maximumFractionDigits: 3 })} mg`;
  if (mg && l.vials_per_pack && l.vials_per_pack > 1) return `${l.vials_per_pack} × ${mg}`;
  return mg ?? l.variant_label ?? '—';
}
