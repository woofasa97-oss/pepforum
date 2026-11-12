import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { FetchResult, FetchText } from "../fetch/types.ts";
import {
  attemptFeeds,
  attemptPageRungs,
  PAGE_RUNGS,
  RUNGS,
  statesVialMassInName,
  validateAgainstRawText,
  withCanonicalQuantity,
} from "./ladder.ts";
import type { Product } from "./types.ts";

const fx = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
const VARIABLE = fx("woo-store-products-variable.json");
const VARIATIONS_181 = fx("woo-store-variations-parent-181.json");
const PRODUCT_PAGE = fx("woo-product-page-handbuilt.html");
const META = fx("shopify-meta.json");

const AT = "2026-10-01T00:00:00.000Z";
const res = (url: string, status: number, body = ""): FetchResult => ({
  url,
  status,
  state: status === 200 ? "hit" : status === 403 || status === 429 || status >= 500 || (status > 200 && status < 300) ? "unknown" : "miss",
  body,
  fetchedAt: AT,
});
const ok = (body: string) => (url: string) => res(url, 200, body);
const failed = (url: string, error = "ETIMEDOUT"): FetchResult => ({ url, status: null, state: "unknown", body: null, fetchedAt: AT, error });
const status = (s: number): FetchText => async (url) => res(url, s);

/** `attemptFeeds` without real pauses; a test that asserts pacing passes its own `sleep`. */
const feeds: typeof attemptFeeds = (base, fetchText, opts = {}) => attemptFeeds(base, fetchText, { sleep: async () => {}, ...opts });

const wooProduct = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: "BPC-157 10mg",
  permalink: "https://v.example/product/bpc-157-10mg/",
  is_purchasable: true,
  is_in_stock: true,
  prices: { price: "5999", currency_code: "USD", currency_minor_unit: 2 },
  ...over,
});
const variableParent = (id: number) => ({
  id,
  name: `Pep-${id}`,
  type: "variable",
  permalink: `https://v.example/product/pep-${id}/`,
  is_purchasable: true,
  is_in_stock: true,
  is_on_backorder: false,
  variations: [{ id: id * 10, attributes: [{ name: "Size", value: "10mg" }] }],
  prices: { price: "4999", regular_price: "4999", currency_code: "USD", currency_minor_unit: 2, price_range: { min_amount: "4999", max_amount: "9999" } },
});
const shopPage = (ids: number[]) =>
  JSON.stringify({ products: ids.map((id) => ({ id, title: `Pep-${id} 10mg`, handle: `pep-${id}`, variants: [{ id: id * 10, title: "Default Title", price: "50.00", available: true }] })) });

describe("attemptFeeds — the three-state rule", () => {
  it("hits on the first rung and does not try the second", async () => {
    const tried: string[] = [];
    const r = await feeds("https://v.example", async (url) => {
      tried.push(url);
      return res(url, 200, JSON.stringify([wooProduct()]));
    });
    expect(r.state).toBe("hit");
    expect(r.rung).toBe("woo_store_api");
    expect(tried).toEqual(["https://v.example/wp-json/wc/store/v1/products?per_page=100"]);
    expect(r.fetches).toBe(1);
  });

  it("falls through a Woo miss to the Shopify rung and records the currency attempts", async () => {
    const r = await feeds("https://s.example", async (url) => {
      if (url.includes("wp-json")) return res(url, 404);
      if (url.includes("/products.json")) return res(url, 200, shopPage([1]));
      return res(url, 404);
    });
    expect(r.state).toBe("hit");
    expect(r.rung).toBe("shopify_products_json");
    expect(r.attempts.map((a) => a.rung)).toEqual(["woo_store_api", "shopify_products_json", "shopify_store_meta", "shopify_store_currency"]);
    expect(r.attempts.find((a) => a.rung === "shopify_store_meta")).toMatchObject({ kind: "meta_json" });
  });

  it("a 403 challenge on the store API makes the vendor result unknown, not miss", async () => {
    const r = await feeds("https://v.example", async (url) => (url.includes("wc/store") ? res(url, 403) : res(url, 404)));
    expect(r.state).toBe("unknown");
    expect(r.reason).toBe("at least one rung was indeterminate");
  });

  it("a 2xx that is not 200 is unknown — a 202 challenge page is not an answer", async () => {
    const r = await feeds("https://v.example", async (url) => res(url, 202, "<html>Checking your browser…</html>"));
    expect(r.state).toBe("unknown");
    expect(r.attempts[0]).toMatchObject({ status: 202, state: "unknown" });
  });

  it("200 with a non-JSON body stays a real miss — the endpoint answered with a page", async () => {
    const r = await feeds("https://v.example", async (url) => res(url, 200, "<html>home</html>"));
    expect(r.state).toBe("miss");
    expect(r.reason).toBe("no rung produced products");
  });

  it("a network failure is unknown, never miss", async () => {
    const r = await feeds("https://v.example", async (url) => failed(url));
    expect(r.state).toBe("unknown");
    expect(r.products).toEqual([]);
  });

  it("5xx, 429 and 403 are unknown; 404 and 401 are miss", async () => {
    for (const s of [500, 502, 503, 429, 403]) expect((await feeds("https://v.example", status(s))).state, `http ${s}`).toBe("unknown");
    for (const s of [404, 401]) expect((await feeds("https://v.example", status(s))).state, `http ${s}`).toBe("miss");
  });

  it("ONE indeterminate rung poisons the whole result to unknown", async () => {
    const r = await feeds("https://v.example", async (url) => (url.includes("wp-json") ? failed(url, "timeout") : res(url, 404)));
    expect(r.state).toBe("unknown");
  });

  it("records every attempt so a classification can be explained later", async () => {
    const r = await feeds("https://v.example", status(404));
    expect(r.attempts.map((a) => a.rung)).toEqual(RUNGS.map((x) => x.source));
    expect(r.attempts[0]).toMatchObject({ state: "miss", status: 404 });
  });

  it("counts every fetch it makes", async () => {
    let calls = 0;
    const r = await feeds("https://s.example", async (url) => {
      calls++;
      if (url.includes("wp-json")) return res(url, 404);
      if (url.includes("/products.json")) return res(url, 200, shopPage([1]));
      if (url.endsWith("/meta.json")) return res(url, 404);
      return res(url, 200, "<html>no signals</html>");
    });
    expect(r.fetches).toBe(calls);
    expect(r.fetches).toBe(4); // feed miss + feed hit + meta.json + anchor page
  });
});

describe("bounded woo pagination", () => {
  const wooPage = (count: number, idBase = 0) => JSON.stringify(Array.from({ length: count }, (_, i) => wooProduct({ id: idBase + i + 1, name: `Pep-${idBase + i + 1} 10mg` })));

  it("walks past a raw-full first page and merges the tail page", async () => {
    const tried: string[] = [];
    const r = await feeds("https://v.example", async (url) => {
      tried.push(url);
      return url.includes("page=2") ? res(url, 200, wooPage(30, 100)) : res(url, 200, wooPage(100));
    });
    expect(r.products).toHaveLength(130);
    expect(tried).toHaveLength(2);
    expect(r.attempts.find((a) => a.url.includes("page=2"))).toMatchObject({ state: "hit", reason: "page 2" });
  });

  it("a short first page does not paginate", async () => {
    const tried: string[] = [];
    await feeds("https://v.example", async (url) => {
      tried.push(url);
      return res(url, 200, wooPage(40));
    });
    expect(tried).toHaveLength(1);
  });

  it("continues on the RAW count, not the parsed count", async () => {
    const mixed = JSON.stringify([
      ...Array.from({ length: 60 }, (_, i) => wooProduct({ id: i + 1 })),
      ...Array.from({ length: 40 }, (_, i) => wooProduct({ id: 100 + i + 1, prices: { price: "0", currency_code: "USD", currency_minor_unit: 2 } })),
    ]);
    const r = await feeds("https://v.example", async (url) => (url.includes("page=2") ? res(url, 200, wooPage(10, 200)) : res(url, 200, mixed)));
    expect(r.products).toHaveLength(70);
  });

  it("a failed later page keeps everything already collected — the vendor stays hit", async () => {
    const r = await feeds("https://v.example", async (url) => (url.includes("page=2") ? failed(url, "ECONNRESET") : res(url, 200, wooPage(100))));
    expect(r.state).toBe("hit");
    expect(r.products).toHaveLength(100);
    expect(r.attempts.find((a) => a.url.includes("page=2"))).toMatchObject({ state: "unknown" });
  });

  it("says whether the catalogue was read to its END — a failed later page, a non-feed page or the page ceiling is INCOMPLETE", async () => {
    const page2 = (answer: (url: string) => FetchResult): FetchText => async (url) => (url.includes("page=2") ? answer(url) : res(url, 200, wooPage(100)));
    expect((await feeds("https://v.example", async (url) => res(url, 200, wooPage(40)))).complete).toBe(true);
    expect((await feeds("https://v.example", page2((url) => res(url, 200, wooPage(30, 100))))).complete).toBe(true);
    expect((await feeds("https://v.example", page2((url) => res(url, 200, "[]")))).complete).toBe(true); // an empty tail IS the end

    const lost = await feeds("https://v.example", page2((url) => res(url, 429)));
    expect(lost).toMatchObject({ state: "hit", complete: false });
    expect((await feeds("https://v.example", page2((url) => failed(url)))).complete).toBe(false);
    // A 200 that is not the feed (a challenge page) is not "the end of the catalogue".
    expect((await feeds("https://v.example", page2((url) => res(url, 200, "<html>Just a moment…</html>")))).complete).toBe(false);

    let n = 0;
    const capped = await feeds("https://v.example", async (url) => res(url, 200, wooPage(100, ++n * 1000)));
    expect(capped.complete).toBe(false);
    expect(capped.attempts.at(-1)).toMatchObject({ state: "unknown", reason: expect.stringContaining("page ceiling") });
  });

  it("names the variable parents whose variation list was cut short", async () => {
    const variations = (count: number) => JSON.stringify(Array.from({ length: count }, (_, i) => ({ id: 7000 + i, prices: { price: "5999", currency_code: "USD", currency_minor_unit: 2 }, is_in_stock: true, attributes: [{ name: "Size", value: `${i + 1}mg` }] })));
    const store = (page2: (url: string) => FetchResult): FetchText => async (url) => {
      if (url.includes("parent=7")) return url.includes("page=2") ? page2(url) : res(url, 200, variations(100));
      return res(url, 200, JSON.stringify([variableParent(7), variableParent(8)].map((p, i) => (i === 1 ? { ...p, type: "simple", prices: { ...p.prices, price_range: null } } : p))));
    };
    const cut = await feeds("https://v.example", store((url) => res(url, 503)));
    expect(cut).toMatchObject({ state: "hit", truncatedParentIds: ["7"] });
    expect(cut.complete).toBe(false);
    const whole = await feeds("https://v.example", store((url) => res(url, 200, variations(3))));
    expect(whole).toMatchObject({ truncatedParentIds: [], complete: true });
  });

  it("stops at the max-page ceiling even when every page is raw-full", async () => {
    const tried: string[] = [];
    const r = await feeds("https://v.example", async (url) => {
      tried.push(url);
      return res(url, 200, wooPage(100, tried.length * 1000));
    });
    const max = RUNGS[0].page?.max ?? 0;
    expect(tried).toHaveLength(max);
    expect(r.products).toHaveLength(max * 100);
  });
});

describe("politeness — pacing, and stopping when a vendor rate-limits us", () => {
  const noSleep = async () => {};
  const parents = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => variableParent(i + 1)));
  const oneVariation = (url: string) => {
    const parent = Number(/parent=(\d+)/.exec(url)?.[1] ?? 0);
    return JSON.stringify([{ id: parent * 10, prices: { price: "5999", currency_code: "USD", currency_minor_unit: 2 }, is_in_stock: true, attributes: [{ name: "Size", value: "10mg" }] }]);
  };

  it("stops asking for variations after the first 429: the parents not asked about are seen, not enumerated", async () => {
    const tried: string[] = [];
    const r = await feeds(
      "https://v.example",
      async (url) => {
        tried.push(url);
        return url.includes("type=variation") ? res(url, 429) : res(url, 200, parents(8));
      },
      { sleep: noSleep },
    );
    // Two requests were already on their way when the first 429 came back; no more were sent.
    expect(tried.filter((u) => u.includes("type=variation"))).toHaveLength(2);
    expect(r).toMatchObject({ state: "hit", complete: false });
    expect(r.products.filter((p) => p.fallbackRange)).toHaveLength(8);
    expect(r.attempts.filter((a) => a.reason?.includes("not asked"))).toHaveLength(6);
    expect(r.fetches).toBe(3);
  });

  it("never has more than two requests in flight at one vendor, and pauses between a worker's requests", async () => {
    let inFlight = 0;
    let peak = 0;
    const pauses: number[] = [];
    const r = await feeds(
      "https://v.example",
      async (url) => {
        if (!url.includes("type=variation")) return res(url, 200, parents(7));
        peak = Math.max(peak, ++inFlight);
        await new Promise((done) => setTimeout(done, 2));
        inFlight--;
        return res(url, 200, oneVariation(url));
      },
      { sleep: async (ms) => void pauses.push(ms) },
    );
    expect(r.products).toHaveLength(7);
    expect(peak).toBe(2);
    expect(pauses.length).toBeGreaterThanOrEqual(5); // 7 requests by 2 workers: a pause after each but a worker's last
    expect(new Set(pauses)).toEqual(new Set([250]));
    expect(r.complete).toBe(true);
  });

  it("a 429 on a later feed page stops the vendor: no variation request follows it", async () => {
    const tried: string[] = [];
    const page1 = JSON.stringify([...Array.from({ length: 98 }, (_, i) => wooProduct({ id: 1000 + i })), variableParent(1), variableParent(2)]);
    const r = await feeds("https://v.example", async (url) => {
      tried.push(url);
      if (url.includes("type=variation")) return res(url, 200, oneVariation(url));
      return url.includes("page=2") ? res(url, 429) : res(url, 200, page1);
    });
    expect(tried.filter((u) => u.includes("type=variation"))).toEqual([]);
    expect(r).toMatchObject({ state: "hit", complete: false });
    expect(r.products.filter((p) => p.fallbackRange)).toHaveLength(2);
    expect(r.unenumeratedParentIds.sort()).toEqual(["1", "2"]);
  });

  it("a 429 on the first feed request ends the read: the next rung is not tried", async () => {
    const tried: string[] = [];
    const r = await feeds("https://v.example", async (url) => {
      tried.push(url);
      return res(url, 429);
    });
    expect(tried).toHaveLength(1);
    expect(r.state).toBe("unknown");
  });

  it("pauses between feed pages", async () => {
    const pauses: number[] = [];
    const wooPage = (count: number, idBase = 0) => JSON.stringify(Array.from({ length: count }, (_, i) => wooProduct({ id: idBase + i + 1 })));
    await attemptFeeds("https://v.example", async (url) => res(url, 200, url.includes("page=3") ? wooPage(5, 200) : wooPage(100, url.includes("page=2") ? 100 : 0)), { sleep: async (ms) => void pauses.push(ms) });
    expect(pauses).toEqual([250, 250]);
  });

  it("a parent whose variation list answers 'no' is reported as not enumerated", async () => {
    const r = await feeds("https://v.example", async (url) => (url.includes("type=variation") ? res(url, 404) : res(url, 200, parents(2))));
    expect(r.unenumeratedParentIds.sort()).toEqual(["1", "2"]);
    expect(r.truncatedParentIds).toEqual([]);
  });

  it("a page rung stops at the first 429 too", async () => {
    const tried: string[] = [];
    const urls = Array.from({ length: 6 }, (_, i) => `https://woo.example/product/p${i}/`);
    const r = await attemptPageRungs(
      urls,
      async (url) => {
        tried.push(url);
        return res(url, 429);
      },
      { platform: "woocommerce_closed_api", sleep: noSleep },
    );
    expect(tried).toHaveLength(2);
    expect(r.state).toBe("unknown");
    expect(r.attempts).toHaveLength(6);
    expect(r.attempts.filter((a) => a.reason?.includes("not asked"))).toHaveLength(4);
    expect(r.attempts.every((a) => a.dead !== true)).toBe(true); // nothing unasked is "dead"
  });
});

describe("attemptFeeds — variable parents become rows", () => {
  it("fetches each parent's variations and emits one row per variation, none for the parent", async () => {
    const tried: string[] = [];
    const r = await feeds("https://blankpeptides.com", async (url) => {
      tried.push(url);
      if (url.includes("parent=181")) return res(url, 200, VARIATIONS_181);
      if (url.includes("parent=286")) return res(url, 200, "[]");
      return res(url, 200, VARIABLE);
    });
    expect(r.state).toBe("hit");
    expect(tried.filter((u) => u.includes("type=variation"))).toHaveLength(2);
    expect(r.products.filter((p) => p.fallbackRange === null)).toHaveLength(4);
    expect(r.products.filter((p) => p.sourceProductId === "181" && p.fallbackRange)).toHaveLength(0);
    expect(r.variationFetches).toBe(2);
    expect(r.fetches).toBe(3);
    const va = r.attempts.filter((a) => a.kind === "variations");
    expect(va.map((a) => a.parentId)).toEqual(["181", "286"]);
  });

  it("a failed variations fetch yields ONE flagged fallback row per parent with no price", async () => {
    const r = await feeds("https://blankpeptides.com", async (url) => (url.includes("type=variation") ? failed(url) : res(url, 200, VARIABLE)));
    expect(r.state).toBe("hit");
    expect(r.products).toHaveLength(2);
    expect(r.products.find((p) => p.sourceProductId === "181")).toMatchObject({ priceMinor: null, fallbackRange: { minMinor: 10500, maxMinor: 23900 }, variantKey: "" });
    expect(r.products.find((p) => p.sourceProductId === "286")).toMatchObject({ priceMinor: null, fallbackRange: { minMinor: 12500, maxMinor: null } });
    expect(r.attempts.filter((a) => a.kind === "variations" && a.state === "unknown")).toHaveLength(2);
  });

  it("a 403 on a parent's variations is unknown, and paginates a full page until a short one", async () => {
    const one = JSON.parse(VARIATIONS_181)[0];
    const full = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ ...one, id: 100000 + i, variation: `Size: ${i + 1}mg` })));
    const tail = JSON.stringify(Array.from({ length: 3 }, (_, i) => ({ ...one, id: 200000 + i, variation: `Size: ${200 + i}mg` })));
    const r = await feeds("https://blankpeptides.com", async (url) => {
      if (url.includes("parent=181") && url.includes("page=2")) return res(url, 200, tail);
      if (url.includes("parent=181")) return res(url, 200, full);
      if (url.includes("parent=286")) return res(url, 403);
      return res(url, 200, VARIABLE);
    });
    expect(r.products.filter((p) => p.sourceProductId === "181" && !p.fallbackRange)).toHaveLength(103);
    expect(r.attempts.filter((a) => a.kind === "variations" && a.parentId === "181").map((a) => a.page)).toEqual([1, 2]);
    expect(r.attempts.find((a) => a.kind === "variations" && a.parentId === "286")).toMatchObject({ state: "unknown", status: 403 });
    expect(r.variationFetches).toBe(3);
  });

  it("a LATER variations page that fails keeps the rows already read and says TRUNCATED", async () => {
    const one = JSON.parse(VARIATIONS_181)[0];
    const full = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ ...one, id: 100000 + i, variation: `Size: ${i + 1}mg` })));
    const r = await feeds("https://blankpeptides.com", async (url) => {
      if (url.includes("parent=181") && url.includes("page=2")) return res(url, 503);
      if (url.includes("parent=181")) return res(url, 200, full);
      if (url.includes("parent=286")) return res(url, 200, "[]");
      return res(url, 200, VARIABLE);
    });
    const rows = r.products.filter((p) => p.sourceProductId === "181");
    expect(rows).toHaveLength(100);
    expect(rows.some((p) => p.fallbackRange)).toBe(false);
    expect(r.attempts.find((a) => a.kind === "variations" && a.parentId === "181" && a.page === 2)?.reason).toMatch(/TRUNCATED after page 1/);
  });

  it("parents found on a LATER page are resolved too", async () => {
    const page1 = JSON.stringify(Array.from({ length: 100 }, (_, i) => wooProduct({ id: i + 1 })));
    const r = await feeds("https://v.example", async (url) => {
      if (url.includes("parent=901")) return res(url, 200, "[]");
      if (url.includes("page=2")) return res(url, 200, JSON.stringify([variableParent(901)]));
      return res(url, 200, page1);
    });
    expect(r.attempts.filter((a) => a.kind === "variations").map((a) => a.parentId)).toEqual(["901"]);
  });
});

describe("Shopify feed — store currency and since_id pagination", () => {
  it("RECORDED FIXTURE: adopts USD from /meta.json and never fetches the anchor page", async () => {
    const tried: string[] = [];
    const r = await feeds("https://orosresearch.com", async (url) => {
      tried.push(url);
      if (url.includes("wp-json")) return res(url, 404);
      if (url.includes("/products.json")) return res(url, 200, shopPage([1]));
      if (url.endsWith("/meta.json")) return res(url, 200, META);
      return res(url, 200, "<html>anchor</html>");
    });
    expect(r.products.every((p) => p.currency === "USD")).toBe(true);
    expect(r.attempts.find((a) => a.rung === "shopify_store_currency")).toMatchObject({ state: "hit", reason: "adopted USD (meta_json)" });
    expect(r.attempts.find((a) => a.rung === "shopify_store_meta")).toBeUndefined();
    expect(tried.some((u) => u.includes("/products/pep-1"))).toBe(false);
    expect(r.fetches).toBe(3);
  });

  it("falls back to the number-anchored og pair when meta.json does not answer; a mismatch leaves currency null", async () => {
    const store = (html: string): FetchText => async (url) => {
      if (url.includes("wp-json")) return res(url, 404);
      if (url.includes("/products.json")) return res(url, 200, shopPage([1]));
      if (url.endsWith("/meta.json")) return res(url, 404);
      return res(url, 200, html);
    };
    const gbp = await feeds("https://s.example", store('<meta property="og:price:amount" content="50.00"><meta property="og:price:currency" content="GBP">'));
    expect(gbp.products.every((p) => p.currency === "GBP")).toBe(true);
    expect(gbp.attempts.find((a) => a.rung === "shopify_store_meta")).toMatchObject({ state: "miss", status: 404, kind: "meta_json" });
    const mismatch = await feeds("https://s.example", store('<meta property="og:price:amount" content="63.40"><meta property="og:price:currency" content="USD">'));
    expect(mismatch.state).toBe("hit");
    expect(mismatch.products.every((p) => p.currency === null)).toBe(true);
    expect(mismatch.attempts.find((a) => a.rung === "shopify_store_currency")?.state).toBe("miss");
  });

  it("continues with &since_id=<last product id> while the raw page is full", async () => {
    const tried: string[] = [];
    const full = Array.from({ length: 250 }, (_, i) => i + 1);
    const r = await feeds("https://s.example", async (url) => {
      tried.push(url);
      if (url.includes("wp-json")) return res(url, 404);
      if (url.includes("since_id=250")) return res(url, 200, shopPage([251, 252]));
      if (url.includes("/products.json")) return res(url, 200, shopPage(full));
      return res(url, 404);
    });
    expect(r.products).toHaveLength(252);
    expect(tried.some((u) => u.includes("since_id=250"))).toBe(true);
    expect(tried.some((u) => u.endsWith("since_id=2"))).toBe(false);
    expect(RUNGS.find((x) => x.source === "shopify_products_json")?.page).toEqual({ param: "since_id", size: 250, max: 5 });
  });
});

describe("attemptPageRungs — the page ladder over known product URLs", () => {
  it("runs the woo embedded rung over two URLs and merges the rows", async () => {
    const r = await attemptPageRungs(["https://woo.example/product/a/", "https://woo.example/product/b/"], async (url) => ok(PRODUCT_PAGE)(url), { platform: "woocommerce_closed_api" });
    expect(r.state).toBe("hit");
    expect(r.rung).toBe("woo_embedded_variations");
    expect(r.products).toHaveLength(4);
    expect(r.attempts).toHaveLength(2);
    expect(r.fetches).toBe(2);
  });

  it("marks a 404 URL dead so a caller can retire it; a 403 is not dead", async () => {
    const r = await attemptPageRungs(["https://woo.example/product/gone/", "https://woo.example/product/live/"], async (url) => (url.includes("gone") ? res(url, 404) : res(url, 200, PRODUCT_PAGE)), { platform: "woocommerce_closed_api" });
    expect(r.state).toBe("hit");
    expect(r.attempts.find((a) => a.url.includes("gone"))).toMatchObject({ state: "miss", status: 404, dead: true });
    const blocked = await attemptPageRungs(["https://woo.example/p/"], status(403), { platform: "woocommerce_closed_api" });
    expect(blocked.attempts[0].dead).toBeUndefined();
    expect(blocked.state).toBe("unknown");
  });

  it("ONE indeterminate page with no rows anywhere is unknown; miss only when every page answered no", async () => {
    const u = await attemptPageRungs(["https://woo.example/a/", "https://woo.example/b/"], async (url) => (url.includes("/a/") ? res(url, 429) : res(url, 200, "<html>no form</html>")), { platform: "woocommerce_closed_api" });
    expect(u.state).toBe("unknown");
    const m = await attemptPageRungs(["https://woo.example/a/"], async (url) => res(url, 200, "<html>no form</html>"), { platform: "woocommerce_closed_api" });
    expect(m.state).toBe("miss");
  });

  it("an EMPTY url list is unknown — nothing was tried", async () => {
    const r = await attemptPageRungs([], async () => { throw new Error("must not be called"); }, { platform: "woocommerce_closed_api" });
    expect(r.state).toBe("unknown");
    expect(r.reason).toContain("nothing was tried");
    expect(r.fetches).toBe(0);
  });

  it("refuses to run without a rung named — each rung costs one fetch per URL", async () => {
    await expect(attemptPageRungs(["https://v.example/p/"], status(200), {})).rejects.toThrow(/rung/);
    await expect(attemptPageRungs(["https://v.example/p/"], status(200), { rungs: [] })).rejects.toThrow(/rung/);
  });

  it("falls from the closed woo rung to the jsonld rung when the page has no variations form", async () => {
    const page = '<script type="application/ld+json">{"@type":"Product","name":"TB-500 5mg","offers":{"@type":"Offer","price":"64.00","priceCurrency":"USD"}}</script>';
    const r = await attemptPageRungs(["https://v.example/p/tb-500/"], async (url) => res(url, 200, page), { rungs: [PAGE_RUNGS[0], PAGE_RUNGS[2]] });
    expect(r.rung).toBe("jsonld");
    expect(r.products[0]).toMatchObject({ priceMinor: 6400, currency: "USD" });
  });

  it("the page rung table", () => {
    expect(PAGE_RUNGS.map((r) => r.source)).toEqual(["woo_embedded_variations", "shopify_product_js", "jsonld"]);
  });
});

describe("attemptFeeds — platform routing to the page rungs", () => {
  it("a closed-API woo vendor never touches the feed endpoint and reads its currency off the page", async () => {
    const tried: string[] = [];
    const r = await feeds("https://woo.example", async (url) => {
      tried.push(url);
      return res(url, 200, '<meta property="product:price:currency" content="GBP">' + PRODUCT_PAGE);
    }, { platform: "woocommerce_closed_api", knownProductUrls: ["https://woo.example/product/bpc-157/"] });
    expect(r.rung).toBe("woo_embedded_variations");
    expect(tried).toEqual(["https://woo.example/product/bpc-157/"]);
    expect(r.products.every((p) => p.currency === "GBP" && p.currencyEvidence === "og_currency")).toBe(true);
    expect(r.fetches).toBe(1);
  });

  it("a closed-API shopify vendor routes to the .js rung AND adopts the store currency from /meta.json", async () => {
    const tried: string[] = [];
    const r = await feeds("https://s.example", async (url) => {
      tried.push(url);
      if (url.endsWith("/meta.json")) return res(url, 200, JSON.stringify({ id: 1, name: "S", currency: "USD" }));
      return res(url, 200, JSON.stringify({ id: 1, title: "Elora 5mg", handle: "elora-5mg", variants: [{ id: 2, title: "Default Title", price: 5999, available: true }] }));
    }, { platform: "shopify_closed_api", knownProductUrls: ["https://s.example/products/elora-5mg"] });
    expect(r.rung).toBe("shopify_product_js");
    expect(r.products[0]).toMatchObject({ priceMinor: 5999, currency: "USD" });
    expect(tried).toEqual(["https://s.example/products/elora-5mg.js", "https://s.example/meta.json"]);
    expect(r.fetches).toBe(2);
  });

  it("a closed-API vendor with NO known urls is unknown, not miss — nothing was tried", async () => {
    const r = await feeds("https://woo.example", async () => { throw new Error("must not be called"); }, { platform: "woocommerce_closed_api", knownProductUrls: [] });
    expect(r.state).toBe("unknown");
    expect(r.reason).toContain("nothing was tried");
  });

  it("`custom` with no known urls falls back to the feed rungs; `jsonld` WITH urls routes to the jsonld rung", async () => {
    const c = await feeds("https://v.example", async (url) => res(url, 200, JSON.stringify([wooProduct()])), { platform: "custom", knownProductUrls: [] });
    expect(c.rung).toBe("woo_store_api");
    const page = '<script type="application/ld+json">{"@type":"Product","name":"GHK-Cu 50mg","offers":{"@type":"Offer","price":"45.00","priceCurrency":"USD"}}</script>';
    const j = await feeds("https://v.example", async (url) => res(url, 200, page), { platform: "jsonld", knownProductUrls: ["https://v.example/p/ghk-cu/"] });
    expect(j.rung).toBe("jsonld");
    expect(j.products[0].name).toBe("GHK-Cu 50mg");
  });

  // A custom-built shop has no product feed: its product pages are found in its sitemap.
  it("a custom shop with no known urls is read through the product pages its sitemap lists", async () => {
    const page = (name: string, price: string) => `<script type="application/ld+json">{"@type":"Product","name":"${name}","offers":[{"@type":"Offer","price":"${price}","priceCurrency":"CAD","availability":"https://schema.org/InStock"}]}</script>`;
    const pages: Record<string, string> = {
      "https://pc.example/robots.txt": "User-Agent: *\nDisallow: /api/\nSitemap: https://pc.example/sitemap.xml\n",
      "https://pc.example/sitemap.xml": "<urlset><url><loc>https://pc.example/products</loc></url><url><loc>https://pc.example/products/bpc5</loc></url><url><loc>https://pc.example/products/tb10</loc></url></urlset>",
      "https://pc.example/products/bpc5": page("BPC-157/5mg", "45.00"),
      "https://pc.example/products/tb10": page("TB-500/10mg", "70.00"),
    };
    const asked: string[] = [];
    const r = await feeds("https://pc.example", async (url) => (asked.push(url), pages[url] ? res(url, 200, pages[url]) : res(url, 404)), { platform: "custom", knownProductUrls: [] });
    expect(r.rung).toBe("jsonld");
    expect(r.products.map((p) => p.name).sort()).toEqual(["BPC-157/5mg", "TB-500/10mg"]);
    expect(asked.some((u) => u.includes("/api/") || u.includes("wp-json") || u.includes("products.json"))).toBe(false);
  });

  it("a custom shop that answers 429 while its sitemap is read is not asked for any page", async () => {
    const asked: string[] = [];
    const r = await feeds("https://pc.example", async (url) => (asked.push(url), url.endsWith("/robots.txt") ? res(url, 429) : res(url, 200, "")), { platform: "custom", knownProductUrls: ["https://pc.example/products/held"] });
    expect(r.state).toBe("unknown");
    expect(r.reason).toContain("429");
    expect(asked).toEqual(["https://pc.example/robots.txt"]);
  });

  it("a known url and a sitemap url are read once each, together", async () => {
    const page = `<script type="application/ld+json">{"@type":"Product","name":"GHK-Cu 50mg","offers":{"@type":"Offer","price":"45.00","priceCurrency":"CAD"}}</script>`;
    const asked: string[] = [];
    const r = await feeds("https://pc.example", async (url) => {
      asked.push(url);
      if (url.endsWith("/sitemap.xml")) return res(url, 200, "<urlset><url><loc>https://pc.example/products/ghk</loc></url><url><loc>https://pc.example/products/new</loc></url></urlset>");
      if (url.includes("/products/")) return res(url, 200, page);
      return res(url, 404);
    }, { platform: "custom", knownProductUrls: ["https://pc.example/products/ghk"] });
    expect(r.rung).toBe("jsonld");
    expect(asked.filter((u) => u === "https://pc.example/products/ghk")).toHaveLength(1);
    expect(asked).toContain("https://pc.example/products/new");
  });
});

describe("withCanonicalQuantity", () => {
  const product = (over: Partial<Product>): Product => ({
    name: "BPC-157 10mg",
    variantLabel: null,
    productUrl: "https://v.example/p/",
    fetchUrl: null,
    sourceSystem: "woocommerce",
    priceSource: "woo_store_api",
    sourceProductId: "1",
    sourceVariantId: null,
    variantKey: "",
    options: null,
    currency: "USD",
    currencyEvidence: null,
    priceMinor: 5999,
    listPriceMinor: null,
    onSale: false,
    availability: "in_stock",
    rawPriceText: "USD5999 (minor_unit=2)",
    fallbackRange: null,
    ...over,
  });

  it("prices a real vial from the whole pack and refuses with a typed reason otherwise", () => {
    const [vial, pack, caps, blank] = withCanonicalQuantity([
      product({}),
      product({ name: "CJC-1295 NO DAC", variantLabel: "(2-Pack) 5mg" }),
      product({ name: "NAD+ 250mg capsules" }),
      product({ name: "BPC-157" }),
    ]);
    expect(vial.quantity).toEqual({ mg: 10, packCount: 1, totalMg: 10, reason: null });
    expect(pack.quantity).toEqual({ mg: 5, packCount: 2, totalMg: 10, reason: null });
    expect(caps.quantity).toEqual({ mg: null, reason: "non_vial_form" });
    expect(blank.quantity).toEqual({ mg: null, reason: "no_mg" });
  });

  it("a variant's own mass wins over the mass in its parent's name; pack and form words in the name still count", () => {
    const [variant, sibling, packed, spray, plain] = withCanonicalQuantity([
      product({ name: "MOTS-C Peptide (20MG)", variantLabel: "Peptide Content: 10mg" }),
      product({ name: "MOTS-C Peptide (20MG)", variantLabel: "Peptide Content: 20mg" }),
      product({ name: "(2-Pack) Semaglutide 5mg", variantLabel: "Size: 10mg" }),
      product({ name: "Oxytocin 10mg Nasal Spray", variantLabel: "Size: 20mg" }),
      product({ name: "BPC-157 5mg", variantLabel: "Colour: Blue" }),
    ]);
    expect(variant.quantity).toEqual({ mg: 10, packCount: 1, totalMg: 10, reason: null });
    expect(sibling.quantity).toEqual({ mg: 20, packCount: 1, totalMg: 20, reason: null });
    expect(packed.quantity).toEqual({ mg: 10, packCount: 2, totalMg: 20, reason: null });
    expect(spray.quantity).toEqual({ mg: null, reason: "non_vial_form" });
    expect(plain.quantity).toEqual({ mg: 5, packCount: 1, totalMg: 5, reason: null });
  });

  it("a size list in the parent's name leaves no stray joiner behind when the variant states the size", () => {
    const [ten, five] = withCanonicalQuantity([
      product({ name: "TB-500 (Thymosin Beta-4) 5mg/10mg", variantLabel: "Select MG: 10 MG" }),
      product({ name: "Retatrutide 5mg / 10mg / 20mg", variantLabel: "Size: 5mg" }),
    ]);
    expect(ten.quantity).toEqual({ mg: 10, packCount: 1, totalMg: 10, reason: null });
    expect(five.quantity).toEqual({ mg: 5, packCount: 1, totalMg: 5, reason: null });
  });

  it("a variant label that states the pack TOTAL does not replace the one-vial mass", () => {
    const [total] = withCanonicalQuantity([product({ name: "BPC-157 5mg", variantLabel: "2 Vials (10mg total)" })]);
    expect(total.quantity).toEqual({ mg: 5, packCount: 2, totalMg: 10, reason: null });
  });

  it("a name that states ONE vial's mass in the plural, with a variant that states the total, is that many vials (data audit, 2026-10-02)", () => {
    const [ten, two, five, one, odd, other] = withCanonicalQuantity([
      product({ name: "BPC-157 (10mg vials)", variantLabel: "QUANTITY (MG):: 100 mg" }),
      product({ name: "TB-500 (TB4, 10mg vials)", variantLabel: "QUANTITY (MG):: 20 mg" }),
      product({ name: "DSIP (5mg vials)", variantLabel: "QUANTITY (MG):: 25 mg" }),
      product({ name: "Epithalon (40mg vials)", variantLabel: "QUANTITY (MG):: 40 mg" }),
      product({ name: "GLP-3 Retatrutide (12mg vials)", variantLabel: "QUANTITY (MG):: 30 mg" }),
      product({ name: "SS-31 (50mg vials)", variantLabel: "QUANTITY (MG):: 100 mg" }),
    ]);
    expect(ten.quantity).toEqual({ mg: 10, packCount: 10, totalMg: 100, reason: null });
    expect(two.quantity).toEqual({ mg: 10, packCount: 2, totalMg: 20, reason: null });
    expect(five.quantity).toEqual({ mg: 5, packCount: 5, totalMg: 25, reason: null });
    expect(one.quantity).toEqual({ mg: 40, packCount: 1, totalMg: 40, reason: null });
    // 30 mg is not a whole number of 12 mg vials: what the price buys is not known.
    expect(odd.quantity).toEqual({ mg: null, reason: "pack_ambiguous" });
    expect(other.quantity).toEqual({ mg: 50, packCount: 2, totalMg: 100, reason: null });
  });

  it("preserves every field and is safe on empty input", () => {
    const p = product({});
    expect(withCanonicalQuantity([p])[0]).toMatchObject(p);
    expect(withCanonicalQuantity([])).toEqual([]);
  });
});

describe("validateAgainstRawText", () => {
  const p = (rawPriceText: string, priceMinor: number | null, currency: string | null = "USD"): Product => ({
    name: "X",
    variantLabel: null,
    productUrl: null,
    fetchUrl: null,
    sourceSystem: "jsonld",
    priceSource: "jsonld",
    sourceProductId: null,
    sourceVariantId: null,
    variantKey: "",
    options: null,
    currency,
    currencyEvidence: null,
    priceMinor,
    listPriceMinor: null,
    onSale: false,
    availability: "unknown",
    rawPriceText,
    fallbackRange: null,
  });
  it("accepts a price present in the raw text, including a sale price beside a struck-through original", () => {
    expect(validateAgainstRawText(p("$59.99", 5999)).ok).toBe(true);
    expect(validateAgainstRawText(p("$79.99 $59.99", 5999)).ok).toBe(true);
    expect(validateAgainstRawText(p("$1,299.00", 129900)).ok).toBe(true);
  });
  it("validates a minor-unit anchor that declares its own scale", () => {
    expect(validateAgainstRawText(p("USD5999 (minor_unit=2)", 5999)).ok).toBe(true);
    expect(validateAgainstRawText(p("5999 (minor_unit=2)", 5999)).ok).toBe(true);
  });
  it("refuses a price that is not in the raw text, a missing raw text and a range row", () => {
    expect(validateAgainstRawText(p("59.99", 6999))).toEqual({ ok: false, reason: "price 69.99 appears in none of [59.99]" });
    // A declared scale is THE scale: the unscaled integer must not vouch for a ×100 price.
    expect(validateAgainstRawText(p("USD5999 (minor_unit=2)", 599_900)).ok).toBe(false);
    expect(validateAgainstRawText(p("5999 (minor_unit=2)", 599_900)).ok).toBe(false);
    expect(validateAgainstRawText(p("", 5999)).ok).toBe(false);
    expect(validateAgainstRawText(p("no number", 5999)).ok).toBe(false);
    expect(validateAgainstRawText(p("45.00", null)).ok).toBe(false);
  });
});

describe("statesVialMassInName", () => {
  it("is true only when the name states one vial's mass in the plural", () => {
    expect(statesVialMassInName("Combo Vial: BPC-157/TB-500 (20mg vials)")).toBe(true);
    expect(statesVialMassInName("BPC-157 10mg + TB-500 10mg")).toBe(false);
    expect(statesVialMassInName("BPC-157 + TB-500 – 10 vials")).toBe(false);
  });
});
