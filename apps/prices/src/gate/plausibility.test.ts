// The per-row structural checks. Each reason is driven from a row that passes every OTHER check,
// so a failure is unambiguously the one under test, and each has a passing control beside it.
import { describe, expect, it } from "vitest";
import {
  OBSERVE_ONLY_REASONS,
  STRUCTURAL_THRESHOLDS,
  blendVialReason,
  buildCompoundRefs,
  classifyOfferRow,
  classifyProductUrlShape,
  median,
  mgPerVialCeiling,
  modal,
  refKey,
  winsorizedP5,
  type OfferLike,
} from "./plausibility.ts";

/** US$189.00 for a 2 × 10 mg pack, per-mg divided by the whole pack: 945 minor/mg. */
const base: OfferLike = {
  compound_id: "c-sema",
  native_currency: "USD",
  price_minor: 18900,
  mg_per_vial: 10,
  vials_per_pack: 2,
  per_mg_minor_e4: 9_450_000,
  form: "vial",
  product_name: "(2-Pack) Semaglutide - 20mg",
  variant_label: null,
  raw_price_text: "189.00",
  product_url: "https://acme-peptides.com/product/semaglutide-2-pack/",
};
const row = (over: Partial<OfferLike> = {}): OfferLike => ({ ...base, ...over });

describe("classifyOfferRow — the clean control", () => {
  it("a consistent row classifies clean, with or without a reference", () => {
    expect(classifyOfferRow(base)).toBeNull();
    expect(classifyOfferRow(base, { vendorWebsiteUrl: "https://acme-peptides.com", matchedCompoundId: "c-sema", medianPerMg: 9_000_000, p5: 8_000_000, nPriced: 12, modalMgPerVial: 10 })).toBeNull();
  });
});

describe("URL reasons", () => {
  it("source_url_non_product: a price read off a legal / tag / policy page", () => {
    expect(classifyOfferRow(row({ product_url: "https://acme-peptides.com/legal/research-use" }))).toBe("source_url_non_product");
    expect(classifyOfferRow(row({ product_url: "https://acme-peptides.com/product-tag/glp/" }))).toBe("source_url_non_product");
    expect(classifyOfferRow(row({ product_url: "https://acme-peptides.com/sitemap_index.xml" }))).toBe("source_url_non_product");
  });

  it("non_product_path: a catalogue index, a utility page or a staging host — but a product node under /collections is a product", () => {
    expect(classifyOfferRow(row({ product_url: "https://acme-peptides.com/collections/all" }))).toBe("non_product_path");
    expect(classifyOfferRow(row({ product_url: "https://acme-peptides.com/shop/" }))).toBe("non_product_path");
    expect(classifyOfferRow(row({ product_url: "https://acme-peptides.com/cart" }))).toBe("non_product_path");
    expect(classifyOfferRow(row({ product_url: "https://acme-peptides.myshopify.com/products/semaglutide" }))).toBe("non_product_path");
    expect(classifyOfferRow(row({ product_url: "https://acme-peptides.com/collections/glp/products/semaglutide" }))).toBeNull();
    expect(classifyProductUrlShape(null)).toBe(true);
    expect(classifyProductUrlShape("not a url")).toBe(true);
  });

  it("fabricated_url: a placeholder host, judged only when the vendor's own site is known", () => {
    const fabricated = row({ product_url: "https://example.com/product/semaglutide" });
    expect(classifyOfferRow(fabricated, { vendorWebsiteUrl: "https://acme-peptides.com" })).toBe("fabricated_url");
    expect(classifyOfferRow(fabricated)).toBeNull();
    expect(classifyOfferRow(row({ product_url: null }), { vendorWebsiteUrl: "https://acme-peptides.com" })).toBeNull();
  });

  it("a URL reason wins over a price reason the same row also trips", () => {
    expect(classifyOfferRow(row({ product_url: "https://acme-peptides.com/legal/terms", raw_price_text: "1.00" }))).toBe("source_url_non_product");
  });
});

describe("compound_not_corroborated", () => {
  it("fires when the matcher, re-run on the stored name and label, no longer files the row under its compound", () => {
    expect(classifyOfferRow(base, { matchedCompoundId: "c-other" })).toBe("compound_not_corroborated");
    expect(classifyOfferRow(base, { matchedCompoundId: null })).toBe("compound_not_corroborated");
  });
  it("passes when the matcher agrees, and is skipped when no verdict is supplied", () => {
    expect(classifyOfferRow(base, { matchedCompoundId: "c-sema" })).toBeNull();
    expect(classifyOfferRow(base)).toBeNull();
  });
});

describe("currency_unresolved", () => {
  it("fires when the raw text names a different currency than the row stores", () => {
    expect(classifyOfferRow(row({ raw_price_text: "CAD18900 (minor_unit=2)" }))).toBe("currency_unresolved");
    expect(classifyOfferRow(row({ raw_price_text: "£189.00" }))).toBe("currency_unresolved");
    expect(classifyOfferRow(row({ raw_price_text: "€189.00" }))).toBe("currency_unresolved");
  });
  it("passes when they agree, and does not judge a bare number or a bare $", () => {
    expect(classifyOfferRow(row({ raw_price_text: "USD18900 (minor_unit=2)" }))).toBeNull();
    expect(classifyOfferRow(row({ native_currency: "CAD", raw_price_text: "CAD18900 (minor_unit=2)" }))).toBeNull();
    expect(classifyOfferRow(row({ native_currency: "CAD", raw_price_text: "$189.00" }))).toBeNull();
    expect(classifyOfferRow(row({ native_currency: "GBP", raw_price_text: "£189.00" }))).toBeNull();
  });
});

describe("price_ne_raw — a transcription contradiction, in the row's own currency", () => {
  it("fires when the stored amount appears nowhere in the raw text", () => {
    expect(classifyOfferRow(row({ raw_price_text: "199.00" }))).toBe("price_ne_raw");
    expect(classifyOfferRow(row({ raw_price_text: "USD19900 (minor_unit=2)" }))).toBe("price_ne_raw");
  });
  it("passes on a declared minor-unit amount and on a multi-price string that contains it", () => {
    expect(classifyOfferRow(row({ raw_price_text: "18900 (minor_unit=2)" }))).toBeNull();
    expect(classifyOfferRow(row({ raw_price_text: "$229.00 $189.00" }))).toBeNull();
  });
  it("a raw text with no number is unjudged, never a contradiction", () => {
    expect(classifyOfferRow(row({ raw_price_text: "" }))).toBeNull();
    expect(classifyOfferRow(row({ raw_price_text: "call for price" }))).toBeNull();
  });
  it("a CAD row is compared in CAD — an exchange rate never makes it disagree", () => {
    expect(classifyOfferRow(row({ native_currency: "CAD", price_minor: 4658, per_mg_minor_e4: 2_329_000, raw_price_text: "CAD4658 (minor_unit=2)" }))).toBeNull();
  });
});

describe("kit_multiplier_ignored — per-mg divided by one vial on a multi-vial pack", () => {
  // Stored per-mg = price / mg_per_vial, where it should be price / (mg_per_vial × vials_per_pack).
  const perVial = (priceMinor: number, mg: number) => Math.round((priceMinor * 10_000) / mg);

  it("flags each pack by the multiple it was wrong by", () => {
    const rows: [string, OfferLike][] = [
      ["25×", row({ price_minor: 7000, mg_per_vial: 50, vials_per_pack: 25, per_mg_minor_e4: perVial(7000, 50), raw_price_text: "70.00" })],
      ["10×", row({ price_minor: 4400, mg_per_vial: 10, vials_per_pack: 10, per_mg_minor_e4: perVial(4400, 10), raw_price_text: "44.00" })],
      ["4×", row({ price_minor: 7200, mg_per_vial: 10, vials_per_pack: 4, per_mg_minor_e4: perVial(7200, 10), raw_price_text: "72.00" })],
      ["2×", row({ per_mg_minor_e4: perVial(18900, 10) })],
    ];
    for (const [label, r] of rows) expect(classifyOfferRow(r), label).toBe("kit_multiplier_ignored");
  });
  it("passes the same rows once the pack divide is applied", () => {
    expect(classifyOfferRow(base)).toBeNull();
    expect(classifyOfferRow(row({ price_minor: 7000, mg_per_vial: 50, vials_per_pack: 25, per_mg_minor_e4: 56_000, raw_price_text: "70.00" }))).toBeNull();
  });
  it("ignores single-vial rows, where the two divides are the same number", () => {
    expect(classifyOfferRow(row({ vials_per_pack: 1, per_mg_minor_e4: perVial(18900, 10) }))).toBeNull();
    expect(classifyOfferRow(row({ vials_per_pack: null, per_mg_minor_e4: perVial(18900, 10) }))).toBeNull();
  });
  it("does not flag a non-vial form, whose pack total is not mg_per_vial × vials_per_pack", () => {
    expect(classifyOfferRow(row({ form: "solution", per_mg_minor_e4: perVial(18900, 10) }))).not.toBe("kit_multiplier_ignored");
  });
  it("does not claim a row that is wrong some other way", () => {
    expect(classifyOfferRow(row({ per_mg_minor_e4: 137 * 100 * 10_000 }))).not.toBe("kit_multiplier_ignored");
  });
  it("tolerates rounding at the stored precision", () => {
    expect(classifyOfferRow(row({ price_minor: 10000, raw_price_text: "100.00", mg_per_vial: 3, vials_per_pack: 7, per_mg_minor_e4: 4_761_905 }))).toBeNull();
  });
});

describe("per-mg floor and market band", () => {
  it("per_mg_below_floor: below half the compound's winsorized p5", () => {
    const single = row({ mg_per_vial: 20, vials_per_pack: 1 }); // one 20 mg vial at the same $9.45/mg
    expect(classifyOfferRow(single, { p5: 20_000_000 })).toBe("per_mg_below_floor");
    expect(classifyOfferRow(single, { p5: 18_000_000 })).toBeNull();
  });
  it("a multi-vial kit is exempt from the single-vial floor — a volume discount is not a parse error — but not from the ÷10 band", () => {
    // Owner ruling 2026-10-01: wholesale 10-vial kits ARE compared. US$160 for 10 × 20 mg is $0.80/mg.
    const kit = row({ price_minor: 16000, raw_price_text: "160.00", mg_per_vial: 20, vials_per_pack: 10, per_mg_minor_e4: 800_000 });
    const singles = { p5: 5_000_000, medianPerMg: 6_000_000, nPriced: 20 };
    expect(classifyOfferRow(kit, singles)).toBeNull();
    // CONTROL: one vial at the same per-mg is below the floor.
    expect(classifyOfferRow(row({ price_minor: 1600, raw_price_text: "16.00", mg_per_vial: 20, vials_per_pack: 1, per_mg_minor_e4: 800_000 }), singles)).toBe("per_mg_below_floor");
    // A kit priced at a tenth of that (a feed error: ten 10 mg vials for $9.90) is still refused.
    expect(classifyOfferRow(row({ price_minor: 990, raw_price_text: "9.90", mg_per_vial: 10, vials_per_pack: 10, per_mg_minor_e4: 99_000 }), singles)).toBe("per_mg_below_floor");
  });

  it("with enough priced rows, outside [median/10, median×10] is above the ceiling or below the floor", () => {
    expect(classifyOfferRow(base, { medianPerMg: 900_000, nPriced: 5 })).toBe("per_mg_above_ceiling");
    expect(classifyOfferRow(base, { medianPerMg: 95_000_000, nPriced: 5 })).toBe("per_mg_below_floor");
    expect(classifyOfferRow(base, { medianPerMg: 9_000_000, nPriced: 5 })).toBeNull();
  });
  it("thin data cannot form a band: only an absurd absolute per-mg is refused, in the row's own minor units", () => {
    expect(classifyOfferRow(base, { medianPerMg: 900_000, nPriced: 4 })).toBeNull();
    const absurd = STRUCTURAL_THRESHOLDS.PER_MG_ABS_CEILING_MAJOR * 100 * 10_000 + 1;
    expect(classifyOfferRow(row({ vials_per_pack: 1, per_mg_minor_e4: absurd }), { nPriced: 1 })).toBe("per_mg_above_ceiling");
    // ¥ has no minor unit: 1,000 major per mg is 1,000 minor per mg, not 100,000.
    expect(classifyOfferRow(row({ native_currency: "JPY", vials_per_pack: 1, raw_price_text: "18900", per_mg_minor_e4: 1000 * 10_000 + 1 }), { nPriced: 1 })).toBe("per_mg_above_ceiling");
  });
  it("a non-comparable row (no per-mg) is not judged by any per-mg check", () => {
    expect(classifyOfferRow(row({ per_mg_minor_e4: null, form: "capsule" }), { p5: 20_000_000, medianPerMg: 900_000, nPriced: 9 })).toBeNull();
  });
});

describe("mg_per_vial_implausible — observe-only", () => {
  it("a thin-data compound cannot licence its own impossible vial", () => {
    expect(mgPerVialCeiling(2400, 1)).toBe(STRUCTURAL_THRESHOLDS.MG_PER_VIAL_THIN_CEILING);
    expect(classifyOfferRow(row({ mg_per_vial: 1000, vials_per_pack: 1, per_mg_minor_e4: 189_000 }), { modalMgPerVial: 1000, nPriced: 1 })).toBe("mg_per_vial_implausible");
  });
  it("a well-populated compound self-validates through its modal vial", () => {
    expect(mgPerVialCeiling(500, 8)).toBe(1500);
    expect(mgPerVialCeiling(5, 8)).toBe(60);
    expect(classifyOfferRow(row({ mg_per_vial: 1000, vials_per_pack: 1, per_mg_minor_e4: 189_000 }), { modalMgPerVial: 500, nPriced: 8 })).toBeNull();
  });
  it("is the LAST reason: a row that also fails an actionable check reports that one", () => {
    const both = row({ mg_per_vial: 1000, vials_per_pack: 1, per_mg_minor_e4: 189_000, raw_price_text: "1.00" });
    expect(classifyOfferRow(both, { nPriced: 1 })).toBe("price_ne_raw");
  });
  it("is declared observe-only, and is the only such reason", () => {
    expect([...OBSERVE_ONLY_REASONS]).toEqual(["mg_per_vial_implausible"]);
  });
});

describe("reference statistics", () => {
  it("median takes positive values only and is null when there are none", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([0, -1])).toBeNull();
  });
  it("modal returns the first value at the winning count", () => {
    expect(modal([5, 10, 10, 5, 2])).toBe(10);
    expect(modal([])).toBeNull();
  });
  it("winsorizedP5 is the value at the 5th percentile index of the positive values", () => {
    expect(winsorizedP5(Array.from({ length: 41 }, (_, i) => i + 1))).toBe(3);
    expect(winsorizedP5([])).toBeNull();
  });
  it("buildCompoundRefs keys by compound AND currency — a CAD price never sets a USD band", () => {
    const refs = buildCompoundRefs([
      { compound_id: "c1", native_currency: "USD", per_mg_minor_e4: 100, mg_per_vial: 5 },
      { compound_id: "c1", native_currency: "USD", per_mg_minor_e4: 300, mg_per_vial: 5 },
      { compound_id: "c1", native_currency: "CAD", per_mg_minor_e4: 900, mg_per_vial: 10 },
    ]);
    expect(refs.get(refKey({ compound_id: "c1", native_currency: "USD" }))).toEqual({ p5: 100, medianPerMg: 200, modalMgPerVial: 5, nPriced: 2 });
    expect(refs.get(refKey({ compound_id: "c1", native_currency: "CAD" }))).toEqual({ p5: 900, medianPerMg: 900, modalMgPerVial: 10, nPriced: 1 });
  });
});

describe("blendVialReason — a blend vial is judged against its own group, per vial", () => {
  const row = (price_minor: number, vials_per_pack = 1, over: Record<string, unknown> = {}) => ({ price_minor, vials_per_pack, is_blend: true, form: "vial", ...over });
  it("sets aside a price per vial more than ten times off the group's median, in either direction", () => {
    expect(blendVialReason(row(60_000), 5_000, 6)).toBe("per_vial_out_of_band");
    expect(blendVialReason(row(400), 5_000, 6)).toBe("per_vial_out_of_band");
    expect(blendVialReason(row(45_000, 10), 5_000, 6)).toBeNull(); // a 10-vial kit at US$45.00 a vial
    expect(blendVialReason(row(5_500), 5_000, 6)).toBeNull();
  });
  it("FINAL REVIEW I4: a vial whose mix is not stated is judged too (its group is its stated total)", () => {
    expect(blendVialReason(row(102_060), 9_000, 30)).toBe("per_vial_out_of_band"); // "GLOW (70mg) -10 Vials" read as one vial
  });
  it("judges nothing without five rows in the group, or a row that is not a blend vial", () => {
    expect(blendVialReason(row(60_000), 5_000, 4)).toBeNull();
    expect(blendVialReason(row(60_000, 1, { form: "capsule" }), 5_000, 9)).toBeNull();
    expect(blendVialReason(row(60_000, 1, { is_blend: false }), 5_000, 9)).toBeNull();
    expect(blendVialReason(row(60_000, null as unknown as number), 5_000, 9)).toBeNull();
  });
});
