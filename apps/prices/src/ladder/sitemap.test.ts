import { describe, expect, it } from "vitest";
import type { FetchResult, FetchText } from "../fetch/types.ts";
import { discoverProductUrls } from "./sitemap.ts";

const AT = "2026-10-03T00:00:00.000Z";
const site = (pages: Record<string, string | number>): FetchText & { asked: string[] } => {
  const asked: string[] = [];
  const fn = (async (url: string): Promise<FetchResult> => {
    asked.push(url);
    const page = pages[url];
    if (typeof page === "string") return { url, status: 200, state: "hit", body: page, fetchedAt: AT };
    const status = page ?? 404;
    return { url, status, state: status === 403 || status === 429 ? "unknown" : "miss", body: null, fetchedAt: AT };
  }) as FetchText & { asked: string[] };
  fn.asked = asked;
  return fn;
};
const urlset = (...locs: string[]) => `<?xml version="1.0"?><urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join("")}</urlset>`;

describe("finding a shop's product pages in its sitemap", () => {
  it("reads the sitemap robots.txt names and keeps this shop's product pages only", async () => {
    const fetchText = site({
      "https://shop.example/robots.txt": "User-Agent: *\nDisallow: /api/\n\nSitemap: https://shop.example/sitemap.xml\n",
      "https://shop.example/sitemap.xml": urlset(
        "https://shop.example",
        "https://shop.example/products",
        "https://shop.example/products/bpc5",
        "https://shop.example/products/bb20/",
        "https://www.shop.example/product/tb500",
        "https://shop.example/about",
        "https://other.example/products/bpc5",
        "https://shop.example/products/bpc5",
        "https://shop.example/products/a/b",
      ),
    });
    const out = await discoverProductUrls("https://shop.example", fetchText);
    expect(out.urls).toEqual(["https://shop.example/products/bpc5", "https://shop.example/products/bb20/", "https://www.shop.example/product/tb500"]);
    expect(out.reason).toBe("sitemap: 3 product urls");
  });

  it("falls back to /sitemap.xml when robots.txt names none", async () => {
    const fetchText = site({ "https://shop.example/robots.txt": "User-Agent: *\nAllow: /\n", "https://shop.example/sitemap.xml": urlset("https://shop.example/products/x") });
    expect((await discoverProductUrls("https://shop.example/", fetchText)).urls).toEqual(["https://shop.example/products/x"]);
  });

  it("follows a sitemap index one level, product sitemaps first, and never further", async () => {
    const fetchText = site({
      "https://shop.example/robots.txt": 404,
      "https://shop.example/sitemap.xml": `<sitemapindex><sitemap><loc>https://shop.example/pages.xml</loc></sitemap><sitemap><loc>https://shop.example/product-sitemap.xml</loc></sitemap></sitemapindex>`,
      "https://shop.example/product-sitemap.xml": urlset("https://shop.example/product/ghk-cu"),
      "https://shop.example/pages.xml": `<sitemapindex><sitemap><loc>https://shop.example/deeper.xml</loc></sitemap></sitemapindex>`,
    });
    const out = await discoverProductUrls("https://shop.example", fetchText);
    expect(out.urls).toEqual(["https://shop.example/product/ghk-cu"]);
    expect(fetchText.asked.indexOf("https://shop.example/product-sitemap.xml")).toBeLessThan(fetchText.asked.indexOf("https://shop.example/pages.xml"));
    expect(fetchText.asked).not.toContain("https://shop.example/deeper.xml");
  });

  it("finds nothing, and says so, when there is no readable sitemap", async () => {
    const out = await discoverProductUrls("https://shop.example", site({ "https://shop.example/robots.txt": 403 }));
    expect(out).toMatchObject({ urls: [], reason: "sitemap: no product urls found" });
  });

  it("keeps at most 400 product pages", async () => {
    const many = Array.from({ length: 450 }, (_, i) => `https://shop.example/products/p${i}`);
    const out = await discoverProductUrls("https://shop.example", site({ "https://shop.example/sitemap.xml": urlset(...many) }));
    expect(out.urls).toHaveLength(400);
  });
});

// Final review (page reader) I2: discovery keeps the pipeline's politeness contract.
describe("discovery is polite", () => {
  it("stops at the first 429: nothing further is asked of the shop", async () => {
    const fetchText = site({ "https://shop.example/robots.txt": 429, "https://shop.example/sitemap.xml": urlset("https://shop.example/products/x") });
    const out = await discoverProductUrls("https://shop.example", fetchText, { sleep: async () => {} });
    expect(out).toMatchObject({ urls: [], rateLimited: true });
    expect(fetchText.asked).toEqual(["https://shop.example/robots.txt"]);
  });

  it("pauses between its requests", async () => {
    const pauses: number[] = [];
    const fetchText = site({ "https://shop.example/robots.txt": "Sitemap: https://shop.example/sitemap.xml\n", "https://shop.example/sitemap.xml": urlset("https://shop.example/products/x") });
    await discoverProductUrls("https://shop.example", fetchText, { sleep: async (ms) => void pauses.push(ms) });
    expect(fetchText.asked).toHaveLength(2);
    expect(pauses.length).toBeGreaterThanOrEqual(1);
    expect(pauses.every((ms) => ms > 0)).toBe(true);
  });
});
