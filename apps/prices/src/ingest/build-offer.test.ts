import { describe, expect, it } from "vitest";
import type { Product } from "../ladder/types.ts";
import { buildProductIndex } from "../units/blend-match.ts";
import { buildOfferRow, computeProductKey, sanitizeProductUrl, stripTrackingParams } from "./build-offer.ts";
import type { CompoundRow, OfferRow, VendorRow } from "./repo.ts";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const vendor = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "acme",
  name: "Acme Peptides",
  website_url: "https://acmepeptides.com",
  canonical_domain: "acmepeptides.com",
  origin_country: "US",
  detected_platform: "woocommerce",
} as VendorRow;
const compound = { id: "22222222-2222-4222-8222-222222222222", slug: "bpc-157", name: "BPC-157", aliases: [] } as unknown as CompoundRow;

const product = (over: Partial<Product> = {}): Product => ({
  name: "BPC-157",
  variantLabel: "Size: 5mg",
  productUrl: "https://acmepeptides.com/product/bpc-157/",
  fetchUrl: "https://acmepeptides.com/wp-json/wc/store/v1/products?per_page=100",
  sourceSystem: "woocommerce",
  priceSource: "woo_store_api",
  sourceProductId: "181",
  sourceVariantId: "4649",
  variantKey: "4649",
  options: null,
  currency: "USD",
  currencyEvidence: "store_api",
  priceMinor: 4999,
  listPriceMinor: null,
  onSale: false,
  availability: "in_stock",
  rawPriceText: "USD4999 (minor_unit=2)",
  fallbackRange: null,
  ...over,
});

const ctx = (previous: OfferRow | null = null) => ({ vendor, compound, runId: "33333333-3333-4333-8333-333333333333", now: NOW, previous });

describe("buildOfferRow", () => {
  it("stores native minor units and the currency; never a converted amount", () => {
    const out = buildOfferRow(product({ currency: "CAD", priceMinor: 4658, rawPriceText: "CAD4658 (minor_unit=2)" }), ctx());
    if (!out.ok) throw new Error(out.reason);
    expect(out.row).toMatchObject({ native_currency: "CAD", price_minor: 4658, vendor_id: vendor.id, compound_id: compound.id, run_id: ctx().runId });
    expect(out.row.product_key).toBe(`${vendor.id}:${compound.id}:acmepeptides.com/product/bpc-157`);
    expect(out.row.variant_key).toBe("4649");
    expect(out.row.observed_at).toBe(NOW.toISOString());
  });

  it("computes per-mg only when comparable, from the whole pack, and marks a multi-vial SKU a fixed kit", () => {
    const single = buildOfferRow(product(), ctx());
    if (!single.ok) throw new Error(single.reason);
    expect(single.row).toMatchObject({ comparable: true, mg_per_vial: 5, vials_per_pack: 1, total_mg: 5, per_mg_minor_e4: 9998000, price_kind: "per_pack", form: "vial", quantity_reason: null });
    const pack = buildOfferRow(product({ variantLabel: "(2-Pack) 5mg", priceMinor: 10000, rawPriceText: "USD10000 (minor_unit=2)" }), ctx());
    if (!pack.ok) throw new Error(pack.reason);
    expect(pack.row).toMatchObject({ comparable: true, mg_per_vial: 5, vials_per_pack: 2, total_mg: 10, per_mg_minor_e4: 10000000, price_kind: "fixed_kit" });
  });

  it("writes non-comparable products with a typed reason and no per-mg", () => {
    const caps = buildOfferRow(product({ name: "NAD+", variantLabel: "250mg capsules" }), ctx());
    if (!caps.ok) throw new Error(caps.reason);
    expect(caps.row).toMatchObject({ comparable: false, quantity_reason: "non_vial_form", per_mg_minor_e4: null, total_mg: null, form: "capsule", mg_per_vial: 250 });
    const blend = buildOfferRow(product({ name: "GLOW Blend", variantLabel: "GHK-Cu 50mg / BPC-157 10mg" }), ctx());
    if (!blend.ok) throw new Error(blend.reason);
    expect(blend.row).toMatchObject({ comparable: false, quantity_reason: "blend", is_blend: true, per_mg_minor_e4: null });
    const pen = buildOfferRow(product({ name: "Semaglutide", variantLabel: "Pre-filled pen 5mg" }), ctx());
    if (!pen.ok) throw new Error(pen.reason);
    expect(pen.row).toMatchObject({ comparable: false, quantity_reason: "non_vial_form", form: "pen" });
    const bulk = buildOfferRow(product({ name: "GHK-Cu", variantLabel: "1000mg" }), ctx());
    if (!bulk.ok) throw new Error(bulk.reason);
    expect(bulk.row).toMatchObject({ comparable: false, quantity_reason: "bulk_over_max", form: "bulk", mg_per_vial: 1000 });
    const noMg = buildOfferRow(product({ name: "BPC-157", variantLabel: null }), ctx());
    if (!noMg.ok) throw new Error(noMg.reason);
    expect(noMg.row).toMatchObject({ comparable: false, quantity_reason: "no_mg", extraction_confidence: "low" });
  });

  it("moves price_changed_at only when the native amount, list price or availability changes", () => {
    const first = buildOfferRow(product(), ctx());
    if (!first.ok) throw new Error(first.reason);
    const previous = { ...first.row, id: "prev", price_changed_at: "2026-09-01T00:00:00.000Z" } as OfferRow;
    const same = buildOfferRow(product(), ctx(previous));
    if (!same.ok) throw new Error(same.reason);
    expect(same.row.price_changed_at).toBe("2026-09-01T00:00:00.000Z");
    expect(same.changed).toBe(false);
    expect(same.isNew).toBe(false);
    for (const over of [{ priceMinor: 5999, rawPriceText: "USD5999 (minor_unit=2)" }, { listPriceMinor: 6999, onSale: true }, { availability: "out_of_stock" as const }]) {
      const moved = buildOfferRow(product(over), ctx(previous));
      if (!moved.ok) throw new Error(moved.reason);
      expect(moved.row.price_changed_at, JSON.stringify(over)).toBe(NOW.toISOString());
      expect(moved.changed).toBe(true);
    }
    expect(first.isNew).toBe(true);
  });

  it("an offer filed under a BLEND compound is a blend whatever its name looks like: never comparable", () => {
    const blend = { ...compound, id: "c-blend", slug: "bpc-157-tb-500", name: "BPC-157 + TB-500", type: "Blend" } as unknown as CompoundRow;
    const out = buildOfferRow(product({ name: "Wolverine Stack Lite", variantLabel: "Size: 10mg" }), { vendor, compound: blend, runId: null, now: NOW, previous: null });
    expect(out).toMatchObject({ ok: true, row: { comparable: false, quantity_reason: "blend", is_blend: true, per_mg_minor_e4: null, total_mg: null } });
    const plain = buildOfferRow(product({ name: "Recovery Duo", variantLabel: "Size: 10mg" }), { vendor, compound: blend, runId: null, now: NOW, previous: null });
    expect(plain).toMatchObject({ ok: true, row: { comparable: false, quantity_reason: "blend", is_blend: true, per_mg_minor_e4: null } });
  });

  it("refuses a price that is not in the raw text, an unresolved currency, a range row", () => {
    expect(buildOfferRow(product({ rawPriceText: "59.99", priceMinor: 6999 }), ctx())).toMatchObject({ ok: false, reason: "raw_text_mismatch" });
    expect(buildOfferRow(product({ currency: null }), ctx())).toMatchObject({ ok: false, reason: "currency_unresolved" });
    expect(buildOfferRow(product({ priceMinor: null, fallbackRange: { minMinor: 4999, maxMinor: 9999 } }), ctx())).toMatchObject({ ok: false, reason: "price_not_positive" });
  });

  it("refuses an off-brand or asset URL, keys a placeholder URL on the fetch URL + name, and strips tracking params", () => {
    expect(buildOfferRow(product({ productUrl: "https://other-shop.com/product/bpc-157/" }), ctx())).toMatchObject({ ok: false, reason: "invalid_product_url" });
    expect(buildOfferRow(product({ productUrl: "https://acmepeptides.com/wp-content/uploads/bpc.png" }), ctx())).toMatchObject({ ok: false, reason: "invalid_product_url" });
    const placeholder = buildOfferRow(product({ productUrl: "https://example.com/bpc-157" }), ctx());
    if (!placeholder.ok) throw new Error(placeholder.reason);
    expect(placeholder.row.product_url).toBeNull();
    expect(placeholder.row.product_key).toMatch(new RegExp(`^${vendor.id}:${compound.id}:fallback:[0-9a-f]{16}$`));
    const tracked = buildOfferRow(product({ productUrl: "https://acmepeptides.com/product/bpc-157/?utm_source=x&fbclid=1#top" }), ctx());
    if (!tracked.ok) throw new Error(tracked.reason);
    expect(tracked.row.product_url).toBe("https://acmepeptides.com/product/bpc-157/");
  });

  it("accepts the vendor's own brand on another TLD (TLD variance is legitimate)", () => {
    expect(sanitizeProductUrl("https://shop.acmepeptides.is/p/x", vendor.website_url)).toEqual({ url: "https://shop.acmepeptides.is/p/x", rejectedReason: null });
    expect(sanitizeProductUrl("https://vendor.co.uk/p", "https://www.vendor.co.uk")).toMatchObject({ rejectedReason: null });
    expect(sanitizeProductUrl("https://localhost/p", vendor.website_url)).toMatchObject({ url: null, rejectedReason: "placeholder" });
    expect(stripTrackingParams("https://a.com/p?variant=1&gclid=2")).toBe("https://a.com/p?variant=1");
    expect(computeProductKey({ vendorId: "v", compoundId: "c", productUrl: "https://A.com/P/", fetchUrl: null, name: "x" })).toBe("v:c:a.com/p");
  });

  it("records the availability check time only when there is a fact to date", () => {
    const known = buildOfferRow(product(), ctx());
    const unknown = buildOfferRow(product({ availability: "unknown" }), ctx());
    if (!known.ok || !unknown.ok) throw new Error("build failed");
    expect(known.row.availability_checked_at).toBe(NOW.toISOString());
    expect(unknown.row.availability_checked_at).toBeNull();
  });
});

describe("buildOfferRow — a blend", () => {
  const rows = [
    { id: "s-bpc", slug: "bpc-157", name: "BPC-157", aliases: [], type: "Single compound" },
    { id: "s-tb", slug: "tb-500", name: "TB-500", aliases: ["Thymosin Beta-4"], type: "Single compound" },
    { id: "b-bt", slug: "bpc-157-tb-500", name: "BPC-157 + TB-500", aliases: ["Wolverine"], type: "Blend", blend_components: [{ slug: "bpc-157" }, { slug: "tb-500" }] },
  ];
  const blends = buildProductIndex(rows).blends;
  const blendCompound = { id: "b-bt", slug: "bpc-157-tb-500", name: "BPC-157 + TB-500", aliases: ["Wolverine"], type: "Blend" } as unknown as CompoundRow;
  const build = (over: Partial<Product>) => {
    const out = buildOfferRow(product({ productUrl: "https://acmepeptides.com/product/blend/", ...over }), { vendor, compound: blendCompound, runId: null, now: NOW, previous: null, blends });
    if (!out.ok) throw new Error(out.reason);
    return out.row;
  };

  it("an exact mix: the recipe key, the vial's total, one vial — and never a per-mg figure", () => {
    expect(build({ name: "BPC-157 10mg + TB-500 10mg (Wolverine Stack 20mg)", variantLabel: null })).toMatchObject({
      is_blend: true, comparable: false, quantity_reason: "blend", form: "vial", recipe_key: "bpc-157:10+tb-500:10",
      mg_per_vial: 20, vials_per_pack: 1, total_mg: null, per_mg_minor_e4: null, price_kind: "per_pack",
    });
  });
  it("amounts not stated: no recipe key; the total when the listing gives one", () => {
    expect(build({ name: "BPC-157 TB500 Blend", variantLabel: "Milligram: 10mg" })).toMatchObject({ recipe_key: null, mg_per_vial: 10, vials_per_pack: 1, form: "vial" });
    expect(build({ name: "BPC-157 + TB500 Blend", variantLabel: null })).toMatchObject({ recipe_key: null, mg_per_vial: null, vials_per_pack: 1 });
  });
  it("a kit of blend vials keeps the vial's mix and counts the vials", () => {
    expect(build({ name: "BPC-157 5mg,TB-500 5mg (Wolverine Blend) (10 vials)", variantLabel: null })).toMatchObject({ recipe_key: "bpc-157:5+tb-500:5", mg_per_vial: 10, vials_per_pack: 10, price_kind: "fixed_kit" });
    expect(build({ name: "Combo Vial: BPC-157/TB-500 (20mg vials)", variantLabel: "QUANTITY (MG):: 100 mg" })).toMatchObject({ recipe_key: null, mg_per_vial: 20, vials_per_pack: 5, price_kind: "fixed_kit" });
  });
  it("a capsule or spray blend is stored but is not a vial, and a pack of unknown size has no pack count", () => {
    expect(build({ name: "BPC/TB Blend (Wolverine) Capsules", variantLabel: null })).toMatchObject({ form: "capsule", is_blend: true });
    expect(build({ name: "BPC-157 / TB-500 Blend", variantLabel: "weight: 500/500mcg/cap" }).form).not.toBe("vial");
    expect(build({ name: "BPC 157 + TB500 Research Kit (10mg)", variantLabel: null })).toMatchObject({ vials_per_pack: null });
  });
  it("REAL-DATA LOOK (2026-10-02): a topical blend is stored but is never a vial, whatever its size", () => {
    expect(build({ name: "BPC-157 1.25%, TB-500 (TB4) 0.85% Topical (630mg Blend)", variantLabel: null }).form).not.toBe("vial");
    expect(build({ name: "BPC-157 + TB-500 Topical 30mg", variantLabel: null }).form).not.toBe("vial");
    expect(build({ name: "BPC-157 10mg + TB-500 10mg (Save 20% OFF)", variantLabel: null }).form).toBe("vial");
  });
});
