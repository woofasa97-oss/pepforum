/**
 * Shopify rungs: the `/products.json` feed (major-unit STRINGS, "59.99") and the closed per-handle
 * `.js` feed (MINOR units, 5999). Same field name, same store, 100× apart — which is why the scale
 * is a parameter of the shared row builder and not a literal in either parser. Neither carries a
 * currency code; `resolveShopifyStoreCurrency` fills it or the rows stay `currency_unresolved`.
 */
import type { FetchText } from "../fetch/types.ts";
import { declaredMinorToMinor, majorToMinor } from "./amounts.ts";
import { slugifyLabel } from "./signals.ts";
import { HIT, isRecord, MISS, parseJson, UNKNOWN, type PageFetchResult, type PriceSource, type Product, type RungResult } from "./types.ts";

export const SHOPIFY_PRODUCTS_PATH = "/products.json?limit=250";
/** Shopify paginates by CURSOR (`since_id`), not page number: `?page=` returns page 1 forever on newer stores. */
export const SHOPIFY_FEED_PAGE = { param: "since_id", size: 250, max: 5 } as const;

type Scale = "major" | "minor";

/** `Default Title` is Shopify's placeholder for "no variant axis". It is not a label. */
function shopifyVariantLabel(v: Record<string, unknown>): string | null {
  const t = v.title;
  return typeof t === "string" && t.trim() && t !== "Default Title" ? t.trim() : null;
}

function toMinorAt(value: unknown, scale: Scale): number | null {
  return scale === "major" ? majorToMinor(value, null) : declaredMinorToMinor(value, 2, null);
}

function shopifyVariantProduct(
  p: Record<string, unknown>,
  v: Record<string, unknown>,
  priceMinor: number,
  opts: { productUrl: string | null; scale: Scale; priceSource: PriceSource; fetchUrl: string | null },
): Product {
  const label = shopifyVariantLabel(v);
  const listMinor = toMinorAt(v.compare_at_price, opts.scale);
  const higher = listMinor !== null && listMinor > priceMinor;
  const variantId = v.id == null ? null : String(v.id);
  return {
    name: typeof p.title === "string" ? p.title.trim() : "",
    variantLabel: label,
    productUrl: opts.productUrl,
    fetchUrl: opts.fetchUrl,
    sourceSystem: "shopify",
    priceSource: opts.priceSource,
    sourceProductId: p.id == null ? null : String(p.id),
    sourceVariantId: variantId,
    variantKey: variantId ?? slugifyLabel(label),
    options: { option1: v.option1 ?? null, option2: v.option2 ?? null, option3: v.option3 ?? null },
    // No currency in either feed. A guessed USD on a CAD store is a silent wrong answer; null skips.
    currency: null,
    currencyEvidence: null,
    priceMinor,
    listPriceMinor: higher ? listMinor : null,
    onSale: higher,
    availability: v.available === true ? "in_stock" : v.available === false ? "out_of_stock" : "unknown",
    rawPriceText: opts.scale === "major" ? String(v.price ?? "") : `${String(v.price ?? "")} (minor_unit=2)`,
    fallbackRange: null,
  };
}

/** `/products.json` → one row per VARIANT. `rawCount` counts products, `lastId` is the since_id cursor. */
export function parseShopifyProductsJson(body: unknown, opts: { baseUrl?: string; fetchUrl?: string | null } = {}): RungResult {
  const json = parseJson(body);
  if (json === undefined) return { state: MISS, reason: "not json", products: [] };
  const arr = isRecord(json) ? json.products : undefined;
  if (!Array.isArray(arr)) return { state: MISS, reason: "no products array", products: [] };
  if (arr.length === 0) return { state: MISS, reason: "empty products array", products: [], rawCount: 0 };
  const first: unknown = arr[0];
  if (!isRecord(first) || !("variants" in first) || !("title" in first)) return { state: MISS, reason: "array but not Shopify product shape", products: [] };

  const products: Product[] = [];
  for (const p of arr as unknown[]) {
    if (!isRecord(p) || !Array.isArray(p.variants)) continue;
    const productUrl = opts.baseUrl && typeof p.handle === "string" ? `${opts.baseUrl.replace(/\/$/, "")}/products/${p.handle}` : null;
    for (const v of p.variants as unknown[]) {
      if (!isRecord(v)) continue;
      const priceMinor = majorToMinor(v.price, null);
      if (priceMinor === null) continue;
      products.push(shopifyVariantProduct(p, v, priceMinor, { productUrl, scale: "major", priceSource: "shopify_products_json", fetchUrl: opts.fetchUrl ?? null }));
    }
  }
  const last: unknown = arr[arr.length - 1];
  const lastId = isRecord(last) && (typeof last.id === "number" || typeof last.id === "string") ? last.id : null;
  if (products.length === 0) return { state: MISS, reason: "no priced variants", products: [], rawCount: arr.length, lastId };
  return { state: HIT, reason: null, products, rawCount: arr.length, lastId };
}

/** `GET {product_url}.js` → the same rows, from MINOR-unit figures. */
export function parseShopifyProductJs(body: unknown, opts: { productUrl?: string | null } = {}): RungResult {
  const json = parseJson(body);
  if (json === undefined) return { state: MISS, reason: "not json", products: [] };
  const p = isRecord(json) && isRecord(json.product) ? json.product : json;
  if (!isRecord(p) || !Array.isArray(p.variants) || !("title" in p)) return { state: MISS, reason: "not a Shopify product .js shape", products: [] };
  const productUrl = opts.productUrl ?? null;
  const products: Product[] = [];
  for (const v of p.variants as unknown[]) {
    if (!isRecord(v)) continue;
    const priceMinor = declaredMinorToMinor(v.price, 2, null);
    if (priceMinor === null) continue;
    products.push(shopifyVariantProduct(p, v, priceMinor, { productUrl, scale: "minor", priceSource: "shopify_product_js", fetchUrl: productUrl }));
  }
  if (products.length === 0) return { state: MISS, reason: "no priced variants", products: [], rawCount: p.variants.length };
  return { state: HIT, reason: null, products, rawCount: p.variants.length };
}

/** Fetch one product page's `.js` feed. `?variant=` and a trailing slash both break the suffix. */
export async function fetchShopifyProductJs(productUrl: string, fetchText: FetchText): Promise<PageFetchResult & { url: string }> {
  const base = String(productUrl ?? "").split("#")[0].split("?")[0].replace(/\/+$/, "");
  const url = `${base}.js`;
  const res = await fetchText(url, { accept: "application/json" });
  if (res.state === "miss") return { state: MISS, products: [], reason: res.error ?? `http ${res.status ?? "?"}`, status: res.status, url, ...(res.status === 404 || res.status === 410 ? { dead: true } : {}) };
  if (res.state !== "hit") return { state: UNKNOWN, products: [], reason: res.error ?? `http ${res.status ?? "?"}`, status: res.status, url };
  const parsed = parseShopifyProductJs(res.body, { productUrl });
  return { ...parsed, status: res.status, url };
}
