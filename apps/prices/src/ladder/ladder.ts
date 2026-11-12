/**
 * The extraction ladder. A vendor's prices come from the JSON its own store already publishes —
 * never from a model reading a page. Feed rungs (Woo Store API, Shopify /products.json) ask one
 * vendor-level endpoint for the catalogue; page rungs (Woo embedded variations, Shopify .js,
 * JSON-LD) ask ONE PRODUCT PAGE at a time, over the URLs we already hold — plus, for a
 * custom-built or page-data shop with no feed, the product pages its own sitemap lists
 * (./sitemap.ts). Nothing else enumerates a vendor's URL space: crawling it is refused.
 *
 * THE THREE-STATE RULE, vendor level: a HIT is products; a MISS is every rung answering "no";
 * if ANY rung was UNKNOWN the vendor is UNKNOWN. "We could not tell" and "there is nothing
 * there" are different facts and only the second licenses removing offers.
 *
 * Every result carries a MEASURED `fetches` count: variable parents cost one fetch each, so no
 * static ceiling bounds a run. Ported from PeptideBase's extraction-ladder.mjs.
 */
import { NOT_ASKED_REASON, RATE_LIMITED_STATUS, REQUEST_PAUSE_MS, realSleep, runPaced, type PacingOptions, type Sleep } from "../fetch/pacing.ts";
import type { FetchText } from "../fetch/types.ts";
import { currencyExponent } from "../money.ts";
import { canonicalVialMg, normalizeQuantityText, statesMass, stripMassTokens } from "../units/canonical-unit.ts";
import { minorToMajorText } from "./amounts.ts";
import { resolveShopifyStoreCurrency } from "./currency.ts";
import { fetchJsonLdOffers } from "./jsonld.ts";
import { fetchShopifyProductJs, parseShopifyProductsJson, SHOPIFY_FEED_PAGE, SHOPIFY_PRODUCTS_PATH } from "./shopify.ts";
import { discoverProductUrls } from "./sitemap.ts";
import { HIT, MISS, UNKNOWN, type Attempt, type FetchState, type LadderResult, type PageFetchResult, type Platform, type PriceSource, type Product, type RungResult } from "./types.ts";
import { fetchWooEmbeddedVariations, parseWooStoreApi, resolveWooVariableParents, WOO_FEED_PAGE, WOO_STORE_PATH, type WooVariableParent } from "./woo.ts";

export interface FeedRung {
  source: PriceSource;
  path: string;
  parse: (body: unknown, opts: { baseUrl: string; fetchUrl: string }) => RungResult & { variable?: WooVariableParent[] };
  page: { param: string; size: number; max: number };
}

export interface PageRung {
  source: PriceSource;
  fetch: (productUrl: string, fetchText: FetchText) => Promise<PageFetchResult>;
}

/** The endpoints each feed rung asks for, in order. Both paginate to a hard ceiling. */
export const RUNGS: readonly FeedRung[] = [
  { source: "woo_store_api", path: WOO_STORE_PATH, parse: (b, o) => parseWooStoreApi(b, o), page: WOO_FEED_PAGE },
  { source: "shopify_products_json", path: SHOPIFY_PRODUCTS_PATH, parse: (b, o) => parseShopifyProductsJson(b, o), page: SHOPIFY_FEED_PAGE },
];

/** The page rungs, in ladder order for a vendor whose platform is unknown. */
export const PAGE_RUNGS: readonly PageRung[] = [
  { source: "woo_embedded_variations", fetch: fetchWooEmbeddedVariations },
  { source: "shopify_product_js", fetch: fetchShopifyProductJs },
  { source: "jsonld", fetch: fetchJsonLdOffers },
];

/** Which page rung a known platform routes to; null for "use the feed rungs". */
export function pageRungsFor(platform: Platform | null | undefined): PageRung[] | null {
  if (platform === "woocommerce_closed_api") return [PAGE_RUNGS[0]];
  if (platform === "shopify_closed_api") return [PAGE_RUNGS[1]];
  if (platform === "jsonld" || platform === "custom") return [PAGE_RUNGS[2]];
  return null;
}

/** Wrap a fetcher so every request this ladder call makes is counted. */
function counting(fetchText: FetchText): { fetchText: FetchText; count: () => number } {
  let n = 0;
  return {
    fetchText: async (url, opts) => {
      n++;
      return fetchText(url, opts);
    },
    count: () => n,
  };
}

/**
 * Shopify rows carry no currency on either route; the store's own /meta.json (or the number-
 * anchored page pair) fills it. Recorded as its own attempt rows so the census says what
 * happened; a probe that explained nothing still appears, or fetches and attempts disagree.
 */
async function adoptShopifyStoreCurrency(products: Product[], attempts: Attempt[], fetchText: FetchText): Promise<void> {
  const cur = await resolveShopifyStoreCurrency(products, fetchText);
  if (cur.meta) {
    attempts.push({ rung: "shopify_store_meta", kind: "meta_json", url: cur.meta.url, state: cur.meta.status === 200 ? MISS : cur.meta.status === null ? UNKNOWN : "miss", status: cur.meta.status, reason: cur.meta.reason });
  }
  attempts.push({
    rung: "shopify_store_currency",
    url: cur.url ?? "",
    state: cur.currency ? HIT : cur.indeterminate ? UNKNOWN : MISS,
    status: cur.status,
    reason: cur.currency ? `adopted ${cur.currency} (${cur.evidence})` : (cur.reason ?? null),
  });
  if (cur.currency) {
    for (const p of products) {
      p.currency = cur.currency;
      p.currencyEvidence = cur.evidence ?? null;
    }
  }
}

/**
 * Try each feed rung in order, or — for a platform already classified as closed — route straight
 * to the matching page rung over the product URLs we hold (for `custom` and `jsonld`, together
 * with the ones its sitemap lists). Never asks a known-shut feed again.
 */
export async function attemptFeeds(
  baseUrl: string,
  fetchText: FetchText,
  opts: { platform?: Platform | null; knownProductUrls?: string[]; rungs?: readonly FeedRung[]; sleep?: Sleep } = {},
): Promise<LadderResult> {
  const counted = counting(fetchText);
  const rungs = opts.rungs ?? RUNGS;
  const platform = opts.platform ?? null;
  const held = (opts.knownProductUrls ?? []).filter((u) => typeof u === "string" && u.trim());
  // A custom-built or page-data shop has no product feed: its sitemap is how new products are found
  // (the URLs already held keep being read). Other platforms are read exactly as before.
  const discovery = platform === "custom" || platform === "jsonld" ? await discoverProductUrls(baseUrl, counted.fetchText, { sleep: opts.sleep }) : null;
  if (discovery?.rateLimited) {
    // A 429 while its sitemap was read: nothing further is asked of this shop in the run.
    return { state: UNKNOWN, rung: null, products: [], attempts: [], fetches: counted.count(), complete: false, truncatedParentIds: [], unenumeratedParentIds: [], reason: `${discovery.reason} (http 429)` };
  }
  const knownUrls = [...new Set([...held, ...(discovery?.urls ?? [])])];

  const pageRoute = pageRungsFor(platform);
  if (pageRoute && knownUrls.length > 0) {
    const out = await attemptPageRungs(knownUrls, counted.fetchText, { rungs: pageRoute, sleep: opts.sleep });
    if (out.state === HIT && out.rung === "shopify_product_js") await adoptShopifyStoreCurrency(out.products, out.attempts, counted.fetchText);
    return { ...out, fetches: counted.count() };
  }
  if (platform === "woocommerce_closed_api" || platform === "shopify_closed_api") {
    // Nothing was TRIED: neither a HIT nor a vendor answering "no".
    return { state: UNKNOWN, rung: null, products: [], attempts: [], fetches: 0, complete: false, truncatedParentIds: [], unenumeratedParentIds: [], reason: `platform ${platform} needs known product urls and none were given (nothing was tried)` };
  }

  const attempts: Attempt[] = [];
  let sawUnknown = false;
  const base = baseUrl.replace(/\/$/, "");
  const sleep = opts.sleep ?? realSleep;
  // "Too many requests" from this vendor, on any request: nothing further is asked of it in this run.
  let rateLimited = false;

  for (const rung of rungs) {
    const url = `${base}${rung.path}`;
    const res = await counted.fetchText(url, { accept: "application/json" });
    if (res.state !== HIT) {
      if (res.state === UNKNOWN) sawUnknown = true;
      attempts.push({ rung: rung.source, url, state: res.state, status: res.status, reason: res.error ?? `http ${res.status ?? "?"}` });
      if (res.status === RATE_LIMITED_STATUS) break; // not the next rung either
      continue;
    }
    const parsed = rung.parse(res.body, { baseUrl: base, fetchUrl: url });
    attempts.push({ rung: rung.source, url, state: parsed.state, status: res.status, reason: parsed.reason });
    if (parsed.state !== HIT) continue;

    const products = [...parsed.products];
    let variable: WooVariableParent[] = parsed.variable ?? [];
    // Bounded pagination on the RAW count. A failed later page ENDS the walk and keeps everything
    // already collected — the vendor HIT; losing page 1 to a page-3 hiccup would be the ladder
    // shrinking itself on bad days. But such a read is INCOMPLETE: what it did not return is
    // unknown, and only a read that reached the END of the catalogue may say a product is absent.
    let complete = true;
    if (parsed.rawCount === rung.page.size) {
      const byCursor = rung.page.param === "since_id";
      let cursor = byCursor ? (parsed.lastId ?? null) : null;
      let lastRaw = parsed.rawCount;
      let page = 2;
      for (; page <= rung.page.max && lastRaw === rung.page.size; page++) {
        if (byCursor && cursor === null) {
          attempts.push({ rung: rung.source, url, state: MISS, status: 200, reason: `page ${page}: no since_id cursor in the previous page` });
          complete = false;
          lastRaw = 0;
          break;
        }
        const pageUrl = `${url}&${rung.page.param}=${byCursor ? String(cursor) : page}`;
        await sleep(REQUEST_PAUSE_MS);
        const pres = await counted.fetchText(pageUrl, { accept: "application/json" });
        if (pres.status === RATE_LIMITED_STATUS) rateLimited = true;
        if (pres.state !== HIT) {
          attempts.push({ rung: rung.source, url: pageUrl, state: UNKNOWN, status: pres.status, reason: `page ${page}: ${pres.error ?? `http ${pres.status ?? "?"}`}` });
          complete = false;
          lastRaw = 0;
          break;
        }
        const pp = rung.parse(pres.body, { baseUrl: base, fetchUrl: pageUrl });
        if (pp.state !== HIT && pp.rawCount === undefined) {
          // A 200 that is not the feed (a challenge page): NOT the end of the catalogue.
          attempts.push({ rung: rung.source, url: pageUrl, state: UNKNOWN, status: 200, reason: `page ${page}: ${pp.reason}` });
          complete = false;
          lastRaw = 0;
          break;
        }
        attempts.push({ rung: rung.source, url: pageUrl, state: pp.state, status: 200, reason: pp.state === HIT ? `page ${page}` : `page ${page}: ${pp.reason}` });
        // An EMPTY tail page is the end of the catalogue, not a vendor MISS; a page of products
        // with nothing priced is still a page, and the walk goes on while pages come back full.
        products.push(...pp.products);
        if (pp.variable?.length) variable = [...variable, ...pp.variable];
        cursor = byCursor ? (pp.lastId ?? null) : null;
        lastRaw = pp.rawCount ?? 0;
      }
      if (lastRaw === rung.page.size) {
        attempts.push({ rung: rung.source, url, state: UNKNOWN, status: null, reason: `page ceiling (${rung.page.max}) reached on a full page — the catalogue continues past what was read` });
        complete = false;
      }
    }
    let variationFetches = 0;
    let truncatedParentIds: string[] = [];
    let unenumeratedParentIds: string[] = [];
    if (rung.source === "woo_store_api" && variable.length > 0) {
      const resolved = await resolveWooVariableParents(variable, base, counted.fetchText, { sleep: opts.sleep, alreadyRateLimited: rateLimited });
      variationFetches = resolved.fetches;
      products.push(...resolved.products);
      attempts.push(...resolved.attempts);
      truncatedParentIds = resolved.truncatedParentIds;
      unenumeratedParentIds = resolved.unenumeratedParentIds;
      // A variation list that could not be read, or was cut short, leaves the read incomplete too.
      if (resolved.attempts.some((a) => a.state === UNKNOWN)) complete = false;
    }
    if (rung.source === "shopify_products_json") await adoptShopifyStoreCurrency(products, attempts, counted.fetchText);
    return { state: HIT, rung: rung.source, products, attempts, fetches: counted.count(), variationFetches, reason: null, complete, truncatedParentIds, unenumeratedParentIds };
  }

  return {
    state: sawUnknown ? UNKNOWN : MISS,
    rung: null,
    products: [],
    attempts,
    fetches: counted.count(),
    reason: sawUnknown ? "at least one rung was indeterminate" : "no rung produced products",
    complete: false,
    truncatedParentIds: [],
    unenumeratedParentIds: [],
  };
}

/**
 * Run a page rung over product URLs we already hold: paced (two at a time, a pause between), NO
 * RETRIES, one attempt per URL, `dead: true` on a 404/410, and a full stop at the first 429 —
 * the URLs not asked about are UNKNOWN, never dead. The rung is REQUIRED (by name or by platform): each rung costs
 * one fetch PER URL, so defaulting to the whole table would silently triple fetch volume.
 */
export async function attemptPageRungs(
  productUrls: string[],
  fetchText: FetchText,
  opts: { rungs?: readonly PageRung[]; platform?: Platform | null } & PacingOptions = {},
): Promise<LadderResult> {
  const rungs = opts.rungs ?? pageRungsFor(opts.platform) ?? [];
  if (rungs.length === 0) {
    throw new Error("attemptPageRungs: a rung is required (`rungs` or a closed `platform`) — each rung costs one fetch PER URL, so there is no safe default");
  }
  const urls = (productUrls ?? []).filter((u) => typeof u === "string" && u.trim());
  const attempts: Attempt[] = [];
  let fetches = 0;
  // A page rung reads the URLs it was given: it is never a catalogue read, complete or otherwise.
  const notACatalogue = { complete: false, truncatedParentIds: [], unenumeratedParentIds: [] };
  if (urls.length === 0) return { state: UNKNOWN, rung: null, products: [], attempts, fetches, reason: "no product urls given (nothing was tried)", ...notACatalogue };

  for (const rung of rungs) {
    const slots: ({ attempt: Attempt; products: Product[] } | undefined)[] = new Array(urls.length);
    let rateLimited = false;
    const runOne = async (i: number) => {
      fetches++;
      const out = await rung.fetch(urls[i], fetchText);
      if (out.status === RATE_LIMITED_STATUS) rateLimited = true;
      slots[i] = {
        attempt: { rung: rung.source, url: urls[i], state: out.state, status: out.status, reason: out.reason, ...(out.dead ? { dead: true } : {}) },
        products: out.products,
      };
    };
    const notAsked = await runPaced(urls.length, runOne, { concurrency: opts.concurrency, pauseMs: opts.pauseMs, sleep: opts.sleep, stopped: () => rateLimited });
    for (const i of notAsked) slots[i] = { attempt: { rung: rung.source, url: urls[i], state: UNKNOWN, status: null, reason: NOT_ASKED_REASON }, products: [] };
    const products: Product[] = [];
    let sawUnknown = false;
    for (const slot of slots) {
      if (!slot) continue;
      attempts.push(slot.attempt);
      products.push(...slot.products);
      if (slot.attempt.state === UNKNOWN) sawUnknown = true;
    }
    if (products.length > 0) return { state: HIT, rung: rung.source, products, attempts, fetches, reason: null, ...notACatalogue };
    if (sawUnknown) return { state: UNKNOWN, rung: null, products: [], attempts, fetches, reason: "at least one product page was indeterminate", ...notACatalogue };
  }
  return { state: MISS, rung: null, products: [], attempts, fetches, reason: "no page rung produced products", ...notACatalogue };
}

/**
 * The text the quantity owners parse: the parent name plus the variant label when there is one.
 * A variant that states its own mass is the authority on it — the parent's name then contributes
 * its WORDS (pack, form), not its figures. "MOTS-C Peptide (20MG)" / "Peptide Content: 10mg" is a
 * 10 mg vial; reading the name's 20 halves its per-mg.
 */
/** "BPC-157 (10mg vials)": the name states ONE vial's mass, in the plural — it is sold as several. */
const VIAL_MASS_IN_NAME_RE = /(?<![\w.])(\d+(?:\.\d+)?)\s*mg\s+vials\b/i;
/** "BPC-157 (10mg vials)": the name states one vial's mass and the variant states the total bought. */
export const statesVialMassInName = (name: string): boolean => VIAL_MASS_IN_NAME_RE.test(name);
const MG_FIGURE_RE = /(?<![\w.])(\d+(?:\.\d+)?)\s*mg\b/gi;

export function quantityTextFor(p: Product): string {
  if (!p.variantLabel) return p.name;
  // "BPC-157 (10mg vials)" / "QUANTITY (MG): 100 mg": the variant states the TOTAL the price buys,
  // of vials whose size the name states — ten 10 mg vials, not one 100 mg vial. A total that is
  // not a whole number of those vials leaves what the price buys unknown, and is refused.
  const perVial = VIAL_MASS_IN_NAME_RE.exec(p.name);
  const totals = perVial ? [...normalizeQuantityText(p.variantLabel).matchAll(MG_FIGURE_RE)] : [];
  if (perVial && totals.length === 1) {
    const vialMg = Number(perVial[1]);
    const count = Number(totals[0][1]) / vialMg;
    if (Number.isInteger(count) && count >= 1) return `${stripMassTokens(p.name)} ${count} x ${vialMg}mg`;
    return `${p.name} ${p.variantLabel} (pack)`;
  }
  const name = statesMass(p.variantLabel) ? stripMassTokens(p.name) : p.name;
  return [name, p.variantLabel].filter(Boolean).join(" ");
}

/** Apply the SHARED quantity owner to ladder output. A wiring step, not a derivation:
 *  `canonicalVialMg` does the work; a rejected product carries its TYPED reason. */
export function withCanonicalQuantity(products: Product[]): Product[] {
  return products.map((p) => ({ ...p, quantity: canonicalVialMg(quantityTextFor(p)) }));
}

/**
 * The stored price must appear in the raw text captured beside it. Every number in the raw text
 * counts (a sale price beside a struck-through original is two legitimate numbers); a raw anchor
 * may declare its own scale (`minor_unit=2`). A product with NO raw text is invalid — absence of
 * evidence is not evidence.
 */
export function validateAgainstRawText(product: Pick<Product, "rawPriceText" | "priceMinor" | "currency">, tolerance = 0.01): { ok: boolean; reason?: string } {
  const raw = product.rawPriceText;
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "no raw price text to validate against" };
  if (product.priceMinor === null || !(product.priceMinor > 0)) return { ok: false, reason: "no positive price" };
  let numbers = (raw.replace(/[, ]/g, "").match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (numbers.length === 0) return { ok: false, reason: "raw price text contains no number" };
  const declared = /minor_unit=(\d+)/.exec(raw);
  if (declared) {
    // A declared scale is THE scale: the unscaled integer must never vouch for a ×100 price.
    const exp = Number(declared[1]);
    numbers = numbers.map((n) => n / 10 ** exp);
  }
  const amount = product.priceMinor / 10 ** currencyExponent(product.currency ?? "");
  const hit = numbers.some((n) => Math.abs(n - amount) <= tolerance * Math.max(n, amount));
  return hit ? { ok: true } : { ok: false, reason: `price ${minorToMajorText(product.priceMinor, product.currency)} appears in none of [${numbers.join(", ")}]` };
}

export type { FetchState, LadderResult, Product };
