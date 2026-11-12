import { afterEach, describe, expect, it, vi } from "vitest";
import { VENDOR_KEYS, readPipelineEnv, vendorAuthorizationFromEnv, type VendorKey } from "./env.ts";

afterEach(() => vi.unstubAllEnvs());

describe("readPipelineEnv", () => {
  it("names the missing variable", () => {
    vi.stubEnv("PRICES_DB_URL", "");
    expect(() => readPipelineEnv()).toThrow("PRICES_DB_URL");
  });
  it("returns the database url", () => {
    vi.stubEnv("PRICES_DB_URL", "postgresql://u:p@127.0.0.1:5432/db");
    expect(readPipelineEnv()).toEqual({ dbUrl: "postgresql://u:p@127.0.0.1:5432/db" });
  });
});

// A vendor's own price key is sent only to that vendor's own site, over https, and never elsewhere.
describe("vendorAuthorizationFromEnv", () => {
  const keys: VendorKey[] = [{ hosts: ["shop.example.ca", "www.shop.example.ca"], variable: "EXAMPLE_PRICE_KEY" }];
  const at = (url: string) => vendorAuthorizationFromEnv(keys)(new URL(url));

  it("no vendor key is configured for Pepforum yet", () => {
    expect(VENDOR_KEYS).toEqual([]);
    expect(vendorAuthorizationFromEnv()(new URL("https://shop.example.ca/products/x"))).toBeNull();
  });

  it("sends nothing while the key is not set", () => {
    vi.stubEnv("EXAMPLE_PRICE_KEY", "");
    expect(at("https://shop.example.ca/products/tb500")).toBeNull();
  });

  it("sends the trimmed key as a Bearer token to the vendor's own hosts", () => {
    vi.stubEnv("EXAMPLE_PRICE_KEY", " key_abc \r");
    expect(at("https://shop.example.ca/products/tb500")).toBe("Bearer key_abc");
    expect(at("https://www.shop.example.ca/sitemap.xml")).toBe("Bearer key_abc");
  });

  it("never sends it to another host, a look-alike host, or over plain http", () => {
    vi.stubEnv("EXAMPLE_PRICE_KEY", "key_abc");
    expect(at("https://other.example.ca/x")).toBeNull();
    expect(at("https://shop.example.ca.evil.test/x")).toBeNull();
    expect(at("https://evil-shop.example.ca/x")).toBeNull();
    expect(at("http://shop.example.ca/products/tb500")).toBeNull();
  });
});
