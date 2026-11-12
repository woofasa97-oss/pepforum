// The ledger's vocabulary, and the one field that licenses a removal. `run_complete` is tested as
// an ALLOWLIST: every outcome is enumerated and exactly one may set it true — a test that only
// checks "a hit sets it true" passes equally when a blocked vendor does too.
import { describe, expect, it } from "vitest";
import type { Attempt } from "../ladder/types.ts";
import { buildAttemptPatch, carriedLists, classifyOutcome, deadUrlsFromAttempts, MAX_DEAD_URLS, pickHttpStatus } from "./attempts.ts";
import type { AttemptRow } from "./repo.ts";

const NOW = new Date("2026-10-01T10:00:00Z");
const attempt = (over: Partial<Attempt> = {}): Attempt => ({ rung: "woo_store_api", url: "https://v/api", state: "unknown", status: null, reason: null, ...over });
const row = (counts: unknown): AttemptRow => ({ counts }) as AttemptRow;

describe("classifyOutcome", () => {
  it("a hit is a hit", () => {
    expect(classifyOutcome({ ladderState: "hit" })).toBe("hit");
  });
  it("a miss is a miss — the endpoint answered no", () => {
    expect(classifyOutcome({ ladderState: "miss" })).toBe("miss");
  });
  it.each([403, 429])("unknown + http %i is blocked — someone refused us", (status) => {
    expect(classifyOutcome({ ladderState: "unknown", attempts: [attempt({ status })] })).toBe("blocked");
  });
  it("unknown + a 2xx-not-200 challenge page is blocked", () => {
    expect(classifyOutcome({ ladderState: "unknown", attempts: [attempt({ status: 202 })] })).toBe("blocked");
  });
  it("unknown + a 503 stays unknown — the server is unwell, nobody refused us", () => {
    expect(classifyOutcome({ ladderState: "unknown", attempts: [attempt({ status: 503 })] })).toBe("unknown");
  });
  it("unknown + a transport failure (status null) stays unknown", () => {
    expect(classifyOutcome({ ladderState: "unknown", attempts: [attempt({ status: null })] })).toBe("unknown");
  });
  it("held overrides a hit — it is a statement about the apply, not the read", () => {
    expect(classifyOutcome({ ladderState: "hit", held: true })).toBe("held");
  });
  it("a plain 200 does not make an unknown look healthy", () => {
    expect(classifyOutcome({ ladderState: "unknown", attempts: [attempt({ status: 200, state: "miss" }), attempt({ status: 403 })] })).toBe("blocked");
  });
});

describe("run_complete — the allowlist", () => {
  type PatchArgs = Parameters<typeof buildAttemptPatch>[0];
  const patchFor = (over: Partial<PatchArgs>) =>
    buildAttemptPatch({ ladderState: "hit", attempts: [], applied: false, rung: null, productsSeen: 0, matched: 0, rowsWritten: 0, counts: {}, finishedAt: NOW, ...over });

  it("only a hit that was fully applied sets it true", () => {
    expect(patchFor({ ladderState: "hit", applied: true }).run_complete).toBe(true);
  });

  it.each<[string, Partial<PatchArgs>]>([
    ["hit but the apply did not complete", { ladderState: "hit", applied: false }],
    ["hit but held", { ladderState: "hit", applied: true, held: true }],
    ["miss", { ladderState: "miss", applied: true }],
    ["unknown", { ladderState: "unknown", applied: true }],
    ["blocked", { ladderState: "unknown", attempts: [attempt({ status: 403 })], applied: true }],
  ])("%s leaves it false", (_label, over) => {
    expect(patchFor(over).run_complete).toBe(false);
  });
});

describe("pickHttpStatus", () => {
  it("a hit records the winning rung's status", () => {
    expect(pickHttpStatus([attempt({ status: 404, state: "miss" }), attempt({ status: 200, state: "hit" })], "hit")).toBe(200);
  });
  it("a held run records the status of the read it withheld", () => {
    expect(pickHttpStatus([attempt({ status: 404, state: "miss" }), attempt({ status: 200, state: "hit" })], "held")).toBe(200);
  });
  it("a block records the blocking status, not an earlier 200", () => {
    expect(pickHttpStatus([attempt({ status: 200, state: "miss" }), attempt({ status: 429 })], "blocked")).toBe(429);
  });
  it("otherwise the last status seen", () => {
    expect(pickHttpStatus([attempt({ status: 200, state: "miss" }), attempt({ status: 404, state: "miss" })], "miss")).toBe(404);
    expect(pickHttpStatus([attempt({ status: 503 }), attempt({ status: null })], "unknown")).toBe(503);
  });
  it("no status anywhere is null, never 0", () => {
    expect(pickHttpStatus([attempt({ status: null })], "unknown")).toBeNull();
    expect(pickHttpStatus([], "unknown")).toBeNull();
  });
});

describe("deadUrlsFromAttempts", () => {
  it("takes only attempts the ladder marked dead", () => {
    expect(
      deadUrlsFromAttempts([attempt({ url: "https://v/a", dead: true, status: 404 }), attempt({ url: "https://v/b", status: 500 }), attempt({ url: "https://v/c", dead: true, status: 410 })]),
    ).toEqual(["https://v/a", "https://v/c"]);
  });
  it("dedupes and sorts — an unsorted bound would carry a different subset each run", () => {
    expect(deadUrlsFromAttempts([attempt({ url: "https://v/z", dead: true }), attempt({ url: "https://v/a", dead: true }), attempt({ url: "https://v/z", dead: true })])).toEqual(["https://v/a", "https://v/z"]);
  });
  it("bounds the list", () => {
    const many = Array.from({ length: MAX_DEAD_URLS + 10 }, (_, i) => attempt({ url: `https://v/${i}`, dead: true }));
    expect(deadUrlsFromAttempts(many)).toHaveLength(MAX_DEAD_URLS);
  });
  it("a 404 with no dead flag is not carried — the flag is the ladder's own verdict", () => {
    expect(deadUrlsFromAttempts([attempt({ url: "https://v/a", status: 404 })])).toEqual([]);
  });
});

describe("buildAttemptPatch — shape", () => {
  it("records the capture pointer, the counts blob and the finish time", () => {
    const patch = buildAttemptPatch({
      ladderState: "hit",
      applied: true,
      attempts: [attempt({ state: "hit", status: 200 })],
      rung: "woo_store_api",
      productsSeen: 12,
      matched: 11,
      rowsWritten: 10,
      counts: { changed: 2, missing_product_keys: ["pk-a"] },
      capture: { uri: "storage://offer-raw/run/v.ndjson.gz", sha256: "abc", bytes: 4096 },
      finishedAt: NOW,
    });
    expect(patch).toMatchObject({
      outcome: "hit",
      rung: "woo_store_api",
      http_status: 200,
      run_complete: true,
      products_seen: 12,
      matched: 11,
      rows_written: 10,
      raw_capture_uri: "storage://offer-raw/run/v.ndjson.gz",
      raw_capture_sha256: "abc",
      raw_capture_bytes: 4096,
      error: null,
      finished_at: NOW.toISOString(),
    });
    expect(carriedLists(patch as AttemptRow).missingProductKeys).toEqual(["pk-a"]);
  });

  it("a capture that never happened is null, not 0 bytes", () => {
    const patch = buildAttemptPatch({ ladderState: "unknown", attempts: [], applied: false, rung: null, productsSeen: 0, matched: 0, rowsWritten: 0, counts: {}, finishedAt: NOW });
    expect(patch.raw_capture_uri).toBeNull();
    expect(patch.raw_capture_bytes).toBeNull();
  });

  it("carries a driver error as the row's error", () => {
    const patch = buildAttemptPatch({ ladderState: "hit", attempts: [], applied: false, rung: null, productsSeen: 3, matched: 0, rowsWritten: 0, counts: {}, error: "driver_error: boom", finishedAt: NOW });
    expect(patch).toMatchObject({ outcome: "hit", run_complete: false, error: "driver_error: boom" });
  });
});

describe("carriedLists — reading a previous row back", () => {
  it("reads both lists out of counts", () => {
    expect(carriedLists(row({ missing_product_keys: ["a"], dead_urls: ["https://v/x"] }))).toEqual({ missingProductKeys: ["a"], deadUrls: ["https://v/x"] });
  });
  it("an older row with no counts yields empty lists, never undefined", () => {
    expect(carriedLists(row(undefined))).toEqual({ missingProductKeys: [], deadUrls: [] });
    expect(carriedLists(null)).toEqual({ missingProductKeys: [], deadUrls: [] });
  });
  it("a non-array value does not leak through", () => {
    expect(carriedLists(row({ missing_product_keys: "pk-a", dead_urls: 7 }))).toEqual({ missingProductKeys: [], deadUrls: [] });
  });
});
