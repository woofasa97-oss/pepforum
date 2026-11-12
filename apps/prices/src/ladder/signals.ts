/**
 * Pure extractors over already-fetched HTML: page-authored currency signals (Open Graph
 * product:price:currency, schema.org priceCurrency), the og price amount, adjacent JSON-LD
 * (price, currency) pairs, the page product name, the label slug and the schema.org
 * availability map. Nothing here fetches. Ported from PeptideBase's
 * structured-currency-signals.mjs and woo-embedded-variations.mjs.
 */
import type { Availability, CurrencyEvidence } from "./types.ts";

/** A stable key for a variant the platform gave no id to: lowercase, non-alphanumeric runs → '-'. */
export function slugifyLabel(label: unknown): string {
  if (label == null) return "";
  return String(label).toLowerCase().match(/[a-z0-9]+/g)?.join("-") ?? "";
}

/** schema.org `availability` → our vocabulary. An UNRECOGNISED value is unknown, never out_of_stock. */
export function mapSchemaAvailability(value: unknown): Availability {
  if (typeof value !== "string" || !value.trim()) return "unknown";
  const token = value.trim().replace(/^.*[/:#]/, "").toLowerCase();
  if (token === "instock" || token === "limitedavailability" || token === "onlineonly" || token === "instoreonly") return "in_stock";
  if (token === "outofstock" || token === "soldout" || token === "discontinued") return "out_of_stock";
  if (token === "backorder") return "backorder";
  if (token === "preorder") return "preorder";
  return "unknown";
}

/** `<meta property="product:price:currency" content="AUD">` (or og:price:currency), either attribute order. */
export function extractOgCurrency(html: unknown): string | null {
  if (typeof html !== "string" || !html) return null;
  const patterns = [
    /<meta[^>]+property=["']product:price:currency["'][^>]+content=["']([A-Za-z]{3})["']/i,
    /<meta[^>]+content=["']([A-Za-z]{3})["'][^>]+property=["']product:price:currency["']/i,
    /<meta[^>]+property=["']og:price:currency["'][^>]+content=["']([A-Za-z]{3})["']/i,
    /<meta[^>]+content=["']([A-Za-z]{3})["'][^>]+property=["']og:price:currency["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

/** The FIRST `"priceCurrency": "GBP"` in the page. A scoped regex survives a malformed sibling block. */
export function extractJsonLdCurrency(html: unknown): string | null {
  if (typeof html !== "string" || !html) return null;
  const m = /"priceCurrency"\s*:\s*"([A-Za-z]{3})"/i.exec(html);
  return m ? m[1].toUpperCase() : null;
}

/** The page-level og price AMOUNT: a positive number or null — never 0, never a guess. */
export function extractOgPriceAmount(html: unknown): number | null {
  if (typeof html !== "string" || !html) return null;
  const patterns = [
    /<meta[^>]+property=["'](?:product|og):price:amount["'][^>]+content=["']([0-9]+(?:\.[0-9]+)?)["']/i,
    /<meta[^>]+content=["']([0-9]+(?:\.[0-9]+)?)["'][^>]+property=["'](?:product|og):price:amount["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) {
      const n = Number(m[1]);
      if (n > 0) return n;
    }
  }
  return null;
}

/** Only amounts ADJACENT to a currency code in the same offer object, both key orders, all
 *  occurrences. An unpaired amount must never donate its currency to the main product. */
export function extractJsonLdPricePairs(html: unknown): { amount: number; currency: string }[] {
  if (typeof html !== "string" || !html) return [];
  const pairs: { amount: number; currency: string }[] = [];
  const forward = /"price"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?\s*,\s*"priceCurrency"\s*:\s*"([A-Za-z]{3})"/gi;
  const backward = /"priceCurrency"\s*:\s*"([A-Za-z]{3})"\s*,\s*"price"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?/gi;
  for (const m of html.matchAll(forward)) {
    const amount = Number(m[1]);
    if (amount > 0) pairs.push({ amount, currency: m[2].toUpperCase() });
  }
  for (const m of html.matchAll(backward)) {
    const amount = Number(m[2]);
    if (amount > 0) pairs.push({ amount, currency: m[1].toUpperCase() });
  }
  return pairs;
}

/**
 * The page's OWN currency declaration — og and/or JSON-LD `priceCurrency`. Two signals that
 * DISAGREE resolve to null rather than to either.
 */
export function pageCurrencySignal(html: unknown): { currency: string | null; evidence: CurrencyEvidence | null; reason: string | null } {
  const og = extractOgCurrency(html);
  const ld = extractJsonLdCurrency(html);
  if (og && ld) {
    return og === ld
      ? { currency: og, evidence: "og_and_jsonld", reason: null }
      : { currency: null, evidence: null, reason: `page currency signals disagree (og ${og} vs jsonld ${ld})` };
  }
  if (og) return { currency: og, evidence: "og_currency", reason: null };
  if (ld) return { currency: ld, evidence: "jsonld_currency", reason: null };
  return { currency: null, evidence: null, reason: "page carries no og/JSON-LD currency" };
}

/** HTML attribute values can hold only the five predefined entities plus numeric refs. `&amp;`
 *  LAST: decoding it first would turn `&amp;quot;` into a quote and corrupt the JSON. */
export function decodeAttribute(value: unknown): string {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#0?34;/g, '"')
    .replace(/&apos;|&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", trade: "™", reg: "®", copy: "©", times: "×", micro: "µ", deg: "°",
};
const codePoint = (n: number, original: string): string => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : original);

/**
 * Rendered HTML text → the text a person reads. The WooCommerce Store API returns product names
 * through WordPress's texturizer ("BPC-157 5mg &#8211; 60 units"), so a name is decoded ONCE
 * before anything parses or stores it. One level only: `&amp;#8211;` is a literal "&#8211;".
 */
export function decodeEntities(value: unknown): string {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);|&#(\d+);|&([a-z]+);/gi, (m: string, hex?: string, dec?: string, named?: string) => {
      if (hex !== undefined) return codePoint(parseInt(hex, 16), m);
      if (dec !== undefined) return codePoint(Number(dec), m);
      return NAMED_ENTITIES[(named ?? "").toLowerCase()] ?? m;
    })
    .replace(/\u00a0/g, " ");
}

/** The page's product name: og:title, then <title> without the vendor suffix, then the first <h1>. */
export function extractPageProductName(html: unknown): string | null {
  if (typeof html !== "string" || !html) return null;
  const og =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html) ??
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i.exec(html);
  if (og) return decodeAttribute(og[1]).trim() || null;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title) {
    const text = decodeAttribute(title[1]).replace(/\s+/g, " ").trim();
    const head = text.split(/\s+[–—|]\s+/)[0].trim();
    if (head) return head;
  }
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1) {
    const text = decodeAttribute(h1[1].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return null;
}
