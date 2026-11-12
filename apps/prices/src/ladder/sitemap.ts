/**
 * The product pages a shop lists in its sitemap — the only way to find a custom-built shop's
 * products, which has no product feed. Reads the sitemaps robots.txt names (else /sitemap.xml),
 * follows one level of sitemap index (product sitemaps first) and keeps this shop's own
 * product-looking pages. Every request goes through the pipeline's fetcher, which honours
 * robots.txt; nothing here retries. Requests are paced, and a 429 stops discovery at once: nothing
 * further is asked of that shop in the run (the pacing contract).
 */
import { RATE_LIMITED_STATUS, REQUEST_PAUSE_MS, realSleep, type Sleep } from "../fetch/pacing.ts";
import type { FetchText } from "../fetch/types.ts";

const PRODUCT_PATH = /^\/(?:products?|shop)\/[^/?#]+\/?$/i;
const MAX_URLS = 400;
const MAX_ROOT_SITEMAPS = 3;
const MAX_CHILD_SITEMAPS = 10;

const locsOf = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
const hostOf = (u: URL) => u.hostname.replace(/^www\./, "");

export async function discoverProductUrls(
  baseUrl: string,
  fetchText: FetchText,
  opts: { sleep?: Sleep } = {},
): Promise<{ urls: string[]; reason: string; rateLimited: boolean }> {
  const base = new URL(baseUrl);
  const sleep = opts.sleep ?? realSleep;
  let rateLimited = false;
  let asked = 0;
  const read = async (url: string): Promise<string | null> => {
    if (rateLimited) return null;
    if (asked++ > 0) await sleep(REQUEST_PAUSE_MS);
    const res = await fetchText(url, { accept: "application/xml, text/xml, text/plain" });
    if (res.status === RATE_LIMITED_STATUS) rateLimited = true;
    return res.state === "hit" && res.body ? res.body : null;
  };

  const robots = await read(new URL("/robots.txt", base).toString());
  const named = robots ? [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]) : [];
  const roots = (named.length > 0 ? named : [new URL("/sitemap.xml", base).toString()]).slice(0, MAX_ROOT_SITEMAPS);

  const pages: string[] = [];
  let children = 0;
  for (const root of roots) {
    if (rateLimited) break;
    const xml = await read(root);
    if (!xml) continue;
    if (!/<sitemapindex/i.test(xml)) {
      pages.push(...locsOf(xml));
      continue;
    }
    // One level only: a child that is itself an index is not followed.
    const kids = locsOf(xml).sort((a, b) => Number(/product/i.test(b)) - Number(/product/i.test(a)));
    for (const kid of kids) {
      if (children >= MAX_CHILD_SITEMAPS || rateLimited) break;
      children++;
      const child = await read(kid);
      if (child && !/<sitemapindex/i.test(child)) pages.push(...locsOf(child));
    }
  }

  const host = hostOf(base);
  const urls = [
    ...new Set(
      pages.filter((u) => {
        try {
          const p = new URL(u);
          return hostOf(p) === host && PRODUCT_PATH.test(p.pathname);
        } catch {
          return false;
        }
      }),
    ),
  ].slice(0, MAX_URLS);
  if (rateLimited) return { urls: [], reason: "sitemap: the shop answered 429; nothing further asked", rateLimited };
  return { urls, reason: urls.length > 0 ? `sitemap: ${urls.length} product urls` : "sitemap: no product urls found", rateLimited };
}
