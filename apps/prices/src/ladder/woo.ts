/**
 * WooCommerce rungs: the Store API feed (`/wp-json/wc/store/v1/products`), its per-parent
 * variations, the flagged fallback for a parent whose variations could not be read, and the
 * closed-Store-API page rung that reads `form.variations_form[data-product_variations]` off a
 * product page. Ported from PeptideBase's extraction-ladder.mjs and woo-embedded-variations.mjs.
 *
 * VARIABLE PRODUCTS ARE NOT A PRICE. The Store API's `prices.price` on a variable product is the
 * bottom of a RANGE; publishing it under the product's name is the defect the variable routing
 * exists to prevent. Parents come back on `variable` and are resolved to one row per variation.
 */
import { NOT_ASKED_REASON, RATE_LIMITED_STATUS, runPaced, type PacingOptions } from "../fetch/pacing.ts";
import type { FetchText } from "../fetch/types.ts";
import { parseWooVariations } from "../units/canonical-unit.ts";
import { declaredMinorToMinor, majorToMinor } from "./amounts.ts";
import { normalizeStructuredCode } from "./currency.ts";
import { decodeAttribute, decodeEntities, extractOgPriceAmount, extractPageProductName, pageCurrencySignal } from "./signals.ts";
import { HIT, isRecord, MISS, parseJson, UNKNOWN, type Attempt, type Availability, type PageFetchResult, type Product, type RungResult } from "./types.ts";

export const WOO_STORE_PATH = "/wp-json/wc/store/v1/products?per_page=100";
/** The Store API's page ceiling and our hard page cap — a ceiling, not a retry. */
export const WOO_FEED_PAGE = { param: "page", size: 100, max: 5 } as const;

interface WooPrices {
  price?: unknown;
  regular_price?: unknown;
  currency_code?: unknown;
  currency_minor_unit?: unknown;
  price_range?: { min_amount?: unknown; max_amount?: unknown } | null;
}

export interface WooVariableParent {
  id: number | string | null;
  name: string;
  permalink: string | null;
  variations: { id?: unknown; attributes?: unknown }[];
  priceRange: { minAmount: unknown; maxAmount: unknown } | null;
  price: unknown;
  currencyCode: string | null;
  currencyMinorUnit: number;
  isInStock: unknown;
  isOnBackorder: unknown;
}

export interface WooFeedResult extends RungResult {
  variable: WooVariableParent[];
}

const prices = (p: Record<string, unknown>): WooPrices => (isRecord(p.prices) ? (p.prices as WooPrices) : {});
const minorUnit = (pr: WooPrices): number => (Number.isInteger(pr.currency_minor_unit) ? (pr.currency_minor_unit as number) : 2);
const currencyOf = (pr: WooPrices): string | null => normalizeStructuredCode(pr.currency_code);
const idText = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Backorder FIRST: a backordered product is `is_in_stock: false` on some themes and `true` on
 *  others. An absent `is_in_stock` is unknown, never out_of_stock. */
function wooAvailability(src: Record<string, unknown>): Availability {
  if (src.is_on_backorder === true) return "backorder";
  if (src.backorders_allowed === true && src.is_in_stock === false) return "backorder";
  if (src.is_in_stock === true) return "in_stock";
  if (src.is_in_stock === false) return "out_of_stock";
  return "unknown";
}

/** The raw anchor: the minor-unit integer the vendor published WITH its declared scale. */
const wooRawPriceText = (pr: WooPrices): string => `${typeof pr.currency_code === "string" ? pr.currency_code : ""}${pr.price ?? ""} (minor_unit=${pr.currency_minor_unit ?? "?"})`.trim();

/** `regular_price` is a list price ONLY when strictly above the price. */
function wooListPrice(pr: WooPrices, priceMinor: number, currency: string | null): { listPriceMinor: number | null; onSale: boolean } {
  const regular = declaredMinorToMinor(pr.regular_price, minorUnit(pr), currency);
  const higher = regular !== null && regular > priceMinor;
  return { listPriceMinor: higher ? regular : null, onSale: higher };
}

function baseProduct(over: Partial<Product> & Pick<Product, "name" | "priceSource" | "rawPriceText">): Product {
  return {
    variantLabel: null,
    productUrl: null,
    fetchUrl: null,
    sourceSystem: "woocommerce",
    sourceProductId: null,
    sourceVariantId: null,
    variantKey: "",
    options: null,
    currency: null,
    currencyEvidence: null,
    priceMinor: null,
    listPriceMinor: null,
    onSale: false,
    availability: "unknown",
    fallbackRange: null,
    ...over,
  };
}

/** `[{name:'Size', value:'15mg'}]` → `"Size: 15mg"`; null when there is nothing to join. */
function joinWooAttributePairs(attributes: unknown): string | null {
  if (!Array.isArray(attributes) || attributes.length === 0) return null;
  const parts = attributes
    .filter((a): a is Record<string, unknown> => isRecord(a) && a.value != null && String(a.value).trim() !== "")
    .map((a) => (a.name ? `${decodeEntities(a.name)}: ${decodeEntities(a.value).trim()}` : decodeEntities(a.value).trim()));
  return parts.length ? parts.join(", ") : null;
}

/** WooCommerce Store API `/products` → the common product shape. Simple products in `products`,
 *  variable parents in `variable`; a variable-only payload is still a HIT. */
export function parseWooStoreApi(body: unknown, opts: { baseUrl?: string; fetchUrl?: string | null } = {}): WooFeedResult {
  const json = parseJson(body);
  if (json === undefined) return { state: MISS, reason: "not json", products: [], variable: [] };
  if (!Array.isArray(json)) return { state: MISS, reason: "json but not an array", products: [], variable: [] };
  if (json.length === 0) return { state: MISS, reason: "empty array", products: [], variable: [], rawCount: 0 };
  const first: unknown = json[0];
  if (!isRecord(first) || !("prices" in first) || !("name" in first)) {
    return { state: MISS, reason: "array but not Store-API product shape", products: [], variable: [] };
  }

  const products: Product[] = [];
  const variable: WooVariableParent[] = [];
  for (const entry of json as unknown[]) {
    if (!isRecord(entry)) continue;
    const pr = prices(entry);
    const permalink = typeof entry.permalink === "string" ? entry.permalink : opts.baseUrl && entry.id != null ? `${opts.baseUrl}/?p=${String(entry.id)}` : null;
    const isVariable = entry.type === "variable" || (pr.price_range != null && typeof pr.price_range === "object");
    if (isVariable) {
      variable.push({
        id: typeof entry.id === "number" || typeof entry.id === "string" ? entry.id : null,
        name: decodeEntities(entry.name).trim(),
        permalink,
        variations: Array.isArray(entry.variations) ? (entry.variations as { id?: unknown; attributes?: unknown }[]) : [],
        priceRange: pr.price_range ? { minAmount: pr.price_range.min_amount, maxAmount: pr.price_range.max_amount } : null,
        price: pr.price ?? null,
        currencyCode: currencyOf(pr),
        currencyMinorUnit: minorUnit(pr),
        isInStock: entry.is_in_stock ?? null,
        isOnBackorder: entry.is_on_backorder ?? null,
      });
      continue;
    }
    const currency = currencyOf(pr);
    const priceMinor = declaredMinorToMinor(pr.price, minorUnit(pr), currency);
    // No price is not a product — this stays a DROP. An out-of-stock product with a real price is
    // EMITTED with its availability: an absent row is indistinguishable from one never stocked.
    if (priceMinor === null) continue;
    products.push(
      baseProduct({
        name: decodeEntities(entry.name).trim(),
        priceSource: "woo_store_api",
        rawPriceText: wooRawPriceText(pr),
        productUrl: permalink,
        fetchUrl: opts.fetchUrl ?? null,
        sourceProductId: idText(entry.id),
        currency,
        currencyEvidence: currency ? "store_api" : null,
        priceMinor,
        availability: wooAvailability(entry),
        ...wooListPrice(pr, priceMinor, currency),
      }),
    );
  }
  if (products.length === 0 && variable.length === 0) {
    return { state: MISS, reason: "no purchasable priced products", products: [], variable: [], rawCount: json.length };
  }
  // rawCount is the UNFILTERED response length — the pagination continue-signal.
  return { state: HIT, reason: null, products, variable, rawCount: json.length };
}

/** `GET …/products?type=variation&parent=<id>` → one product per variation. The per-id form
 *  returns the same shape as a bare object, so both are accepted. `productUrl` is the PARENT's
 *  permalink, never the variation's `?attribute_size=` URL. */
export function parseWooStoreVariations(body: unknown, opts: { parent?: WooVariableParent | null } = {}): RungResult {
  const json = parseJson(body);
  if (json === undefined) return { state: MISS, reason: "not json", products: [] };
  const list: unknown[] | null = Array.isArray(json) ? json : isRecord(json) ? [json] : null;
  if (!list) return { state: MISS, reason: "json but not a variation object or array", products: [] };
  if (list.length === 0) return { state: MISS, reason: "empty array", products: [], rawCount: 0 };
  const parent = opts.parent ?? null;

  const products: Product[] = [];
  for (const v of list) {
    if (!isRecord(v) || !("prices" in v)) continue;
    const pr = prices(v);
    const currency = currencyOf(pr) ?? parent?.currencyCode ?? null;
    const priceMinor = declaredMinorToMinor(pr.price, minorUnit(pr), currency);
    if (priceMinor === null) continue;
    const ownAttrs = Array.isArray(v.attributes) && v.attributes.length ? v.attributes : null;
    const parentAttrs = parent?.variations.find((x) => x?.id === v.id)?.attributes;
    const options = ownAttrs ?? (Array.isArray(parentAttrs) && parentAttrs.length ? parentAttrs : null);
    const label = typeof v.variation === "string" && v.variation.trim() ? decodeEntities(v.variation).trim() : joinWooAttributePairs(options);
    const variantId = idText(v.id);
    products.push(
      baseProduct({
        name: decodeEntities(parent?.name ?? v.name).trim(),
        variantLabel: label,
        priceSource: "woo_store_api",
        rawPriceText: wooRawPriceText(pr),
        productUrl: parent?.permalink ?? (typeof v.permalink === "string" ? v.permalink : null),
        sourceProductId: idText(parent?.id ?? v.parent),
        sourceVariantId: variantId,
        variantKey: variantId ?? (label ? label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : ""),
        options,
        currency,
        currencyEvidence: currency ? "store_api" : null,
        priceMinor,
        availability: wooAvailability(v),
        ...wooListPrice(pr, priceMinor, currency),
      }),
    );
  }
  if (products.length === 0) return { state: MISS, reason: "no priced variations", products: [], rawCount: list.length };
  return { state: HIT, reason: null, products, rawCount: list.length };
}

/** The one row a variable parent gets when its variations could NOT be read: a RANGE, with no
 *  price, so nothing downstream can publish the range bottom as a price. null when the parent
 *  has no usable figure at all. */
export function wooVariableParentFallback(parent: WooVariableParent, opts: { fetchUrl?: string | null } = {}): Product | null {
  const mu = parent.currencyMinorUnit;
  const rawMinor = parent.priceRange?.minAmount ?? parent.price;
  const min = declaredMinorToMinor(rawMinor, mu, parent.currencyCode);
  if (min === null) return null;
  const max = parent.priceRange?.maxAmount != null ? declaredMinorToMinor(parent.priceRange.maxAmount, mu, parent.currencyCode) : null;
  return baseProduct({
    name: parent.name,
    priceSource: "woo_store_api",
    rawPriceText: `${parent.currencyCode ?? ""}${String(rawMinor ?? "")} (minor_unit=${mu})`.trim(),
    productUrl: parent.permalink,
    fetchUrl: opts.fetchUrl ?? null,
    sourceProductId: idText(parent.id),
    currency: parent.currencyCode,
    currencyEvidence: parent.currencyCode ? "store_api" : null,
    priceMinor: null,
    availability: wooAvailability({ is_in_stock: parent.isInStock, is_on_backorder: parent.isOnBackorder }),
    fallbackRange: { minMinor: min, maxMinor: max },
  });
}

/**
 * Fetch each variable parent's variations, one row per variation, concurrency 4, NO RETRIES,
 * results in PARENT ORDER. Paginated like the feed rung: a full page is followed by `page=2`
 * until a short page, capped at the feed's page maximum. A LATER page that fails keeps the rows
 * already read (the parent WAS enumerated, partially) and says so: `list TRUNCATED`.
 */
export async function resolveWooVariableParents(
  parents: WooVariableParent[],
  baseUrl: string,
  fetchText: FetchText,
  opts: PacingOptions & { alreadyRateLimited?: boolean } = {},
): Promise<{ products: Product[]; attempts: Attempt[]; fetches: number; truncatedParentIds: string[]; unenumeratedParentIds: string[] }> {
  const base = baseUrl.replace(/\/$/, "");
  // Once this vendor answers 429 — here or on the feed itself — nothing further is asked of it in this run.
  let rateLimited = opts.alreadyRateLimited === true;
  const variationsUrl = (parent: WooVariableParent, page: number) =>
    `${base}/wp-json/wc/store/v1/products?type=variation&parent=${String(parent.id)}&per_page=${WOO_FEED_PAGE.size}${page > 1 ? `&page=${page}` : ""}`;
  const slots: ({ attempts: Attempt[]; products: Product[]; fetches: number; truncated: boolean; enumerated: boolean } | undefined)[] = new Array(parents.length);

  const runOne = async (i: number) => {
    const parent = parents[i];
    const products: Product[] = [];
    const attempts: Attempt[] = [];
    let fetched = 0;
    // TRUNCATED: some variations were read and the list did not reach its end. The variants not
    // reached are UNKNOWN, never gone.
    let truncated = false;
    let reachedEnd = false;
    // Page 1 gave no variation list: the parent was seen, not enumerated (with or without a fallback row).
    let enumerated = true;
    const fallback = (url: string) => {
      enumerated = false;
      const row = wooVariableParentFallback(parent, { fetchUrl: url });
      if (row) products.push(row);
    };
    for (let page = 1; page <= WOO_FEED_PAGE.max; page++) {
      const url = variationsUrl(parent, page);
      if (page > 1 && rateLimited) {
        // The vendor refused a request elsewhere while this list was being read: stop here too.
        attempts.push({ rung: "woo_store_api", kind: "variations", url, parentId: idText(parent.id), page, state: UNKNOWN, status: null, reason: `variations ${NOT_ASKED_REASON} — list TRUNCATED after page ${page - 1}` });
        truncated = true;
        reachedEnd = true;
        break;
      }
      const attempt: Attempt = { rung: "woo_store_api", kind: "variations", url, parentId: idText(parent.id), page, state: UNKNOWN, status: null, reason: null };
      fetched++;
      const res = await fetchText(url, { accept: "application/json" });
      if (res.status === RATE_LIMITED_STATUS) rateLimited = true;
      if (res.state !== "hit") {
        const what = res.error ? `variations ${res.error}` : `variations http ${res.status ?? "?"}`;
        attempts.push({ ...attempt, state: res.state, status: res.status, reason: page === 1 ? what : `${what} — list TRUNCATED after page ${page - 1}` });
        if (page === 1) fallback(url);
        else truncated = true;
        reachedEnd = true;
        break;
      }
      const parsed = parseWooStoreVariations(res.body, { parent });
      if (parsed.state !== HIT) {
        if (page === 1) {
          attempts.push({ ...attempt, state: MISS, status: res.status, reason: `variations: ${parsed.reason}` });
          fallback(url);
        } else if (parsed.rawCount === 0) {
          attempts.push({ ...attempt, state: MISS, status: res.status, reason: `variations page ${page}: ${parsed.reason} (end of list)` });
        } else {
          // A 200 that is not a variation list (a challenge page) is not the end of the list.
          attempts.push({ ...attempt, state: UNKNOWN, status: res.status, reason: `variations page ${page}: ${parsed.reason} — list TRUNCATED after page ${page - 1}` });
          truncated = true;
        }
        reachedEnd = true;
        break;
      }
      for (const p of parsed.products) p.fetchUrl = url;
      products.push(...parsed.products);
      attempts.push({ ...attempt, state: HIT, status: res.status, reason: page === 1 ? null : `page ${page}` });
      if ((parsed.rawCount ?? 0) < WOO_FEED_PAGE.size) {
        reachedEnd = true; // a short page is the last page
        break;
      }
    }
    if (!reachedEnd) {
      // Every page up to the ceiling was full: the list continues past what was read.
      truncated = true;
      attempts.push({ rung: "woo_store_api", kind: "variations", url: "", parentId: idText(parent.id), state: UNKNOWN, status: null, reason: `variations page ceiling (${WOO_FEED_PAGE.max}) reached on a full page — list TRUNCATED` });
    }
    slots[i] = { attempts, products, fetches: fetched, truncated, enumerated: enumerated && !truncated };
  };

  const notAsked = await runPaced(parents.length, runOne, { ...opts, stopped: () => rateLimited });
  for (const i of notAsked) {
    // SEEN in the feed, never enumerated: a range fallback, exactly as if its variations had failed.
    const url = variationsUrl(parents[i], 1);
    const row = wooVariableParentFallback(parents[i], { fetchUrl: url });
    slots[i] = {
      attempts: [{ rung: "woo_store_api", kind: "variations", url, parentId: idText(parents[i].id), page: 1, state: UNKNOWN, status: null, reason: `variations ${NOT_ASKED_REASON}` }],
      products: row ? [row] : [],
      fetches: 0,
      truncated: false,
      enumerated: false,
    };
  }

  const products: Product[] = [];
  const attempts: Attempt[] = [];
  const truncatedParentIds: string[] = [];
  const unenumeratedParentIds: string[] = [];
  let fetches = 0;
  slots.forEach((slot, i) => {
    if (!slot) return;
    attempts.push(...slot.attempts);
    products.push(...slot.products);
    fetches += slot.fetches;
    const parentId = idText(parents[i].id);
    if (parentId === null) return;
    if (slot.truncated) truncatedParentIds.push(parentId);
    if (!slot.enumerated) unenumeratedParentIds.push(parentId);
  });
  return { products, attempts, fetches, truncatedParentIds, unenumeratedParentIds };
}

// ── The closed-Store-API page rung ───────────────────────────────────────────

/** The opening `<form …>` tag of the variations form, or null. */
function findVariationsForm(html: string): string | null {
  const m = /<form[^>]*\bclass=["'][^"']*\bvariations_form\b[^"']*["'][^>]*>/i.exec(html);
  if (m) return m[0];
  const m2 = /<form[^>]*\bdata-product_variations=[^>]*>/i.exec(html);
  return m2 ? m2[0] : null;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** `{ attribute_pa_size: "15mg", attribute_colour: "" }` → `"Size: 15mg"`. Empty values mean "any" and are dropped. */
function labelFromAttributes(attributes: unknown): string | null {
  if (!isRecord(attributes)) return null;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value == null || String(value).trim() === "") continue;
    const name = key.replace(/^attribute_/, "").replace(/^pa_/, "").replace(/[-_]+/g, " ").trim();
    const pretty = name ? name.charAt(0).toUpperCase() + name.slice(1) : name;
    parts.push(`${pretty}: ${String(value).trim()}`);
  }
  return parts.length ? parts.join(", ") : null;
}

/**
 * A Woo product page's `data-product_variations` payload → the common product shape. The
 * `"false"` sentinel (WC deferring to AJAX above its variation threshold) is a MISS with a
 * reason, never an empty catalogue. Currency comes from the page's own og / JSON-LD declaration,
 * withdrawn when an og amount on the page matches no variation price.
 */
export function parseWooEmbeddedVariations(html: unknown, opts: { productUrl?: string | null } = {}): RungResult {
  if (typeof html !== "string" || !html) return { state: MISS, products: [], reason: "no html" };
  const form = findVariationsForm(html);
  if (!form) return { state: MISS, products: [], reason: "no form.variations_form on the page" };
  const rawAttr = attr(form, "data-product_variations");
  if (rawAttr === null) return { state: MISS, products: [], reason: "variations_form carries no data-product_variations" };
  const decoded = decodeAttribute(rawAttr).trim();
  if (decoded === "" || decoded === "false" || decoded === "null") return { state: MISS, products: [], reason: "variations deferred (false sentinel)" };

  let raw: unknown;
  try {
    raw = JSON.parse(decoded);
  } catch {
    return { state: MISS, products: [], reason: "data-product_variations is not parseable JSON" };
  }
  if (!Array.isArray(raw)) {
    if (isRecord(raw) && Array.isArray(raw.variations)) raw = raw.variations;
    else return { state: MISS, products: [], reason: "data-product_variations is not an array" };
  }
  const list = raw as unknown[];
  if (list.length === 0) return { state: MISS, products: [], reason: "data-product_variations is an empty array" };

  // The shared normaliser decides which entries are usable; ids and stock come off the raw objects.
  const usable = new Set(list.map((v, i) => (parseWooVariations([v]).length === 1 ? i : -1)).filter((i) => i >= 0));
  const productUrl = opts.productUrl ?? null;
  const productId = attr(form, "data-product_id");
  const productName = extractPageProductName(html);
  const pageCurrency = pageCurrencySignal(html);
  const currency = normalizeStructuredCode(pageCurrency.currency);
  const products: Product[] = [];

  list.forEach((v, i) => {
    if (!usable.has(i) || !isRecord(v)) return;
    // `variation_is_active: false` is a variation the vendor disabled — not purchasable in any
    // state. `is_purchasable: false` is live but unsellable right now and IS emitted.
    if (v.variation_is_active === false) return;
    const priceMinor = majorToMinor(v.display_price, currency);
    if (priceMinor === null) return;
    const listMinor = majorToMinor(v.display_regular_price, currency);
    const higher = listMinor !== null && listMinor > priceMinor;
    const variantId = idText(v.variation_id);
    products.push(
      baseProduct({
        name: productName ?? "",
        variantLabel: labelFromAttributes(v.attributes),
        priceSource: "woo_embedded_variations",
        rawPriceText: String(v.display_price ?? ""),
        productUrl,
        fetchUrl: productUrl,
        sourceProductId: productId,
        sourceVariantId: variantId,
        variantKey: variantId ?? "",
        options: v.attributes ?? null,
        currency,
        currencyEvidence: currency ? pageCurrency.evidence : null,
        priceMinor,
        listPriceMinor: higher ? listMinor : null,
        onSale: higher,
        availability: wooAvailability(v),
      }),
    );
  });
  if (products.length === 0) return { state: MISS, products: [], reason: "no active priced variations in data-product_variations" };

  // Refuse-only corroboration: an og amount on the page must be one of the variation prices, or
  // the page's money markup disagrees with its own payload and its currency claim is withdrawn.
  const ogAmount = extractOgPriceAmount(html);
  if (currency && ogAmount !== null) {
    const ogMinor = majorToMinor(String(ogAmount), currency);
    const corroborated = ogMinor !== null && products.some((p) => p.priceMinor === ogMinor);
    if (!corroborated) {
      for (const p of products) {
        p.currency = null;
        p.currencyEvidence = null;
      }
    }
  }
  return { state: HIT, products, reason: null };
}

/** Fetch one product page and read its embedded variations. Three-state; 404/410 carry `dead`. */
export async function fetchWooEmbeddedVariations(productUrl: string, fetchText: FetchText): Promise<PageFetchResult> {
  const res = await fetchText(productUrl, { accept: "text/html" });
  if (res.state === "miss") return { state: MISS, products: [], reason: res.error ?? `http ${res.status ?? "?"}`, status: res.status, ...(res.status === 404 || res.status === 410 ? { dead: true } : {}) };
  if (res.state !== "hit") return { state: UNKNOWN, products: [], reason: res.error ?? `http ${res.status ?? "?"}`, status: res.status };
  const parsed = parseWooEmbeddedVariations(res.body, { productUrl });
  return { ...parsed, status: res.status };
}
