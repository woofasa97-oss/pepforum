/**
 * Which MIX a blend listing is: how much of each ingredient one vial holds — when the listing says
 * so beyond doubt. Anything less is "not stated": the site shows such a listing apart and never
 * ranks it. PURE. A reading is refused, never guessed: figures that contradict each other state
 * nothing.
 */
import { ingredientMentions, type BlendIndex, type Mention } from "./blend-match.ts";
import { normalizeQuantityText } from "./canonical-unit.ts";

export type BlendRecipe =
  | { kind: "exact"; amounts: { slug: string; mg: number }[]; totalMg: number; key: string }
  | { kind: "unstated"; totalMg: number | null };

const NUMBER = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
const MASS_RE = new RegExp(String.raw`(?<![\w.])(${NUMBER})\s*(mcg|mg)\b`, "gi");
const DOSES_RE = new RegExp(String.raw`(?<![\w.])(${NUMBER}\s*(?:mcg|mg)?(?:\s*[/+]\s*${NUMBER}\s*(?:mcg|mg)?)+)`, "gi");
const EACH_RE = new RegExp(String.raw`(?<![\w.])(${NUMBER})\s*(mcg|mg)\s+each\b`, "i");

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
const toMg = (value: string, unit: string): number => round(unit.toLowerCase() === "mcg" ? parseFloat(value) / 1000 : parseFloat(value));
const fmt = (n: number): string => String(Number(n.toFixed(3)));

interface Mass {
  mg: number;
  start: number;
  end: number;
}
const massesOf = (text: string): Mass[] => [...text.matchAll(MASS_RE)].map((m) => ({ mg: toMg(m[1], m[2]), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));

/** "5/5mg", "10mg/10mg", "8MG/2MG", "50 + 10 + 10 mg": the figures in order, when the last one wears a unit. */
function doseList(text: string, count: number): { mgs: number[]; start: number; end: number } | null {
  for (const m of text.matchAll(DOSES_RE)) {
    const parts = m[1].split(/[/+]/).map((p) => p.trim());
    const lastUnit = /(mcg|mg)\s*$/i.exec(parts[parts.length - 1])?.[1];
    if (!lastUnit || parts.length !== count) continue;
    const mgs = parts.map((p) => {
      const x = new RegExp(String.raw`^(${NUMBER})\s*(mcg|mg)?$`, "i").exec(p);
      return x ? toMg(x[1], x[2] ?? lastUnit) : Number.NaN;
    });
    if (mgs.every((n) => n > 0)) return { mgs, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length };
  }
  return null;
}

/** Every dose list the text states, whatever its length, where the last figure wears a unit. */
const doseListsOf = (text: string): { count: number; mgs: number[]; start: number; end: number }[] =>
  [...text.matchAll(DOSES_RE)].flatMap((m) => {
    const parts = m[1].split(/[/+]/).map((p) => p.trim());
    const lastUnit = /(mcg|mg)\s*$/i.exec(parts[parts.length - 1])?.[1];
    if (!lastUnit) return [];
    const mgs = parts.map((p) => {
      const x = new RegExp(String.raw`^(${NUMBER})\s*(mcg|mg)?$`, "i").exec(p);
      return x ? toMg(x[1], x[2] ?? lastUnit) : Number.NaN;
    });
    return [{ count: parts.length, mgs, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }];
  });

/** Canonical name of a mix: every ingredient with its mg, in the blend's own order. */
export const recipeKey = (amounts: readonly { slug: string; mg: number }[]): string => amounts.map((a) => `${a.slug}:${fmt(a.mg)}`).join("+");

/**
 * @param ingredients the blend's ingredient slugs, in the blend's own order
 * @param packCount   what the pack reader found: a stated pack total is not a contradiction
 */
export function readBlendRecipe(name: string, label: string | null | undefined, ingredients: readonly string[], idx: BlendIndex, packCount = 1): BlendRecipe {
  const n = normalizeQuantityText(name ?? "");
  const l = normalizeQuantityText(label ?? "");
  const mentions = ingredientMentions(n, idx);
  const order = [...new Set(mentions.map((m) => m.slug))];
  const nameMasses = massesOf(n);
  const labelMasses = massesOf(l);
  const all = [...nameMasses, ...labelMasses].map((m) => m.mg);

  // The vial's total: one figure, and nothing that disagrees with it. A reading that was tried
  // and contradicted leaves no total either. A dose list is never read as its last figure: the
  // variant's own list, one figure per ingredient, totals its sum ("Size: 10/10/50mg" is 70 mg);
  // any other list (a name's may be a list of sizes) leaves the total unknown.
  const labelLists = doseListsOf(l);
  const nameLists = doseListsOf(n);
  const totalOf = (): number | null => {
    if (labelLists.length + nameLists.length > 0) {
      const d = labelLists[0];
      if (labelLists.length !== 1 || nameLists.length > 0 || d.count !== ingredients.length || !d.mgs.every((x) => x > 0)) return null;
      const sum = round(d.mgs.reduce((a, b) => a + b, 0));
      const others = [...nameMasses.map((m) => m.mg), ...labelMasses.filter((m) => m.start < d.start || m.start >= d.end).map((m) => m.mg)];
      return others.every((x) => Math.abs(x - sum) < 1e-9) ? sum : null;
    }
    return all.length > 0 && all.every((x) => x === all[0]) && (all.length === 1 || labelMasses.length === 1) ? all[0] : null;
  };
  const unstated = (doubt = false): BlendRecipe => ({ kind: "unstated", totalMg: doubt ? null : totalOf() });
  const exact = (mgs: number[], rest: number[]): BlendRecipe => {
    const total = round(mgs.reduce((a, b) => a + b, 0));
    // Any other mass the listing states must be the vial's total (or the pack's): otherwise the reading is in doubt.
    if (!rest.every((x) => Math.abs(x - total) < 1e-9 || Math.abs(x - total * packCount) < 1e-9)) return unstated(true);
    const byOrder = new Map(order.map((slug, i) => [slug, mgs[i]]));
    const amounts = ingredients.map((slug) => ({ slug, mg: byOrder.get(slug) as number }));
    return { kind: "exact", amounts, totalMg: total, key: recipeKey(amounts) };
  };
  // The name has to name each ingredient once we map amounts onto them; a trade name alone gives no order.
  if (order.length !== ingredients.length || !ingredients.every((s) => order.includes(s))) return unstated();

  // 1. The variant's own dose list ("20mg (10mg/10mg)", "weight: 5/5mg") is the variant's statement.
  const fromLabel = doseList(l, ingredients.length);
  if (fromLabel) return exact(fromLabel.mgs, labelMasses.filter((m) => m.start < fromLabel.start || m.start >= fromLabel.end).map((m) => m.mg));

  // 2. An amount beside each ingredient in the name: after it ("BPC-157 10mg + TB-500 10mg") or,
  //    failing that, before it ("10mg BPC-157 & 10mg TB4").
  const first = order.map((slug) => mentions.find((m) => m.slug === slug) as Mention);
  const last = order.map((slug) => [...mentions].reverse().find((m) => m.slug === slug) as Mention);
  const after = order.map((_, i) => nameMasses.find((x) => x.start >= last[i].end && x.start < (first[i + 1]?.start ?? n.length)));
  const before = order.map((_, i) => [...nameMasses].reverse().find((x) => x.end <= first[i].start && x.start >= (last[i - 1]?.end ?? 0)));
  for (const beside of [after, before]) {
    if (!beside.every((b): b is Mass => b !== undefined)) continue;
    const used = new Set(beside.map((b) => b.start));
    return exact(beside.map((b) => b.mg), [...nameMasses.filter((m) => !used.has(m.start)).map((m) => m.mg), ...labelMasses.map((m) => m.mg)]);
  }

  // 3. "2mg each": every ingredient in that amount.
  const each = EACH_RE.exec(`${n} ${l}`);
  if (each) {
    const mg = toMg(each[1], each[2]);
    const rest = [...all];
    rest.splice(rest.indexOf(mg), 1);
    return exact(order.map(() => mg), rest);
  }

  // 4. A dose list in the name ("Tesamorelin/Ipamorelin 8MG/2MG"). With a variant that states a
  //    mass it must add up to that mass — otherwise it is a list of sizes, and the mix is not stated.
  const fromName = doseList(n, ingredients.length);
  if (fromName) return exact(fromName.mgs, [...nameMasses.filter((m) => m.start < fromName.start || m.start >= fromName.end).map((m) => m.mg), ...labelMasses.map((m) => m.mg)]);
  return unstated();
}
