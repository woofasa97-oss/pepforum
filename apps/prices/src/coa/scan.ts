/**
 * Finds links that look like certificates of analysis in a page or feed the pipeline already
 * captured. Deliberately shallow: it reports addresses, never what a document says. A person opens
 * each one and records what it states (docs/PRICES.md, "Certificates of analysis").
 */

/** Words in an address that mark a lab document. Checked against the path and query, not the host. */
const COA_WORDS = /(?:^|[^a-z])(?:coa|coas|c-of-a|certificate[-_ ]?of[-_ ]?analysis|certificat[-_ ]?d[-_ ]?analyse|lab[-_ ]?(?:report|result|results|test|tests)|hplc|purity[-_ ]?(?:report|test))(?:[^a-z]|$)/i;
/** Labs whose public report pages vendors link to: any address on these hosts is a candidate. */
const LAB_HOSTS = /(?:^|\.)(?:janoshik\.com|vialtests\.com|mapletesting\.ca)$/i;
const DOCUMENT = /\.(?:pdf|png|jpe?g|webp)$/i;
const MAX_LINKS = 50;
const MAX_URL = 1000;

/** JSON feeds escape slashes ("https:\/\/…") and HTML escapes ampersands; undo both before matching. */
function unescape(body: string): string {
  return body.replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/&amp;/g, "&");
}

/**
 * Every distinct https link in `body` that looks like a certificate: a document or page whose path
 * names one, or any page on a known testing lab's site. `pageUrl` resolves relative links.
 */
export function findCoaLinks(body: string, pageUrl?: string): string[] {
  const text = unescape(body);
  const found = new Set<string>();
  const candidates = [
    ...[...text.matchAll(/https:\/\/[^\s"'<>\\)]+/g)].map((m) => m[0]),
    ...[...text.matchAll(/(?:href|src)\s*=\s*["']([^"'\s<>]+)["']/gi)].map((m) => m[1]),
  ];
  for (const raw of candidates) {
    if (found.size >= MAX_LINKS) break;
    let url: URL;
    try {
      url = new URL(raw.replace(/[.,;]+$/, ""), pageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") continue;
    url.hash = "";
    const href = url.toString();
    if (href.length > MAX_URL) continue;
    const where = decodeURIComponent(url.pathname).toLowerCase() + url.search.toLowerCase();
    const named = COA_WORDS.test(where);
    if (LAB_HOSTS.test(url.hostname) ? where.length > 1 : named && (DOCUMENT.test(url.pathname) || /coa|certificate|analys/i.test(where))) found.add(href);
  }
  return [...found];
}

/** The compound an address names, if exactly one fits best: the longest slug found in it as whole tokens. */
export function matchCompoundSlug(url: string, slugs: readonly string[]): string | null {
  let text: string;
  try {
    const u = new URL(url);
    text = decodeURIComponent(u.pathname + u.search);
  } catch {
    return null;
  }
  const tokens = `-${text.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-`;
  const hits = slugs.filter((slug) => tokens.includes(`-${slug}-`)).sort((a, b) => b.length - a.length);
  if (hits.length === 0) return null;
  // Two different compounds of the same length in one address: not ours to guess.
  return hits.length > 1 && hits[1].length === hits[0].length ? null : hits[0];
}
