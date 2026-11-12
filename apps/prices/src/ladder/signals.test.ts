import { describe, expect, it } from "vitest";
import {
  extractJsonLdCurrency,
  extractJsonLdPricePairs,
  extractOgCurrency,
  extractOgPriceAmount,
  extractPageProductName,
  mapSchemaAvailability,
  pageCurrencySignal,
  slugifyLabel,
} from "./signals.ts";

describe("slugifyLabel", () => {
  it("lowercases, collapses runs of non-alphanumerics and trims", () => {
    expect(slugifyLabel("Size: 15 mg")).toBe("size-15-mg");
    expect(slugifyLabel("  10MG / Lyophilized ")).toBe("10mg-lyophilized");
    expect(slugifyLabel(null)).toBe("");
    expect(slugifyLabel("")).toBe("");
  });
});

describe("mapSchemaAvailability", () => {
  it("accepts the bare token, the schema.org URL and the schema: prefix", () => {
    expect(mapSchemaAvailability("InStock")).toBe("in_stock");
    expect(mapSchemaAvailability("https://schema.org/OutOfStock")).toBe("out_of_stock");
    expect(mapSchemaAvailability("schema:BackOrder")).toBe("backorder");
    expect(mapSchemaAvailability("http://schema.org/PreOrder")).toBe("preorder");
    expect(mapSchemaAvailability("https://schema.org/LimitedAvailability")).toBe("in_stock");
    expect(mapSchemaAvailability("https://schema.org/Discontinued")).toBe("out_of_stock");
  });
  it("an unrecognised value is unknown, never out_of_stock", () => {
    expect(mapSchemaAvailability("https://schema.org/SomethingNew")).toBe("unknown");
    expect(mapSchemaAvailability("")).toBe("unknown");
    expect(mapSchemaAvailability(undefined)).toBe("unknown");
  });
});

describe("og / JSON-LD currency signals", () => {
  it("reads product:price:currency and og:price:currency in either attribute order", () => {
    expect(extractOgCurrency('<meta property="product:price:currency" content="aud">')).toBe("AUD");
    expect(extractOgCurrency('<meta content="GBP" property="og:price:currency">')).toBe("GBP");
    expect(extractOgCurrency("<html></html>")).toBeNull();
  });
  it("reads the first priceCurrency in a JSON-LD block", () => {
    expect(extractJsonLdCurrency('<script type="application/ld+json">{"priceCurrency": "cad"}</script>')).toBe("CAD");
    expect(extractJsonLdCurrency("nope")).toBeNull();
  });
  it("reads a positive og price amount and never a zero", () => {
    expect(extractOgPriceAmount('<meta property="og:price:amount" content="49.95">')).toBe(49.95);
    expect(extractOgPriceAmount('<meta content="0" property="product:price:amount">')).toBeNull();
  });
  it("collects only ADJACENT (price, priceCurrency) pairs, both key orders", () => {
    const html =
      '{"price":"49.95","priceCurrency":"GBP"}' +
      '{"priceCurrency":"USD","price":63.4}' +
      '{"@type":"Product","name":"other","price":"12.00"}';
    expect(extractJsonLdPricePairs(html)).toEqual([
      { amount: 49.95, currency: "GBP" },
      { amount: 63.4, currency: "USD" },
    ]);
  });
});

describe("pageCurrencySignal", () => {
  const LD = '<script type="application/ld+json">{"priceCurrency":"USD"}</script>';
  it("og alone, jsonld alone, both agreeing, both disagreeing, none", () => {
    expect(pageCurrencySignal('<meta property="product:price:currency" content="GBP">')).toEqual({ currency: "GBP", evidence: "og_currency", reason: null });
    expect(pageCurrencySignal(LD)).toEqual({ currency: "USD", evidence: "jsonld_currency", reason: null });
    expect(pageCurrencySignal('<meta property="product:price:currency" content="USD">' + LD)).toEqual({ currency: "USD", evidence: "og_and_jsonld", reason: null });
    const conflict = pageCurrencySignal('<meta property="product:price:currency" content="GBP">' + LD);
    expect(conflict.currency).toBeNull();
    expect(conflict.reason).toMatch(/disagree \(og GBP vs jsonld USD\)/);
    expect(pageCurrencySignal("<html></html>").currency).toBeNull();
  });
});

describe("extractPageProductName", () => {
  it("prefers og:title, then <title> without the vendor suffix, then <h1>", () => {
    expect(extractPageProductName('<meta property="og:title" content="BPC-157 Peptide">')).toBe("BPC-157 Peptide");
    expect(extractPageProductName("<title>BPC-157 – Example Peptides</title>")).toBe("BPC-157");
    expect(extractPageProductName('<h1 class="product_title">TB-500</h1>')).toBe("TB-500");
  });
  it("returns null rather than a guess when the page names nothing", () => {
    expect(extractPageProductName("<html><body><p>hello</p></body></html>")).toBeNull();
    expect(extractPageProductName("")).toBeNull();
    expect(extractPageProductName(null)).toBeNull();
  });
});
