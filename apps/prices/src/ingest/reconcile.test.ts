import { describe, expect, it } from "vitest";
import { decideQuarantine, MAX_MISSING_PRODUCT_KEYS, REASON_PRECEDENCE, skuKey } from "./reconcile.ts";
import type { OfferInsert, OfferRow } from "./repo.ts";

type StoredOver = Partial<OfferRow> & { id: string };
const stored = (over: StoredOver): OfferRow =>
  ({ product_key: "v:c:site/p", variant_key: "", product_url: "https://site/p", source_product_id: null, source_variant_id: null, ...over }) as OfferRow;
const emitted = (over: Partial<OfferInsert> = {}): OfferInsert =>
  ({ product_key: "v:c:site/p", variant_key: "", product_url: "https://site/p", source_product_id: null, source_variant_id: null, ...over }) as OfferInsert;

const decide = (args: Partial<Parameters<typeof decideQuarantine>[0]>) =>
  decideQuarantine({ ladderState: "hit", stored: [], emitted: [], fullCatalogue: true, degradedProductKeys: [], deadUrlsThisRun: [], priorDeadUrls: [], priorMissingProductKeys: [], ...args });

describe("decideQuarantine — what a successful fetch licenses removing", () => {
  it("returns nothing unless the ladder state is hit", () => {
    const rows = [stored({ id: "a", product_key: "v:c:gone" })];
    expect(decide({ ladderState: "unknown", stored: rows, priorMissingProductKeys: ["v:c:gone"] }).batches).toEqual([]);
    expect(decide({ ladderState: "miss", stored: rows, priorMissingProductKeys: ["v:c:gone"] }).batches).toEqual([]);
  });

  it("duplicate_url: one platform SKU under two product_keys — the emitted row names the keeper", () => {
    const rows = [stored({ id: "old", product_key: "v:c:site/old-url", source_product_id: "9" }), stored({ id: "new", product_key: "v:c:site/p", source_product_id: "9" })];
    const d = decide({ stored: rows, emitted: [emitted({ source_product_id: "9" })] });
    expect(d.batches).toEqual([{ reason: "duplicate_url", ids: ["old"] }]);
    // No emitted row names the SKU → undecided, nothing quarantined.
    const u = decide({ stored: rows, emitted: [emitted({ product_key: "v:c:site/other", source_product_id: "10" })] });
    expect(u.batches.find((b) => b.reason === "duplicate_url")).toBeUndefined();
    expect(u.undecided.duplicate_url_unresolved).toBe(2);
  });

  it("superseded_by_variants: the whole-product row of a product that now yields variant rows", () => {
    const d = decide({ stored: [stored({ id: "whole" })], emitted: [emitted({ variant_key: "1" }), emitted({ variant_key: "2" })] });
    expect(d.batches).toEqual([{ reason: "superseded_by_variants", ids: ["whole"] }]);
  });

  it("variant_gone: a stored variant absent from a product the run READ — but not from a degraded (fallback) product", () => {
    const rows = [stored({ id: "v1", variant_key: "1" }), stored({ id: "v2", variant_key: "2" })];
    const d = decide({ stored: rows, emitted: [emitted({ variant_key: "1" })] });
    expect(d.batches).toEqual([{ reason: "variant_gone", ids: ["v2"] }]);
    const degraded = decide({ stored: rows, emitted: [emitted({ variant_key: "1" })], degradedProductKeys: ["v:c:site/p"] });
    expect(degraded.batches).toEqual([]);
    expect(degraded.undecided.variant_gone_unenumerated).toBe(2);
    // A product with NO emitted rows was absent, which is delisted's question, not variant_gone's.
    expect(decide({ stored: rows, emitted: [emitted({ product_key: "v:c:site/other" })] }).batches.find((b) => b.reason === "variant_gone")).toBeUndefined();
  });

  it("a degraded product with no emitted rows was seen, not absent: never carried as missing, never delisted", () => {
    const rows = [stored({ id: "v1", variant_key: "1" }), stored({ id: "whole", product_key: "v:c:site/q" })];
    const d = decide({
      stored: rows,
      emitted: [emitted({ product_key: "v:c:site/other" })],
      degradedProductKeys: ["v:c:site/p", "v:c:site/q"],
      priorMissingProductKeys: ["v:c:site/p", "v:c:site/q"],
    });
    expect(d.batches).toEqual([]);
    expect(d.missingProductKeys).toEqual([]);
    expect(d.undecided.variant_gone_unenumerated).toBe(1);
  });

  it("dead_url: two consecutive 404/410s on the same URL", () => {
    const rows = [stored({ id: "d", product_url: "https://site/dead" })];
    expect(decide({ stored: rows, emitted: [emitted()], deadUrlsThisRun: ["https://site/dead"], priorDeadUrls: [] }).batches).toEqual([]);
    expect(decide({ stored: rows, emitted: [emitted()], deadUrlsThisRun: ["https://site/dead"], priorDeadUrls: ["https://site/dead"] }).batches).toEqual([{ reason: "dead_url", ids: ["d"] }]);
  });

  it("delists only after two consecutive complete hits without the SKU, only from a full-catalogue read, and only if this run emitted rows", () => {
    const rows = [stored({ id: "g", product_key: "v:c:site/gone" })];
    const first = decide({ stored: rows, emitted: [emitted()] });
    expect(first.batches).toEqual([]);
    expect(first.missingProductKeys).toEqual(["v:c:site/gone"]);
    const second = decide({ stored: rows, emitted: [emitted()], priorMissingProductKeys: first.missingProductKeys });
    expect(second.batches).toEqual([{ reason: "delisted", ids: ["g"] }]);
    // A page rung cannot say a product is absent from a catalogue it never read.
    expect(decide({ stored: rows, emitted: [emitted()], fullCatalogue: false, priorMissingProductKeys: ["v:c:site/gone"] }).batches).toEqual([]);
    // A successful read that emitted NOTHING cannot delist anything.
    const empty = decide({ stored: rows, emitted: [], priorMissingProductKeys: ["v:c:site/gone"] });
    expect(empty.batches).toEqual([]);
    expect(empty.missingProductKeys).toEqual([]);
  });

  it("carries a SORTED, bounded missing list and says when it truncated", () => {
    const rows = Array.from({ length: MAX_MISSING_PRODUCT_KEYS + 5 }, (_, i) => stored({ id: `r${i}`, product_key: `v:c:site/p${String(i).padStart(4, "0")}` }));
    const d = decide({ stored: rows, emitted: [emitted({ product_key: "v:c:site/present" })] });
    expect(d.missingProductKeys).toHaveLength(MAX_MISSING_PRODUCT_KEYS);
    expect(d.missingKeysTruncated).toBe(true);
    expect([...d.missingProductKeys]).toEqual([...d.missingProductKeys].sort());
  });

  it("every row lands in at most one batch, by precedence", () => {
    // A whole-product row whose product gained variants AND whose URL died twice: superseded wins.
    const rows = [stored({ id: "x", product_url: "https://site/dead" })];
    const d = decide({ stored: rows, emitted: [emitted({ variant_key: "1" })], deadUrlsThisRun: ["https://site/dead"], priorDeadUrls: ["https://site/dead"] });
    expect(d.batches).toEqual([{ reason: "superseded_by_variants", ids: ["x"] }]);
    expect(REASON_PRECEDENCE).toEqual(["duplicate_url", "superseded_by_variants", "variant_gone", "dead_url", "delisted"]);
  });

  it("skuKey spells the platform-SKU index: coalesce(source_variant_id, '')", () => {
    expect(skuKey({ source_product_id: "9", source_variant_id: null })).toBe("9|");
    expect(skuKey({ source_product_id: "9", source_variant_id: "1" })).toBe("9|1");
    expect(skuKey({ source_product_id: null, source_variant_id: "1" })).toBeNull();
  });
});
