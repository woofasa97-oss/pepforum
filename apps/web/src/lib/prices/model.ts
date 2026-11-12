/**
 * Pricing rules for the Prices section, kept pure so they can be tested.
 * Ported from PepSpotter's src/lib/pricing (tiers.ts, live.ts) onto the shape
 * get_price_catalog() returns. The rules, each a product decision:
 *
 *   - A price is stored in the vendor's own currency as integer cents and
 *     converted once, for display, at a named, dated reference rate.
 *   - An order of N vials is N single vials less the vendor's own automatic
 *     multipack discount, or a real N-vial kit when the vendor sells one and
 *     it is cheaper.
 *   - Out-of-stock and stale prices are shown but never ranked; "lowest"
 *     needs at least two current vendors, and a tie is a tie.
 *   - A blend is compared per vial within one exact mix, never per mg; a
 *     blend whose mix is not stated is listed, never ranked.
 *   - No discount code, shipping cost or affiliate relationship ever changes
 *     a price, an order or a "lowest" label.
 */
import type { PriceCatalog, PriceCompound, PriceCurrency, PriceOffer, PriceQuantityTier, PriceRate, PriceVendor } from '@pepforum/database';

export const QUANTITIES = [1, 3, 5, 10] as const;

/** The reference rate used to show a USD price in CAD: 1 USD = `rate` CAD, as of `date`. */
export interface CadRate {
  readonly rate: number;
  readonly date: string;
  readonly provider: string;
}

export function usdToCad(rates: readonly PriceRate[]): CadRate | null {
  const direct = rates.find((r) => r.base === 'USD' && r.quote === 'CAD' && r.rate > 0);
  if (direct) return { rate: Number(direct.rate), date: direct.rate_date, provider: direct.provider };
  const inverse = rates.find((r) => r.base === 'CAD' && r.quote === 'USD' && r.rate > 0);
  return inverse ? { rate: 1 / Number(inverse.rate), date: inverse.rate_date, provider: inverse.provider } : null;
}

/** Vendor-currency cents as CAD cents (a fraction until displayed); null for a currency we cannot convert. */
export function toCad(minor: number, currency: PriceCurrency, rate: CadRate | null): number | null {
  if (currency === 'CAD') return minor;
  if (currency === 'USD' && rate) return minor * rate.rate;
  return null;
}

export const isStale = (offer: Pick<PriceOffer, 'observed_at'>, staleHours: number, now: number): boolean =>
  now - new Date(offer.observed_at).getTime() > staleHours * 3_600_000;

/** Current and in stock: the only listings that can be a best price. */
export const isCurrent = (offer: PriceOffer, staleHours: number, now: number): boolean =>
  offer.availability === 'in_stock' && !isStale(offer, staleHours, now);

/** The tier a quantity reaches: the largest threshold at or below it; none on a blend it does not cover. */
export function tierAt(tiers: readonly PriceQuantityTier[], q: number, blend: boolean): PriceQuantityTier | null {
  let best: PriceQuantityTier | null = null;
  for (const t of tiers) if (t.vials <= q && (!blend || t.blends) && (best === null || t.vials > best.vials)) best = t;
  return best;
}

/** The discount on a whole order, rounded once, in the vendor's own cents. */
export const discountMinor = (fullMinor: number, percent: number): number => Math.round((fullMinor * Math.round(percent * 1000)) / 100000);

/**
 * What a compound page compares: one strength of a single compound (`mg:10`),
 * one exact mix of a blend (`mix:bpc-157:10+tb-500:10`), or a blend's listings
 * that do not state their mix (`unstated`), which are listed and never ranked.
 */
export interface Variant {
  readonly key: string;
  readonly kind: 'size' | 'mix' | 'unstated';
  /** mg per vial for a size; the vial's stated total for a mix, when there is one. */
  readonly mg: number | null;
  readonly mix: string | null;
  /** Vendors with a current single-vial listing of it. */
  readonly vendors: number;
}

export function variantKey(offer: PriceOffer): string {
  if (!offer.is_blend) return `mg:${Number(offer.mg_per_vial)}`;
  return offer.recipe_key ? `mix:${offer.recipe_key}` : 'unstated';
}

export function variantsOf(offers: readonly PriceOffer[], staleHours: number, now: number): Variant[] {
  const byKey = new Map<string, { offer: PriceOffer; vendors: Set<string> }>();
  for (const o of offers) {
    const key = variantKey(o);
    const entry = byKey.get(key) ?? { offer: o, vendors: new Set<string>() };
    if (o.vials_per_pack === 1 && isCurrent(o, staleHours, now)) entry.vendors.add(o.vendor);
    byKey.set(key, entry);
  }
  const variants = [...byKey].map(([key, { offer, vendors }]): Variant => ({
    key,
    kind: !offer.is_blend ? 'size' : offer.recipe_key ? 'mix' : 'unstated',
    mg: offer.mg_per_vial === null ? null : Number(offer.mg_per_vial),
    mix: offer.recipe_key,
    vendors: vendors.size,
  }));
  const rank = { size: 0, mix: 1, unstated: 2 } as const;
  return variants.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.mg ?? Infinity) - (b.mg ?? Infinity) || a.key.localeCompare(b.key));
}

/** The variant the most current vendors carry (ties: the smaller); unstated mixes only when there is nothing else. */
export function startingVariant(variants: readonly Variant[]): Variant | null {
  const ranked = variants.filter((v) => v.kind !== 'unstated');
  const pool = ranked.length > 0 ? ranked : variants;
  return [...pool].sort((a, b) => b.vendors - a.vendors || (a.mg ?? Infinity) - (b.mg ?? Infinity) || a.key.localeCompare(b.key))[0] ?? null;
}

/** One vendor's price for an exact quantity of one variant. */
export interface Quote {
  readonly vendor: PriceVendor;
  /** The listing the price comes from, and the link target. */
  readonly offer: PriceOffer;
  readonly quantity: number;
  /** A real N-vial kit rather than N single vials. */
  readonly kit: boolean;
  readonly currency: PriceCurrency;
  /** The order total in the vendor's own cents. */
  readonly totalMinor: number;
  /** The same total in CAD cents (unrounded). */
  readonly totalCad: number;
  readonly perVialCad: number;
  /** Null for blends: they are compared per vial. */
  readonly perMgCad: number | null;
  /** The vendor's own multipack discount that was applied, if any. */
  readonly tier: PriceQuantityTier | null;
  /** In stock and checked within the staleness limit. */
  readonly current: boolean;
  readonly stale: boolean;
}

/**
 * Among a vendor's listings of one variant and pack: current first, then
 * cheaper (in CAD: a vendor may list in both currencies), then more recently checked.
 */
function best(list: PriceOffer[], rate: CadRate | null, staleHours: number, now: number): PriceOffer | undefined {
  return list
    .filter((o) => toCad(o.price_minor, o.currency, rate) !== null)
    .sort((a, b) =>
      Number(isCurrent(b, staleHours, now)) - Number(isCurrent(a, staleHours, now))
      || (toCad(a.price_minor, a.currency, rate) ?? 0) - (toCad(b.price_minor, b.currency, rate) ?? 0)
      || b.observed_at.localeCompare(a.observed_at))[0];
}

/** One vendor's price for `quantity` vials of a variant, or null when it cannot fill that order. */
export function vendorQuote(
  vendor: PriceVendor, mine: readonly PriceOffer[], variant: string, quantity: number,
  ctx: { rate: CadRate | null; staleHours: number; now: number },
): Quote | null {
  const { rate, staleHours, now } = ctx;
  const sized = mine.filter((o) => variantKey(o) === variant);
  const single = best(sized.filter((o) => o.vials_per_pack === 1), rate, staleHours, now);
  const kit = quantity > 1 ? best(sized.filter((o) => o.vials_per_pack === quantity), rate, staleHours, now) : undefined;
  if (!single && !kit) return null;

  const blend = (single ?? kit)?.is_blend === true;
  const tier = tierAt(vendor.quantity_tiers, quantity, blend);
  const discounted = (priceMinor: number) => priceMinor * quantity - (tier ? discountMinor(priceMinor * quantity, tier.percent) : 0);
  const singleCad = single ? (toCad(discounted(single.price_minor), single.currency, rate) ?? Infinity) : Infinity;
  const kitCad = kit ? (toCad(kit.price_minor, kit.currency, rate) ?? Infinity) : Infinity;
  const live = (o: PriceOffer) => isCurrent(o, staleHours, now);
  // The kit is the row when it is the only way to buy, when it is orderable and the single vial
  // is not, or (both equally orderable) when it is cheaper.
  const useKit = kit !== undefined && (single === undefined || (live(kit) && !live(single)) || (live(kit) === live(single) && kitCad < singleCad));
  const chosen = useKit ? kit : single;
  if (!chosen) return null;

  const totalMinor = useKit ? chosen.price_minor : discounted(chosen.price_minor);
  const totalCad = toCad(totalMinor, chosen.currency, rate);
  if (totalCad === null) return null;
  const mg = chosen.is_blend || chosen.mg_per_vial === null ? null : Number(chosen.mg_per_vial) * quantity;
  return {
    vendor,
    offer: chosen,
    quantity,
    kit: useKit,
    currency: chosen.currency,
    totalMinor,
    totalCad,
    perVialCad: totalCad / quantity,
    perMgCad: mg ? totalCad / mg : null,
    tier: useKit ? null : tier,
    current: live(chosen),
    stale: isStale(chosen, staleHours, now),
  };
}

/** The figure a quote is ranked by: per mg for a single compound, per vial for a blend. */
export const unitCad = (q: Quote): number => q.perMgCad ?? q.perVialCad;

export interface Comparison {
  readonly variant: Variant;
  readonly quantity: number;
  /** Current quotes cheapest first, then out-of-stock and stale ones. */
  readonly quotes: Quote[];
  /** Vendors whose quote is the lowest. Empty for an unstated mix, or with fewer than two current vendors. */
  readonly lowest: ReadonlySet<string>;
}

/** The comparison table: one row per vendor that can fill the order. */
export function compare(catalog: PriceCatalog, compound: string, variant: Variant, quantity: number, now: number): Comparison {
  const ctx = { rate: usdToCad(catalog.rates), staleHours: catalog.stale_hours, now };
  const vendors = new Map(catalog.vendors.map((v) => [v.slug, v]));
  const byVendor = new Map<string, PriceOffer[]>();
  for (const o of catalog.offers) if (o.compound === compound) byVendor.set(o.vendor, [...(byVendor.get(o.vendor) ?? []), o]);

  const quotes: Quote[] = [];
  for (const [slug, mine] of byVendor) {
    const vendor = vendors.get(slug);
    const quote = vendor ? vendorQuote(vendor, mine, variant.key, quantity, ctx) : null;
    if (quote) quotes.push(quote);
  }
  quotes.sort((a, b) =>
    Number(b.current) - Number(a.current) || unitCad(a) - unitCad(b)
    || b.offer.observed_at.localeCompare(a.offer.observed_at) || a.vendor.name.localeCompare(b.vendor.name));
  return { variant, quantity, quotes, lowest: variant.kind === 'unstated' ? new Set() : lowestOf(quotes) };
}

/**
 * Every current quote whose unit price, shown to the cent, equals the lowest
 * such price. A tie is a tie: the table's order never decides it. None with
 * fewer than two current vendors to compare.
 */
export function lowestOf(quotes: readonly Quote[]): Set<string> {
  const current = quotes.filter((q) => q.current);
  if (current.length < 2) return new Set();
  const cents = (q: Quote) => Math.round(unitCad(q));
  const least = Math.min(...current.map(cents));
  return new Set(current.filter((q) => cents(q) === least).map((q) => q.vendor.slug));
}

/** A compound's line on the index page. */
export interface IndexRow {
  readonly compound: PriceCompound;
  /** Vendors with a current listing. */
  readonly vendors: number;
  /** The lowest current single-vial price per mg (per vial for a blend) in CAD cents, with at least one vendor. */
  readonly fromCad: number | null;
  readonly unit: 'mg' | 'vial';
}

export function indexRows(catalog: PriceCatalog, now: number): IndexRow[] {
  const rate = usdToCad(catalog.rates);
  const byCompound = new Map<string, PriceOffer[]>();
  for (const o of catalog.offers) byCompound.set(o.compound, [...(byCompound.get(o.compound) ?? []), o]);
  const rows: IndexRow[] = [];
  for (const compound of catalog.compounds) {
    const offers = byCompound.get(compound.slug);
    if (!offers) continue;
    const blend = compound.type === 'Blend';
    const current = offers.filter((o) => isCurrent(o, catalog.stale_hours, now));
    let fromCad: number | null = null;
    for (const o of current) {
      if (o.vials_per_pack !== 1 || (blend && !o.recipe_key)) continue;
      const cad = toCad(o.price_minor, o.currency, rate);
      const unit = cad === null ? null : blend ? cad : o.mg_per_vial ? cad / Number(o.mg_per_vial) : null;
      if (unit !== null && (fromCad === null || unit < fromCad)) fromCad = unit;
    }
    rows.push({ compound, vendors: new Set(current.map((o) => o.vendor)).size, fromCad, unit: blend ? 'vial' : 'mg' });
  }
  return rows;
}

/** A blend mix key ("bpc-157:10+tb-500:10") as readable text ("BPC-157 10 mg + TB-500 10 mg"). */
export function mixLabel(mix: string, names: ReadonlyMap<string, string>): string {
  return mix.split('+').map((part) => {
    const [slug = '', mg = ''] = part.split(':');
    return `${names.get(slug) ?? slug.toUpperCase()} ${mg} mg`;
  }).join(' + ');
}

/** A milligram amount as text, without binary-fraction noise. */
export const mgText = (n: number): string => String(Number(n.toFixed(3)));

/** CAD cents as money: "$12.34" in English, "12,34 $" in French. Small per-mg figures keep their cents. */
export function formatCad(cents: number, locale: 'en' | 'fr'): string {
  return new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100);
}

/** An amount in the vendor's own currency, always with its currency code. */
export function formatNative(minor: number, currency: PriceCurrency, locale: 'en' | 'fr'): string {
  return `${new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100)} ${currency}`;
}
