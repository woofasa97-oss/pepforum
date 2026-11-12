import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { FetchResult, FetchText } from "../fetch/types.ts";
import { normalizeStructuredCode, resolveCurrency, resolveShopifyStoreCurrency, SUPPORTED_CURRENCIES } from "./currency.ts";
import type { Product } from "./types.ts";

const META = readFileSync(new URL("./__fixtures__/shopify-meta.json", import.meta.url), "utf8");

const res = (url: string, status: number, body = ""): FetchResult => ({
  url,
  status,
  state: status === 200 ? "hit" : status === 403 || status === 429 || status >= 500 || (status > 200 && status < 300) ? "unknown" : "miss",
  body,
  fetchedAt: "2026-10-01T00:00:00.000Z",
});
const failed = (url: string): FetchResult => ({ url, status: null, state: "unknown", body: null, fetchedAt: "2026-10-01T00:00:00.000Z", error: "socket hang up" });

const anchor = (over: Partial<Product> = {}): Product => ({
  name: "GHK-Cu",
  variantLabel: null,
  productUrl: "https://s.example/products/ghk-cu",
  fetchUrl: "https://s.example/products.json",
  sourceSystem: "shopify",
  priceSource: "shopify_products_json",
  sourceProductId: "1",
  sourceVariantId: "2",
  variantKey: "2",
  options: null,
  currency: null,
  currencyEvidence: null,
  priceMinor: 4995,
  listPriceMinor: null,
  onSale: false,
  availability: "in_stock",
  rawPriceText: "49.95",
  fallbackRange: null,
  ...over,
});

describe("resolveCurrency — vendor-authored structured signals only", () => {
  it("ranks woo above og above jsonld and normalises the code", () => {
    expect(resolveCurrency({ wooCurrencyCode: "usd", ogCurrency: "GBP" })).toEqual({ currency: "USD", source: "woo" });
    expect(resolveCurrency({ ogCurrency: "gbp", jsonLdCurrency: "USD" })).toEqual({ currency: "GBP", source: "og" });
    expect(resolveCurrency({ jsonLdCurrency: "CAD" })).toEqual({ currency: "CAD", source: "jsonld" });
  });
  it("never guesses: nothing structured means unresolved, and an unsupported currency is not adopted", () => {
    expect(resolveCurrency({})).toEqual({ currency: null, source: "unresolved" });
    expect(resolveCurrency({ wooCurrencyCode: "JPY" })).toEqual({ currency: null, source: "unresolved" });
    expect(normalizeStructuredCode("xyz")).toBeNull();
    expect([...SUPPORTED_CURRENCIES].sort()).toEqual(["AUD", "CAD", "EUR", "GBP", "NZD", "USD"]);
  });
});

describe("resolveShopifyStoreCurrency", () => {
  it("with no anchor URL there is nothing to fetch — refuses without a network call", async () => {
    const r = await resolveShopifyStoreCurrency([anchor({ productUrl: null })], async () => {
      throw new Error("must not be called");
    });
    expect(r.currency).toBeNull();
    expect(r.reason).toContain("no anchor");
  });

  it("RECORDED FIXTURE: adopts the store's own /meta.json declaration and never fetches the anchor page", async () => {
    const tried: string[] = [];
    const fetchText: FetchText = async (url) => {
      tried.push(url);
      return url.endsWith("/meta.json") ? res(url, 200, META) : res(url, 200, "<html>anchor</html>");
    };
    const r = await resolveShopifyStoreCurrency([anchor({ productUrl: "https://orosresearch.com/products/elora-5mg" })], fetchText);
    expect(r).toMatchObject({ currency: "USD", evidence: "meta_json", url: "https://orosresearch.com/meta.json", status: 200 });
    expect(tried).toEqual(["https://orosresearch.com/meta.json"]);
    expect(r.meta).toBeNull();
  });

  it("a 200 /meta.json without a 3-letter currency is not an adoption and rides along as `meta`", async () => {
    const fetchText: FetchText = async (url) =>
      url.endsWith("/meta.json") ? res(url, 200, JSON.stringify({ name: "Shop", currency: "" })) : res(url, 200, "<html>no signals</html>");
    const r = await resolveShopifyStoreCurrency([anchor()], fetchText);
    expect(r.currency).toBeNull();
    expect(r.meta?.reason).toContain("no 3-letter currency");
    expect(r.meta?.status).toBe(200);
  });

  const withAnchorPage = (html: string, tried: string[] = []): FetchText => async (url) => {
    tried.push(url);
    if (url.endsWith("/meta.json")) return res(url, 404);
    return res(url, 200, html);
  };

  it("adopts the og pair currency when the page amount equals the feed amount", async () => {
    const r = await resolveShopifyStoreCurrency([anchor()], withAnchorPage('<meta property="og:price:amount" content="49.95"><meta property="og:price:currency" content="GBP">'));
    expect(r).toMatchObject({ currency: "GBP", evidence: "og_pair", status: 200 });
    expect(r.meta).toMatchObject({ status: 404 });
  });

  it("REFUSES on an og amount mismatch — the presentment signature — without consulting JSON-LD", async () => {
    const presentment =
      '<meta property="og:price:amount" content="63.40"><meta property="og:price:currency" content="USD">' +
      '<script type="application/ld+json">{"@type":"Offer","price":"49.95","priceCurrency":"USD"}</script>';
    const r = await resolveShopifyStoreCurrency([anchor()], withAnchorPage(presentment));
    expect(r.currency).toBeNull();
    expect(r.reason).toContain("presentment");
  });

  it("falls back to a matching JSON-LD pair when the page has no og pair; two matching pairs that disagree refuse", async () => {
    const ld = await resolveShopifyStoreCurrency([anchor()], withAnchorPage('<script type="application/ld+json">{"@type":"Offer","priceCurrency":"GBP","price":"49.95"}</script>'));
    expect(ld).toMatchObject({ currency: "GBP", evidence: "jsonld_pair" });
    const conflict = await resolveShopifyStoreCurrency(
      [anchor()],
      withAnchorPage('{"price":"49.95","priceCurrency":"GBP"}{"price":"49.95","priceCurrency":"USD"}'),
    );
    expect(conflict.currency).toBeNull();
    expect(conflict.reason).toContain("conflicting");
  });

  it("an UNPAIRED amount cannot donate a currency — the related-products-carousel shape", async () => {
    const html =
      '<script type="application/ld+json">{"@type":"Product","name":"other","price":"49.95"}</script>' +
      '<script type="application/ld+json">{"@type":"Offer","price":"63.40","priceCurrency":"USD"}</script>';
    const r = await resolveShopifyStoreCurrency([anchor()], withAnchorPage(html));
    expect(r.currency).toBeNull();
    expect(r.reason).toContain("no page pair matches");
  });

  it("og pair MATCHES but jsonld money is ×100,000 — adoption refused as incoherent", async () => {
    const html =
      '<meta property="og:price:amount" content="49.95"><meta property="og:price:currency" content="USD">' +
      '<script type="application/ld+json">{"@type":"Offer","price":"4995000","priceCurrency":"USD"}</script>';
    const r = await resolveShopifyStoreCurrency([anchor()], withAnchorPage(html));
    expect(r.currency).toBeNull();
    expect(r.reason).toContain("incoherent");
  });

  it("control: a coherent bulk-pack jsonld amount (10× the anchor) does NOT block adoption", async () => {
    const html =
      '<meta property="og:price:amount" content="49.95"><meta property="og:price:currency" content="GBP">' +
      '<script type="application/ld+json">{"@type":"Offer","price":"499.50","priceCurrency":"GBP"}</script>';
    expect((await resolveShopifyStoreCurrency([anchor()], withAnchorPage(html))).currency).toBe("GBP");
  });

  it("an anchor fetch failure is indeterminate, not a refusal", async () => {
    const fetchText: FetchText = async (url) => (url.endsWith("/meta.json") ? res(url, 404) : failed(url));
    const r = await resolveShopifyStoreCurrency([anchor()], fetchText);
    expect(r.currency).toBeNull();
    expect(r.indeterminate).toBe(true);
  });

  it("a denylisted store refuses WITHOUT fetching — zero requests spent on a ruled store", async () => {
    const tried: string[] = [];
    const r = await resolveShopifyStoreCurrency(
      [anchor({ productUrl: "https://www.ruled.example/products/ghk-cu" })],
      async (url) => {
        tried.push(url);
        return res(url, 200, META);
      },
      { denylist: { "ruled.example": { ruling: "test ruling", ruled: "2026-10-01", reason: "vantage-varying markup" } } },
    );
    expect(r.currency).toBeNull();
    expect(r.reason).toContain("vantage-denylisted");
    expect(tried).toEqual([]);
  });
});
