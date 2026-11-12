// Where a vendor ships, as its own pages state it (owner, 2026-10-05): the USA view lists a vendor
// based in Canada only on such evidence. The evidence is a committed file, read and checked by hand
// (src/vendors/shipping-evidence.json); `pnpm vendors:shipping` records it in vendors.ships_to.

export interface ShippingEvidence {
  slug: string;
  /** The countries the vendor's own page says it ships to (the site knows the USA and Canada). */
  ships_to: ("CA" | "US")[];
  /** The page that says so (https only). */
  source: string;
  /** The vendor's words, verbatim. */
  quote: string;
  /** The day the page was read, YYYY-MM-DD. */
  checked: string;
  /** Limits the vendor states, verbatim (states it does not ship to, products that cannot go there). */
  restrictions?: string;
  /** Who read the page. */
  read_by?: string;
  /** "owner YYYY-MM-DD" once the owner has approved the list (X posts need it; the site does not). */
  reviewed?: string;
  notes?: string;
}

/** An https address with a host (the only kind of evidence source we keep). */
export const isHttpsSource = (s: unknown): s is string => typeof s === "string" && /^https:\/\/[^\s/]+\.[^\s]+$/.test(s);

/** A real calendar day written YYYY-MM-DD. */
export function isRealDay(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Absent, or the owner's approval with its day. */
export const isReview = (s: unknown): boolean => s === undefined || (typeof s === "string" && /^owner \d{4}-\d{2}-\d{2}$/.test(s) && isRealDay(s.slice(6)));

const optionalText = (s: unknown) => s === undefined || (typeof s === "string" && s.trim() !== "");

const fail = (slug: unknown, why: string): never => {
  throw new Error(`shipping evidence ${JSON.stringify(slug)}: ${why}`);
};

/** The file's entries, or an error naming the first one that is not evidence. */
export function validateEvidence(raw: unknown): ShippingEvidence[] {
  if (!Array.isArray(raw)) return fail("file", "not a list");
  const seen = new Set<string>();
  return raw.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return fail(entry, "not an entry");
    const e = entry as Record<string, unknown>;
    const { slug, ships_to, source, quote, checked } = e;
    if (typeof slug !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return fail(slug, "slug");
    if (seen.has(slug)) return fail(slug, "listed twice");
    seen.add(slug);
    if (!Array.isArray(ships_to) || ships_to.length === 0 || new Set(ships_to).size !== ships_to.length || !ships_to.every((c) => c === "CA" || c === "US")) return fail(slug, "ships_to");
    if (!isHttpsSource(source)) return fail(slug, "source must be an https address");
    if (typeof quote !== "string" || quote.trim() === "") return fail(slug, "quote");
    if (!isRealDay(checked)) return fail(slug, "checked must be a real day, YYYY-MM-DD");
    if (!optionalText(e.restrictions)) return fail(slug, "restrictions must be text");
    if (!optionalText(e.read_by)) return fail(slug, "read_by must be text");
    if (!isReview(e.reviewed)) return fail(slug, 'reviewed must be "owner YYYY-MM-DD"');
    return e as unknown as ShippingEvidence;
  });
}

/** What vendors.ships_to_source records: the page and the day it was read. */
export const shipsSource = (e: ShippingEvidence) => `${e.source} (checked ${e.checked})`;
