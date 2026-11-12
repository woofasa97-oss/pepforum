/**
 * THE single blend/combo-product predicate. A blend's total mg and price attributed to ONE
 * ingredient compound gives an artificially low per-mg that passes every structural check,
 * so a blend is refused from comparison with a typed reason. Ported from PeptideBase's blend.mjs.
 */
export function isBlendProduct(name: string | null | undefined): boolean {
  if (typeof name !== "string") return false;
  if (/\bblend\b/i.test(name) || /\bklow\b/i.test(name) || /\bstack\b/i.test(name)) return true;
  // Two or more distinct names joined by "+", "/", or "," with mg amounts = an ingredient list.
  if (/([a-z][a-z0-9-]+\s*\d+\s*m(?:c?)g[\s,/+]+){2,}/i.test(name)) return true;
  // Dual-dose notation ("Tesamorelin/Ipamorelin 8MG/2MG", "10mg + 10mg", "weight: 10/10mg").
  if (/\d+\s*m(?:c?)g\s*[/+&]\s*\d+\s*m(?:c?)g/i.test(name)) return true;
  // Not after a hyphen: the "157" of "BPC-157/5mg" is part of the name, not a first dose.
  if (/(?<![\w.-])\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\s*m(?:c?)g\b/i.test(name)) return true;
  // Names joined by "/", judged without bracketed asides ("GLOW (70mg) / FOXO4-DRI (10mg)"). A
  // side is a NAME when it has three letters, or is a code — two letters and two digits (TB-500,
  // SS-31; the "LR3" of "IGF-1/LR3" is not one). A quantity ("10mg") never is. Two names are a
  // blend when one has five letters, or both are codes ("BPC 157/TB-500").
  const letters = (s: string) => (s.match(/[a-z]/gi) ?? []).length;
  const isQuantity = (s: string) => /^\d+(?:\.\d+)?\s*(?:mcg|mg|ml|iu|g)$/i.test(s.trim());
  const isCode = (s: string) => letters(s) >= 2 && (s.match(/\d/g) ?? []).length >= 2;
  // A pack word after the slash ("65mg / Single Vial", "65mg / 5-Pack") describes the package, not a second ingredient.
  const isPackWord = (s: string) => /^(?:\d+[- ]?)?(?:single|vials?|packs?|kits?|box(?:es)?|bottles?|count|ct|pcs?|units?)$/i.test(s.trim());
  const isNameToken = (s: string) => !isQuantity(s) && !isPackWord(s) && (letters(s) >= 3 || isCode(s));
  const bare = name.replace(/\([^)]*\)/g, " ");
  for (const m of bare.matchAll(/((?:[A-Za-z]+\s)?[A-Za-z0-9-]+)\s*\/\s*([A-Za-z0-9-]+)/g)) {
    const [, left, right] = m;
    if (!isNameToken(left) || !isNameToken(right)) continue;
    if (Math.max(letters(left), letters(right)) >= 5 || (isCode(left) && isCode(right))) return true;
  }
  // Names joined by "+": spaced ("CJC-1295 + Ipamorelin", "BPC-157 + TB-500" — a short code with
  // a digit counts as a name) or run together ("BPC157+TB500"). "NAD+ 500mg" and "Pro+ 10mg"
  // (a + that ends a name) stay single.
  return /[a-z0-9]\s+\+\s*(?:[a-z]{3,}|[a-z]{2,}-?\d)/i.test(name) || /[a-z0-9]\+[a-z]{2,}/i.test(name);
}
