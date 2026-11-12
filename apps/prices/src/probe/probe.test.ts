import { describe, expect, it } from "vitest";
import type { FetchResult, FetchText } from "../fetch/types.ts";
import {
  assessNetworkHealth,
  classifyPlatform,
  listRegressions,
  NEGATIVE_CONTROL_ORIGIN,
  originOf,
  PLATFORMS,
  probeOrigin,
  probeVendors,
  PROBE_ENDPOINTS,
  runControls,
  shouldWritePlatform,
  TRANSPORT_RETRY_DELAY_MS,
  UNREACHABLE_SHARE_GUARD,
  type Signal,
} from "./probe.ts";

/** A signal triple; anything omitted is "no evidence from this step" (status 0, empty body). */
const sig = (woo: Partial<Signal> = {}, shop: Partial<Signal> = {}, home: Partial<Signal> = {}) => ({
  woo: { status: 0, body: "", ...woo },
  shop: { status: 0, body: "", ...shop },
  home: { status: 0, body: "", ...home },
});

const WOO_JSON = JSON.stringify([{ id: 7781, name: "BPC-157 5mg", prices: { price: "5499", currency_code: "USD" } }]);
const SHOPIFY_JSON = JSON.stringify({ products: [{ id: 42, title: "TB-500 10mg", variants: [{ price: "89.00" }] }] });
const PLAIN_HTML = `<!doctype html><html><head><title>Research Peptides</title><link rel="stylesheet" href="/assets/app.css"></head><body><main><h1>Catalogue</h1></main></body></html>`;
const CHALLENGE_HTML = `<!doctype html><html><head><title>Just a moment...</title></head><body><div id="challenge-running">Checking your browser</div></body></html>`;
const withMarker = (marker: string) => PLAIN_HTML.replace("</head>", `<link rel="stylesheet" href="${marker}"></head>`);

describe("classifyPlatform — the positive ladder", () => {
  it("open WooCommerce Store API (200 + JSON array) → woocommerce", () => {
    const got = classifyPlatform(sig({ status: 200, body: WOO_JSON }));
    expect(got.platform).toBe("woocommerce");
    expect(got.reason).toContain("woo:200");
  });
  it("open Shopify products.json → shopify; an EMPTY array still counts — the test is the shape", () => {
    expect(classifyPlatform(sig({ status: 404 }, { status: 200, body: SHOPIFY_JSON })).platform).toBe("shopify");
    expect(classifyPlatform(sig({ status: 200, body: "[]" })).platform).toBe("woocommerce");
    expect(classifyPlatform(sig({ status: 404 }, { status: 200, body: '{"products":[]}' })).platform).toBe("shopify");
  });
  it("200 on the Woo endpoint with an HTML soft-404 or a JSON object is NOT woocommerce", () => {
    expect(classifyPlatform(sig({ status: 200, body: PLAIN_HTML }, { status: 404 }, { status: 200, body: PLAIN_HTML })).platform).toBe("custom");
    expect(classifyPlatform(sig({ status: 200, body: '{"code":"rest_no_route"}' }, { status: 404 }, { status: 200, body: PLAIN_HTML })).platform).toBe("custom");
  });
});

describe("classifyPlatform — homepage fingerprints (API closed)", () => {
  it("Woo API 403 + wp-content/plugins/woocommerce → woocommerce_closed_api", () => {
    const got = classifyPlatform(sig({ status: 403 }, { status: 404 }, { status: 200, body: withMarker("/wp-content/plugins/woocommerce/assets/css/woocommerce.css") }));
    expect(got.platform).toBe("woocommerce_closed_api");
    expect(got.reason).toContain("wp-content/plugins/woocommerce");
  });
  it("Shopify blocked + cdn.shopify.com or Shopify.theme → shopify_closed_api", () => {
    expect(classifyPlatform(sig({ status: 404 }, { status: 403 }, { status: 200, body: withMarker("https://cdn.shopify.com/s/files/1/x.css") })).platform).toBe("shopify_closed_api");
    expect(classifyPlatform(sig({ status: 404 }, { status: 403 }, { status: 200, body: PLAIN_HTML.replace("</body>", "<script>Shopify.theme = {}</script></body>") })).platform).toBe("shopify_closed_api");
  });
  it("bigcommerce, squarespace and wix fingerprints", () => {
    expect(classifyPlatform(sig({ status: 404 }, { status: 404 }, { status: 200, body: withMarker("https://cdn11.bigcommerce.com/x.css") })).platform).toBe("bigcommerce");
    expect(classifyPlatform(sig({ status: 404 }, { status: 404 }, { status: 200, body: withMarker("https://static1.squarespace.com/x.css") })).platform).toBe("squarespace");
    expect(classifyPlatform(sig({ status: 404 }, { status: 404 }, { status: 200, body: withMarker("https://static.parastorage.com/wix.com/x.css") })).platform).toBe("wix");
  });
  it("a fingerprint is read even when the homepage itself was blocked", () => {
    expect(classifyPlatform(sig({ status: 403 }, { status: 403 }, { status: 403, body: withMarker("/wp-content/plugins/woocommerce/x.css") })).platform).toBe("woocommerce_closed_api");
  });
});

describe("classifyPlatform — custom, blocked, unreachable", () => {
  it("homepage read (200) with no fingerprint → custom", () => {
    expect(classifyPlatform(sig({ status: 404 }, { status: 404 }, { status: 200, body: PLAIN_HTML })).platform).toBe("custom");
  });
  it("403 everywhere, a 202 challenge, 429 and 503 → blocked (never custom)", () => {
    expect(classifyPlatform(sig({ status: 403 }, { status: 403 }, { status: 403, body: CHALLENGE_HTML })).platform).toBe("blocked");
    expect(classifyPlatform(sig({ status: 202, body: CHALLENGE_HTML }, { status: 202, body: CHALLENGE_HTML }, { status: 202, body: CHALLENGE_HTML })).platform).toBe("blocked");
    expect(classifyPlatform(sig({ status: 429 }, { status: 429 }, { status: 429 })).platform).toBe("blocked");
    expect(classifyPlatform(sig({ status: 503 }, { status: 503 }, { status: 503 })).platform).toBe("blocked");
    expect(classifyPlatform(sig({ status: 404 }, { status: 404 }, { status: 403 })).platform).toBe("blocked");
  });
  it("an EMPTY 200 homepage is NOT custom — a body we did not get is not a measurement", () => {
    const got = classifyPlatform(sig({ status: 404 }, { status: 404 }, { status: 200, body: "" }));
    expect(got.platform).toBe("unreachable");
    expect(got.reason).toContain("empty_body");
  });
  it("transport failure on every step → unreachable; an unrecognised non-200 with no fingerprint → unreachable", () => {
    expect(classifyPlatform(sig()).platform).toBe("unreachable");
    expect(classifyPlatform(sig({ status: 404 }, { status: 404 }, { status: 500 })).platform).toBe("unreachable");
  });
  it("only ever returns a label from PLATFORMS and is deterministic", () => {
    const statuses = [0, 200, 202, 403, 404, 429, 500, 503];
    for (const w of statuses) for (const s of statuses) for (const h of statuses) {
      const a = classifyPlatform(sig({ status: w, body: w === 200 ? WOO_JSON : "" }, { status: s }, { status: h, body: h === 200 ? PLAIN_HTML : "" }));
      const b = classifyPlatform(sig({ status: w, body: w === 200 ? WOO_JSON : "" }, { status: s }, { status: h, body: h === 200 ? PLAIN_HTML : "" }));
      expect(PLATFORMS).toContain(a.platform);
      expect(a).toEqual(b);
    }
    expect(new Set(PLATFORMS).size).toBe(PLATFORMS.length);
  });
});

describe("originOf and the endpoints", () => {
  it("accepts a bare domain and a full URL, and yields scheme+host only", () => {
    expect(originOf("example.com")).toBe("https://example.com");
    expect(originOf("http://shop.example.com/products/x?y=1")).toBe("http://shop.example.com");
    expect(originOf("")).toBeNull();
    expect(originOf("not a url")).toBeNull();
  });
  it("asks the two documented capability endpoints at page size 1", () => {
    expect(PROBE_ENDPOINTS.woo).toBe("/wp-json/wc/store/v1/products?per_page=1");
    expect(PROBE_ENDPOINTS.shop).toBe("/products.json?limit=1");
  });
});

const AT = "2026-10-01T00:00:00.000Z";
const res = (url: string, status: number, body = ""): FetchResult => ({ url, status, state: status === 200 ? "hit" : status === 404 ? "miss" : "unknown", body, fetchedAt: AT });
const failed = (url: string): FetchResult => ({ url, status: null, state: "unknown", body: null, fetchedAt: AT, error: "ECONNREFUSED" });
const noSleep = async () => {};

describe("probeOrigin", () => {
  it("stops after a positive API match — one request for an open Woo store", async () => {
    const tried: string[] = [];
    const r = await probeOrigin("https://woo.example", async (url) => {
      tried.push(url);
      return res(url, 200, WOO_JSON);
    }, { sleep: noSleep });
    expect(r.platform).toBe("woocommerce");
    expect(tried).toEqual(["https://woo.example/wp-json/wc/store/v1/products?per_page=1"]);
    expect(r.statuses).toEqual({ woo: 200, shop: 0, home: 0 });
  });

  it("a transport failure on the first attempt of a step is retried once, after the documented delay", async () => {
    let calls = 0;
    const waits: number[] = [];
    const fetchText: FetchText = async (url) => (++calls === 1 ? failed(url) : res(url, 200, WOO_JSON));
    const r = await probeOrigin("https://woo.example", fetchText, { sleep: async (ms) => { waits.push(ms); } });
    expect(r.platform).toBe("woocommerce");
    expect(calls).toBe(2);
    expect(waits).toEqual([TRANSPORT_RETRY_DELAY_MS]);
  });

  it("two transport failures per step → unreachable, six fetches total, never a seventh", async () => {
    let calls = 0;
    const r = await probeOrigin("https://dead.example", async (url) => {
      calls++;
      return failed(url);
    }, { sleep: noSleep });
    expect(r.platform).toBe("unreachable");
    expect(calls).toBe(6);
  });

  it("a served status is never retried", async () => {
    let calls = 0;
    const r = await probeOrigin("https://blocked.example", async (url) => {
      calls++;
      return res(url, 403, CHALLENGE_HTML);
    }, { sleep: noSleep });
    expect(r.platform).toBe("blocked");
    expect(calls).toBe(3);
  });
});

describe("probeVendors and the controls", () => {
  const vendors = [
    { id: "a", slug: "woo-shop", website: "https://woo.example", detectedPlatform: "woocommerce" as const },
    { id: "b", slug: "no-site", website: null, detectedPlatform: null },
    { id: "c", slug: "gone", website: "https://gone.example", detectedPlatform: "shopify" as const },
  ];
  const fetchText: FetchText = async (url) => (url.startsWith("https://woo.example") ? res(url, 200, WOO_JSON) : failed(url));

  it("probes every vendor with an origin at bounded concurrency and keeps the previous platform beside the verdict", async () => {
    const rows = await probeVendors(vendors, fetchText, { concurrency: 2, sleep: noSleep });
    expect(rows.map((r) => [r.slug, r.platform, r.previousPlatform])).toEqual([
      ["woo-shop", "woocommerce", "woocommerce"],
      ["no-site", "no_origin", null],
      ["gone", "unreachable", "shopify"],
    ]);
    expect(listRegressions(rows)).toEqual([{ slug: "gone", previous: "shopify" }]);
  });

  it("runControls classifies a known Woo origin, a known Shopify origin and the negative control", async () => {
    const controls = await runControls(
      async (url) => {
        if (url.startsWith("https://woo.example")) return res(url, 200, WOO_JSON);
        if (url.startsWith("https://shop.example")) return url.includes("products.json") ? res(url, 200, SHOPIFY_JSON) : res(url, 404);
        return failed(url);
      },
      { wooOrigin: "https://woo.example", shopifyOrigin: "https://shop.example", sleep: noSleep },
    );
    expect(controls.map((c) => [c.kind, c.expect, c.got])).toEqual([
      ["woo", "woocommerce", "woocommerce"],
      ["shopify", "shopify", "shopify"],
      ["negative", "unreachable", "unreachable"],
    ]);
    expect(controls[2].origin).toBe(NEGATIVE_CONTROL_ORIGIN);
  });
});

describe("assessNetworkHealth — a network outage is never a vendor property", () => {
  const rows = (unreachable: number, total: number) =>
    Array.from({ length: total }, (_, i) => ({ slug: `v${i}`, platform: i < unreachable ? ("unreachable" as const) : ("woocommerce" as const) }));
  it("the incident shape is REFUSED: 161 of 177 unreachable", () => {
    const v = assessNetworkHealth(rows(161, 177), []);
    expect(v.ok).toBe(false);
    expect(v.unreachableShare).toBeCloseTo(161 / 177);
    expect(v.reason).toMatch(/exceeds the guard/);
  });
  it("a healthy sweep passes — 10% unreachable, controls still classify", () => {
    expect(assessNetworkHealth(rows(10, 100), [{ kind: "woo", expect: "woocommerce", got: "woocommerce" }]).ok).toBe(true);
  });
  it("an end-of-run control that no longer classifies REFUSES even when the share is fine", () => {
    const v = assessNetworkHealth(rows(1, 100), [{ kind: "woo", expect: "woocommerce", got: "unreachable" }]);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/control woo/);
  });
  it("the guard is exact at the boundary, no_origin rows are not in the denominator, and an empty sweep is not a failure", () => {
    expect(assessNetworkHealth(rows(25, 100), []).ok).toBe(true);
    expect(assessNetworkHealth(rows(26, 100), []).ok).toBe(false);
    const mixed: { platform: "woocommerce" | "unreachable" | "no_origin" }[] = [...rows(1, 2), { platform: "no_origin" }];
    expect(assessNetworkHealth(mixed, []).unreachableShare).toBe(0.5);
    expect(assessNetworkHealth([], []).ok).toBe(true);
    expect(UNREACHABLE_SHARE_GUARD).toBe(0.25);
  });
});

describe("shouldWritePlatform — not measured is not a finding", () => {
  it("blocked and unreachable never overwrite a known platform, but do fill an empty one", () => {
    expect(shouldWritePlatform("woocommerce", "blocked")).toBe(false);
    expect(shouldWritePlatform("shopify", "unreachable")).toBe(false);
    expect(shouldWritePlatform(null, "blocked")).toBe(true);
    expect(shouldWritePlatform("blocked", "unreachable")).toBe(true);
    expect(shouldWritePlatform("woocommerce", "woocommerce_closed_api")).toBe(true);
    expect(shouldWritePlatform("woocommerce", "no_origin")).toBe(false);
  });
});
