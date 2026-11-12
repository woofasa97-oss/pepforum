import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { FetchText } from "../fetch/types.ts";
import { validateAgainstRawText } from "./ladder.ts";
import { fetchShopifyProductJs, parseShopifyProductJs, parseShopifyProductsJson } from "./shopify.ts";

const fx = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
const PRODUCTS = fx("shopify-products.json");
const PRODUCT_JS = fx("shopify-product.js.json");

const shop = (variants: Record<string, unknown>[]) => JSON.stringify({ products: [{ id: 9001, title: "GHK-Cu", handle: "ghk-cu", variants }] });

const at = (status: number, body = ""): FetchText => async (url) => ({
  url,
  status,
  state: status === 200 ? "hit" : status === 404 || status === 410 ? "miss" : "unknown",
  body,
  fetchedAt: "2026-10-01T00:00:00.000Z",
});

describe("parseShopifyProductsJson", () => {
  it("reads products.json prices as major-unit strings, exactly", () => {
    const r = parseShopifyProductsJson(PRODUCTS, { baseUrl: "https://orosresearch.com" });
    expect(r.state).toBe("hit");
    expect(r.products.map((p) => p.priceMinor)).toEqual([16999, 5999]);
    expect(r.products[1]).toMatchObject({
      name: "Elora 5mg",
      productUrl: "https://orosresearch.com/products/elora-5mg",
      sourceSystem: "shopify",
      priceSource: "shopify_products_json",
      rawPriceText: "59.99",
      availability: "out_of_stock",
    });
  });

  it("emits one row per VARIANT with the variant title as the label", () => {
    const r = parseShopifyProductsJson(shop([{ id: 1, title: "50mg", price: "45.00", available: true }, { id: 2, title: "100mg", price: "80.00", available: true }]), { baseUrl: "https://s.example" });
    expect(r.products.map((p) => [p.name, p.variantLabel, p.priceMinor])).toEqual([
      ["GHK-Cu", "50mg", 4500],
      ["GHK-Cu", "100mg", 8000],
    ]);
  });

  it("leaves currency null rather than guessing USD", () => {
    expect(parseShopifyProductsJson(shop([{ title: "Default Title", price: "45.00", available: true }])).products[0].currency).toBeNull();
  });

  it("drops 'Default Title' as a label and EMITS an unavailable variant as out_of_stock", () => {
    const r = parseShopifyProductsJson(shop([{ id: 11, title: "Default Title", price: "45.00", available: true }, { id: 12, title: "100mg", price: "80.00", available: false }]));
    expect(r.products[0]).toMatchObject({ variantLabel: null, availability: "in_stock" });
    expect(r.products[1]).toMatchObject({ variantLabel: "100mg", availability: "out_of_stock" });
  });

  it("carries the variant contract: ids, options, list price", () => {
    const r = parseShopifyProductsJson(shop([{ id: 555, title: "50mg", option1: "50mg", option2: null, option3: null, price: "45.00", compare_at_price: "60.00", available: true }]), { baseUrl: "https://s.example" });
    expect(r.products[0]).toMatchObject({
      sourceProductId: "9001",
      sourceVariantId: "555",
      variantKey: "555",
      options: { option1: "50mg", option2: null, option3: null },
      listPriceMinor: 6000,
      onSale: true,
    });
  });

  it("reports rawCount and lastId — the since_id pagination signals", () => {
    const r = parseShopifyProductsJson(
      JSON.stringify({
        products: [
          { id: 1, title: "A", handle: "a", variants: [{ id: 1, title: "Default Title", price: "10.00", available: true }] },
          { id: 2, title: "B", handle: "b", variants: [{ id: 2, title: "Default Title", price: "20.00", available: true }] },
        ],
      }),
    );
    expect(r.rawCount).toBe(2);
    expect(r.lastId).toBe(2);
  });

  it("miss — not a throw — on non-product shapes", () => {
    expect(parseShopifyProductsJson("<html>").state).toBe("miss");
    expect(parseShopifyProductsJson('{"products":[]}').state).toBe("miss");
    expect(parseShopifyProductsJson('{"products":[{"foo":1}]}').state).toBe("miss");
  });
});

describe("parseShopifyProductJs — the .js feed is in MINOR units", () => {
  it("reads product .js prices as minor units and products.json prices as major-unit strings", () => {
    expect(parseShopifyProductJs(PRODUCT_JS, { productUrl: "https://orosresearch.com/products/elora-5mg" }).products[0].priceMinor).toBe(5999);
    expect(parseShopifyProductsJson(PRODUCTS, { baseUrl: "https://orosresearch.com" }).products[1].priceMinor).toBe(5999);
  });

  it("RECORDED FIXTURE: carries the product .js provenance and the variant contract", () => {
    const r = parseShopifyProductJs(PRODUCT_JS, { productUrl: "https://orosresearch.com/products/elora-5mg" });
    expect(r.state).toBe("hit");
    expect(r.products[0]).toMatchObject({
      name: "Elora 5mg",
      priceSource: "shopify_product_js",
      sourceSystem: "shopify",
      sourceProductId: "9632790282461",
      sourceVariantId: "48434342035677",
      variantKey: "48434342035677",
      variantLabel: null,
      availability: "out_of_stock",
      rawPriceText: "5999 (minor_unit=2)",
    });
    expect(validateAgainstRawText(r.products[0]).ok).toBe(true);
  });

  it("converts compare_at_price on the same scale", () => {
    const body = JSON.stringify({ id: 1, title: "BPC-157 5mg", handle: "bpc", variants: [{ id: 2, title: "Default Title", price: 4999, compare_at_price: 6999, available: true }] });
    expect(parseShopifyProductJs(body, { productUrl: "https://x.test/products/bpc" }).products[0]).toMatchObject({ priceMinor: 4999, listPriceMinor: 6999, onSale: true });
  });

  it("miss — not a throw — on a page that is not a product .js", () => {
    expect(parseShopifyProductJs("<html>404</html>").state).toBe("miss");
    expect(parseShopifyProductJs("{}").state).toBe("miss");
  });

  it("three-state on fetch: 403 unknown, 404 miss + dead, 200 hit", async () => {
    expect((await fetchShopifyProductJs("https://x.test/products/y", at(403))).state).toBe("unknown");
    const gone = await fetchShopifyProductJs("https://x.test/products/y", at(404));
    expect(gone.state).toBe("miss");
    expect(gone.dead).toBe(true);
    expect((await fetchShopifyProductJs("https://x.test/products/y", at(200, PRODUCT_JS))).state).toBe("hit");
  });

  it("builds the .js URL from the page URL, stripping query and trailing slash", async () => {
    const tried: string[] = [];
    await fetchShopifyProductJs("https://x.test/products/y/?variant=123", async (url) => {
      tried.push(url);
      return at(200, PRODUCT_JS)(url);
    });
    expect(tried).toEqual(["https://x.test/products/y.js"]);
  });
});
