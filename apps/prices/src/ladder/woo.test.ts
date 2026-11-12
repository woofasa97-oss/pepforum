import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { FetchResult, FetchText } from "../fetch/types.ts";
import { validateAgainstRawText, withCanonicalQuantity } from "./ladder.ts";
import {
  fetchWooEmbeddedVariations,
  parseWooEmbeddedVariations,
  parseWooStoreApi,
  parseWooStoreVariations,
  wooVariableParentFallback,
} from "./woo.ts";

const fx = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
const VARIABLE = fx("woo-store-products-variable.json");
const VARIATIONS_181 = fx("woo-store-variations-parent-181.json");
const VARIATION_182 = fx("woo-store-variation-182.json");
const SIMPLE = fx("woo-store-products-simple.json");
const PAGE = fx("woo-product-page-handbuilt.html");
const PRODUCT_URL = "https://woo.example/product/bpc-157/";

const wooProduct = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: "BPC-157 10mg",
  permalink: "https://v.example/product/bpc-157-10mg/",
  is_purchasable: true,
  prices: { price: "5999", currency_code: "USD", currency_minor_unit: 2 },
  ...over,
});

const at = (status: number, body = ""): FetchText => async (url) => ({
  url,
  status,
  state: status === 200 ? "hit" : status === 404 || status === 410 || status === 401 ? "miss" : "unknown",
  body,
  fetchedAt: "2026-10-01T00:00:00.000Z",
});
const rejecting: FetchText = async (url): Promise<FetchResult> => ({ url, status: null, state: "unknown", body: null, fetchedAt: "2026-10-01T00:00:00.000Z", error: "ECONNRESET" });

describe("parseWooStoreApi", () => {
  it("keeps the vendor's minor units exactly and carries currency + permalink", () => {
    const r = parseWooStoreApi(JSON.stringify([wooProduct()]), { baseUrl: "https://v.example" });
    expect(r.state).toBe("hit");
    expect(r.products[0]).toMatchObject({
      name: "BPC-157 10mg",
      priceMinor: 5999,
      currency: "USD",
      productUrl: "https://v.example/product/bpc-157-10mg/",
      sourceSystem: "woocommerce",
      priceSource: "woo_store_api",
      rawPriceText: "USD5999 (minor_unit=2)",
    });
  });

  it("honours a non-2 currency_minor_unit rather than assuming cents", () => {
    // JPY is minor_unit 0: 5000 stays 5000 minor units, never ÷100.
    const r = parseWooStoreApi(JSON.stringify([wooProduct({ prices: { price: "5000", currency_code: "JPY", currency_minor_unit: 0 } })]));
    expect(r.products[0].priceMinor).toBe(5000);
    // A store declaring 3 minor digits for a 2-digit currency is rescaled exactly, half-even.
    const r3 = parseWooStoreApi(JSON.stringify([wooProduct({ prices: { price: "59995", currency_code: "USD", currency_minor_unit: 3 } })]));
    expect(r3.products[0].priceMinor).toBe(6000);
  });

  it("does NOT set a quantity — that belongs to withCanonicalQuantity", () => {
    const p = parseWooStoreApi(JSON.stringify([wooProduct()])).products[0];
    expect(p.quantity).toBeUndefined();
  });

  it("drops an unpriced entry but EMITS an unpurchasable one with its availability", () => {
    const r = parseWooStoreApi(
      JSON.stringify([
        wooProduct({ is_purchasable: false, is_in_stock: false }),
        wooProduct({ id: 2, prices: { price: "0", currency_code: "USD", currency_minor_unit: 2 } }),
        wooProduct({ id: 3, name: "TB-500 5mg", is_in_stock: true }),
      ]),
    );
    expect(r.products.map((p) => [p.name, p.availability])).toEqual([
      ["BPC-157 10mg", "out_of_stock"],
      ["TB-500 5mg", "in_stock"],
    ]);
  });

  it("a zero price is still a drop — no price is not a product", () => {
    const r = parseWooStoreApi(JSON.stringify([wooProduct({ prices: { price: "0", currency_code: "USD", currency_minor_unit: 2 } })]));
    expect(r.state).toBe("miss");
    expect(r.products).toHaveLength(0);
  });

  it("a missing is_in_stock is unknown availability, never out_of_stock; backorder is its own state", () => {
    expect(parseWooStoreApi(JSON.stringify([wooProduct()])).products[0].availability).toBe("unknown");
    expect(parseWooStoreApi(JSON.stringify([wooProduct({ is_in_stock: false, is_on_backorder: true })])).products[0].availability).toBe("backorder");
  });

  it("carries the variant contract for a SIMPLE product: variantKey is the empty string", () => {
    const p = parseWooStoreApi(JSON.stringify([wooProduct({ id: 77, is_in_stock: true })])).products[0];
    expect(p).toMatchObject({ sourceProductId: "77", sourceVariantId: null, variantKey: "", variantLabel: null, options: null, fallbackRange: null });
  });

  it("reads regular_price as a list price ONLY when it is strictly higher", () => {
    const onSale = parseWooStoreApi(JSON.stringify([wooProduct({ prices: { price: "5999", regular_price: "7999", currency_code: "USD", currency_minor_unit: 2 } })])).products[0];
    expect(onSale).toMatchObject({ listPriceMinor: 7999, onSale: true });
    const equal = parseWooStoreApi(JSON.stringify([wooProduct({ prices: { price: "5999", regular_price: "5999", currency_code: "USD", currency_minor_unit: 2 } })])).products[0];
    expect(equal).toMatchObject({ listPriceMinor: null, onSale: false });
    expect(parseWooStoreApi(JSON.stringify([wooProduct()])).products[0]).toMatchObject({ listPriceMinor: null, onSale: false });
  });

  it("reports miss — not a throw — on every non-product shape", () => {
    expect(parseWooStoreApi("<html>WAF</html>").state).toBe("miss");
    expect(parseWooStoreApi("[]").state).toBe("miss");
    expect(parseWooStoreApi('{"products":[]}').state).toBe("miss");
    expect(parseWooStoreApi(JSON.stringify([{ foo: 1 }])).state).toBe("miss");
  });

  it("routes a variable product to `variable`, never to `products`, and a variable-only payload is a hit", () => {
    const r = parseWooStoreApi(VARIABLE, { baseUrl: "https://blankpeptides.com" });
    expect(r.state).toBe("hit");
    expect(r.products).toHaveLength(0);
    expect(r.variable.map((p) => p.id)).toEqual([181, 286]);
    expect(r.variable[0].priceRange).toMatchObject({ minAmount: "10500", maxAmount: "23900" });
    // Parent 286 (GLOW) is variable with price_range null; its own price is carried for the fallback.
    expect(r.variable[1].priceRange).toBeNull();
    expect(r.variable[1].price).toBe("12500");
    expect(r.rawCount).toBe(2);
  });

  it("the recorded SIMPLE feed is a miss for price, not for shape — all three are priced 0", () => {
    const r = parseWooStoreApi(SIMPLE, { baseUrl: "https://blankpeptides.com" });
    expect(r.state).toBe("miss");
    expect(r.reason).toBe("no purchasable priced products");
    expect(r.rawCount).toBe(3);
  });
});

describe("Store API text is rendered HTML — names and labels are decoded to what the page shows", () => {
  it("decodes numeric, hex and the common named entities in simple-product names", () => {
    const r = parseWooStoreApi(
      JSON.stringify([
        wooProduct({ name: "BPC-157 500mcg &#8211; 60 units" }),
        wooProduct({ id: 2, name: "VARAE&#8217;/GHK-Cu Shampoo" }),
        wooProduct({ id: 3, name: "Selank &amp; Semax &#x2013; 10mg&nbsp;vial" }),
      ]),
    );
    expect(r.products.map((p) => p.name)).toEqual(["BPC-157 500mcg – 60 units", "VARAE’/GHK-Cu Shampoo", "Selank & Semax – 10mg vial"]);
  });

  it("decodes variable-parent names and variation attribute labels", () => {
    const parents = parseWooStoreApi(JSON.stringify([wooProduct({ id: 9, type: "variable", name: "Retatrutide &#8211; Research", variations: [{ id: 91, attributes: [{ name: "Size &amp; Form", value: "10mg &#8211; vial" }] }] })]));
    expect(parents.variable[0].name).toBe("Retatrutide – Research");
    const rows = parseWooStoreVariations(JSON.stringify([{ id: 91, prices: { price: "5999", currency_code: "USD", currency_minor_unit: 2 }, is_in_stock: true }]), { parent: parents.variable[0] });
    expect(rows.products[0]).toMatchObject({ name: "Retatrutide – Research", variantLabel: "Size & Form: 10mg – vial" });
  });
});

describe("parseWooStoreVariations — the recorded fixtures", () => {
  const parents = () => parseWooStoreApi(VARIABLE, { baseUrl: "https://blankpeptides.com" }).variable;

  it("emits one product per variation with its own label, price and stock", () => {
    const r = parseWooStoreVariations(VARIATIONS_181, { parent: parents()[0] });
    expect(r.state).toBe("hit");
    expect(r.products.map((p) => p.priceMinor)).toEqual([11900, 15900, 10500, 23900]);
    expect(r.products.map((p) => p.variantKey)).toEqual(["4649", "1179", "182", "1979"]);
    expect(new Set(r.products.map((p) => p.sourceVariantId)).size).toBe(4);
    expect(r.products.map((p) => p.variantLabel)).toEqual(["Size: 15mg", "Size: 20mg", "Size: 10mg", "Size: 30mg"]);
    expect(r.products.every((p) => p.sourceProductId === "181" && p.name === "RETATRUTIDE")).toBe(true);
  });

  it("emits out-of-stock products with availability out_of_stock, never dropping them", () => {
    const r = parseWooStoreVariations(VARIATIONS_181, { parent: parents()[0] });
    expect(r.products[1].availability).toBe("out_of_stock");
    expect(r.products.filter((p) => p.availability === "in_stock")).toHaveLength(3);
  });

  it("productUrl is the PARENT permalink — never the variation URL with its query string", () => {
    const r = parseWooStoreVariations(VARIATIONS_181, { parent: parents()[0] });
    expect(new Set(r.products.map((p) => p.productUrl))).toEqual(new Set(["https://blankpeptides.com/product/retatrutide/"]));
  });

  it("options fall back to the PARENT's attributes — this store sends attributes: []", () => {
    const r = parseWooStoreVariations(VARIATIONS_181, { parent: parents()[0] });
    expect(r.products.find((p) => p.variantKey === "182")?.options).toEqual([{ name: "Size", value: "10mg" }]);
    const orphan = parseWooStoreVariations(VARIATIONS_181, { parent: { ...parents()[0], variations: [] } });
    expect(orphan.products[0].options).toBeNull();
  });

  it("the quantity owners resolve mg from name + variantLabel", () => {
    const q = withCanonicalQuantity(parseWooStoreVariations(VARIATIONS_181, { parent: parents()[0] }).products);
    expect(q.map((p) => (p.quantity?.reason === null ? p.quantity.totalMg : p.quantity?.reason))).toEqual([15, 20, 10, 30]);
  });

  it("the per-id fallback shape (a bare object, not an array) parses identically", () => {
    const r = parseWooStoreVariations(VARIATION_182, { parent: parents()[0] });
    expect(r.state).toBe("hit");
    expect(r.products[0]).toMatchObject({ variantKey: "182", priceMinor: 10500, variantLabel: "Size: 10mg" });
  });

  it("its rows pass the shared raw-text validator", () => {
    for (const p of parseWooStoreVariations(VARIATIONS_181, { parent: parents()[0] }).products) {
      expect(validateAgainstRawText(p).ok, p.variantKey).toBe(true);
    }
  });
});

describe("wooVariableParentFallback", () => {
  it("carries the range with NO price — a range is not a price", () => {
    const [reta, glow] = parseWooStoreApi(VARIABLE, { baseUrl: "https://blankpeptides.com" }).variable;
    expect(wooVariableParentFallback(reta, { fetchUrl: "u" })).toMatchObject({
      priceMinor: null,
      fallbackRange: { minMinor: 10500, maxMinor: 23900 },
      variantKey: "",
      sourceVariantId: null,
      sourceProductId: "181",
    });
    expect(wooVariableParentFallback(glow, { fetchUrl: "u" })?.fallbackRange).toEqual({ minMinor: 12500, maxMinor: null });
    expect(wooVariableParentFallback({ ...glow, price: "0", priceRange: null }, { fetchUrl: "u" })).toBeNull();
  });
});

describe("parseWooEmbeddedVariations — HAND-BUILT page mirroring WooCommerce variable.php", () => {
  const pageWith = (payload: unknown, extraHead = "") => {
    const json = typeof payload === "string" ? payload : JSON.stringify(payload);
    const encoded = json.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    return `<html><head>${extraHead}<meta property="og:title" content="BPC-157"></head><body><form class="variations_form cart" data-product_id="123" data-product_variations="${encoded}"></form></body></html>`;
  };

  it("reads both variations, their ids, prices, labels and stock", () => {
    const r = parseWooEmbeddedVariations(PAGE, { productUrl: PRODUCT_URL });
    expect(r.state).toBe("hit");
    expect(r.products).toHaveLength(2);
    expect(r.products[0]).toMatchObject({
      name: "BPC-157",
      variantLabel: "Size: 5mg",
      priceMinor: 4999,
      sourceSystem: "woocommerce",
      priceSource: "woo_embedded_variations",
      sourceProductId: "123",
      sourceVariantId: "456",
      variantKey: "456",
      availability: "in_stock",
      productUrl: PRODUCT_URL,
      rawPriceText: "49.99",
    });
    expect(r.products[1]).toMatchObject({ variantLabel: "Size: 10mg", priceMinor: 8999, availability: "out_of_stock" });
  });

  it("reads the sale pair: display_regular_price above display_price is the list price", () => {
    const r = parseWooEmbeddedVariations(PAGE, { productUrl: PRODUCT_URL });
    expect(r.products[0]).toMatchObject({ listPriceMinor: 6999, onSale: true });
    expect(r.products[1]).toMatchObject({ listPriceMinor: null, onSale: false });
  });

  it("carries `options` verbatim and joins a multi-axis label, dropping an empty ('any') axis", () => {
    const r = parseWooEmbeddedVariations(PAGE, { productUrl: PRODUCT_URL });
    expect(r.products[0].options).toEqual({ attribute_pa_size: "5mg" });
    const multi = parseWooEmbeddedVariations(
      pageWith([{ variation_id: 1, attributes: { attribute_pa_size: "5mg", attribute_form: "Lyophilized", attribute_colour: "" }, display_price: 10, is_in_stock: true }]),
      { productUrl: PRODUCT_URL },
    );
    expect(multi.products[0].variantLabel).toBe("Size: 5mg, Form: Lyophilized");
  });

  it("currency comes from the PAGE's own og / JSON-LD declaration — and stays null when the page states none", () => {
    const bare = parseWooEmbeddedVariations(PAGE, { productUrl: PRODUCT_URL });
    expect(bare.products.every((p) => p.currency === null && p.currencyEvidence === null)).toBe(true);
    const og = parseWooEmbeddedVariations('<meta property="product:price:currency" content="GBP">' + PAGE, { productUrl: PRODUCT_URL });
    expect(og.products.every((p) => p.currency === "GBP" && p.currencyEvidence === "og_currency")).toBe(true);
  });

  it("an og AMOUNT on the page must match a variation price, or the currency claim is withdrawn", () => {
    const head = (amount: string) => `<meta property="product:price:currency" content="USD"><meta property="product:price:amount" content="${amount}">`;
    const agree = parseWooEmbeddedVariations(head("49.99") + PAGE, { productUrl: PRODUCT_URL });
    expect(agree.products.every((p) => p.currency === "USD")).toBe(true);
    const disagree = parseWooEmbeddedVariations(head("12.34") + PAGE, { productUrl: PRODUCT_URL });
    expect(disagree.state).toBe("hit");
    expect(disagree.products.every((p) => p.currency === null && p.currencyEvidence === null)).toBe(true);
  });

  it("the `false` sentinel is a miss WITH A REASON, never an empty catalogue", () => {
    const r = parseWooEmbeddedVariations(pageWith("false"), { productUrl: PRODUCT_URL });
    expect(r.state).toBe("miss");
    expect(r.reason).toBe("variations deferred (false sentinel)");
  });

  it("miss — not a throw — on no form, malformed JSON, an empty array, and empty input", () => {
    expect(parseWooEmbeddedVariations("<html>no form</html>", {}).reason).toBe("no form.variations_form on the page");
    expect(parseWooEmbeddedVariations(pageWith("[{oops"), {}).state).toBe("miss");
    expect(parseWooEmbeddedVariations(pageWith([]), {}).reason).toBe("data-product_variations is an empty array");
    expect(parseWooEmbeddedVariations("", {}).state).toBe("miss");
  });

  it("drops a DISABLED variation but EMITS an unpurchasable one; a zero display_price is dropped", () => {
    const r = parseWooEmbeddedVariations(
      pageWith([
        { variation_id: 1, attributes: { attribute_size: "5mg" }, display_price: 10, variation_is_active: false, is_in_stock: true },
        { variation_id: 2, attributes: { attribute_size: "10mg" }, display_price: 20, is_purchasable: false, is_in_stock: true },
        { variation_id: 3, attributes: { attribute_size: "20mg" }, display_price: 0, is_in_stock: true },
      ]),
      { productUrl: PRODUCT_URL },
    );
    expect(r.products.map((p) => p.variantKey)).toEqual(["2"]);
  });

  it("decodes &amp; last, so a literal &quot; in the vendor data does not corrupt the JSON", () => {
    const r = parseWooEmbeddedVariations(
      pageWith([{ variation_id: 9, attributes: { attribute_size: 'A&B "5mg"' }, display_price: 10, is_in_stock: true }]),
      { productUrl: PRODUCT_URL },
    );
    expect(r.state).toBe("hit");
    expect(r.products[0].options).toEqual({ attribute_size: 'A&B "5mg"' });
  });

  it("its rows pass the shared raw-text validator and resolve mg from name + label", () => {
    const r = parseWooEmbeddedVariations(PAGE, { productUrl: PRODUCT_URL });
    for (const p of r.products) expect(validateAgainstRawText(p).ok, p.variantKey).toBe(true);
    expect(withCanonicalQuantity(r.products).map((p) => (p.quantity?.reason === null ? p.quantity.totalMg : null))).toEqual([5, 10]);
  });
});

describe("fetchWooEmbeddedVariations — three-state", () => {
  it("200 with the form is a hit; 403/429/5xx/202 unknown; 404/410 miss + dead; a rejection unknown", async () => {
    expect((await fetchWooEmbeddedVariations(PRODUCT_URL, at(200, PAGE))).state).toBe("hit");
    for (const s of [403, 429, 500, 503, 202]) expect((await fetchWooEmbeddedVariations(PRODUCT_URL, at(s, "<html>queue</html>"))).state, `http ${s}`).toBe("unknown");
    for (const s of [404, 410]) {
      const r = await fetchWooEmbeddedVariations(PRODUCT_URL, at(s));
      expect(r.state, `http ${s}`).toBe("miss");
      expect(r.dead, `http ${s}`).toBe(true);
    }
    expect((await fetchWooEmbeddedVariations(PRODUCT_URL, at(403))).dead).toBeUndefined();
    expect((await fetchWooEmbeddedVariations(PRODUCT_URL, rejecting)).state).toBe("unknown");
  });
});
