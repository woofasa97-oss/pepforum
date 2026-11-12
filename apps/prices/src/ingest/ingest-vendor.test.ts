import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { FetchResult, FetchText } from "../fetch/types.ts";
import { buildProductIndex } from "../units/blend-match.ts";
import { ingestVendor, SKU_DROP_FLOOR } from "./ingest-vendor.ts";
import { InMemoryRepo, type AttemptRow, type CompoundRow, type OfferRow, type RunRow, type VendorRow } from "./repo.ts";

const VARIABLE = readFileSync(new URL("../ladder/__fixtures__/woo-store-products-variable.json", import.meta.url), "utf8");
const VARIATIONS_181 = readFileSync(new URL("../ladder/__fixtures__/woo-store-variations-parent-181.json", import.meta.url), "utf8");
const PRODUCT_PAGE = readFileSync(new URL("../ladder/__fixtures__/woo-product-page-handbuilt.html", import.meta.url), "utf8");

const AT = "2026-10-01T00:00:00.000Z";
const NOW = new Date("2026-10-01T12:00:00.000Z");
const res = (url: string, status: number, body = ""): FetchResult => ({ url, status, state: status === 200 ? "hit" : status === 404 ? "miss" : "unknown", body, fetchedAt: AT });

const VENDOR_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const vendorRow = (over: Partial<VendorRow> = {}): VendorRow =>
  ({
    id: VENDOR_ID,
    slug: "blank",
    name: "Blank Peptides",
    website_url: "https://blankpeptides.com",
    canonical_domain: "blankpeptides.com",
    origin_country: "US",
    status: "active",
    detected_platform: "woocommerce",
    ...over,
  }) as VendorRow;
const compounds = [
  { id: "c-reta", slug: "retatrutide", name: "Retatrutide", aliases: [] },
  { id: "c-glow", slug: "glow", name: "GLOW", aliases: ["GLOW Blend"] },
] as unknown as CompoundRow[];

const wooProduct = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: "Retatrutide 10mg",
  permalink: "https://blankpeptides.com/product/retatrutide-10/",
  is_in_stock: true,
  prices: { price: "10500", currency_code: "USD", currency_minor_unit: 2 },
  ...over,
});

function setup(vendor = vendorRow()) {
  const repo = new InMemoryRepo();
  repo.seedVendor(vendor);
  for (const c of compounds) repo.seedCompound(c);
  const products = buildProductIndex(compounds.map((c) => ({ id: c.id, name: c.name, slug: c.slug, aliases: c.aliases, type: c.type, blend_components: c.blend_components as { slug: string }[] | null })));
  return { repo, products, vendor };
}

const deps = (repo: InMemoryRepo, fetchText: FetchText, over: Partial<Parameters<typeof ingestVendor>[1]> = {}) => ({
  repo,
  fetchText,
  sleep: async () => {},
  products: over.products ?? setup().products,
  compoundsById: new Map(compounds.map((c) => [c.id, c])),
  runId: RUN_ID,
  runLabel: "test-run",
  now: NOW,
  dryRun: false,
  ...over,
});

const blankStore: FetchText = async (url) => {
  if (url.includes("parent=181")) return res(url, 200, VARIATIONS_181);
  if (url.includes("parent=286")) return res(url, 200, "[]");
  if (url.includes("wc/store")) return res(url, 200, VARIABLE);
  return res(url, 404);
};

describe("ingestVendor", () => {
  it("writes one offer per variation from the recorded fixtures, records the attempt and the observations", async () => {
    const { repo, vendor } = setup();
    const out = await ingestVendor(vendor, deps(repo, blankStore));
    expect(out.outcome).toBe("hit");
    expect(out.rung).toBe("woo_store_api");
    // 4 RETATRUTIDE variations written; the GLOW parent's fallback (a range) is refused, not written.
    expect(out.rowsWritten).toBe(4);
    expect(out.refusals).toMatchObject({ price_not_positive: 1 });
    expect([...repo.offers.values()].map((o) => [o.variant_label, o.price_minor, o.comparable, o.per_mg_minor_e4])).toEqual([
      ["Size: 15mg", 11900, true, 7933333],
      ["Size: 20mg", 15900, true, 7950000],
      ["Size: 10mg", 10500, true, 10500000],
      ["Size: 30mg", 23900, true, 7966667],
    ]);
    expect(repo.observations).toHaveLength(4);
    expect(repo.observations.every((o) => o.run_label === "test-run" && o.offer_id)).toBe(true);
    const attempt = [...repo.attempts.values()][0];
    expect(attempt).toMatchObject({ vendor_id: VENDOR_ID, run_id: RUN_ID, outcome: "hit", run_complete: true, rows_written: 4, products_seen: 5, rung: "woo_store_api" });
    expect(attempt.finished_at).not.toBeNull();
    expect(out.fetches).toBe(3);
  });

  it("an unknown vendor run writes no offers, quarantines nothing, and records outcome 'unknown' (blocked on a 403)", async () => {
    const { repo, vendor } = setup();
    repo.seedOffer({ id: "stale", vendor_id: VENDOR_ID, compound_id: "c-reta", product_key: "k", variant_key: "", product_url: "https://blankpeptides.com/product/old/" } as OfferRow);
    const out = await ingestVendor(vendor, deps(repo, async (url) => res(url, 403)));
    expect(out.outcome).toBe("blocked");
    expect(repo.offers.size).toBe(1);
    expect(repo.quarantined).toEqual([]);
    const attempt = [...repo.attempts.values()][0];
    expect(attempt).toMatchObject({ outcome: "blocked", run_complete: false, rows_written: 0, http_status: 403 });
    const timeout = await ingestVendor(vendor, deps(repo, async (url) => ({ ...res(url, 500), status: null, error: "timeout" })));
    expect(timeout.outcome).toBe("unknown");
  });

  it("holds a vendor whose row count falls below 0.7 × the last complete hit — observations still written, nothing served", async () => {
    const { repo, vendor } = setup();
    repo.seedAttempt({ id: "prior", vendor_id: VENDOR_ID, run_id: "r0", outcome: "hit", run_complete: true, rows_written: 100, finished_at: "2026-09-30T00:00:00.000Z", counts: {} } as AttemptRow);
    const out = await ingestVendor(vendor, deps(repo, blankStore));
    expect(out.outcome).toBe("held");
    expect(out.reason).toContain(`sku_drop_guard: 4 < ${SKU_DROP_FLOOR} × 100`);
    expect(repo.offers.size).toBe(0);
    expect(repo.observations).toHaveLength(4);
    expect([...repo.attempts.values()].find((a) => a.id !== "prior")).toMatchObject({ outcome: "held", run_complete: false, rows_written: 0 });
  });

  it("routes an unmatched product to candidates with reason no_compound_match; a currency-less one as currency_unresolved", async () => {
    const { repo, vendor } = setup();
    const feed = JSON.stringify([
      wooProduct(),
      wooProduct({ id: 2, name: "Mystery Compound 5mg", permalink: "https://blankpeptides.com/product/mystery/" }),
      wooProduct({ id: 3, name: "Retatrutide 5mg", permalink: "https://blankpeptides.com/product/reta-5/", prices: { price: "5000", currency_code: "XYZ", currency_minor_unit: 2 } }),
    ]);
    const out = await ingestVendor(vendor, deps(repo, async (url) => (url.includes("wc/store") ? res(url, 200, feed) : res(url, 404))));
    expect(out.rowsWritten).toBe(1);
    expect(repo.candidates.map((c) => [c.product_name, c.reject_reason])).toEqual([
      ["Mystery Compound 5mg", "no_compound_match"],
      ["Retatrutide 5mg", "currency_unresolved"],
    ]);
    expect(repo.candidates[0]).toMatchObject({ run_label: "test-run", vendor_id: VENDOR_ID, product_url: "https://blankpeptides.com/product/mystery/" });
    expect(out.candidates).toBe(2);
  });

  it("dry run touches nothing but records the attempt", async () => {
    const { repo, vendor } = setup();
    const out = await ingestVendor(vendor, deps(repo, blankStore, { dryRun: true }));
    expect(out.outcome).toBe("hit");
    expect(out.rowsWritten).toBe(4);
    expect(repo.offers.size).toBe(0);
    expect(repo.observations).toEqual([]);
    expect(repo.candidates).toEqual([]);
    expect(repo.attempts.size).toBe(1);
    expect([...repo.attempts.values()][0]).toMatchObject({ outcome: "hit", rows_written: 4 });
  });

  it("keeps price_changed_at on a re-read that finds the same price and moves it on a change", async () => {
    const { repo, vendor } = setup();
    await ingestVendor(vendor, deps(repo, blankStore));
    const before = [...repo.offers.values()].map((o) => o.price_changed_at);
    const later = new Date("2026-10-02T12:00:00.000Z");
    const again = await ingestVendor(vendor, deps(repo, blankStore, { now: later }));
    expect(again.changed).toBe(0);
    expect(again.unchanged).toBe(4);
    expect([...repo.offers.values()].map((o) => o.price_changed_at)).toEqual(before);
    expect([...repo.offers.values()].every((o) => o.observed_at === later.toISOString())).toBe(true);
    const repriced = VARIATIONS_181.replace('"price": "11900"', '"price": "12900"').replace('"regular_price": "11900"', '"regular_price": "12900"').replace('"sale_price": "11900"', '"sale_price": "12900"');
    const third = await ingestVendor(vendor, deps(repo, async (url) => (url.includes("parent=181") ? res(url, 200, repriced) : blankStore(url)), { now: new Date("2026-10-03T12:00:00.000Z") }));
    expect(third.changed).toBe(1);
    expect([...repo.offers.values()].find((o) => o.variant_label === "Size: 15mg")).toMatchObject({ price_minor: 12900, price_changed_at: "2026-10-03T12:00:00.000Z" });
  });

  it("quarantines a variant the feed no longer lists, and delists a product absent on two consecutive complete hits", async () => {
    const { repo, vendor } = setup();
    await ingestVendor(vendor, deps(repo, blankStore));
    const without30 = JSON.stringify(JSON.parse(VARIATIONS_181).filter((v: { id: number }) => v.id !== 1979));
    const store2: FetchText = async (url) => (url.includes("parent=181") ? res(url, 200, without30) : blankStore(url));
    const second = await ingestVendor(vendor, deps(repo, store2));
    expect(second.quarantined).toEqual({ variant_gone: 1 });
    expect(repo.quarantined.map((q) => [q.variant_label, q.reason, q.quarantine_run_id])).toEqual([["Size: 30mg", "variant_gone", RUN_ID]]);
    expect(repo.offers.size).toBe(3);
    // Now the whole product disappears from the feed: absent once → carried; absent twice → delisted.
    // Three GLOW products keep the run above the SKU-drop floor (3 ≥ 0.7 × 3), so the guard does not hold it.
    const glow = JSON.stringify([10, 20, 30].map((mg, i) => wooProduct({ id: 500 + i, name: `GLOW Blend ${mg}mg`, permalink: `https://blankpeptides.com/product/glow-${mg}/` })));
    const noReta: FetchText = async (url) => (url.includes("wc/store") ? res(url, 200, glow) : res(url, 404));
    const third = await ingestVendor(vendor, deps(repo, noReta));
    expect(third.quarantined).toEqual({});
    expect(repo.offers.size).toBe(6); // 3 reta + 3 glow
    const fourth = await ingestVendor(vendor, deps(repo, noReta));
    expect(fourth.quarantined).toEqual({ delisted: 3 });
    expect(repo.offers.size).toBe(3);
  });

  it("keeps the stored variants of a product the run saw but could not enumerate — seen is not absent", async () => {
    const { repo, vendor } = setup();
    // GLOW's variations were readable once; from now on the store lists the parent and answers [] for its variations.
    const glowVariant = { id: "glow-10", vendor_id: VENDOR_ID, compound_id: "c-glow", product_key: `${VENDOR_ID}:c-glow:blankpeptides.com/product/glow`, variant_key: "2860", product_url: "https://blankpeptides.com/product/glow/", variant_label: "Size: 10mg" } as OfferRow;
    repo.seedOffer(glowVariant);
    const first = await ingestVendor(vendor, deps(repo, blankStore));
    const second = await ingestVendor(vendor, deps(repo, blankStore));
    expect(first.undecided).toEqual({ variant_gone_unenumerated: 1 });
    expect(second.quarantined).toEqual({});
    expect(repo.quarantined).toEqual([]);
    expect(repo.offers.get("glow-10")).toMatchObject({ variant_key: "2860" });
  });

  it("an incomplete catalogue read removes nothing and is not a baseline: a failed page 3 never delists the products behind it", async () => {
    const { repo, vendor } = setup();
    const page = (from: number, to: number) => JSON.stringify(Array.from({ length: to - from + 1 }, (_, i) => wooProduct({ id: from + i, name: "Retatrutide 10mg", permalink: `https://blankpeptides.com/product/reta-${from + i}/` })));
    const store = (page3: (url: string) => FetchResult): FetchText => async (url) => {
      if (!url.includes("wc/store")) return res(url, 404);
      if (url.includes("page=3")) return page3(url);
      return res(url, 200, url.includes("page=2") ? page(101, 200) : page(1, 100));
    };
    const whole = store((url) => res(url, 200, page(201, 220)));
    const cut = store((url) => ({ ...res(url, 429), state: "unknown" }));

    expect((await ingestVendor(vendor, deps(repo, whole))).rowsWritten).toBe(220);
    const second = await ingestVendor(vendor, deps(repo, cut));
    expect(second).toMatchObject({ outcome: "hit", rowsWritten: 200, quarantined: {} });
    const third = await ingestVendor(vendor, deps(repo, cut));
    expect(third.quarantined).toEqual({});
    expect(repo.offers.size).toBe(220);
    expect(repo.quarantined).toEqual([]);
    // Neither partial read is a baseline: the SKU-drop guard and the two-run rule still measure against the whole read.
    const attempts = [...repo.attempts.values()];
    expect(attempts.map((a) => a.run_complete)).toEqual([true, false, false]);
    expect(attempts[2].counts).toMatchObject({ catalogue_complete: false });
    expect((await repo.lastCompleteHit(VENDOR_ID))?.rows_written).toBe(220);
  });

  it("a variation list cut short on a later page keeps the variants it did not reach", async () => {
    const { repo, vendor } = setup();
    const parent = [{ id: 181, name: "RETATRUTIDE", type: "variable", permalink: "https://blankpeptides.com/product/retatrutide/", is_in_stock: true, variations: [], prices: { price: "10500", currency_code: "USD", currency_minor_unit: 2, price_range: { min_amount: "10500", max_amount: "23900" } } }];
    const variations = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: 5000 + i, prices: { price: "10500", currency_code: "USD", currency_minor_unit: 2 }, is_in_stock: true, attributes: [{ name: "Size", value: "10mg" }, { name: "Lot", value: `L${i}` }] })));
    repo.seedOffer({ id: "beyond", vendor_id: VENDOR_ID, compound_id: "c-reta", product_key: `${VENDOR_ID}:c-reta:blankpeptides.com/product/retatrutide`, variant_key: "9999", product_url: "https://blankpeptides.com/product/retatrutide/" } as OfferRow);
    const store: FetchText = async (url) => {
      if (url.includes("parent=181")) return url.includes("page=2") ? { ...res(url, 503), state: "unknown" } : res(url, 200, variations);
      return url.includes("wc/store") ? res(url, 200, JSON.stringify(parent)) : res(url, 404);
    };
    const out = await ingestVendor(vendor, deps(repo, store));
    expect(out.rowsWritten).toBe(100);
    expect(out.quarantined).toEqual({});
    expect(out.undecided).toEqual({ variant_gone_unenumerated: 1 });
    expect(repo.offers.has("beyond")).toBe(true);
  });

  it("stored variants of a parent the run could not enumerate are kept even when they are filed under another compound", async () => {
    const { repo, vendor } = setup();
    // Parent 181 is listed, its variation list answers 404, and it has no price range to fall back on.
    const feed = JSON.stringify([
      wooProduct(),
      { id: 181, name: "Research Peptides", type: "variable", permalink: "https://blankpeptides.com/product/research/", is_in_stock: true, variations: [], prices: { price: "10500", currency_code: "USD", currency_minor_unit: 2, price_range: null } },
    ]);
    // Its variants were filed under GLOW by their LABEL on an earlier read — not under the parent's own key.
    repo.seedOffer({ id: "glow-variant", vendor_id: VENDOR_ID, compound_id: "c-glow", product_key: `${VENDOR_ID}:c-glow:blankpeptides.com/product/research`, variant_key: "1810", source_product_id: "181", source_variant_id: "1810", product_url: "https://blankpeptides.com/product/research/" } as OfferRow);
    const store: FetchText = async (url) => (url.includes("type=variation") ? res(url, 404) : url.includes("wc/store") ? res(url, 200, feed) : res(url, 404));
    const first = await ingestVendor(vendor, deps(repo, store));
    const second = await ingestVendor(vendor, deps(repo, store));
    expect(first.rowsWritten).toBe(1);
    expect(second.quarantined).toEqual({});
    expect(repo.quarantined).toEqual([]);
    expect(repo.offers.has("glow-variant")).toBe(true);
  });

  it("a page read cut short by a 429 is not a baseline either", async () => {
    const closed = vendorRow({ detected_platform: "woocommerce_closed_api" });
    const { repo } = setup(closed);
    for (const slug of ["a", "b", "c"]) repo.seedOffer({ id: `p-${slug}`, vendor_id: VENDOR_ID, compound_id: "c-reta", product_key: `k-${slug}`, variant_key: "", product_url: `https://blankpeptides.com/product/${slug}/` } as OfferRow);
    // CONTROL: every page answers — a hit, and a complete one.
    const whole = await ingestVendor(closed, deps(repo, async (url) => res(url, 200, PRODUCT_PAGE)));
    expect(whole.outcome).toBe("hit");
    expect([...repo.attempts.values()].at(-1)).toMatchObject({ outcome: "hit", run_complete: true });
    // One page answers, one says "too many requests", and the third is never asked: still a hit, not a complete one.
    const cut = await ingestVendor(closed, deps(repo, async (url) => (url.includes("/b/") ? res(url, 429) : res(url, 200, PRODUCT_PAGE))));
    expect(cut.outcome).toBe("hit");
    const attempt = [...repo.attempts.values()].at(-1);
    expect(attempt).toMatchObject({ outcome: "hit", run_complete: false });
    expect(attempt?.counts).toMatchObject({ catalogue_complete: false });
    expect(repo.quarantined).toEqual([]);
  });

  it("a dry run is not a baseline: it neither arms the SKU-drop guard nor counts as a first absence", async () => {
    const { repo, vendor } = setup();
    repo.runs.set("dry-run", { id: "dry-run", dry_run: true } as RunRow);
    repo.seedAttempt({ id: "dry-1", vendor_id: VENDOR_ID, run_id: "dry-run", outcome: "hit", run_complete: true, rows_written: 100, finished_at: "2026-09-30T00:00:00.000Z", counts: { missing_product_keys: ["k-old"] } } as unknown as AttemptRow);
    expect(await repo.lastCompleteHit(VENDOR_ID)).toBeNull();
    expect(await repo.previousAttempt(VENDOR_ID)).toBeNull();
    const out = await ingestVendor(vendor, deps(repo, blankStore));
    expect(out).toMatchObject({ outcome: "hit", held: false, rowsWritten: 4 });
  });

  it("a held vendor is released only by an explicit acceptance of the smaller catalogue", async () => {
    const { repo, vendor } = setup();
    repo.seedAttempt({ id: "prior", vendor_id: VENDOR_ID, run_id: "r0", outcome: "hit", run_complete: true, rows_written: 100, finished_at: "2026-09-30T00:00:00.000Z", counts: {} } as AttemptRow);
    expect((await ingestVendor(vendor, deps(repo, blankStore))).outcome).toBe("held");
    const released = await ingestVendor(vendor, deps(repo, blankStore, { acceptSkuDrop: true }));
    expect(released).toMatchObject({ outcome: "hit", held: false, rowsWritten: 4 });
    const attempt = [...repo.attempts.values()].at(-1);
    expect(attempt).toMatchObject({ run_complete: true, rows_written: 4 });
    expect(attempt?.counts).toMatchObject({ sku_drop_accepted: { built: 4, baseline: 100 } });
    // The accepted read is the new baseline: the next ordinary run is not held.
    expect((await ingestVendor(vendor, deps(repo, blankStore))).outcome).toBe("hit");
  });

  it("uses stored product URLs to route a closed-API vendor to the page rung, and marks a dead URL", async () => {
    const { repo } = setup(vendorRow({ detected_platform: "woocommerce_closed_api" }));
    const vendor = vendorRow({ detected_platform: "woocommerce_closed_api" });
    repo.seedOffer({ id: "o1", vendor_id: VENDOR_ID, compound_id: "c-reta", product_key: "k1", variant_key: "", product_url: "https://blankpeptides.com/product/gone/" } as OfferRow);
    const tried: string[] = [];
    const out = await ingestVendor(vendor, deps(repo, async (url) => {
      tried.push(url);
      return res(url, 404);
    }));
    expect(tried).toEqual(["https://blankpeptides.com/product/gone/"]);
    expect(out.outcome).toBe("miss");
    const attempt = [...repo.attempts.values()][0];
    expect((attempt.counts as { dead_urls?: string[] }).dead_urls).toEqual(["https://blankpeptides.com/product/gone/"]);
    expect(repo.quarantined).toEqual([]); // a MISS removes nothing
  });

  it("a repo failure on one row is that row's failure — the rest of the catalogue still lands", async () => {
    const { repo, vendor } = setup();
    repo.failUpsertFor = (row) => row.variant_label === "Size: 20mg";
    const out = await ingestVendor(vendor, deps(repo, blankStore));
    expect(out.rowsWritten).toBe(3);
    expect(out.rowFailures).toHaveLength(1);
    expect([...repo.attempts.values()][0]).toMatchObject({ outcome: "hit", run_complete: false });
  });

  it("files a blend under the blend with exactly its ingredients, with its mix; two ingredients that are no seeded blend are a candidate", async () => {
    const repo = new InMemoryRepo();
    const vendor = vendorRow();
    repo.seedVendor(vendor);
    const rows = [
      { id: "c-bpc", slug: "bpc-157", name: "BPC-157", aliases: [], type: "Single compound" },
      { id: "c-tb", slug: "tb-500", name: "TB-500", aliases: [], type: "Single compound" },
      { id: "c-ghrp", slug: "ghrp-2", name: "GHRP-2", aliases: [], type: "Single compound" },
      { id: "c-bt", slug: "bpc-157-tb-500", name: "BPC-157 + TB-500", aliases: ["Wolverine"], type: "Blend", blend_components: [{ slug: "bpc-157" }, { slug: "tb-500" }] },
    ] as unknown as CompoundRow[];
    for (const c of rows) repo.seedCompound(c);
    const products = buildProductIndex(rows.map((c) => ({ id: c.id, name: c.name, slug: c.slug, aliases: c.aliases, type: c.type, blend_components: c.blend_components as { slug: string }[] | null })));
    const feed = JSON.stringify([
      wooProduct({ id: 11, name: "BPC-157 10mg + TB-500 10mg", permalink: "https://blankpeptides.com/product/wolverine/", prices: { price: "6000", currency_code: "USD", currency_minor_unit: 2 } }),
      wooProduct({ id: 12, name: "BPC-157 + GHRP-2 10mg", permalink: "https://blankpeptides.com/product/odd/" }),
    ]);
    const store: FetchText = async (url) => (url.includes("wc/store") ? res(url, 200, feed) : res(url, 404));
    const out = await ingestVendor(vendor, deps(repo, store, { products, compoundsById: new Map(rows.map((c) => [c.id, c])) }));
    expect(out.rowsWritten).toBe(1);
    expect([...repo.offers.values()].map((o) => [o.compound_id, o.recipe_key, o.comparable, o.vials_per_pack])).toEqual([["c-bt", "bpc-157:10+tb-500:10", false, 1]]);
    expect(repo.candidates.map((c) => [c.product_name, c.reject_reason])).toEqual([["BPC-157 + GHRP-2 10mg", "no_compound_match"]]);
  });
});
