/**
 * THE single canonical-unit parser. Ported from PeptideBase's canonical-unit.mjs (2026-09),
 * rules unchanged. Consumed by the offer builder (ingest), reconcile and the gate: one
 * definition, zero drift — do not fork this logic.
 *
 * Canonical comparison unit = ONE real injectable vial at the compound's standard
 * concentration. Bulk powder, >100 mg "vials", non-vial forms (capsule/gel/nasal) and blends
 * are all refused with a TYPED reason — never a silent null.
 *
 * TWO PARSERS, TWO JOBS, AND THEY MUST NOT BE MERGED.
 *   canonicalVialMg()  the COMPARABLE gate: "may this mass serve as the per-mg denominator?"
 *   parseSize()        the LABEL parser: "what does the label SAY?" — a 500 mg NAD+ vial
 *                      reports 500 because 500 is what is printed. It never withholds a
 *                      printed number to express a comparability verdict.
 */
import { isBlendProduct } from "./blend.ts";

/** A single injectable vial above this is bulk, not a vial. */
export const VIAL_MAX_MG = 100;

export type CanonicalRefusal = "blend" | "non_vial_form" | "bulk_over_max" | "no_mg" | "pack_ambiguous";

export type CanonicalVial =
  | { mg: number; packCount: number; totalMg: number; reason: null }
  | { mg: null; reason: CanonicalRefusal };

// Non-vial delivery forms + bulk indicators. `\bg\b`/gram and "powder"/"bulk" catch lyophilized
// bulk grams; capsule/gel/nasal/etc. are valid products but not vial-per-mg-comparable. A volume
// ("30ml" — `\bml\b` alone never matches it, digit and `m` are both word characters), a
// "solution" or a "liquid" ("LIQ", as one store abbreviates it) is a pre-mixed product: mL is never
// converted to mg. A "dry-fill" is a filled powder, sold beside the lyophilized vial at another price.
const NON_VIAL_RE =
  /\b(caps?|capsules?|per\s*cap|tabs?|tablets?|gels?|creams?|serums?|transdermal|nasal|sublingual|troches?|patch(?:es)?|oral|lozenges?|ml|solutions?|liquids?|liq|dry[\s-]?fill)\b|\d\s*ml\b|\/cap|\bpowder\b|\bbulk\b|\bgram\b|\bgrams\b|\bg\b/i;

/** A listing only a wholesale account may buy: its price is not what one vial costs a visitor. */
const WHOLESALE_ONLY_RE = /\bwholesale\s+only\b/i;

/**
 * Blend-only refusals beyond NON_VIAL_RE: a topical, dissolving strips and films, "melts", and
 * "btls." (one vendor's capsule bottles). Not "bottle": another vendor labels its vials "Bottle
 * Content: 10mg+10mg". A percentage alone says nothing: on real listings it is mostly a
 * discount, "Save 20%".
 */
const TOPICAL_RE = /\btopical\b|\bstrips?\b|\bfilms?\b|\bdissolv\w*|\bmelts?\b|\bbtls?\b/i;

/**
 * A capsule, spray, cream, topical, liquid or bulk powder: never a vial, whatever else the label
 * says. Used for blends; single compounds keep `canonicalVialMg`'s own refusals.
 */
export const isNonVialForm = (text: string): boolean => {
  const t = normalizeQuantityText(text);
  return NON_VIAL_RE.test(t) || TOPICAL_RE.test(t);
};

/**
 * Multi-pack multiplicity in a product/variation name ("(2-Pack) CJC-1295 NO DAC 5mg" priced
 * against ONE vial's mg is a ~2× inflated per-mg). Counted shapes: "2-Pack", "pack/box/bundle of
 * 3", "Vials: 10" (what a WooCommerce attribute renders as), "10 vials", "10pk", "x2", "2 x 5mg".
 * A pack/kit word WITHOUT a countable number, a bare "Quantity: 3", or a count of unnamed units
 * is AMBIGUOUS → fail-safe (refuse), never guess. `count` is 1 when there is no pack wording.
 */
/**
 * A count of DOSAGE UNITS — "60 units", "30 count", "60ct". It says the price buys many of
 * something and does not say the something is a vial (on the stores read so far it is capsules
 * or tablets), so one stated mass is not what the price buys. Ambiguous → refuse, never guess.
 */
const UNIT_COUNT_RE = /(?<![\w.])\d+\s*(?:units?|count|ct)\b/i;

/** Lookahead: the number just read is NOT followed by a quantity unit ("10 mg", "10.5mg"). */
const NOT_A_QUANTITY = String.raw`(?!\s*(?:\.\d+)?\s*(?:mcg|µg|ug|mg|g|ml|iu)\b)`;

/**
 * "1,500mg" is 1500 mg. Without this the mass readers start at the digit after the comma and
 * report 500 — and "1,200mcg" becomes a comparable 0.2 mg vial. Only a separator inside a
 * number that wears a quantity unit is removed; a size list ("5mg,10mg") and a name that ends
 * in digits ("BPC-157,500mcg") are left alone.
 */
export function normalizeQuantityText(text: string): string {
  return (
    text
      .replace(/(?<![\w.,-])(\d{1,3}),(\d{3})(?=\s*(?:mcg|µg|ug|mg|g|iu|ml)\b)/gi, "$1$2")
      // A decimal comma: "2,5mg" is 2.5 and "0,25mg" is 0.25 — read as written they are 5 and 25.
      // Only an unmistakable decimal (one digit after the comma, or a leading zero): "5,10mg" is
      // a size list and is left alone.
      .replace(/(?<![\w.,-])(\d+),(\d)(?=\s*(?:mcg|µg|ug|mg|g|iu|ml)\b)/gi, "$1.$2")
      .replace(/(?<![\w.,-])0,(\d{1,3})(?=\s*(?:mcg|µg|ug|mg|g|iu|ml)\b)/gi, "0.$1")
  );
}

export function packMultiplicity(text: string): { count: number | null; ambiguous: boolean } {
  const patterns = [
    /(?<![\w-])(\d+)\s*-?\s*pack\b/i, // "2-Pack", "3 pack" — never the 157 of "BPC-157 Pack"
    /\b(?:pack|box|bundle|set|case|kit)\s+of\s+(\d+)\b/i, // "pack of 3", "Box of 10"
    // "Vials: 10", "Number of vials: 5", "Vial Amount: 25" — but "Vial: 10 mg" states a mass.
    new RegExp(String.raw`\b(?:number\s+of\s+)?vials?(?:\s+(?:amount|count|qty|quantity))?\s*[:=]\s*(\d+)\b${NOT_A_QUANTITY}`, "i"),
    // "10 vials", "(70mg) -10 Vials" — never the 157 of "BPC-157 Vial" (a hyphen after a letter).
    /(?<!\w)(?<!\w[-–])(\d+)\s*vials?\b/i,
    /(?<![\w.])(\d+)\s*pk\b/i, // "10pk"
    // "2 x 5mg", "Kit (10 x 5/5mg)" — the count before a mass or a blend's dose list.
    /(?<![\w-])(\d+)\s*[x×]\s*(?=\d+(?:\.\d+)?(?:\s*m(?:c?)g)?(?:\s*[/+]\s*\d+(?:\.\d+)?(?:\s*m(?:c?)g)?)*\s*m(?:c?)g\b)/i,
    // "Vial x2" (but not "x 5mg", not "x 5/5mg", and not the x of "Max 2")
    /(?<![a-z])[x×]\s*(\d+)\b(?!\s*m(?:c?)g\b)(?!\s*[/+])/i,
  ];
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 50) return { count: n, ambiguous: false };
      return { count: null, ambiguous: true }; // absurd count — don't trust it
    }
  }
  // One vial stated in words — "Pack Size: Single Vial" (VPeptide's variation labels), "One vial".
  // Without this, the word "pack" in the attribute's name made every such single vial ambiguous.
  if (/\b(?:single|one)[-\s]vials?\b|\bpack\s*size\s*[:=]\s*(?:single|one|1)\b/i.test(text)) return { count: 1, ambiguous: false };
  if (/\b(twin|double|triple|value|multi)[-\s]?pack\b|\bpack\b|\bkit\b/i.test(text)) {
    return { count: null, ambiguous: true }; // pack wording, no countable number
  }
  if (UNIT_COUNT_RE.test(text)) return { count: null, ambiguous: true }; // many units of an unnamed form
  // "Quantity: 3" — of what? Ambiguous. "qty: 1" is simply one; "Quantity: 5 mg" is a mass.
  const bare = new RegExp(String.raw`\b(?:quantity|qty)\s*[:=]\s*(\d+)\b${NOT_A_QUANTITY}`, "i").exec(text);
  if (bare && parseInt(bare[1], 10) !== 1) return { count: null, ambiguous: true };
  return { count: 1, ambiguous: false };
}

/**
 * Parse ONE vial's mg from a product/variation name or attribute token.
 * `totalMg` = mg × packCount — the amount the price actually buys; per-mg MUST divide by it.
 */
export function canonicalVialMg(input: string | null | undefined, opts: { isBlend?: boolean } = {}): CanonicalVial {
  if (typeof input !== "string" || input.trim() === "") return { mg: null, reason: "no_mg" };
  const text = normalizeQuantityText(input);
  if (opts.isBlend || isBlendProduct(text)) return { mg: null, reason: "blend" };
  if (NON_VIAL_RE.test(text)) return { mg: null, reason: "non_vial_form" };
  if (WHOLESALE_ONLY_RE.test(text)) return { mg: null, reason: "pack_ambiguous" };
  const pack = packMultiplicity(text);
  if (pack.ambiguous || pack.count === null) return { mg: null, reason: "pack_ambiguous" };
  const perVial = oneVialMg(text, pack.count);
  if (perVial === "ambiguous") return { mg: null, reason: "pack_ambiguous" };
  if (perVial === null) return { mg: null, reason: "no_mg" };
  if (perVial > VIAL_MAX_MG) return { mg: null, reason: "bulk_over_max" };
  return { mg: perVial, packCount: pack.count, totalMg: perVial * pack.count, reason: null };
}

/** One mass figure: not the tail of a longer number ("157,500", "2.5"), and ".5" is a half. */
const MASS_FIGURE = String.raw`(?<![\d.])(?<!\d,)(\d+(?:\.\d+)?|\.\d+)\s*(mcg|mg)\b`;

/**
 * The mass of ONE vial, in mg.
 *   "3 x 10mg"                 names it outright (10), whatever total the name leads with;
 *   "50mg (10mg x 5)"          a mass that is count × another names the pack total: the vial is 10;
 *   "Total: 50mg (10 vials)"   a mass called a total, on either side, is divided by the count;
 *   otherwise                  the first stated mass, an mg figure before an mcg one.
 * A pack whose one mass cannot be tied to the word "total" beside it is AMBIGUOUS — the caller
 * refuses rather than guess which of the two it is.
 */
function oneVialMg(text: string, packCount: number): number | "ambiguous" | null {
  const toMg = (value: string, unit: string): number => (unit.toLowerCase() === "mcg" ? parseFloat(value) / 1000 : parseFloat(value));
  const each = new RegExp(String.raw`(?<![\w.])\d+\s*[x×]\s*${MASS_FIGURE}`, "i").exec(text);
  if (each) return toMg(each[1], each[2]);

  const masses = [...text.matchAll(new RegExp(MASS_FIGURE, "gi"))].map((m) => {
    const start = m.index ?? 0;
    const calledTotal = /^\s*\)?\s*\(?\s*(?:in\s+)?total\b/i.test(text.slice(start + m[0].length)) || /\btotal(?:\s+amount)?\s*[:=-]?\s*\(?\s*$/i.test(text.slice(0, start));
    return { mg: toMg(m[1], m[2]), isMg: m[2].toLowerCase() === "mg", isTotal: calledTotal };
  });
  if (packCount > 1) {
    const unit = masses.find((m) => masses.some((other) => other !== m && Math.abs(other.mg - m.mg * packCount) < 1e-9));
    if (unit) return unit.mg;
  }
  const stated = masses.find((m) => !m.isTotal && m.isMg) ?? masses.find((m) => !m.isTotal);
  if (stated) {
    if (packCount > 1 && masses.length === 1 && /\btotal\b/i.test(text)) return "ambiguous";
    return stated.mg;
  }
  return masses.length > 0 ? masses[0].mg / packCount : null;
}

export interface WooVariation {
  priceUsd: number;
  text: string;
}

interface RawWooVariation {
  display_price?: unknown;
  price?: unknown;
  prices?: { price?: unknown };
  attributes?: Record<string, unknown>;
  sku?: unknown;
  name?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a WooCommerce product page's variation payload into `[{ priceUsd, text }]`, across
 * the shapes seen on Woo themes. FAILS SAFE (returns `[]`) on the `"false"` sentinel (WC emits
 * `data-product_variations="false"` when it defers to AJAX), on missing/empty input and on
 * malformed JSON — a held row beats a silently mispriced one.
 * @param raw a JSON string, an already-parsed array, or a wrapper object (`{ variations: [...] }`).
 */
export function parseWooVariations(raw: unknown): WooVariation[] {
  let data: unknown = raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t === "" || t === "false" || t === "null") return [];
    try {
      data = JSON.parse(t);
    } catch {
      return [];
    }
  }
  if (isRecord(data) && Array.isArray(data.variations)) data = data.variations;
  if (!Array.isArray(data)) return [];
  return data
    .map((entry: unknown): WooVariation => {
      const v: RawWooVariation = isRecord(entry) ? (entry as RawWooVariation) : {};
      const priceUsd = Number(v.display_price ?? v.price ?? v.prices?.price);
      // Attribute values carry the size/form ("Peptide (Lyophilized) 5mg"); sku/name as fallback.
      const text = v.attributes
        ? Object.values(v.attributes).filter(Boolean).map(String).join(" ")
        : String(v.sku || v.name || "");
      return { priceUsd, text };
    })
    .filter((v) => v.text !== "" || v.priceUsd > 0);
}

export interface CanonicalSelection {
  perMg: number;
  priceUsd: number;
  mg: number;
  totalMg: number;
  packCount: number;
  text: string;
}

/**
 * From a variable product's variations, select the cheapest REAL single-vial SKU as the
 * canonical per-mg unit, rejecting bulk/powder/non-vial/blend variations. `null` when no
 * variation is a real vial. (Float per-mg here is a SELECTION key only; stored money goes
 * through `perMgMinorE4`.)
 */
export function selectCanonicalVariation(variations: WooVariation[] | null | undefined): CanonicalSelection | null {
  let best: CanonicalSelection | null = null;
  for (const v of variations ?? []) {
    const parsed = canonicalVialMg(v.text);
    if (parsed.reason !== null || !(parsed.mg > 0) || !(v.priceUsd > 0)) continue;
    // Per-mg divides by totalMg — the amount the price actually buys (multi-pack correction).
    const perMg = v.priceUsd / parsed.totalMg;
    if (best === null || perMg < best.perMg) {
      best = { perMg, priceUsd: v.priceUsd, mg: parsed.mg, totalMg: parsed.totalMg, packCount: parsed.packCount, text: v.text };
    }
  }
  return best;
}

// ── parseSize — THE label parser ─────────────────────────────────────────────

/** The unit a label denominates its quantity in. `null` when the label states none. */
export type ParsedSizeUnit = "mg" | "iu" | "ml" | "capsule";

/** The forms a label can NAME. `blend`, `bulk_powder`, `vial_solution` and `other` are
 *  CONCLUSIONS drawn from a label, not words printed on one, so they are absent on purpose. */
export type ParsedSizeForm = "vial_lyophilized" | "pen" | "nasal" | "capsule" | "tablet" | "topical";

/** How much of the label was read unambiguously. `low` means multi-size or no mass at all. */
export type ParsedSizeConfidence = "high" | "medium" | "low";

export type PackageKind = "single" | "kit" | "tier" | "unknown";

export interface LabelledQuantity {
  value: number;
  unit: string;
  /** The matched substring, unmodified, so the stored value can be audited against the page. */
  raw: string;
}

/**
 * One vendor size label, read. DESCRIPTIVE — it reports what the label states and flags what
 * the label leaves unresolved. Comparability is `canonicalVialMg`'s job and is deliberately
 * not represented here.
 */
export interface ParsedSize {
  /** Mass per unit in mg (mcg ÷ 1000, g × 1000). A blend's is the SUM of its stated masses.
   *  `null` when the label states no mass, or states several unresolved ones. */
  mg_per_vial: number | null;
  /** Pack count. `1` when a quantity was read and no pack word appeared; `null` when the label
   *  states neither, and when a size list leaves the package unresolved. */
  vials_per_kit: number | null;
  quantity_unit: ParsedSizeUnit | null;
  form: ParsedSizeForm | null;
  /** `isBlendProduct()` — the single blend definition, never a second one. */
  is_blend: boolean;
  /** Two or more DIFFERENT masses joined as a list ("5mg / 10mg / 20mg"): a variant set the
   *  page has not resolved. Resolved by reading the variants, never by picking one. */
  multi_size: boolean;
  confidence: ParsedSizeConfidence;
  package_kind: PackageKind;
  /** The first quantity token, verbatim, for display and audit. */
  labelled: LabelledQuantity | null;
}

/**
 * Quantity-tier wording: a discount for buying several, not a bigger package. A tier leaves
 * the comparable quantity at ONE unit and becomes a promotion on the base variant; a kit is a
 * distinct variant. Reading a tier as a kit halves the per-mg figure.
 */
export const TIER_RE = /\bbuy\s+\d+\b|\b\d+\s+or\s+more\b|\b\d+\s*\+\s*(?:units?|vials?)\b|\bbulk\s+(?:discount|pricing|tier|savings|rate)/i;

/** The first quantity token in the text, verbatim. A LABEL read, deliberately not an mg derivation. */
export const LABELLED_RE = /(?<![\w.])(\d+(?:\.\d+)?)\s*(mcg|mg|iu|ml|count|ct|g)\b/i;

/** Mass units, longest-first so `mcg` is never read as `g` and `mg` never as `g`. The `g`
 *  alternative carries `(?![a-z])` at every use site: the `g` of `mg`, `kg` and `µg` is not a
 *  gram, and reading it as one is a 1000× error in the direction that makes a vendor look cheap. */
const MASS_UNIT_ALT = "mcg|µg|ug|mg|g(?:rams?)?";
const MASS_TOKEN_RE = new RegExp(`(?<![\\w.])(\\d+(?:\\.\\d+)?)\\s*(${MASS_UNIT_ALT})(?![a-z])`, "gi");

const MASS_RUN_RE = new RegExp(
  `(?<![\\w.])\\d+(?:\\.\\d+)?\\s*(?:${MASS_UNIT_ALT})(?![a-z])(?:\\s*(?:[/,|+&]|or)\\s*\\d+(?:\\.\\d+)?\\s*(?:${MASS_UNIT_ALT})(?![a-z]))*`,
  "gi",
);

/** mg/ml is a CONCENTRATION, never a package mass. Checked before any mass token is read:
 *  "10mg/ml x 3ml" is 30 mg, and the one thing it must never report is 10. */
const MG_PER_ML_RE = /(\d+(?:\.\d+)?)\s*mg\s*\/\s*ml\b/i;
const ML_VOLUME_RE = /(\d+(?:\.\d+)?)\s*ml\b/i;
/** Both spellings: `\bml\b` alone does NOT match "30ml" (digit and `m` are both word characters). */
const ML_TOKEN_RE = /\bml\b|\d\s*ml\b/i;
const IU_TOKEN_RE = /(?<![\w.])\d+(?:\.\d+)?\s*iu\b/i;
const CAPSULE_COUNT_RE = /(?<![\w.])(\d+)\s*(?:capsules?|caps|tablets?)\b/i;

/** A SIZE LIST separator. Two different masses joined by one of these is a variant list the
 *  page has not resolved. Anything else between two masses (" × 10 Vials (") is structure. */
const SIZE_JOINER_RE = /^\s*(?:[/,|]|or)\s*$/i;

/** Two or more doses sharing one trailing unit: "5mg/5mg", "5/5 mg", "5 + 5 mg", "8MG/2MG".
 *  Blend-only — the SUM of a blend's stated masses is what one vial contains. */
const DOSE_LIST_RE = new RegExp(
  `(?<![\\w.])(\\d+(?:\\.\\d+)?(?:\\s*(?:${MASS_UNIT_ALT})?\\s*[/+]\\s*\\d+(?:\\.\\d+)?)+)\\s*(${MASS_UNIT_ALT})(?![a-z])`,
  "i",
);

/**
 * Pack-count shapes, in precedence order. This EXTENDS packMultiplicity rather than reusing it:
 * packMultiplicity is the per-mg gate's counter (caps at 50, AMBIGUOUS above — right for a vial
 * multiplier, wrong for "60 Capsules"). Two lookbehinds are load-bearing: `(?<![\w-])` before a
 * count so "BPC-157 x 5mg" is not 157 vials; `(?<![a-z])` before the bare-x shape so "Max 10"
 * is not "× 10".
 */
const PACK_COUNT_RES = [
  /(?<![\w-])(\d+)\s*-?\s*pack\b/i, // "2-Pack", "3 pack"
  /\b(?:pack|kit|set|box)\s+of\s+(\d+)\b/i, // "pack of 3", "Kit of 10"
  /(?<![\w-])(\d+)\s*(?:vials?|bottles?|capsules?|caps|tablets?)\b/i, // "10 vials", "60 Capsules"
  /(?<![\w-])(\d+)\s*(?:per|\/)\s*kit\b/i, // "10 per kit"
  new RegExp(`(?<![\\w-])(\\d+)\\s*[x×]\\s*(?=\\d+(?:\\.\\d+)?\\s*(?:${MASS_UNIT_ALT})\\b)`, "i"), // "10 x 5mg"
  new RegExp(`(?<![a-z])[x×]\\s*(\\d+)\\b(?!\\s*(?:${MASS_UNIT_ALT}|ml|iu)\\b)`, "i"), // "Vial x2"
];

/** Form words ONLY. A form is never inferred from a number: "10 mg" says nothing about whether
 *  it arrives in a vial, a pen or a capsule. */
const FORM_RES: Array<[ParsedSizeForm, RegExp]> = [
  ["pen", /\bpens?\b|\bpre[-\s]?mixed\b|\bpre[-\s]?filled\b/i],
  ["nasal", /\bnasal\b|\bsprays?\b/i],
  ["capsule", /\bcapsules?\b|\bcaps\b/i],
  ["tablet", /\btablets?\b|\btabs?\b|\btroches?\b|\bsublingual\b/i],
  ["topical", /\bcreams?\b|\bgels?\b|\bserums?\b|\bpatch(?:es)?\b/i],
  ["vial_lyophilized", /\bvials?\b|\blyophili[sz]ed\b/i],
];

interface MassToken {
  mg: number;
  start: number;
  end: number;
}

/** Float dust from a unit conversion or a concentration multiply, trimmed at ng precision. */
function trimMg(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function unitToMg(value: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u === "mcg" || u === "µg" || u === "ug") return trimMg(value / 1000);
  if (u.charAt(0) === "g") return trimMg(value * 1000); // g / gram / grams — never mcg, mg or µg
  return trimMg(value);
}

/** Every mass token in the text, in order, WITH its offsets — what makes a size list
 *  ("5mg / 10mg") distinguishable from a per-unit mass beside a pack total ("10mg × 10 Vials (100mg)"). */
function massTokens(text: string): MassToken[] {
  const out: MassToken[] = [];
  for (const m of text.matchAll(MASS_TOKEN_RE)) {
    const start = m.index ?? 0;
    out.push({ mg: unitToMg(parseFloat(m[1]), m[2]), start, end: start + m[0].length });
  }
  return out;
}

/** The text with every mass token removed — the NAME, without its figures. */
export function stripMassTokens(text: string): string {
  // A run of masses goes together with the joiners between them: "5mg/10mg" must not leave a
  // stray "/" behind to be read as "name / name".
  return normalizeQuantityText(text).replace(MASS_RUN_RE, " ");
}

/** Does the text state a mass at all? */
export function statesMass(text: string | null | undefined): boolean {
  return typeof text === "string" && massTokens(normalizeQuantityText(text)).length > 0;
}

function isSizeList(text: string, tokens: MassToken[]): boolean {
  for (let i = 1; i < tokens.length; i++) {
    const separator = text.slice(tokens[i - 1].end, tokens[i].start);
    if (SIZE_JOINER_RE.test(separator) && tokens[i].mg !== tokens[i - 1].mg) return true;
  }
  return false;
}

/** An INGREDIENT joiner between two masses. Masses add only across one of these. */
const INGREDIENT_JOINER_RE = /[/+]/;

/**
 * The SUM of a blend's stated masses. A dose list ("5/5 mg") is read first — only the last
 * dose wears the unit. Otherwise masses add only while an INGREDIENT JOINER sits between them,
 * and the walk STOPS at the first mass joined by anything else: "AOD-9604 10mg × 10 Vials
 * (100mg) $249 + tax" is a 10 mg vial, not 110 mg.
 */
function blendSumMg(text: string, tokens: MassToken[]): number | null {
  const list = DOSE_LIST_RE.exec(text);
  if (list) {
    const trailingUnit = list[2];
    let total = 0;
    for (const part of list[1].split(INGREDIENT_JOINER_RE)) {
      const m = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${MASS_UNIT_ALT})?`, "i").exec(part.trim());
      if (!m) continue;
      total += unitToMg(parseFloat(m[1]), m[2] ?? trailingUnit);
    }
    if (total > 0) return trimMg(total);
  }
  if (tokens.length === 0) return null;
  let total = tokens[0].mg;
  for (let i = 1; i < tokens.length; i++) {
    if (!INGREDIENT_JOINER_RE.test(text.slice(tokens[i - 1].end, tokens[i].start))) break;
    total += tokens[i].mg;
  }
  return trimMg(total);
}

function resolvePackCount(text: string): number | null {
  for (const pattern of PACK_COUNT_RES) {
    const m = pattern.exec(text);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    // 500 is a label ceiling, not a vial ceiling: capsule and tablet counts run to the hundreds.
    return n >= 1 && n <= 500 ? n : null;
  }
  return null;
}

function resolveLabelForm(text: string): ParsedSizeForm | null {
  for (const [form, pattern] of FORM_RES) if (pattern.test(text)) return form;
  return null;
}

function readLabelledToken(text: string): LabelledQuantity | null {
  const m = LABELLED_RE.exec(text);
  return m ? { value: parseFloat(m[1]), unit: m[2].toLowerCase(), raw: m[0] } : null;
}

/**
 * Read a vendor's size label. Descriptive: it reports what the label states and flags what
 * the label leaves unresolved. It never applies the vial ceiling, never rejects a non-vial
 * form, and never refuses a blend — those are canonicalVialMg's judgements.
 */
export function parseSize(text: string | null | undefined): ParsedSize {
  const subject = typeof text === "string" ? normalizeQuantityText(text) : "";
  const blend = isBlendProduct(subject);
  const tokens = massTokens(subject);
  // A SIZE LIST and a DUAL-DOSE BLEND look the same to the blend predicate ("8MG/2MG" fires on
  // "Retatrutide 5mg / 10mg / 20mg"). Ask the SAME predicate a second question on the name
  // alone: "Tesamorelin/Ipamorelin" is still a blend; "Retatrutide" is not.
  const nameEvidencedBlend = isBlendProduct(stripMassTokens(subject));
  const multiSize = !nameEvidencedBlend && isSizeList(subject, tokens);

  const concentration = MG_PER_ML_RE.exec(subject);
  // The concentration branch runs FIRST and SUPPRESSES the plain mass read: "10mg/ml x 3ml"
  // is 30 (concentration × volume) or nothing, never 10.
  const volume = concentration ? ML_VOLUME_RE.exec(subject.replace(MG_PER_ML_RE, " ")) : null;

  let mgPerVial: number | null = null;
  let quantityUnit: ParsedSizeUnit | null = null;
  let derivedFromConcentration = false;
  if (concentration) {
    if (volume) {
      mgPerVial = trimMg(parseFloat(concentration[1]) * parseFloat(volume[1]));
      quantityUnit = "mg";
      derivedFromConcentration = true;
    } else {
      quantityUnit = ML_TOKEN_RE.test(subject) ? "ml" : null;
    }
  } else if (multiSize) {
    // A size list states a unit but not A size. Unit yes, number no — resolved by variants.
    quantityUnit = "mg";
  } else if (tokens.length > 0) {
    mgPerVial = blend ? blendSumMg(subject, tokens) : tokens[0].mg;
    quantityUnit = "mg";
  } else if (IU_TOKEN_RE.test(subject)) {
    quantityUnit = "iu";
  } else if (ML_TOKEN_RE.test(subject)) {
    quantityUnit = "ml";
  } else if (CAPSULE_COUNT_RE.test(subject)) {
    // 'capsule' only when a capsule count is the ONLY quantity on the label.
    quantityUnit = "capsule";
  }

  const packCount = resolvePackCount(subject);
  const packAmbiguous = packMultiplicity(subject).ambiguous;
  let vialsPerKit: number | null;
  if (multiSize) vialsPerKit = null; // no size resolved ⇒ no pack claim
  else if (packCount !== null) vialsPerKit = packCount;
  else if (packAmbiguous) vialsPerKit = null; // pack wording, no countable number
  else if (quantityUnit !== null || mgPerVial !== null) vialsPerKit = 1;
  else vialsPerKit = null; // no quantity at all: say nothing

  let confidence: ParsedSizeConfidence;
  if (multiSize || mgPerVial === null) confidence = "low";
  else if (blend || packAmbiguous || tokens.length > 1 || derivedFromConcentration) confidence = "medium";
  else confidence = "high";

  // TIER first: tier wording is an explicit statement about the price and outranks a count
  // inferred from surrounding words.
  let packageKind: PackageKind;
  if (TIER_RE.test(subject)) packageKind = "tier";
  else if (packAmbiguous) packageKind = "unknown";
  else if ((vialsPerKit ?? 1) > 1) packageKind = "kit";
  else packageKind = "single";

  return {
    mg_per_vial: mgPerVial,
    vials_per_kit: vialsPerKit,
    quantity_unit: quantityUnit,
    form: resolveLabelForm(subject),
    is_blend: blend,
    multi_size: multiSize,
    confidence,
    package_kind: packageKind,
    labelled: readLabelledToken(subject),
  };
}
