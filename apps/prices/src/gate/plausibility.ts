/**
 * STRUCTURAL PLAUSIBILITY — deterministic, per-row reasons a stored offer cannot be right, and the
 * per-compound reference statistics they are judged against. PURE: no DB, no I/O.
 *
 * Every per-mg figure here is `per_mg_minor_e4` (minor units per mg × 10^4) in the row's NATIVE
 * currency, so references are keyed by compound AND currency: a CAD price never sets, or is judged
 * against, a USD band. Nothing here converts currency.
 *
 * Ported from PeptideBase's structural-plausibility.mjs, product-url-contract.mjs and
 * classifyPriceRow (price-gate-shared.mjs).
 */
import { sanitizeProductUrl } from "../ingest/build-offer.ts";
import type { OfferRow } from "../ingest/repo.ts";
import { validateAgainstRawText } from "../ladder/ladder.ts";
import { currencyExponent } from "../money.ts";

export const STRUCTURAL_THRESHOLDS = {
  MG_PER_VIAL_ABS_CEILING: 60, // a single vial above this is implausible unless the compound's own modal vial is larger
  MG_PER_VIAL_MODAL_MULT: 3, // …ceiling = max(ABS_CEILING, MODAL_MULT × modal mg per vial)
  MG_PER_VIAL_THIN_CEILING: 100, // NON-CIRCULAR ceiling for thin data: a single-row compound cannot be an outlier against itself
  MIN_ROWS_FOR_MODAL: 5, // below this, trust the hard ceiling and no market band
  ROBUST_FLOOR_DIVISOR: 2, // per-mg below winsorized p5 / this
  KIT_MULTIPLIER_TOLERANCE: 0.05, // wide enough for rounding, far below the smallest defect it catches (2×)
  PLAUSIBILITY_BAND_K: 10, // per-mg outside [median / K, median × K]
  PER_MG_ABS_CEILING_MAJOR: 1000, // thin-data backstop, in MAJOR units per mg
} as const;

export type StructuralReason =
  | "source_url_non_product"
  | "non_product_path"
  | "fabricated_url"
  | "compound_not_corroborated"
  | "currency_unresolved"
  | "price_ne_raw"
  | "kit_multiplier_ignored"
  | "per_mg_below_floor"
  | "per_mg_above_ceiling"
  | "mg_per_vial_implausible"
  | "per_vial_out_of_band";

/** Reported, never acted on as a class: a vendor really can list a large vial, so a sweep is refused. */
export const OBSERVE_ONLY_REASONS: ReadonlySet<StructuralReason> = new Set<StructuralReason>(["mg_per_vial_implausible"]);

export type OfferLike = Pick<
  OfferRow,
  "compound_id" | "native_currency" | "price_minor" | "mg_per_vial" | "vials_per_pack" | "per_mg_minor_e4" | "form" | "product_name" | "variant_label" | "raw_price_text" | "product_url"
>;

export interface CompoundRef {
  p5: number | null;
  medianPerMg: number | null;
  modalMgPerVial: number | null;
  nPriced: number;
}

/** What one row is judged against. Every member is optional: an absent one skips its check. */
export interface ClassifyRef extends Partial<CompoundRef> {
  vendorWebsiteUrl?: string | null;
  /** What the matcher says NOW for the row's stored name and label (`resolveProduct`). Undefined skips the check. */
  matchedCompoundId?: string | null;
}

// ── reference statistics ─────────────────────────────────────────────────────

/** Median of the positive values; null when there are none. */
export function median(nums: readonly number[]): number | null {
  const xs = nums.filter((n) => n > 0).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

/** The most frequent value; on a tie, the first to reach the winning count. */
export function modal(nums: readonly number[]): number | null {
  const counts = new Map<number, number>();
  let best: number | null = null;
  let bestCount = 0;
  for (const n of nums) {
    const k = (counts.get(n) ?? 0) + 1;
    counts.set(n, k);
    if (k > bestCount) {
      best = n;
      bestCount = k;
    }
  }
  return best;
}

/** Winsorized 5th percentile of the positive values (the robust floor basis). */
export function winsorizedP5(nums: readonly number[]): number | null {
  const xs = nums.filter((n) => n > 0).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  return xs[Math.floor(0.05 * (xs.length - 1))];
}

export const refKey = (row: { compound_id: string; native_currency: string }): string => `${row.compound_id}|${row.native_currency}`;

/**
 * Per compound-and-currency reference from REFERENCE rows. The caller chooses that population
 * (comparable rows with a per-mg) and it is not the population being judged — conflating the two
 * is how a check ends up unable to see the rows that fall out of it.
 */
export function buildCompoundRefs(rows: readonly Pick<OfferRow, "compound_id" | "native_currency" | "per_mg_minor_e4" | "mg_per_vial">[]): Map<string, CompoundRef> {
  const perMg = new Map<string, number[]>();
  const mgPerVial = new Map<string, number[]>();
  for (const r of rows) {
    const key = refKey(r);
    perMg.set(key, [...(perMg.get(key) ?? []), Number(r.per_mg_minor_e4)]);
    if (Number(r.mg_per_vial) > 0) mgPerVial.set(key, [...(mgPerVial.get(key) ?? []), Number(r.mg_per_vial)]);
  }
  return new Map(
    [...perMg.entries()].map(([key, values]) => [key, { p5: winsorizedP5(values), medianPerMg: median(values), modalMgPerVial: modal(mgPerVial.get(key) ?? []), nPriced: values.length }]),
  );
}

/** Well-populated compounds self-validate via MODAL_MULT × their modal vial; thin data falls back to a non-circular ceiling. */
export function mgPerVialCeiling(modalMgPerVial: number | null | undefined, nPriced = Infinity): number {
  const m = Number(modalMgPerVial);
  if (!(nPriced >= STRUCTURAL_THRESHOLDS.MIN_ROWS_FOR_MODAL) || !(m > 0)) return STRUCTURAL_THRESHOLDS.MG_PER_VIAL_THIN_CEILING;
  return Math.max(STRUCTURAL_THRESHOLDS.MG_PER_VIAL_ABS_CEILING, STRUCTURAL_THRESHOLDS.MG_PER_VIAL_MODAL_MULT * m);
}

// ── URL shape ────────────────────────────────────────────────────────────────

/** Paths that can never yield a price: legal, policy, tag archives, blog, sitemaps. */
export const NON_PRODUCT_URL_RE = /\/(legal|terms|contact(-us)?|privacy|product-tag|blog|faq|shipping|research-use|disclaimer|refund|policy|about)(\/|$)|sitemap[^/]*\.xml(?:$|[/?#])/i;

const NON_PRODUCT_FIRST_SEGMENT = new Set(["contact", "cart", "checkout", "sitemap", "research", "blog", "guide", "articles"]);

function isStagingHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  return /(^|\.)vercel\.app$/.test(h) || /(^|\.)netlify\.app$/.test(h) || h === "cdn.shopify.com" || /(^|\.)myshopify\.com$/.test(h);
}

/**
 * Is this URL shaped like a page that sells one product? False for a staging/preview host, an
 * asset CDN, a catalogue index or a utility/article path. Absence and malformed URLs are TRUE:
 * only an actively bad, well-formed URL is rejected here.
 */
export function classifyProductUrlShape(productUrl: string | null | undefined): boolean {
  if (typeof productUrl !== "string" || !productUrl.trim()) return true;
  let parsed: URL;
  try {
    parsed = new URL(productUrl.trim());
  } catch {
    return true;
  }
  if (!/^https?:$/i.test(parsed.protocol)) return true;
  if (isStagingHost(parsed.hostname)) return false;
  const segs = parsed.pathname.toLowerCase().split("/").filter(Boolean);
  // A `product(s)` segment followed by a slug is a product node wherever it sits — Shopify serves
  // the same product at /products/<slug> and /collections/<c>/products/<slug>.
  const at = segs.findIndex((s) => s === "product" || s === "products");
  if (at >= 0 && segs.length > at + 1) return true;
  if (segs.includes("collections")) return false;
  const first = segs[0] ?? "";
  if (segs.length === 1 && (first === "shop" || first === "products")) return false;
  return !NON_PRODUCT_FIRST_SEGMENT.has(first);
}

// ── currency ─────────────────────────────────────────────────────────────────

const CURRENCY_SIGNALS: readonly [RegExp, string][] = [
  [/(?<![A-Za-z])USD(?![A-Za-z])/, "USD"],
  [/(?<![A-Za-z])CAD(?![A-Za-z])|\bCA\$|\bC\$/, "CAD"],
  [/(?<![A-Za-z])GBP(?![A-Za-z])|£/, "GBP"],
  [/(?<![A-Za-z])EUR(?![A-Za-z])|€/, "EUR"],
  [/(?<![A-Za-z])AUD(?![A-Za-z])|\bAU\$|\bA\$/, "AUD"],
  [/(?<![A-Za-z])NZD(?![A-Za-z])|\bNZ\$/, "NZD"],
];

/** The currency a raw price text EXPLICITLY names, or null. A bare `$` names none. */
export function explicitCurrencySignal(rawText: string | null | undefined): string | null {
  const raw = String(rawText ?? "");
  const found = CURRENCY_SIGNALS.filter(([re]) => re.test(raw)).map(([, code]) => code);
  return found.length === 1 ? found[0] : null;
}

// ── the classifier ───────────────────────────────────────────────────────────

/**
 * The first structural reason a row fails, or null. URL provenance first (so such rows always
 * report it, not a band reason they also trip), then identity, currency, the transcription check,
 * arithmetic, the market band — and the observe-only vial ceiling LAST, so it never masks a
 * reason the gate acts on.
 */
export function classifyOfferRow(row: OfferLike, ref: ClassifyRef = {}): StructuralReason | null {
  if (row.product_url) {
    let pathname: string | null = null;
    try {
      pathname = new URL(row.product_url).pathname;
    } catch {
      pathname = null;
    }
    if (pathname && NON_PRODUCT_URL_RE.test(pathname)) return "source_url_non_product";
    if (!classifyProductUrlShape(row.product_url)) return "non_product_path";
    if (ref.vendorWebsiteUrl && sanitizeProductUrl(row.product_url, ref.vendorWebsiteUrl).rejectedReason === "placeholder") return "fabricated_url";
  }

  // Identity has ONE owner, the matcher. A row it would no longer file under this compound — a
  // changed alias, a fragment, a DAC variant — is not corroborated; a literal name search here
  // would be a second, weaker definition that disagrees with the first.
  if (ref.matchedCompoundId !== undefined && ref.matchedCompoundId !== row.compound_id) return "compound_not_corroborated";

  const signal = explicitCurrencySignal(row.raw_price_text);
  if (signal !== null && signal !== row.native_currency) return "currency_unresolved";

  // A transcription contradiction, judged in the row's own currency. A raw text with no number is
  // UNJUDGED — never an agreement, and never a contradiction.
  const raw = row.raw_price_text;
  if (/\d/.test(raw) && !validateAgainstRawText({ rawPriceText: raw, priceMinor: row.price_minor, currency: row.native_currency }, 0.01).ok) return "price_ne_raw";

  const perMg = row.per_mg_minor_e4 === null || row.per_mg_minor_e4 === undefined ? null : Number(row.per_mg_minor_e4);
  const price = Number(row.price_minor);
  const mg = Number(row.mg_per_vial);
  const vials = Number(row.vials_per_pack);

  // NARROW BY CONSTRUCTION: fires only when the stored value MATCHES the per-vial divide, so a row
  // wrong some other way keeps its own reason. Vials only — no other form's pack total is mg × count.
  if (row.form === "vial" && vials > 1 && mg > 0 && perMg !== null && perMg > 0 && price > 0) {
    const byPack = (price * 10_000) / (mg * vials);
    const byVial = (price * 10_000) / mg;
    const off = (a: number, b: number) => Math.abs(a / b - 1) > STRUCTURAL_THRESHOLDS.KIT_MULTIPLIER_TOLERANCE;
    if (off(perMg, byPack) && !off(perMg, byVial)) return "kit_multiplier_ignored";
  }

  if (perMg !== null && perMg > 0) {
    // The tight floor is a SINGLE-VIAL rule: a 10-vial wholesale kit legitimately sells well below
    // half the retail floor (owner ruling 2026-10-01: kits are compared). A kit is still held to
    // the ÷K market band below, which is what catches a feed error.
    const isKit = vials > 1;
    if (!isKit && ref.p5 !== null && ref.p5 !== undefined && ref.p5 > 0 && perMg < ref.p5 / STRUCTURAL_THRESHOLDS.ROBUST_FLOOR_DIVISOR) return "per_mg_below_floor";
    const med = ref.medianPerMg ?? null;
    const enough = (ref.nPriced ?? 0) >= STRUCTURAL_THRESHOLDS.MIN_ROWS_FOR_MODAL;
    if (enough && med !== null && med > 0) {
      if (perMg > med * STRUCTURAL_THRESHOLDS.PLAUSIBILITY_BAND_K) return "per_mg_above_ceiling";
      if (perMg < med / STRUCTURAL_THRESHOLDS.PLAUSIBILITY_BAND_K) return "per_mg_below_floor";
    } else if (perMg > STRUCTURAL_THRESHOLDS.PER_MG_ABS_CEILING_MAJOR * 10 ** currencyExponent(row.native_currency) * 10_000) {
      return "per_mg_above_ceiling";
    }
  }

  if (row.form === "vial" && mg > 0 && mg > mgPerVialCeiling(ref.modalMgPerVial, ref.nPriced)) return "mg_per_vial_implausible";
  return null;
}

/**
 * A blend vial is judged per vial against its own group — there is no per-mg figure. The group is
 * the blend and currency with the same exact mix, or, for a row whose mix is not stated, the same
 * stated total (or none): a wide band, but enough to catch a pack read as one vial. Outside
 * [median / K, median × K] with at least MIN_ROWS_FOR_MODAL rows in the group: a feed error.
 */
export function blendVialReason(row: Pick<OfferRow, "price_minor" | "vials_per_pack" | "is_blend" | "form">, medianPerVial: number | null, n: number): "per_vial_out_of_band" | null {
  const vials = Number(row.vials_per_pack);
  if (!row.is_blend || row.form !== "vial" || !(vials >= 1) || medianPerVial === null || !(medianPerVial > 0) || n < STRUCTURAL_THRESHOLDS.MIN_ROWS_FOR_MODAL) return null;
  const perVial = Number(row.price_minor) / vials;
  const k = STRUCTURAL_THRESHOLDS.PLAUSIBILITY_BAND_K;
  return perVial > medianPerVial * k || perVial < medianPerVial / k ? "per_vial_out_of_band" : null;
}
