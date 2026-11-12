/**
 * Currency resolution. THE TRAP: a bare "$" is ambiguous (real stores show "$" and price in AUD
 * or CAD). A currency is adopted ONLY from a vendor-authored structured signal: the Woo Store
 * API's `currency_code`, a Shopify store's `/meta.json`, an Open Graph `product:price:currency`
 * or a schema.org `priceCurrency` — and for Shopify pages only when the page amount equals the
 * feed amount (the number-anchored rule, which defeats Shopify Markets geo-presentment). Vendor
 * country and TLD are NOT signals: a Canadian vendor may price in USD, and a `.com` says nothing.
 * Unresolved rows are refused as `currency_unresolved`, never defaulted.
 */
import type { FetchText } from "../fetch/types.ts";
import { majorToMinor } from "./amounts.ts";
import { extractJsonLdPricePairs, extractOgCurrency, extractOgPriceAmount } from "./signals.ts";
import type { CurrencyEvidence, Product } from "./types.ts";

/** Currencies the schema admits (`offers.native_currency`). A structured signal outside this set is not adopted. */
export const SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set(["USD", "CAD", "GBP", "AUD", "NZD", "EUR"]);

export function normalizeStructuredCode(code: unknown): string | null {
  const upper = String(code ?? "").trim().toUpperCase();
  return SUPPORTED_CURRENCIES.has(upper) ? upper : null;
}

export type CurrencySource = "woo" | "og" | "jsonld" | "unresolved";

/** Rank whatever structured signals were already extracted. Pure; never guesses. */
export function resolveCurrency(input: { wooCurrencyCode?: string | null; ogCurrency?: string | null; jsonLdCurrency?: string | null }): {
  currency: string | null;
  source: CurrencySource;
} {
  const woo = normalizeStructuredCode(input.wooCurrencyCode);
  if (woo) return { currency: woo, source: "woo" };
  const og = normalizeStructuredCode(input.ogCurrency);
  if (og) return { currency: og, source: "og" };
  const ld = normalizeStructuredCode(input.jsonLdCurrency);
  if (ld) return { currency: ld, source: "jsonld" };
  return { currency: null, source: "unresolved" };
}

export interface DenylistEntry {
  ruling: string;
  ruled: string;
  reason: string;
}

/**
 * Stores whose store-currency adoption is REFUSED BY RULING: vantage-varying markup defeats the
 * single-vantage anchor. Keyed by hostname (www-stripped). Empty for PepSpotter today; the
 * mechanism is kept because PeptideBase paid for it (a UK store showed one runner a clean og USD
 * pair and another runner money ×100,000). Adding an entry is an owner ruling.
 */
export const CURRENCY_VANTAGE_DENYLIST: Record<string, DenylistEntry> = {};

/** An integer JSON-LD amount three-plus orders of magnitude off the anchor is broken money
 *  encoding; a page that serializes money incoherently forfeits currency adoption. */
const INCOHERENT_SCALE_RATIO = 1000;
const incoherentAgainstAnchor = (amount: number, anchorMajor: number) =>
  Number.isInteger(amount) && (amount >= anchorMajor * INCOHERENT_SCALE_RATIO || amount <= anchorMajor / INCOHERENT_SCALE_RATIO);

export interface MetaProbe {
  currency: string | null;
  reason: string | null;
  url: string;
  status: number | null;
}

export interface StoreCurrencyVerdict {
  currency: string | null;
  evidence?: CurrencyEvidence;
  reason?: string;
  indeterminate?: boolean;
  url: string | null;
  status: number | null;
  /** The /meta.json probe when it happened and did NOT answer, so the caller can record the fetch it paid for. */
  meta: MetaProbe | null;
}

/** Shopify `/meta.json`: the store's OWN declaration of its base currency — consulted first. */
export async function resolveShopifyCurrencyFromMeta(origin: string, fetchText: FetchText): Promise<MetaProbe> {
  const url = `${origin.replace(/\/$/, "")}/meta.json`;
  const res = await fetchText(url, { accept: "application/json" });
  if (res.state !== "hit") return { currency: null, reason: res.error ? `meta.json ${res.error}` : `meta.json http ${res.status ?? "?"}`, url, status: res.status };
  let json: unknown;
  try {
    json = JSON.parse(res.body ?? "");
  } catch {
    return { currency: null, reason: "meta.json is not json", url, status: 200 };
  }
  const code = typeof json === "object" && json !== null ? (json as { currency?: unknown }).currency : undefined;
  if (typeof code !== "string" || !/^[A-Za-z]{3}$/.test(code.trim())) {
    return { currency: null, reason: "meta.json carries no 3-letter currency", url, status: 200 };
  }
  const normalized = normalizeStructuredCode(code);
  if (!normalized) return { currency: null, reason: `meta.json currency ${code.trim().toUpperCase()} is not one this pipeline admits`, url, status: 200 };
  return { currency: normalized, reason: null, url, status: 200 };
}

/**
 * Resolve a Shopify store's currency for products that carry none. Costs at most TWO fetches:
 * `/meta.json`, then the anchor product page when meta.json does not answer. The denylist is
 * consulted BEFORE any fetch, so a ruled store costs zero requests.
 */
export async function resolveShopifyStoreCurrency(
  products: Product[],
  fetchText: FetchText,
  opts: { denylist?: Record<string, DenylistEntry> } = {},
): Promise<StoreCurrencyVerdict> {
  const denylist = opts.denylist ?? CURRENCY_VANTAGE_DENYLIST;
  const anchor = products.find((p) => p.productUrl && p.priceMinor !== null && p.priceMinor > 0);
  if (!anchor || !anchor.productUrl || anchor.priceMinor === null) {
    return { currency: null, reason: "no anchor product with a url", url: null, status: null, meta: null };
  }
  let host: string | null = null;
  let origin: string | null = null;
  try {
    const parsed = new URL(anchor.productUrl);
    host = parsed.hostname.replace(/^www\./, "");
    origin = parsed.origin;
  } catch {
    /* unparseable url → no denylist match; the fetch below fails on its own */
  }
  const denied = host ? denylist[host] : undefined;
  if (denied) {
    return { currency: null, reason: `vantage-denylisted by ruling ${denied.ruling} (${denied.ruled})`, url: anchor.productUrl, status: null, meta: null };
  }

  let meta: MetaProbe | null = null;
  if (origin) {
    const m = await resolveShopifyCurrencyFromMeta(origin, fetchText);
    if (m.currency) return { currency: m.currency, evidence: "meta_json", url: m.url, status: m.status, meta: null };
    meta = m;
  }
  const verdict = await resolveFromAnchorPage(anchor.productUrl, anchor.priceMinor, fetchText);
  return { ...verdict, meta };
}

/** The number-anchored page-pair resolver: og pair first (a MISMATCH refuses outright), then a
 *  JSON-LD pair whose amount matches; two matching pairs that disagree refuse as a conflict. */
async function resolveFromAnchorPage(productUrl: string, anchorMinor: number, fetchText: FetchText): Promise<Omit<StoreCurrencyVerdict, "meta">> {
  const res = await fetchText(productUrl, { accept: "text/html" });
  if (res.state !== "hit" || typeof res.body !== "string") {
    const reason = res.error ? `anchor fetch ${res.error}` : `http ${res.status ?? "?"}`;
    return { currency: null, reason, indeterminate: res.state === "unknown", url: productUrl, status: res.status };
  }
  const html = res.body;
  const anchorMajor = anchorMinor / 100;
  // ±1 minor unit: a page amount equals the feed amount, or it does not.
  const matches = (amountMajor: number) => {
    const minor = majorToMinor(String(amountMajor), null);
    return minor !== null && Math.abs(minor - anchorMinor) <= 1;
  };

  const jsonldPairs = extractJsonLdPricePairs(html);
  const incoherent = jsonldPairs.find((p) => incoherentAgainstAnchor(p.amount, anchorMajor));
  if (incoherent) {
    return { currency: null, reason: `money serialization incoherent (jsonld ${incoherent.amount} vs anchor ${anchorMajor}) — trust withdrawn`, url: productUrl, status: 200 };
  }

  const ogCurrency = extractOgCurrency(html);
  const ogAmount = extractOgPriceAmount(html);
  if (ogCurrency && ogAmount !== null) {
    if (!matches(ogAmount)) {
      return { currency: null, reason: `amount mismatch (og ${ogAmount} ${ogCurrency} vs anchor ${anchorMajor} — presentment?)`, url: productUrl, status: 200 };
    }
    const normalized = normalizeStructuredCode(ogCurrency);
    return normalized
      ? { currency: normalized, evidence: "og_pair", url: productUrl, status: 200 }
      : { currency: null, reason: `og currency ${ogCurrency} is not one this pipeline admits`, url: productUrl, status: 200 };
  }

  const agreeing = [...new Set(jsonldPairs.filter((p) => matches(p.amount)).map((p) => p.currency))];
  if (agreeing.length === 1) {
    const normalized = normalizeStructuredCode(agreeing[0]);
    return normalized
      ? { currency: normalized, evidence: "jsonld_pair", url: productUrl, status: 200 }
      : { currency: null, reason: `jsonld currency ${agreeing[0]} is not one this pipeline admits`, url: productUrl, status: 200 };
  }
  if (agreeing.length > 1) return { currency: null, reason: `conflicting page signals (${agreeing.join(", ")})`, url: productUrl, status: 200 };
  return {
    currency: null,
    reason: ogCurrency || jsonldPairs.length ? "no page pair matches the anchor amount" : "no page currency signal",
    url: productUrl,
    status: 200,
  };
}
