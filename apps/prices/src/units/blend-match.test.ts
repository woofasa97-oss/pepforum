import { describe, expect, it } from "vitest";
import { buildProductIndex, resolveBlend, resolveProduct } from "./blend-match.ts";

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
const is = (name: string, variantLabel: string | null = null) => resolveProduct({ name, variantLabel }, index);

describe("resolveProduct — which blend", () => {
  it("files a product under the blend whose ingredients are exactly the ones it names, however it writes them", () => {
    expect(is("BPC-157 10mg + TB-500 10mg (Wolverine Stack 20mg)")).toBe("bpc-157-tb-500");
    expect(is("BPC-157 & TB-500 Blend – 10MG / 20MG", "Please select a size: 20mg (10mg/10mg)")).toBe("bpc-157-tb-500");
    expect(is("BPC-157, TB-500 (Blend)", "Weight: 20mg/20mg")).toBe("bpc-157-tb-500");
    expect(is("BPC-157 TB500 Blend", "Milligram: 10mg")).toBe("bpc-157-tb-500");
    expect(is("Wolverine Blend 10mg BPC-157 & 10mg TB4")).toBe("bpc-157-tb-500");
    expect(is("BPC 10mg + TB 10mg, 20mg")).toBe("bpc-157-tb-500");
    expect(is("Combo Vial: BPC-157/TB-500 (20mg vials)", "QUANTITY (MG):: 100 mg")).toBe("bpc-157-tb-500");
    expect(is("Mod GRF 1-29 & Ipamorelin Blend – 10MG")).toBe("cjc-1295-ipamorelin");
    expect(is("CJC-1295 w/ Ipamorelin (No DAC)", "5mg")).toBe("cjc-1295-ipamorelin");
    expect(is("GHK-Cu 50mg + BPC-157 10mg + TB-500 10mg Research GLOW Blend")).toBe("bpc-157-tb-500-ghk-cu");
    expect(is("KLOW (BPC-157, KPV, TB-500, GHK-Cu) Blend – 80MG")).toBe("bpc-157-tb-500-ghk-cu-kpv");
    expect(is("Tesamorelin + Ipamorelin (16mg – 13mg/3mg)")).toBe("tesamorelin-ipamorelin");
    expect(is("Semax N-Acetyl 9mg, Selank N-Acetyl 6mg (15mg Blend)", "15mg")).toBe("n-acetyl-selank-n-acetyl-semax");
    expect(is("SELANK / SEMAX BLEND", "Weight: 10/10mg")).toBe("selank-semax");
  });

  it("a trade name alone names its blend", () => {
    expect(is("GLOW 70mg")).toBe("bpc-157-tb-500-ghk-cu");
    expect(is("Wolverine Blend 20MG", "Product Grade: US cGMP")).toBe("bpc-157-tb-500");
    expect(is("KLOW", "Variant: 80mg, Supply: 10 Vials")).toBe("bpc-157-tb-500-ghk-cu-kpv");
    expect(is("Glow Blend (BPC-157/TB4/GHK-Cu) 70mg")).toBe("bpc-157-tb-500-ghk-cu");
  });

  it("REVIEW FOCUS 1: an ingredient we do not track means it is not the blend of the ones we do", () => {
    expect(is("Fragment 176-191 & CJC-1295 & Ipamorelin Blend – 12MG")).toBeNull();
    expect(is("Larazotide + BPC-157 + TB-500")).toBeNull();
    expect(is("IGF-LR3 + BPC-157 + Thymosin Beta-4 Peptide Blend", "Form: IGF-LR3 + BPC-157 + TB-500, Strength: 11mg")).toBeNull(); // tracked ingredients, no such blend seeded
    expect(is("BPC-157 + TB-500 + Free BAC Water")).toBeNull();
  });

  it("a different ingredient is a different blend: DAC, and a trade name that disagrees with the ingredients", () => {
    expect(is("CJC-1295 With DAC + Ipamorelin")).toBeNull(); // CJC-1295 DAC + Ipamorelin is not seeded here
    expect(is("GLOW: BPC-157 + TB-500")).toBeNull(); // GLOW has three ingredients; this names two
  });

  it("REAL-DATA LOOK (2026-10-02): a bundle is several separate vials, not one vial of a blend", () => {
    expect(is("WOLVERINE Bundle – BPC-157 10mg + TB-500 10mg")).toBeNull();
    expect(is("TB 500 (10mg), KPV (10mg), BPC 157 (10mg) Bundle")).toBeNull();
    expect(is("Recovery Stack – TB-500 10MG + BPC-157 10MG Research Bundle")).toBeNull();
    expect(is("GLOW Bundle")).toBeNull();
    // Controls: a combo VIAL and a "stack" that names one vial's mass stay the blend.
    expect(is("Combo Vial: BPC-157/TB-500 (20mg vials)", "QUANTITY (MG):: 100 mg")).toBe("bpc-157-tb-500");
    expect(is("BPC-157 10mg + TB-500 10mg (Wolverine Stack 20mg)")).toBe("bpc-157-tb-500");
  });

  it("FINAL REVIEW I1: an untracked ingredient with a short name, a code or a bare range is still an unknown part", () => {
    expect(is("PE 22-28 / Selank / Semax 30mg")).toBeNull(); // amc-essentials, saved feed 2026-10-01
    expect(is("176-191 & CJC-1295 & Ipamorelin Blend")).toBeNull();
    expect(is("Selank + Semax + P21")).toBeNull();
    expect(is("B7-33 + BPC-157 + TB-500 Blend")).toBeNull();
    expect(is("Wolverine Blend (BPC-157/TB-500/Larazotide)")).toBeNull();
    // Controls: a trade name with a number, an alias with a range, a bracketed list of known ingredients.
    expect(is("Klow80 Blend: BPC-157, TB-500, GHK-Cu & KPV Peptide Stack")).toBe("bpc-157-tb-500-ghk-cu-kpv");
    expect(is("CJC-1295 (Mod GRF 1-29) & Ipamorelin Blend – 10MG")).toBe("cjc-1295-ipamorelin");
    expect(is("BPC-157 / TB4 Blend – 10mg/10mg (10 vials/kit)")).toBe("bpc-157-tb-500");
    expect(is("GLOW – BPC-157/GHK-Cu/TB-500 | 5/50/2mg")).toBe("bpc-157-tb-500-ghk-cu");
    // A bracketed list is checked on its own: what follows the bracket is not its last ingredient.
    expect(is("Buy Wolverine (BPC-157 + TB-500 10mg + 10mg) in Canada")).toBe("bpc-157-tb-500"); // peptide-bros
  });

  it("FINAL REVIEW I2: a trade word alone names a blend only with a mass, or the word blend or peptide", () => {
    expect(is("Daily Glow Skincare Essentials")).toBeNull(); // pivot-labs-global, $20
    expect(is("Skin Glow Face Mask")).toBeNull();
    expect(is("Copper Glow Firming Cream")).toBeNull();
    expect(is("Ultimate Wolverine Research Stack")).toBeNull(); // elite-biogenix, $810.99
    expect(is("Economy GLOW Research Stack")).toBeNull();
    // Controls: corroborated, or nothing else in the name at all.
    expect(is("Buy KLOW Blend Online")).toBe("bpc-157-tb-500-ghk-cu-kpv");
    expect(is("GLOW Peptide")).toBe("bpc-157-tb-500-ghk-cu");
    expect(is("GLOW")).toBe("bpc-157-tb-500-ghk-cu");
    expect(is("GLOW 70")).toBe("bpc-157-tb-500-ghk-cu");
    expect(is("KLOW 80")).toBe("bpc-157-tb-500-ghk-cu-kpv");
  });

  it("two ingredients never fall back to one of them", () => {
    expect(is("BPC-157 + GHRP-2 10mg")).toBeNull();
    expect(resolveBlend({ name: "BPC-157 + GHRP-2 10mg" }, index.blends)).toBeNull();
  });

  it("CONTROL: single compounds resolve as before, and a single product that merely contains a trade word stays single", () => {
    expect(is("BPC-157 10mg")).toBe("bpc-157");
    expect(is("TB-500 (Thymosin Beta-4) 10MG")).toBe("tb-500");
    expect(is("CJC-1295 DAC 5mg")).toBe("cjc-1295-dac");
    expect(is("N-Acetyl Semax Amidate 10mg")).toBe("n-acetyl-semax");
    expect(is("Skin Glow GHK-Cu 50mg")).toBe("ghk-cu");
    expect(is("GHK-Cu / Methylene Blue Tallow Matrix")).toBe("ghk-cu"); // one known ingredient: the single path, where the vial parser refuses it as a blend
    expect(is("Wolverine Blend (BPC-157)")).toBe("bpc-157-tb-500"); // one ingredient beside a trade name AND the word "blend"
  });
});

// Design review 2026-10-04: an arginine-salt ingredient is not the blend's usual form.
describe("a blend with a salt-form ingredient", () => {
  it("is not the plain blend", () => {
    expect(is("BPC-157 Arginate + TB-500 10mg")).toBeNull();
    expect(is("BPC-157 / TB-500 Blend", "Form: Arginine Salt")).toBeNull();
  });
  it("an acetate blend still is", () => {
    expect(is("BPC-157 + TB-500 (Acetate) 10mg")).toBe(is("BPC-157 + TB-500 10mg"));
    expect(is("BPC-157 + TB-500 10mg")).not.toBeNull();
  });
});
