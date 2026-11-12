import { describe, expect, it } from "vitest";
import { classifyStatus, createFetcher, PEPFORUM_USER_AGENT, ROBOTS_AGENT } from "./http.ts";
import { createRawCapture } from "./raw-capture.ts";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response> | never;

/** A `fetch` stand-in that records every call and answers per URL. */
function stubFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

const text = (status: number, body = "") => new Response(body, { status });

describe("classifyStatus — the three-state rule at the HTTP layer", () => {
  it("200 is hit", () => expect(classifyStatus(200)).toBe("hit"));
  it("404, 410 and 401 are miss — the server answered no", () => {
    expect(classifyStatus(404)).toBe("miss");
    expect(classifyStatus(410)).toBe("miss");
    expect(classifyStatus(401)).toBe("miss");
  });
  it("403, 429 and 5xx are unknown — a block is not an answer", () => {
    expect(classifyStatus(403)).toBe("unknown");
    expect(classifyStatus(429)).toBe("unknown");
    expect(classifyStatus(500)).toBe("unknown");
    expect(classifyStatus(503)).toBe("unknown");
  });
  it("a 2xx that is not 200 is unknown — a 202 challenge page is not the endpoint's answer", () => {
    expect(classifyStatus(202)).toBe("unknown");
    expect(classifyStatus(204)).toBe("unknown");
  });
});

describe("createFetcher", () => {
  it("classifies 403, 429, 5xx, timeouts and non-200 2xx as unknown; 404 as miss; 200 as hit", async () => {
    const byStatus = new Map<string, number>([
      ["https://v.test/a", 403],
      ["https://v.test/b", 429],
      ["https://v.test/c", 502],
      ["https://v.test/d", 202],
      ["https://v.test/e", 404],
      ["https://v.test/f", 200],
    ]);
    const { impl } = stubFetch((url) => text(byStatus.get(url) ?? 500, "body"));
    const fetchText = createFetcher({ fetchImpl: impl, robots: false });
    expect((await fetchText("https://v.test/a")).state).toBe("unknown");
    expect((await fetchText("https://v.test/b")).state).toBe("unknown");
    expect((await fetchText("https://v.test/c")).state).toBe("unknown");
    expect((await fetchText("https://v.test/d")).state).toBe("unknown");
    expect((await fetchText("https://v.test/e")).state).toBe("miss");
    const hit = await fetchText("https://v.test/f");
    expect(hit.state).toBe("hit");
    expect(hit.status).toBe(200);
    expect(hit.body).toBe("body");
    expect(hit.url).toBe("https://v.test/f");
    expect(hit.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("a network rejection is unknown with the error, never a throw", async () => {
    const { impl } = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const fetchText = createFetcher({ fetchImpl: impl, robots: false });
    const r = await fetchText("https://v.test/x");
    expect(r).toMatchObject({ state: "unknown", status: null, body: null, error: "fetch failed" });
  });

  it("a timeout is unknown with error 'timeout'", async () => {
    const { impl } = stubFetch((_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    );
    const fetchText = createFetcher({ fetchImpl: impl, robots: false, timeoutMs: 20 });
    const r = await fetchText("https://v.test/slow");
    expect(r.state).toBe("unknown");
    expect(r.error).toBe("timeout");
  });

  it("sends the PepforumBot user-agent and the accept header asked for", async () => {
    const { impl, calls } = stubFetch(() => text(200, "{}"));
    const fetchText = createFetcher({ fetchImpl: impl, robots: false });
    await fetchText("https://v.test/products.json", { accept: "application/json" });
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("user-agent")).toBe(PEPFORUM_USER_AGENT);
    // The page named here must exist: /methodology is a real route; a UA that points at a 404 identifies nobody.
    expect(PEPFORUM_USER_AGENT).toBe("PepforumBot/1.0 (+https://pepforum.ca/legal/price-methodology)");
    expect(PEPFORUM_USER_AGENT.startsWith(ROBOTS_AGENT)).toBe(true);
    expect(headers.get("accept")).toBe("application/json");
  });

  it("refuses a path robots.txt disallows for our agent and reports state 'miss' with error 'robots_disallow'", async () => {
    const { impl, calls } = stubFetch((url) => {
      if (url === "https://v.test/robots.txt") return text(200, `User-agent: ${ROBOTS_AGENT}\nDisallow: /wp-json/\n\nUser-agent: *\nDisallow:\n`);
      return text(200, "[]");
    });
    const fetchText = createFetcher({ fetchImpl: impl });
    const refused = await fetchText("https://v.test/wp-json/wc/store/v1/products");
    expect(refused).toMatchObject({ state: "miss", status: null, body: null, error: "robots_disallow" });
    const allowed = await fetchText("https://v.test/products.json");
    expect(allowed.state).toBe("hit");
    // robots.txt was read once for the origin, and the disallowed request was never sent.
    expect(calls.map((c) => c.url)).toEqual(["https://v.test/robots.txt", "https://v.test/products.json"]);
  });

  it("a missing robots.txt allows everything", async () => {
    const { impl } = stubFetch((url) => (url.endsWith("/robots.txt") ? text(404) : text(200, "ok")));
    const fetchText = createFetcher({ fetchImpl: impl });
    expect((await fetchText("https://v.test/anything")).state).toBe("hit");
  });

  it("records every fetch, including robots.txt and failures, in the capture", async () => {
    const { impl } = stubFetch((url) => {
      if (url.endsWith("/robots.txt")) return text(404);
      if (url.endsWith("/boom")) throw new Error("boom");
      return text(200, "ok");
    });
    const capture = createRawCapture({ runLabel: "r1", vendorSlug: "v" });
    const fetchText = createFetcher({ fetchImpl: impl, capture });
    await fetchText("https://v.test/ok");
    await fetchText("https://v.test/boom");
    expect(capture.records.map((r) => [r.url, r.state])).toEqual([
      ["https://v.test/robots.txt", "miss"],
      ["https://v.test/ok", "hit"],
      ["https://v.test/boom", "unknown"],
    ]);
    expect(capture.records[2].error).toBe("boom");
  });
});

// Vendor logos (2026-10-04): an image is read as bytes, never as text, with the same honest
// user-agent and the same robots.txt check as every other read.
describe("a binary read", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe]);

  it("returns the bytes untouched", async () => {
    const { impl } = stubFetch((url) => (url.endsWith("/robots.txt") ? text(404) : new Response(PNG, { status: 200 })));
    const out = await createFetcher({ fetchImpl: impl })("https://shop.example/icon.png", { binary: true });
    expect(out.state).toBe("hit");
    expect(out.body).toBeNull();
    expect([...(out.bytes ?? [])]).toEqual([...PNG]);
  });

  it("is refused where robots.txt disallows it, like any read", async () => {
    const { impl, calls } = stubFetch((url) => (url.endsWith("/robots.txt") ? text(200, "User-agent: *\nDisallow: /wp-content/\n") : new Response(PNG, { status: 200 })));
    const out = await createFetcher({ fetchImpl: impl })("https://shop.example/wp-content/icon.png", { binary: true });
    expect(out).toMatchObject({ state: "miss", error: "robots_disallow" });
    expect(calls.map((c) => c.url)).toEqual(["https://shop.example/robots.txt"]);
  });
});

// Peptide Confidential's price key (2026-10-28): a vendor's key goes to that vendor's own site and
// nowhere else — not to another host, not over plain http, not through a redirect off the site —
// and it is never written into what a run keeps.
describe("a vendor's key", () => {
  const KEY = "Bearer pcpk_test_key_value";
  const onShop = (u: URL) => (u.hostname === "shop.test" ? KEY : null);
  const robots404 = (url: string) => url.endsWith("/robots.txt");

  it("is sent to the URLs its rule names, and to no others", async () => {
    const { impl, calls } = stubFetch((url) => (robots404(url) ? text(404) : text(200, "ok")));
    const fetchText = createFetcher({ fetchImpl: impl, authorization: onShop });
    await fetchText("https://shop.test/products/a");
    await fetchText("https://other.test/products/a");
    const auth = (u: string) => new Headers(calls.find((c) => c.url === u)?.init.headers).get("authorization");
    expect(auth("https://shop.test/products/a")).toBe(KEY);
    expect(auth("https://other.test/products/a")).toBeNull();
  });

  it("is never sent over plain http", async () => {
    const { impl, calls } = stubFetch(() => text(200, "ok"));
    await createFetcher({ fetchImpl: impl, robots: false, authorization: onShop })("http://shop.test/products/a");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBeNull();
  });

  it("follows a redirect on the same site with the key", async () => {
    const { impl, calls } = stubFetch((url) =>
      url === "https://shop.test/old" ? new Response(null, { status: 301, headers: { location: "/products/new" } }) : text(200, "page"),
    );
    const r = await createFetcher({ fetchImpl: impl, robots: false, authorization: onShop })("https://shop.test/old");
    expect(r).toMatchObject({ url: "https://shop.test/old", state: "hit", status: 200, body: "page" });
    expect(calls.map((c) => [c.url, new Headers(c.init.headers).get("authorization"), c.init.redirect])).toEqual([
      ["https://shop.test/old", KEY, "manual"],
      ["https://shop.test/products/new", KEY, "manual"],
    ]);
  });

  it("does not follow a redirect off the site: the read is unknown and the other site is never asked", async () => {
    const { impl, calls } = stubFetch(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/login" } }));
    const r = await createFetcher({ fetchImpl: impl, robots: false, authorization: onShop })("https://shop.test/products/a");
    expect(r).toMatchObject({ state: "unknown", status: 302, body: null, error: "redirect_off_site" });
    expect(calls.map((c) => c.url)).toEqual(["https://shop.test/products/a"]);
  });

  it("stops after five redirects on the site", async () => {
    let n = 0;
    const { impl, calls } = stubFetch(() => new Response(null, { status: 302, headers: { location: `/hop-${++n}` } }));
    const r = await createFetcher({ fetchImpl: impl, robots: false, authorization: onShop })("https://shop.test/start");
    expect(r).toMatchObject({ state: "unknown", error: "too_many_redirects" });
    expect(calls).toHaveLength(6);
  });

  it("leaves a read without a key as it was: redirects followed by fetch itself", async () => {
    const { impl, calls } = stubFetch(() => text(200, "ok"));
    await createFetcher({ fetchImpl: impl, robots: false, authorization: onShop })("https://other.test/a");
    expect(calls[0].init.redirect).toBe("follow");
  });

  it("is never in the capture", async () => {
    const { impl } = stubFetch((url) => (robots404(url) ? text(404) : url.endsWith("/old") ? new Response(null, { status: 301, headers: { location: "/new" } }) : text(200, "ok")));
    const capture = createRawCapture({ runLabel: "r1", vendorSlug: "shop" });
    const fetchText = createFetcher({ fetchImpl: impl, capture, authorization: onShop });
    await fetchText("https://shop.test/old");
    await fetchText("https://shop.test/products/a");
    expect(capture.records.length).toBeGreaterThan(0);
    expect(JSON.stringify(capture.records)).not.toContain("pcpk_test_key_value");
    expect(capture.serialize().buffer.toString("latin1")).not.toContain("pcpk_test_key_value");
  });
});
