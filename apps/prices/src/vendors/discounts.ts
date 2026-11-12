// A vendor's multipack discount, as its own pages state it (owner, 2026-10-06): a percentage off the
// whole order for buying several vials, given without a code. The evidence is a committed file, read
// and checked by hand (src/vendors/discount-evidence.json); `pnpm vendors:discounts` records it
// in quantity_tiers as verified vendor-wide vial tiers that expire 60 days after the check.

export interface DiscountEvidence {
  slug: string;
  /** Ascending by vials; the percentage never falls. Empty: checked, and no such discount found. */
  tiers: { vials: number; percent: number }[];
  /** Whether the vendor's pages say the discount covers its blends too. */
  blends?: boolean;
  /** Whether vials of different compounds count together ("mix and match"). */
  any_product?: boolean;
  /** Where the discount is given: in the cart, or on the vendor's own pack page. Never a code. */
  mechanism?: "cart" | "pack page";
  /** The page that says so (https only), and the vendor's words, verbatim. */
  source?: string;
  quote?: string;
  /** The day the page was read, YYYY-MM-DD. */
  checked: string;
  notes?: string;
}

const fail = (slug: unknown, why: string): never => {
  throw new Error(`discount evidence ${JSON.stringify(slug)}: ${why}`);
};

const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** The file's entries, or an error naming the first one that is not evidence. */
export function validateDiscounts(raw: unknown): DiscountEvidence[] {
  if (!Array.isArray(raw)) return fail("file", "not a list");
  const seen = new Set<string>();
  return raw.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return fail(entry, "not an entry");
    const e = entry as Record<string, unknown>;
    const { slug, tiers, checked } = e;
    if (typeof slug !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return fail(slug, "slug");
    if (seen.has(slug)) return fail(slug, "listed twice");
    seen.add(slug);
    if (!isDay(checked)) return fail(slug, "checked must be a real day, YYYY-MM-DD");
    if (!Array.isArray(tiers)) return fail(slug, "tiers must be a list");
    if (tiers.length === 0) return e as unknown as DiscountEvidence;
    let last = { vials: 0, percent: 0 };
    for (const t of tiers as unknown[]) {
      const { vials, percent } = (t ?? {}) as Record<string, unknown>;
      if (typeof vials !== "number" || !Number.isInteger(vials) || vials < 1 || vials > 100) return fail(slug, "a tier's vials must be a whole number from 1 to 100");
      if (typeof percent !== "number" || !(percent > 0 && percent < 100)) return fail(slug, "a tier's percent must be above 0 and below 100");
      if (vials <= last.vials || percent < last.percent) return fail(slug, "tiers must rise in vials, and the percent never fall");
      last = { vials, percent };
    }
    const { source, quote, mechanism, blends, any_product } = e;
    if (typeof source !== "string" || !/^https:\/\/[^\s/]+\.[^\s]+$/.test(source)) return fail(slug, "source must be an https address");
    if (typeof quote !== "string" || quote.trim() === "") return fail(slug, "quote");
    // Every number recorded is in the vendor's own words, as a figure or a word ("six"). A one-vial
    // tier is a discount on every order ("10% off every compound vial"): its percent must be there.
    for (const t of tiers as { vials: number; percent: number }[])
      for (const n of t.vials === 1 ? [t.percent] : [t.vials, t.percent]) if (!inWords(quote, n)) return fail(slug, `${n} is not in the quote`);
    if (mechanism !== "cart" && mechanism !== "pack page") return fail(slug, "mechanism must be 'cart' or 'pack page' — a code is never a multipack discount");
    if (typeof blends !== "boolean" || typeof any_product !== "boolean") return fail(slug, "blends and any_product must be true or false");
    return e as unknown as DiscountEvidence;
  });
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

/** Whether a number appears in a quote as a figure (not part of a longer one), or as a word up to twenty. */
function inWords(quote: string, n: number): boolean {
  const figure = new RegExp(`(^|[^0-9.])${String(n).replace(".", "\\.")}([^0-9]|$)`);
  return figure.test(quote) || (Number.isInteger(n) && n < WORDS.length && new RegExp(`\\b${WORDS[n]}\\b`, "i").test(quote));
}

const EXPIRES_DAYS = 60;

/** The quantity_tiers rows an entry records: verified, vendor-wide, all units, expiring 60 days after the check. */
export function tierRows(e: DiscountEvidence, vendorId: string) {
  const until = new Date(`${e.checked}T00:00:00Z`);
  until.setUTCDate(until.getUTCDate() + EXPIRES_DAYS);
  return e.tiers.map((t) => ({
    vendor_id: vendorId,
    compound_id: null,
    threshold: t.vials,
    basis: "vials",
    scope: "all_units",
    discount_pct: t.percent,
    applies_to_blends: e.blends === true,
    mix_and_match: e.any_product === true,
    evidence_url: e.source ?? "",
    evidence_text: e.quote ?? "",
    observed_at: `${e.checked}T00:00:00Z`,
    valid_from: e.checked,
    valid_to: until.toISOString().slice(0, 10),
    status: "verified",
  }));
}
