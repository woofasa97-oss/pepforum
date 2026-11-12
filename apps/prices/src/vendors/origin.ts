// Where a vendor's business is based, as its own pages state it (spec 2026-10-08, part 1): an X post
// names a market only for vendors with this evidence. Read by hand into origin-evidence.json and
// checked here; nothing in this file touches a database. A .ca domain, CAD prices or a "ships from"
// line are never a business base (handoff §5).
import { isHttpsSource, isRealDay, isReview } from "./shipping.ts";

export const BASES = ["CA", "US", "OTHER", "unknown", "conflict"] as const;
export type Base = (typeof BASES)[number];
/** The kind of statement the base rests on, so a weak one stays visible. */
export const BASIS = ["business address", "company statement", "legal entity", "governing law"] as const;
export type Basis = (typeof BASIS)[number];
const SHIPS_FROM = ["CA", "US", "OTHER"] as const;

export interface OriginEvidence {
  slug: string;
  based_in: Base;
  /** Absent only when nothing was found (`unknown`). */
  basis?: Basis;
  /** The page that says so (https only); for `unknown`, the last page read. */
  source: string;
  /** The vendor's words, verbatim ("…" between fragments). Empty only for `unknown`. */
  quote: string;
  /** The day the page was read, YYYY-MM-DD. */
  checked: string;
  /** Who read the page. */
  read_by: string;
  /** Where orders ship from, when a page says so — never evidence of the business base. */
  ships_from?: (typeof SHIPS_FROM)[number];
  /** "owner YYYY-MM-DD" once the owner has approved the list. */
  reviewed?: string;
  notes?: string;
}

const fail = (slug: unknown, why: string): never => {
  throw new Error(`origin evidence ${JSON.stringify(slug)}: ${why}`);
};
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** The file's entries, or an error naming the first one that is not evidence. */
export function validateOrigin(raw: unknown): OriginEvidence[] {
  if (!Array.isArray(raw)) return fail("file", "not a list");
  const seen = new Set<string>();
  return raw.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return fail(entry, "not an entry");
    const e = entry as Record<string, unknown>;
    const { slug, based_in, basis, source, quote, checked, read_by, ships_from, reviewed, notes } = e;
    if (typeof slug !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return fail(slug, "slug");
    if (seen.has(slug)) return fail(slug, "listed twice");
    seen.add(slug);
    if (!oneOf(BASES, based_in)) return fail(slug, `based_in must be one of ${BASES.join(", ")}`);
    const found = based_in !== "unknown";
    if (found && !oneOf(BASIS, basis)) return fail(slug, `basis must be one of ${BASIS.join(", ")}`);
    if (!found && basis !== undefined) return fail(slug, "basis is only for a base that was found");
    if (!isHttpsSource(source)) return fail(slug, "source must be an https address");
    if (typeof quote !== "string" || (found && quote.trim() === "")) return fail(slug, "quote");
    if (basis === "business address" && /\b(shipping|return|returns|warehouse|fulfil?lment)\s+address\b/i.test(quote)) return fail(slug, "a shipping, return or warehouse address is not a business address");
    if (!isRealDay(checked)) return fail(slug, "checked must be a real day, YYYY-MM-DD");
    if (typeof read_by !== "string" || read_by.trim() === "") return fail(slug, "read_by");
    if (ships_from !== undefined && !oneOf(SHIPS_FROM, ships_from)) return fail(slug, "ships_from");
    if (!isReview(reviewed)) return fail(slug, 'reviewed must be "owner YYYY-MM-DD"');
    if (notes !== undefined && typeof notes !== "string") return fail(slug, "notes");
    if (based_in === "conflict" && (typeof notes !== "string" || notes.trim() === "")) return fail(slug, "a conflict needs notes quoting both statements");
    return e as unknown as OriginEvidence;
  });
}
