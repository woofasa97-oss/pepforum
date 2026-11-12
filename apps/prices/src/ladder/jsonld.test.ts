import { describe, expect, it } from "vitest";
import type { FetchText } from "../fetch/types.ts";
import { fetchJsonLdOffers, parseJsonLdOffers } from "./jsonld.ts";

const ld = (json: unknown) => `<script type="application/ld+json">${JSON.stringify(json)}</script>`;
const URL_ = "https://v.example/p/tb-500/";

describe("parseJsonLdOffers", () => {
  it("reads a Product with a single Offer, exactly", () => {
    const r = parseJsonLdOffers(ld({ "@type": "Product", name: "TB-500 5mg", sku: "TB5", offers: { "@type": "Offer", price: "64.00", priceCurrency: "usd", availability: "https://schema.org/InStock" } }), { productUrl: URL_ });
    expect(r.state).toBe("hit");
    expect(r.products[0]).toMatchObject({
      name: "TB-500 5mg",
      variantLabel: null,
      variantKey: "",
      priceMinor: 6400,
      currency: "USD",
      availability: "in_stock",
      sourceSystem: "jsonld",
      priceSource: "jsonld",
      sourceProductId: "TB5",
      productUrl: URL_,
      rawPriceText: "64.00",
    });
  });

  it("expands an offer array and an AggregateOffer's inner offers to one row per offer, labelled", () => {
    const r = parseJsonLdOffers(
      ld({
        "@type": "Product",
        name: "BPC-157",
        offers: { "@type": "AggregateOffer", lowPrice: "45", highPrice: "80", offers: [{ "@type": "Offer", name: "5mg", price: 45, priceCurrency: "USD" }, { "@type": "Offer", sku: "BPC-10", price: 80, priceCurrency: "USD" }] },
      }),
    );
    expect(r.products.map((p) => [p.variantLabel, p.variantKey, p.priceMinor])).toEqual([
      ["5mg", "5mg", 4500],
      ["BPC-10", "bpc-10", 8000],
    ]);
    expect(r.products[1].sourceVariantId).toBe("BPC-10");
  });

  it("an AggregateOffer WITHOUT inner offers becomes a fallback range with no price", () => {
    const r = parseJsonLdOffers(ld({ "@type": "Product", name: "GHK-Cu", offers: { "@type": "AggregateOffer", lowPrice: "45.00", highPrice: "80.00", priceCurrency: "USD" } }));
    expect(r.state).toBe("hit");
    expect(r.products[0]).toMatchObject({ priceMinor: null, fallbackRange: { minMinor: 4500, maxMinor: 8000 }, currency: "USD", rawPriceText: "45.00" });
  });

  it("reads @graph, arrays and array-valued @type; skips a malformed block without voiding the others", () => {
    const html =
      '<script type="application/ld+json">{broken</script>' +
      ld({ "@graph": [{ "@type": ["Product", "Drug"], name: "X 10mg", offers: [{ price: "10", priceCurrency: "CAD" }] }] });
    const r = parseJsonLdOffers(html);
    expect(r.products).toHaveLength(1);
    expect(r.products[0].currency).toBe("CAD");
  });

  it("only a Product with offers becomes a row — a Service with offers does not", () => {
    expect(parseJsonLdOffers(ld({ "@type": "Service", name: "Consult", offers: { price: "100", priceCurrency: "USD" } })).state).toBe("miss");
    expect(parseJsonLdOffers(ld({ "@type": "Product", name: "X" })).reason).toBe("no json-ld Product with offers");
    expect(parseJsonLdOffers(ld({ "@type": "Product", name: "X", offers: { price: "0" } })).reason).toBe("json-ld offers carried no positive price");
    expect(parseJsonLdOffers("<html>none</html>").reason).toBe("no json-ld blocks");
    expect(parseJsonLdOffers("").state).toBe("miss");
  });

  it("reads priceSpecification and an unrecognised availability as unknown", () => {
    const r = parseJsonLdOffers(ld({ "@type": "Product", name: "X", offers: { priceSpecification: { price: "12.50", priceCurrency: "GBP" }, availability: "Sometimes" } }));
    expect(r.products[0]).toMatchObject({ priceMinor: 1250, currency: "GBP", availability: "unknown" });
  });
});

describe("fetchJsonLdOffers — three-state", () => {
  const at = (status: number, body = ""): FetchText => async (url) => ({
    url,
    status,
    state: status === 200 ? "hit" : status === 404 || status === 410 ? "miss" : "unknown",
    body,
    fetchedAt: "2026-10-01T00:00:00.000Z",
  });
  it("200 hit, 404/410 miss + dead, 403 unknown", async () => {
    const page = ld({ "@type": "Product", name: "TB-500 5mg", offers: { price: "64.00", priceCurrency: "USD" } });
    expect((await fetchJsonLdOffers(URL_, at(200, page))).state).toBe("hit");
    const gone = await fetchJsonLdOffers(URL_, at(410));
    expect(gone).toMatchObject({ state: "miss", dead: true, status: 410 });
    expect((await fetchJsonLdOffers(URL_, at(403))).state).toBe("unknown");
  });
});
