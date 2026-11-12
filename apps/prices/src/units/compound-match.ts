/**
 * THE single product-name → compound resolver. Ported from PeptideBase's peptide-match.mjs
 * (2026-09): a matcher that differs between writers produces rows that disagree about
 * identity, which no downstream check can reconcile. PURE — no DB, no I/O.
 *
 * Resolution is deterministic; its input is vendor catalog text, which the caller may treat
 * as evidence of the vendor's own claim but never as a verified identity.
 */

export interface CompoundRow {
  id: string;
  name: string;
  slug: string;
  aliases?: string[] | null;
  /** "Blend" rows are matched by their ingredients (blend-match.ts), never by this index. */
  type?: string | null;
  blend_components?: { slug: string }[] | null;
}

export interface CompoundIndex {
  /** normalized name/alias → compound id */
  index: Map<string, string>;
  /** id → [name, ...aliases] (original casing, for corroboration text-matching) */
  namesById: Map<string, string[]>;
  /** normalized token → id, spanning slug + name + aliases across ALL compounds; first owner wins */
  tokenOwner: Map<string, string>;
}

/** Lowercase, non-alphanumerics collapsed to `-`, trimmed: the URL-segment shape of a name. */
export function normalizeToken(s: string | null | undefined): string {
  return String(s ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** True when the product is a DAC variant ("CJC-1295 DAC") — and NOT a negated form
 *  ("no DAC", "without DAC", "no-DAC"). Negated forms are the plain compound. */
export function isDacVariant(lowerName: string): boolean {
  if (!/(?<![a-z0-9])dac(?![a-z0-9])/.test(lowerName)) return false;
  return !/(?:no|without|w\/o|non)[\s/-]*dac/.test(lowerName);
}

/**
 * True when the text names an N-ACETYL (or amidated) analogue — "N-Acetyl Semax", "NA-Selank",
 * "Selank (N-Acetyl Amidate)", "Semax NA". It is a different molecule from the plain peptide, sold
 * at a different price, and must never be priced as it. ("Acetate" is a salt and is not this.)
 */
export function isAcetylVariant(lowerName: string): boolean {
  return /(?<![a-z0-9])n[\s-]*acetyl/.test(lowerName) || /(?<![a-z0-9])amidate(?![a-z0-9])/.test(lowerName) || /(?<![a-z0-9])na(?![a-z0-9])/.test(lowerName);
}

/**
 * True when the text names a SALT FORM other than the usual acetate — "BPC-157 Arginine Salt",
 * "BPC 157 Arginate", "Arg Salt", "Sodium/TFA/HCl salt". It is sold at a different price and must
 * never be priced as the plain compound (design review 2026-10-04: a ranked BPC-157 listing was an
 * arginine salt). "Acetate" — and "acetate salt" — is the usual form and is not this.
 */
export function isSaltVariant(lowerText: string): boolean {
  return (
    /(?<![a-z0-9])argin(?:ine|ate)(?![a-z0-9])/.test(lowerText) ||
    /(?<![a-z0-9])(?:arg|sodium|tfa|hcl|hydrochloride|trifluoroacetate|citrate|phosphate|sulfate)[\s-]+salt(?![a-z0-9])/.test(lowerText)
  );
}

/** True when the text names a FRAGMENT ("Frag(17-23) TB-500", "hGH Fragment 176-191"): a
 *  fragment of a compound is a different product and must never be priced as the compound. */
const DAC_TOKEN = /(?<![a-z0-9])dac(?![a-z0-9])/;

export function isFragmentVariant(lowerName: string): boolean {
  return /(?<![a-z])frag(?:ment)?s?(?![a-z])/.test(lowerName);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Match a product name to exactly one compound.
 *
 * Exact normalized-name hit wins; otherwise a unique word-boundary substring match against
 * the index (keys ≥4 chars), with DAC-variant polarity respected on both sides. Ambiguity
 * (2+ candidates) resolves to null — a wrong attribution is worse than none.
 *
 * @param contextText wider text (product name, raw price text) — DAC markers often live
 *                    outside the bare name.
 */
export function matchCompound(name: string | null | undefined, index: Map<string, string>, contextText = ""): string | null {
  if (!name) return null;
  const lower = name.toLowerCase().trim().replace(/\s+/g, " ");
  const given = contextText.toLowerCase();
  // When the context carries its own DAC marker it DECIDES: a parent named "CJC-1295 (With or
  // Without DAC)" says nothing about which one this variant is.
  const nameIsDac = isDacVariant(DAC_TOKEN.test(given) ? given : lower);
  const nameIsFragment = isFragmentVariant(`${lower} ${given}`);
  const nameIsAcetyl = isAcetylVariant(`${lower} ${given}`);
  const nameIsSalt = isSaltVariant(`${lower} ${given}`);
  // POLARITY, on the exact hit too: the marker often lives in the variant label, outside the name.
  const compatible = (key: string): boolean =>
    isDacVariant(key) === nameIsDac && isFragmentVariant(key) === nameIsFragment && isAcetylVariant(key) === nameIsAcetyl && isSaltVariant(key) === nameIsSalt;

  const exact = index.get(lower);
  if (exact && compatible(lower)) return exact;
  if (exact && nameIsDac && !isDacVariant(lower) && isFragmentVariant(lower) === nameIsFragment) {
    // "CJC-1295" / "Content: 5mg (w/ DAC)": the DAC sibling of the named compound, when there is one.
    const sibling = index.get(`${lower} dac`) ?? index.get(`${lower} with dac`) ?? index.get(`${lower}-dac`);
    if (sibling) return sibling;
  }

  // Every key the name mentions, whatever its polarity. A key inside a longer mentioned key is
  // the same mention ("cjc-1295" inside "cjc-1295 dac", "tb-500" inside "bpc-157 + tb-500"), so
  // the longest wins.
  const mentioned = [...index.keys()].filter((key) => key.length >= 4 && new RegExp(`(?<![a-z0-9])${escapeRe(key)}(?![a-z0-9])`).test(lower));
  const longest = (keys: string[]): string[] => keys.filter((key) => !keys.some((other) => other !== key && other.includes(key)));

  // A name that mentions two DIFFERENT compounds is a bundle or a blend ("CJC-1295 (DAC)/
  // Ipamorelin"): there is no single compound to file it under, whatever the markers say.
  if (new Set(longest(mentioned).map((key) => index.get(key))).size > 1) return null;

  const candidates = new Set(longest(mentioned.filter(compatible)).map((key) => index.get(key)));
  if (candidates.size === 0 && nameIsDac) {
    // A DAC variant of a compound named without the marker: the DAC sibling of the plain key the
    // name mentions, when there is exactly one.
    const siblings = new Set<string>();
    for (const key of mentioned) {
      if (isDacVariant(key) || isFragmentVariant(key) !== nameIsFragment) continue;
      const sibling = index.get(`${key} dac`) ?? index.get(`${key} with dac`) ?? index.get(`${key}-dac`);
      if (sibling) siblings.add(sibling);
    }
    if (siblings.size === 1) return [...siblings][0];
  }
  if (candidates.size === 0 && nameIsAcetyl) {
    // An N-acetyl analogue named in another word order ("Selank N-Acetyl Amidate", "Semax NA"): the
    // analogue of the one plain key the name mentions, when the catalogue has it. When it does not
    // ("N-Acetyl Epithalon"), the answer is nothing — never the plain peptide.
    const siblings = new Set<string>();
    for (const key of longest(mentioned)) {
      if (isAcetylVariant(key) || isDacVariant(key) !== nameIsDac || isFragmentVariant(key) !== nameIsFragment) continue;
      const sibling = index.get(`n-acetyl ${key}`) ?? index.get(`na-${key}`) ?? index.get(`na ${key}`);
      if (sibling) siblings.add(sibling);
    }
    if (siblings.size === 1) return [...siblings][0];
  }
  if (candidates.size !== 1) return null;
  const [only] = candidates;
  return only ?? null;
}

/**
 * THE attribution of one product: by its name (the variant label is context — a DAC or fragment
 * marker often lives there), unless the variant label itself names a different compound, which
 * then wins. The writer files rows with this and the gate re-runs it on the stored text, so
 * "which compound is this?" has exactly one answer in the system.
 */
export function resolveCompound(product: { name: string | null | undefined; variantLabel?: string | null }, index: Map<string, string>): string | null {
  const label = product.variantLabel ?? "";
  // A DAC marker in the label is the variant's own statement and outranks whatever the name says.
  const context = DAC_TOKEN.test(label.toLowerCase()) ? label : `${product.name ?? ""} ${label}`;
  let id = matchCompound(product.name, index, context);
  if (product.variantLabel) {
    const byLabel = matchCompound(product.variantLabel, index, context);
    if (byLabel && byLabel !== id) id = byLabel;
  }
  return id;
}

/** Build the matcher's three lookup structures from compound rows. */
export function buildCompoundIndex(rows: CompoundRow[] | null | undefined): CompoundIndex {
  const index = new Map<string, string>();
  const namesById = new Map<string, string[]>();
  const tokenOwner = new Map<string, string>();
  for (const p of rows ?? []) {
    if (p.type === "Blend") continue;
    const aliases = p.aliases ?? [];
    index.set(p.name.toLowerCase(), p.id);
    namesById.set(p.id, [p.name, ...aliases]);
    for (const alias of aliases) index.set(alias.toLowerCase(), p.id);
    for (const label of [p.slug, p.name, ...aliases]) {
      const tok = normalizeToken(label);
      if (tok.length >= 5 && !tokenOwner.has(tok)) tokenOwner.set(tok, p.id);
    }
  }
  return { index, namesById, tokenOwner };
}
