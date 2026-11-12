import { describe, expect, it } from "vitest";
import { loadRobots, parseRobots } from "./robots.ts";
import type { FetchResult, FetchText } from "./types.ts";

const AGENT = "PepforumBot";

const result = (url: string, status: number | null, body: string | null): FetchResult => ({
  url,
  status,
  state: status === 200 ? "hit" : status === null || status === 403 || status >= 500 ? "unknown" : "miss",
  body,
  fetchedAt: "2026-10-01T00:00:00.000Z",
});

describe("parseRobots", () => {
  it("uses our agent's group when present, else *", () => {
    const ours = parseRobots(`User-agent: *\nDisallow: /\n\nUser-agent: ${AGENT}\nDisallow: /cart/\n`, AGENT);
    expect(ours.allows("/products.json")).toBe(true);
    expect(ours.allows("/cart/")).toBe(false);
    const star = parseRobots(`User-agent: Googlebot\nDisallow:\n\nUser-agent: *\nDisallow: /wp-json/\n`, AGENT);
    expect(star.allows("/wp-json/wc/store/v1/products")).toBe(false);
    expect(star.allows("/product/bpc-157/")).toBe(true);
  });

  it("matches the agent token case-insensitively and as a prefix", () => {
    const p = parseRobots(`user-agent: pepforumbot\ndisallow: /private/\n`, AGENT);
    expect(p.allows("/private/x")).toBe(false);
  });

  it("the longest matching rule wins; Allow wins a tie", () => {
    const p = parseRobots(`User-agent: *\nDisallow: /wp-json/\nAllow: /wp-json/wc/store/\n`, AGENT);
    expect(p.allows("/wp-json/wc/store/v1/products")).toBe(true);
    expect(p.allows("/wp-json/wp/v2/posts")).toBe(false);
    const tie = parseRobots(`User-agent: *\nDisallow: /a\nAllow: /a\n`, AGENT);
    expect(tie.allows("/a")).toBe(true);
  });

  it("supports * wildcards and the $ end anchor", () => {
    const p = parseRobots(`User-agent: *\nDisallow: /*.json$\nDisallow: /search*\n`, AGENT);
    expect(p.allows("/products.json")).toBe(false);
    expect(p.allows("/products.json?limit=250")).toBe(true);
    expect(p.allows("/search?q=x")).toBe(false);
  });

  it("an empty Disallow allows everything; a bare / blocks everything", () => {
    expect(parseRobots(`User-agent: *\nDisallow:\n`, AGENT).allows("/x")).toBe(true);
    expect(parseRobots(`User-agent: *\nDisallow: /\n`, AGENT).allows("/x")).toBe(false);
  });

  it("no matching group means allowed", () => {
    expect(parseRobots(`User-agent: Bingbot\nDisallow: /\n`, AGENT).allows("/x")).toBe(true);
    expect(parseRobots("", AGENT).allows("/x")).toBe(true);
  });
});

describe("loadRobots", () => {
  it("fetches <origin>/robots.txt once and applies it", async () => {
    const seen: string[] = [];
    const fetchText: FetchText = async (url) => {
      seen.push(url);
      return result(url, 200, `User-agent: *\nDisallow: /blocked/\n`);
    };
    const policy = await loadRobots("https://v.test", fetchText);
    expect(seen).toEqual(["https://v.test/robots.txt"]);
    expect(policy.source).toBe("fetched");
    expect(policy.allows("/blocked/page")).toBe(false);
    expect(policy.allows("/open")).toBe(true);
  });

  it("a 404 robots.txt allows everything and says so", async () => {
    const policy = await loadRobots("https://v.test", async (url) => result(url, 404, null));
    expect(policy.source).toBe("absent");
    expect(policy.allows("/anything")).toBe(true);
  });

  it("an unreachable robots.txt allows everything — we cannot honour a file we cannot read", async () => {
    const policy = await loadRobots("https://v.test", async (url) => ({ ...result(url, null, null), error: "timeout" }));
    expect(policy.source).toBe("unreachable");
    expect(policy.allows("/anything")).toBe(true);
  });
});
