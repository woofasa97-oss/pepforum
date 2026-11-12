/**
 * Which BLEND a product is. A blend's identity is its ingredients: a product is filed under the
 * seeded blend whose ingredient set is EXACTLY the set its name mentions — never under one of the
 * ingredients, and never under a blend it only partly matches. `resolveProduct` is the single
 * entry point for "which compound is this?": the writer files rows with it and the gate re-runs
 * it on the stored text.
 */
import abbreviations from "../../seed/blend-abbreviations.json" with { type: "json" };
import { buildCompoundIndex, isAcetylVariant, isDacVariant, isFragmentVariant, isSaltVariant, resolveCompound, type CompoundIndex, type CompoundRow } from "./compound-match.ts";

export interface BlendIndex {
  /** sorted ingredient slugs joined by "+" → blend compound id */
  bySet: Map<string, string>;
  /** blend compound id → its ingredient slugs, in the blend's own order */
  ingredients: Map<string, string[]>;
  /** lower-case name, alias or abbreviation → single-compound slug */
  mentions: Map<string, string>;
  /** lower-case trade name (a blend's alias) → blend compound id */
  tradeNames: Map<string, string>;
  /** every single-compound slug */
  slugs: Set<string>;
}

export interface ProductIndex {
  compounds: CompoundIndex;
  blends: BlendIndex;
}

export interface Mention {
  slug: string;
  start: number;
  end: number;
}

const setKey = (slugs: readonly string[]): string => [...new Set(slugs)].sort().join("+");
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The key as a whole word, with "-" and spaces interchangeable ("BPC 157", "BPC-157", "BPC157"). */
const bounded = (key: string): RegExp => new RegExp(`(?<![a-z0-9])${escapeRe(key).replace(/[\s-]+/g, "[\\s-]*")}(?![a-z0-9])`, "g");

export function buildBlendIndex(rows: readonly CompoundRow[]): BlendIndex {
  const idx: BlendIndex = { bySet: new Map(), ingredients: new Map(), mentions: new Map(), tradeNames: new Map(), slugs: new Set() };
  for (const r of rows) {
    if (r.type === "Blend") continue;
    idx.slugs.add(r.slug);
    for (const n of [r.name, ...(r.aliases ?? [])]) if (n.trim().length >= 3) idx.mentions.set(n.toLowerCase().trim(), r.slug);
  }
  for (const [abbr, slug] of Object.entries(abbreviations as Record<string, string>)) {
    if (idx.slugs.has(slug) && !idx.mentions.has(abbr)) idx.mentions.set(abbr, slug);
  }
  for (const r of rows) {
    if (r.type !== "Blend" || !r.blend_components || r.blend_components.length < 2) continue;
    const parts = r.blend_components.map((c) => c.slug);
    idx.bySet.set(setKey(parts), r.id);
    idx.ingredients.set(r.id, parts);
    for (const a of r.aliases ?? []) if (a.trim().length >= 4) idx.tradeNames.set(a.toLowerCase().trim(), r.id);
  }
  return idx;
}

export function buildProductIndex(rows: readonly CompoundRow[]): ProductIndex {
  return { compounds: buildCompoundIndex([...rows]), blends: buildBlendIndex(rows) };
}

/**
 * Every ingredient the text names, in order of appearance; where two names overlap the longer
 * wins. A DAC or N-acetyl marker anywhere in the text moves an ingredient to that sibling when the
 * catalogue has one ("CJC-1295 with DAC + Ipamorelin" names CJC-1295 DAC).
 */
export function ingredientMentions(text: string, idx: BlendIndex): Mention[] {
  const lower = text.toLowerCase();
  const found: Mention[] = [];
  for (const key of [...idx.mentions.keys()].sort((a, b) => b.length - a.length)) {
    for (const m of lower.matchAll(bounded(key))) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (!found.some((f) => start < f.end && f.start < end)) found.push({ slug: idx.mentions.get(key) as string, start, end });
    }
  }
  found.sort((a, b) => a.start - b.start);
  const dac = isDacVariant(lower);
  const acetyl = isAcetylVariant(lower);
  return found.map((f) => {
    let slug = f.slug;
    if (dac && idx.slugs.has(`${slug}-dac`)) slug = `${slug}-dac`;
    if (acetyl && idx.slugs.has(`n-acetyl-${slug}`)) slug = `n-acetyl-${slug}`;
    return { ...f, slug };
  });
}

/** Words a part of a name may consist of without naming an ingredient. Deliberately short. */
const FILLER_RE = /\b(?:blend(?:ed)?|stack|combo|peptides?|research|materials?|vials?|kits?|bundle|pack|btls?|mg|mcg|ml|iu|each|total|per|x|no|dac|without|new|the|of|for|in)\b/g;
const MARK = "§";
/** A trade name as a whole word, also with a number on it ("Klow80"). */
const tradeRe = (t: string): RegExp => new RegExp(`(?<![a-z0-9])${escapeRe(t).replace(/[\s-]+/g, "[\\s-]*")}\\d*(?![a-z0-9])`, "g");

/** Words the name holds beyond its trade names, filler and figures ("Daily … Skincare Essentials"). */
function hasOtherWords(name: string, idx: BlendIndex): boolean {
  let t = name.toLowerCase();
  for (const trade of idx.tradeNames.keys()) t = t.replace(tradeRe(trade), " ");
  t = t.replace(/[^a-z0-9\s.-]/g, " ").replace(FILLER_RE, " ").replace(/\b[\d.]+\b/g, " ");
  return t.replace(/[^a-z]/g, "").length >= 3;
}
const MARKS_RE = new RegExp(MARK, "g");
/** A short code that names a compound: "P21", "B7-33", "PE 22-28" (never "x10", a pack). */
const CODE_RE = /(?<![a-z0-9])(?!x\d)[a-z]{1,4}-?\d+(?:-\d+)?(?![a-z0-9])|(?<![a-z0-9])[a-z]{1,4}\s+\d+\s*-\s*\d+(?![\d.]*\s*(?:mcg|mg|ml|iu)\b)/;
/** A bare range with no unit: "176-191" (a fragment), never "5-5mg". */
const RANGE_RE = /(?<![a-z0-9.-])\d+\s*-\s*\d+(?![\d.])(?!\s*(?:mcg|mg|ml|iu|g)\b)/;

/**
 * A part of the name — between "+", "/", "&", "," — that names no ingredient we know and is not
 * just filler: the product holds something we do not track ("Fragment 176-191 & CJC-1295 &
 * Ipamorelin", "… + Free BAC Water", "PE 22-28 / Selank / Semax"), so it is not the blend its
 * known ingredients suggest. A short code is unknown wherever it stands, even beside a known name.
 */
export function hasUnknownPart(name: string, mentions: readonly Mention[], idx: BlendIndex): boolean {
  let masked = name.toLowerCase();
  for (const m of mentions) masked = masked.slice(0, m.start) + MARK.repeat(m.end - m.start) + masked.slice(m.end);
  for (const t of idx.tradeNames.keys()) masked = masked.replace(tradeRe(t), (x) => MARK.repeat(x.length));
  // An aside with no ingredient in it ("(10 vials/kit)") is not part of the list. One that names
  // ingredients ("(BPC-157/TB-500/Larazotide)") is a list of its own, checked part by part, and
  // stands in the outer name as one mention ("Buy Wolverine (…) in Canada").
  const asides: string[] = [];
  masked = masked.replace(/\([^)]*\)/g, (x) => {
    if (!x.includes(MARK)) return " ";
    asides.push(x.slice(1, -1));
    return ` ${MARK} `;
  });
  const JOINERS = /[+/&,|]|\band\b|\bwith\b|\bw\//;
  for (const part of [...asides.flatMap((a) => a.split(JOINERS)), ...masked.split(JOINERS)]) {
    const plain = part.replace(MARKS_RE, " ").replace(/[^a-z0-9\s.-]/g, " ").replace(FILLER_RE, " ");
    if (CODE_RE.test(plain)) return true;
    if (part.includes(MARK)) continue;
    if (RANGE_RE.test(plain)) return true;
    if (plain.replace(/\b[\d.]+\b/g, " ").replace(/[^a-z]/g, "").length >= 3) return true;
  }
  return false;
}

/** The seeded blend this product is, or null: its ingredients must be exactly one blend's. */
export function resolveBlend(product: { name: string | null | undefined; variantLabel?: string | null }, idx: BlendIndex): string | null {
  const name = String(product.name ?? "").replace(/\s+/g, " ").trim();
  if (!name) return null;
  // A bundle is several separate vials sold together — not one vial holding the mix.
  if (/\bbundles?\b/i.test(`${name} ${product.variantLabel ?? ""}`)) return null;
  if (isFragmentVariant(`${name} ${product.variantLabel ?? ""}`.toLowerCase())) return null;
  // A salt form other than acetate (an arginate) is not the blend's usual form (design review 2026-10-04).
  if (isSaltVariant(`${name} ${product.variantLabel ?? ""}`.toLowerCase())) return null;
  const mentions = ingredientMentions(name, idx);
  const slugs = [...new Set(mentions.map((m) => m.slug))];
  const lower = name.toLowerCase();
  const tradeIds = [...new Set([...idx.tradeNames.entries()].filter(([t]) => bounded(t).test(lower)).map(([, id]) => id))];
  if (slugs.length >= 2) {
    if (hasUnknownPart(name, mentions, idx)) return null;
    const id = idx.bySet.get(setKey(slugs)) ?? null;
    // A trade name beside the ingredients must agree with them.
    if (tradeIds.length > 0 && (id === null || tradeIds.some((t) => t !== id))) return null;
    return id;
  }
  if (tradeIds.length !== 1) return null;
  // A trade word with other words beside it ("Daily Glow Skincare Essentials", "Ultimate Wolverine
  // Research Stack") names the blend only when the listing also says it is a peptide product: a
  // mass, or the word "blend" or "peptide". "GLOW" or "KLOW 80" alone is the blend.
  if (slugs.length === 0 && hasOtherWords(name, idx)) {
    const corroborated = /(?<![\w.])\d+(?:\.\d+)?\s*(?:mg|mcg)\b/i.test(`${name} ${product.variantLabel ?? ""}`) || /\b(?:blend|peptides?)\b/i.test(name);
    if (!corroborated) return null;
  }
  const parts = idx.ingredients.get(tradeIds[0]) ?? [];
  if (slugs.length === 1 && !parts.includes(slugs[0])) return null;
  // One ingredient beside a trade name is the blend only when the name says it is one
  // ("Wolverine Blend (BPC-157)"); "Skin Glow GHK-Cu 50mg" is a GHK-Cu vial.
  if (slugs.length === 1 && !/\b(?:blend|stack)\b/i.test(name)) return null;
  return tradeIds[0];
}

/**
 * THE attribution of one product. A blend first; a name that mentions two or more ingredients
 * and is no seeded blend matches NOTHING (never one of its ingredients); everything else is the
 * single-compound matcher's.
 */
export function resolveProduct(product: { name: string | null | undefined; variantLabel?: string | null }, index: ProductIndex): string | null {
  const blendId = resolveBlend(product, index.blends);
  if (blendId) return blendId;
  const named = new Set(ingredientMentions(String(product.name ?? ""), index.blends).map((m) => m.slug));
  if (named.size >= 2) return null;
  return resolveCompound(product, index.compounds.index);
}
