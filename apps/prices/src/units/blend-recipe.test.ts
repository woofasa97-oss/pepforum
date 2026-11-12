import { describe, expect, it } from "vitest";
import { buildProductIndex } from "./blend-match.ts";
import { readBlendRecipe } from "./blend-recipe.ts";

// Real compound names and aliases (from the seed), and real product names from the saved feeds of 2026-10-01.
const single = (slug: string, name: string, aliases: string[] = []) => ({ id: slug, slug, name, aliases, type: "Single compound" });
const blend = (parts: string[], name: string, aliases: string[] = []) => ({ id: parts.join("-"), slug: parts.join("-"), name, aliases, type: "Blend", blend_components: parts.map((slug) => ({ slug })) });
const index = buildProductIndex([
  single("bpc-157", "BPC-157", ["Body Protection Compound-157"]),
  single("tb-500", "TB-500", ["Thymosin Beta-4"]),
  single("ghk-cu", "GHK-Cu"),
  single("kpv", "KPV"),
  single("cjc-1295", "CJC-1295 (without DAC)", ["CJC-1295", "Mod GRF 1-29", "CJC-1295 no DAC"]),
  single("cjc-1295-dac", "CJC-1295 DAC", ["CJC-1295 with DAC"]),
  single("ipamorelin", "Ipamorelin"),
  single("tesamorelin", "Tesamorelin"),
  single("ghrp-2", "GHRP-2"),
  single("selank", "Selank"),
  single("semax", "Semax"),
  single("n-acetyl-selank", "N-Acetyl Selank", ["NA-Selank", "NA Selank"]),
  single("n-acetyl-semax", "N-Acetyl Semax", ["NA-Semax", "NA Semax"]),
  single("igf-1-lr3", "IGF-1 LR3"),
  blend(["bpc-157", "tb-500"], "BPC-157 + TB-500", ["Wolverine"]),
  blend(["cjc-1295", "ipamorelin"], "CJC-1295 (without DAC) + Ipamorelin"),
  blend(["bpc-157", "tb-500", "ghk-cu"], "BPC-157 + TB-500 + GHK-Cu", ["GLOW"]),
  blend(["bpc-157", "tb-500", "ghk-cu", "kpv"], "BPC-157 + TB-500 + GHK-Cu + KPV", ["KLOW"]),
  blend(["tesamorelin", "ipamorelin"], "Tesamorelin + Ipamorelin"),
  blend(["selank", "semax"], "Selank + Semax"),
  blend(["n-acetyl-selank", "n-acetyl-semax"], "N-Acetyl Selank + N-Acetyl Semax"),
]);

const idx = index.blends;
const BT = ["bpc-157", "tb-500"];
const read = (name: string, label: string | null, parts: string[], pack = 1) => readBlendRecipe(name, label, parts, idx, pack);
const exact = (key: string, totalMg: number) => expect.objectContaining({ kind: "exact", key, totalMg });
const unstated = (totalMg: number | null) => ({ kind: "unstated", totalMg });

describe("readBlendRecipe — how much of each ingredient one vial holds", () => {
  it("an amount beside each ingredient, after it or before it", () => {
    expect(read("BPC-157 10mg + TB-500 10mg (Wolverine Stack 20mg)", null, BT)).toEqual(exact("bpc-157:10+tb-500:10", 20));
    expect(read("BPC-157 5mg & TB-500 5mg", null, BT)).toEqual(exact("bpc-157:5+tb-500:5", 10));
    expect(read("Wolverine Blend 10mg BPC-157 & 10mg TB4", null, BT)).toEqual(exact("bpc-157:10+tb-500:10", 20));
    expect(read("BPC 10mg + TB 10mg, 20mg", null, BT)).toEqual(exact("bpc-157:10+tb-500:10", 20));
    expect(read("GHK-Cu 50mg + BPC-157 10mg + TB-500 10mg Research GLOW Blend", null, ["bpc-157", "tb-500", "ghk-cu"])).toEqual(exact("bpc-157:10+tb-500:10+ghk-cu:50", 70));
    expect(read("Semax N-Acetyl 9mg, Selank N-Acetyl 6mg (15mg Blend)", "15mg", ["n-acetyl-selank", "n-acetyl-semax"])).toEqual(exact("n-acetyl-selank:6+n-acetyl-semax:9", 15));
  });

  it("a dose list, read in the order the name lists the ingredients", () => {
    expect(read("BPC-157, TB-500 (Blend)", "Weight: 20mg/20mg", BT)).toEqual(exact("bpc-157:20+tb-500:20", 40));
    expect(read("CJC-1295(No Dac)/Ipamorelin", "Size: 5/5mg", ["cjc-1295", "ipamorelin"])).toEqual(exact("cjc-1295:5+ipamorelin:5", 10));
    expect(read("Tesamorelin/Ipamorelin 8MG/2MG", null, ["tesamorelin", "ipamorelin"])).toEqual(exact("tesamorelin:8+ipamorelin:2", 10));
    expect(read("Tesamorelin + Ipamorelin (16mg – 13mg/3mg)", null, ["tesamorelin", "ipamorelin"])).toEqual(exact("tesamorelin:13+ipamorelin:3", 16));
    // The key is in the blend's own order whatever order the name uses.
    expect(read("Ipamorelin 3mg / Tesamorelin 10mg", null, ["tesamorelin", "ipamorelin"])).toEqual(exact("tesamorelin:10+ipamorelin:3", 13));
  });

  it("'2mg each' gives every ingredient that amount", () => {
    expect(read("BPC 157 and TB-500 BLEND  (2mg each = 4mg total)", null, BT)).toEqual(exact("bpc-157:2+tb-500:2", 4));
  });

  it("REVIEW FOCUS 2: the variant's own statement wins over a size list in the name", () => {
    expect(read("BPC-157 & TB-500 Blend – 10MG / 20MG", "Please select a size: 20mg (10mg/10mg)", BT)).toEqual(exact("bpc-157:10+tb-500:10", 20));
    expect(read("BPC-157 & TB-500 Blend – 10MG / 20MG", "Please select a size: 10mg (5mg/5mg)", BT)).toEqual(exact("bpc-157:5+tb-500:5", 10));
    // With a variant that states one mass, a list in the name that does not add up to it is a list of sizes.
    expect(read("BPC-157 & TB-500 Blend – 10MG / 20MG", "Size: 20mg", BT)).toEqual(unstated(null));
  });

  it("REVIEW FOCUS 3: figures that contradict each other state nothing — not even a total", () => {
    expect(read("BPC-157 10MG + TB-500 10MG", "Dosages: 10mg", BT)).toEqual(unstated(null));
    expect(read("BPC-157 10mg + TB-500 10mg (30mg Blend)", null, BT)).toEqual(unstated(null));
  });

  it("a total only, or nothing, is 'not stated' — with the total when the listing gives exactly one figure", () => {
    expect(read("BPC-157 TB500 Blend", "Milligram: 10mg", BT)).toEqual(unstated(10));
    expect(read("Wolverine Blend 20MG", "Product Grade: US cGMP", BT)).toEqual(unstated(20));
    expect(read("BPC157, TB500, GHK-Cu (Glow Blend) 70mg", "Select mg: 70mg, pack: 10 pack", ["bpc-157", "tb-500", "ghk-cu"], 10)).toEqual(unstated(70));
    expect(read("BPC-157 + TB500 Blend", null, BT)).toEqual(unstated(null));
    expect(read("Tesamorelin, Ipamorelin (8/2 Blend)", null, ["tesamorelin", "ipamorelin"])).toEqual(unstated(null)); // no unit: not read
    expect(read("GLOW 70mg", null, ["bpc-157", "tb-500", "ghk-cu"])).toEqual(unstated(70)); // a trade name names no order to map amounts onto
  });

  it("FINAL REVIEW I5: a dose list the name cannot map still gives the vial's total — its sum, never its last figure", () => {
    expect(read("GLOW Blend", "Size: 10/10/50mg", ["bpc-157", "tb-500", "ghk-cu"])).toEqual(unstated(70)); // honest-peptide
    expect(read("KLOW", "weight: 10/50/10/10mg", ["bpc-157", "tb-500", "ghk-cu", "kpv"])).toEqual(unstated(80)); // pure-health-peptides-us
    expect(read("GLOW Blend", "Size: 10/50mg", ["bpc-157", "tb-500", "ghk-cu"])).toEqual(unstated(null)); // a list of another length says nothing sure
    expect(read("GLOW Blend 70mg", "Size: 10/10/50mg", ["bpc-157", "tb-500", "ghk-cu"])).toEqual(unstated(70));
    expect(read("GLOW Blend 60mg", "Size: 10/10/50mg", ["bpc-157", "tb-500", "ghk-cu"])).toEqual(unstated(null)); // figures disagree
    expect(read("GLOW 10/10/50mg", null, ["bpc-157", "tb-500", "ghk-cu"])).toEqual(unstated(null)); // a name's list may be sizes: never its last figure
    expect(read("Wolverine Blend 10mg/20mg", null, BT)).toEqual(unstated(null));
  });

  it("a stated pack total is not a contradiction", () => {
    expect(read("BPC-157 10mg + TB-500 10mg – 10 vials (200mg)", null, BT, 10)).toEqual(exact("bpc-157:10+tb-500:10", 20));
  });

  it("micrograms are converted", () => {
    expect(read("BPC-157 / TB-500 Blend", "weight: 500/500mcg", BT)).toEqual(exact("bpc-157:0.5+tb-500:0.5", 1));
  });
});
