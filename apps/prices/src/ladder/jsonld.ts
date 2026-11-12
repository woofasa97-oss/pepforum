/**
 * The LAST page rung: a product page's own schema.org Product/Offer block. A real JSON parse
 * (unlike `extractJsonLdPricePairs`, which corroborates one field with a scoped regex): here the
 * OFFER STRUCTURE is the payload, and a regex cannot represent nesting. A block that fails to
 * parse is skipped, not fatal.
 */
import type { FetchText } from "../fetch/types.ts";
import { majorToMinor } from "./amounts.ts";
import { normalizeStructuredCode } from "./currency.ts";
import { mapSchemaAvailability, slugifyLabel } from "./signals.ts";
import { HIT, isRecord, MISS, UNKNOWN, type PageFetchResult, type Product, type RungResult } from "./types.ts";

const LD_BLOCK_RE = /<script[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Every JSON-LD node in the page, flattening arrays and `@graph`. */
function jsonLdNodes(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const push = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const n of node) push(n);
      return;
    }
    if (!isRecord(node)) return;
    out.push(node);
    if (node["@graph"]) push(node["@graph"]);
  };
  for (const m of html.matchAll(LD_BLOCK_RE)) {
    try {
      push(JSON.parse(m[1].trim()));
    } catch {
      continue;
    }
  }
  return out;
}

/** `@type` may be a string or an array. The bare name is compared, so 'ProductModel' is not 'Product'. */
function isType(node: Record<string, unknown>, wanted: string): boolean {
  const t = node["@type"];
  const list = Array.isArray(t) ? t : [t];
  return list.some((x) => typeof x === "string" && x.replace(/^.*[/:#]/, "").toLowerCase() === wanted.toLowerCase());
}

function offerPriceText(offer: Record<string, unknown>): unknown {
  return offer.price ?? (isRecord(offer.priceSpecification) ? offer.priceSpecification.price : undefined);
}

function offerCurrency(offer: Record<string, unknown>): string | null {
  const c = offer.priceCurrency ?? (isRecord(offer.priceSpecification) ? offer.priceSpecification.priceCurrency : undefined);
  return normalizeStructuredCode(c);
}

const isAggregate = (o: Record<string, unknown>) => isType(o, "AggregateOffer") || o.lowPrice != null || o.highPrice != null;

/**
 * schema.org Product/Offer blocks → the common product shape. An AggregateOffer WITH inner
 * offers expands to one row per inner offer; one WITHOUT them cannot name a price and emits a
 * fallback range row (no price) — a range is not a price.
 */
export function parseJsonLdOffers(html: unknown, opts: { productUrl?: string | null } = {}): RungResult {
  if (typeof html !== "string" || !html) return { state: MISS, products: [], reason: "no html" };
  const nodes = jsonLdNodes(html);
  if (nodes.length === 0) return { state: MISS, products: [], reason: "no json-ld blocks" };
  const productUrl = opts.productUrl ?? null;

  const products: Product[] = [];
  let sawProductNode = false;
  const base = (over: Partial<Product> & Pick<Product, "name" | "rawPriceText" | "currency">): Product => ({
    variantLabel: null,
    productUrl,
    fetchUrl: productUrl,
    sourceSystem: "jsonld",
    priceSource: "jsonld",
    sourceProductId: null,
    sourceVariantId: null,
    variantKey: "",
    options: null,
    currencyEvidence: over.currency ? "jsonld_currency" : null,
    priceMinor: null,
    listPriceMinor: null,
    onSale: false,
    availability: "unknown",
    fallbackRange: null,
    ...over,
  });

  for (const node of nodes) {
    // Only a Product with offers. A Service or an Event carrying `offers` is not a product listing.
    if (!isType(node, "Product") || node.offers == null) continue;
    sawProductNode = true;
    const productName = typeof node.name === "string" && node.name.trim() ? node.name.trim() : "";
    const productId = node.productID ?? node.sku ?? null;
    const rawOffers = Array.isArray(node.offers) ? node.offers : [node.offers];

    const flat: { offer: Record<string, unknown>; aggregate: boolean }[] = [];
    for (const o of rawOffers) {
      if (!isRecord(o)) continue;
      if (isAggregate(o) && Array.isArray(o.offers) && o.offers.length) {
        for (const inner of o.offers) if (isRecord(inner)) flat.push({ offer: inner, aggregate: false });
      } else flat.push({ offer: o, aggregate: isAggregate(o) });
    }

    for (const { offer, aggregate } of flat) {
      const currency = offerCurrency(offer);
      if (aggregate) {
        const low = majorToMinor(offer.lowPrice, currency);
        if (low === null) continue;
        products.push(
          base({
            name: productName,
            currency,
            rawPriceText: String(offer.lowPrice ?? ""),
            sourceProductId: productId == null ? null : String(productId),
            availability: mapSchemaAvailability(offer.availability),
            fallbackRange: { minMinor: low, maxMinor: majorToMinor(offer.highPrice, currency) },
          }),
        );
        continue;
      }
      const priceMinor = majorToMinor(offerPriceText(offer), currency);
      if (priceMinor === null) continue;
      const label = [offer.name, offer.sku].find((x): x is string => typeof x === "string" && x.trim() !== "") ?? null;
      products.push(
        base({
          name: productName,
          variantLabel: label,
          currency,
          priceMinor,
          rawPriceText: String(offerPriceText(offer) ?? ""),
          sourceProductId: productId == null ? null : String(productId),
          sourceVariantId: offer.sku == null ? null : String(offer.sku),
          // No platform id exists here, so the label IS the key; '' for a lone unlabelled offer.
          variantKey: label ? slugifyLabel(label) : "",
          availability: mapSchemaAvailability(offer.availability),
        }),
      );
    }
  }

  if (products.length === 0) {
    return { state: MISS, products: [], reason: sawProductNode ? "json-ld offers carried no positive price" : "no json-ld Product with offers" };
  }
  return { state: HIT, products, reason: null };
}

/** `GET <product page>` → the page's schema.org offers. Three-state; 404/410 carry `dead`. */
export async function fetchJsonLdOffers(productUrl: string, fetchText: FetchText): Promise<PageFetchResult> {
  const res = await fetchText(productUrl, { accept: "text/html" });
  if (res.state === "miss") return { state: MISS, products: [], reason: res.error ?? `http ${res.status ?? "?"}`, status: res.status, ...(res.status === 404 || res.status === 410 ? { dead: true } : {}) };
  if (res.state !== "hit") return { state: UNKNOWN, products: [], reason: res.error ?? `http ${res.status ?? "?"}`, status: res.status };
  const parsed = parseJsonLdOffers(res.body, { productUrl });
  return { ...parsed, status: res.status };
}
