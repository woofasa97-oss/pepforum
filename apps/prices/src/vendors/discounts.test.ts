import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tierRows, validateDiscounts, type DiscountEvidence } from "./discounts.ts";

const good: DiscountEvidence = {
  slug: "peptide-confidential", tiers: [{ vials: 3, percent: 10 }, { vials: 5, percent: 20 }, { vials: 10, percent: 30 }], blends: true, any_product: true, mechanism: "pack page",
  source: "https://peptideconfidential.com/products/multi-pack", quote: "Target 3 vials −10% 5 vials −20% 10 vials −30%", checked: "2026-10-06",
};

// Owner, 2026-10-06: a multipack discount is recorded only from the vendor's own words, and expires.
describe("multipack discount evidence", () => {
  it("keeps an entry with its tiers, its page, its words and its day; a vendor found to have none has no tiers", () => {
    expect(validateDiscounts([good])).toEqual([good]);
    expect(validateDiscounts([{ slug: "retaone", tiers: [], checked: "2026-10-06", notes: "FAQ: no bulk discounts" }])).toHaveLength(1);
  });

  it("refuses anything it could not stand behind", () => {
    for (const bad of [
      { ...good, tiers: [{ vials: 10, percent: 30 }, { vials: 5, percent: 20 }] }, // not ascending
      { ...good, tiers: [{ vials: 3, percent: 20 }, { vials: 5, percent: 10 }] }, // falls
      { ...good, tiers: [{ vials: 0, percent: 10 }] },
      { ...good, tiers: [{ vials: 3, percent: 100 }] },
      { ...good, quote: "Target 3 vials −10% 5 vials −20%" }, // 30 is not in the words
      { ...good, source: "http://peptideconfidential.com/products/multi-pack" },
      { ...good, mechanism: "coupon" },
      { ...good, checked: "2026-02-30" },
      { ...good, blends: "unclear" },
      null,
    ]) expect(() => validateDiscounts([bad])).toThrow(/discount evidence/);
    expect(() => validateDiscounts([good, good])).toThrow(/twice/);
    // A number in words counts; a one-vial tier (every order) needs only its percent in the words.
    expect(validateDiscounts([{ ...good, tiers: [{ vials: 6, percent: 15 }], quote: "15% off once six eligible vials are selected" }])).toHaveLength(1);
    expect(validateDiscounts([{ ...good, tiers: [{ vials: 1, percent: 10 }, { vials: 3, percent: 15 }], quote: "10% off every compound vial · 15% at 3" }])).toHaveLength(1);
  });

  it("becomes verified vendor-wide rows that expire 60 days after the check", () => {
    expect(tierRows(good, "vendor-id")[2]).toEqual({
      vendor_id: "vendor-id", compound_id: null, threshold: 10, basis: "vials", scope: "all_units", discount_pct: 30, applies_to_blends: true, mix_and_match: true,
      evidence_url: "https://peptideconfidential.com/products/multi-pack", evidence_text: "Target 3 vials −10% 5 vials −20% 10 vials −30%",
      observed_at: "2026-10-06T00:00:00Z", valid_from: "2026-10-06", valid_to: "2026-12-05", status: "verified",
    });
  });

  it("the committed file is valid and covers every vendor once", () => {
    const file = validateDiscounts(JSON.parse(readFileSync("src/vendors/discount-evidence.json", "utf8")));
    expect(file).toHaveLength(10);
    expect(file.find((e) => e.slug === "peptide-confidential")?.tiers).toEqual(good.tiers);
  });
});
