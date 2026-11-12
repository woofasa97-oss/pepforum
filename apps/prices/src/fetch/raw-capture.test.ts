import { describe, expect, it } from "vitest";
import {
  CAPTURE_HEADER_MARK,
  MAX_CAPTURE_BYTES,
  RAW_CAPTURE_BUCKET,
  captureObjectKey,
  captureStorageUri,
  createRawCapture,
  gunzipCapture,
  parseCapture,
  replayFetchText,
} from "./raw-capture.ts";
import type { FetchResult } from "./types.ts";

const hit = (url: string, body: string): FetchResult => ({ url, status: 200, state: "hit", body, fetchedAt: "2026-10-01T00:00:01.000Z" });
const failed = (url: string): FetchResult => ({ url, status: null, state: "unknown", body: null, fetchedAt: "2026-10-01T00:00:02.000Z", error: "timeout" });

describe("createRawCapture", () => {
  it("opens with a routing header carrying what the caller passed", () => {
    const c = createRawCapture({
      runLabel: "2026-10-01T00-00Z",
      vendorSlug: "acme",
      header: { platform: "woocommerce", known_product_urls: ["https://acme.test/p/1"], base_url: "https://acme.test" },
      startedAt: new Date("2026-10-01T00:00:00Z"),
    });
    expect(c.header).toMatchObject({
      capture: CAPTURE_HEADER_MARK,
      run_label: "2026-10-01T00-00Z",
      vendor_slug: "acme",
      platform: "woocommerce",
      known_product_urls: ["https://acme.test/p/1"],
      started_at: "2026-10-01T00:00:00.000Z",
    });
  });

  it("records hits and failures alike, and serializes to gzip NDJSON with a digest over the same bytes", () => {
    const c = createRawCapture({ runLabel: "r", vendorSlug: "v" });
    c.record(hit("https://v.test/a", "[1]"));
    c.record(failed("https://v.test/b"));
    expect(c.count).toBe(2);
    const out = c.serialize();
    expect(out.bytes).toBe(out.buffer.length);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.overCap).toBe(false);
    const text = gunzipCapture(out.buffer);
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).capture).toBe(CAPTURE_HEADER_MARK);
    expect(JSON.parse(lines[1])).toMatchObject({ url: "https://v.test/a", status: 200, state: "hit", body: "[1]" });
    expect(JSON.parse(lines[2])).toMatchObject({ url: "https://v.test/b", status: null, state: "unknown", error: "timeout" });
  });

  it("names the bucket and the object key the migration documents", () => {
    expect(RAW_CAPTURE_BUCKET).toBe("offer-raw");
    expect(captureObjectKey("2026-10-01T00-00Z", "acme")).toBe("2026-10-01T00-00Z/acme.ndjson.gz");
    expect(captureStorageUri(captureObjectKey("r", "v"))).toBe("storage://offer-raw/r/v.ndjson.gz");
    expect(MAX_CAPTURE_BYTES).toBe(52_428_800);
  });
});

describe("parseCapture", () => {
  it("refuses an empty file or one without the routing header", () => {
    expect(() => parseCapture("")).toThrow(/empty/);
    expect(() => parseCapture('{"url":"x"}\n')).toThrow(/header/);
    expect(() => parseCapture("not json\n")).toThrow(/not JSON/);
  });
  it("refuses a partial replay when a later line is broken", () => {
    const c = createRawCapture({ runLabel: "r", vendorSlug: "v" });
    const text = gunzipCapture(c.serialize().buffer) + "{broken\n";
    expect(() => parseCapture(text)).toThrow(/line 2/);
  });
  it("round-trips header and records", () => {
    const c = createRawCapture({ runLabel: "r", vendorSlug: "v" });
    c.record(hit("https://v.test/a", "[1]"));
    const parsed = parseCapture(gunzipCapture(c.serialize().buffer));
    expect(parsed.header.vendor_slug).toBe("v");
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].body).toBe("[1]");
  });
});

describe("replayFetchText — a replay never fetches", () => {
  it("answers captured URLs with the recorded result, failures included, so UNKNOWN replays as UNKNOWN", async () => {
    const c = createRawCapture({ runLabel: "r", vendorSlug: "v" });
    c.record(hit("https://v.test/a", "[1]"));
    c.record(failed("https://v.test/b"));
    const replay = replayFetchText(c.records);
    expect(await replay("https://v.test/a")).toMatchObject({ state: "hit", status: 200, body: "[1]" });
    expect(await replay("https://v.test/b")).toMatchObject({ state: "unknown", status: null, error: "timeout" });
  });
  it("throws on an uncaptured URL rather than quietly fetching or 404ing it", async () => {
    const replay = replayFetchText([]);
    await expect(replay("https://v.test/never")).rejects.toThrow(/uncaptured/);
  });
  it("first-seen wins on a duplicate URL", async () => {
    const c = createRawCapture({ runLabel: "r", vendorSlug: "v" });
    c.record(hit("https://v.test/a", "first"));
    c.record(hit("https://v.test/a", "second"));
    expect((await replayFetchText(c.records)("https://v.test/a")).body).toBe("first");
  });
});
