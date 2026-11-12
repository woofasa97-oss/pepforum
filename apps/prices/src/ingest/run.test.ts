import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { FetchResult, FetchText } from "../fetch/types.ts";
import { InMemoryRepo, type CompoundRow, type VendorRow } from "./repo.ts";
import { defaultRunLabel, runRefresh, selectVendors } from "./run.ts";

const VARIABLE = readFileSync(new URL("../ladder/__fixtures__/woo-store-products-variable.json", import.meta.url), "utf8");
const VARIATIONS_181 = readFileSync(new URL("../ladder/__fixtures__/woo-store-variations-parent-181.json", import.meta.url), "utf8");
const AT = "2026-10-01T00:00:00.000Z";
const res = (url: string, status: number, body = ""): FetchResult => ({ url, status, state: status === 200 ? "hit" : status === 404 ? "miss" : "unknown", body, fetchedAt: AT });

const vendor = (id: string, slug: string, over: Partial<VendorRow> = {}): VendorRow =>
  ({ id, slug, name: slug, website_url: `https://${slug}.com`, canonical_domain: `${slug}.com`, origin_country: "US", status: "active", detected_platform: "woocommerce", ...over }) as VendorRow;

const fetchText: FetchText = async (url) => {
  if (url.startsWith("https://blankpeptides.com")) {
    if (url.includes("parent=181")) return res(url, 200, VARIATIONS_181);
    if (url.includes("parent=286")) return res(url, 200, "[]");
    if (url.includes("wc/store")) return res(url, 200, VARIABLE);
    return res(url, 404);
  }
  if (url.startsWith("https://blocked.com")) return res(url, 403);
  return res(url, 404);
};

function setup() {
  const repo = new InMemoryRepo();
  repo.seedVendor(vendor("v-blank", "blankpeptides"));
  repo.seedVendor(vendor("v-blocked", "blocked"));
  repo.seedVendor(vendor("v-closed", "closed", { detected_platform: "woocommerce_closed_api" }));
  repo.seedVendor(vendor("v-pending", "pending", { status: "pending" }));
  repo.seedCompound({ id: "c-reta", slug: "retatrutide", name: "Retatrutide", aliases: [] } as unknown as CompoundRow);
  return repo;
}

describe("selectVendors", () => {
  it("feeds mode takes feed platforms (and unprobed vendors); pages mode takes the closed/page platforms", () => {
    const all = [vendor("1", "a"), vendor("2", "b", { detected_platform: "shopify" }), vendor("3", "c", { detected_platform: "woocommerce_closed_api" }), vendor("4", "d", { detected_platform: null }), vendor("5", "e", { detected_platform: "blocked" })];
    expect(selectVendors(all, "feeds").map((v) => v.slug)).toEqual(["a", "b", "d"]);
    expect(selectVendors(all, "pages").map((v) => v.slug)).toEqual(["c"]);
  });
  it("names a run by mode and minute", () => {
    expect(defaultRunLabel("feeds", new Date("2026-10-01T12:34:56Z"))).toBe("refresh-feeds-2026-10-01T12-34Z");
  });
});

describe("runRefresh", () => {
  it("creates a run, ingests each selected active vendor in turn, and commits with a summary", async () => {
    const repo = setup();
    const summary = await runRefresh({ repo, fetchText, mode: "feeds", dryRun: false, now: new Date("2026-10-01T12:00:00Z") });
    expect(summary.runLabel).toBe("refresh-feeds-2026-10-01T12-00Z");
    expect(summary.vendors).toBe(2); // blank + blocked; closed is pages-mode, pending is not active
    expect(summary.byOutcome).toEqual({ hit: 1, blocked: 1 });
    expect(summary.rowsWritten).toBe(4);
    expect(summary.fetches).toBeGreaterThan(0);
    const run = [...repo.runs.values()][0];
    expect(run).toMatchObject({ run_label: summary.runLabel, mode: "feeds", dry_run: false, status: "committed" });
    expect(run.finished_at).not.toBeNull();
    expect((run.metrics as { rows_written: number }).rows_written).toBe(4);
    expect(repo.attempts.size).toBe(2);
    expect(repo.offers.size).toBe(4);
  });

  it("a dry run creates a dry-run row, writes no offers and still reports what it would have written", async () => {
    const repo = setup();
    const summary = await runRefresh({ repo, fetchText, mode: "feeds", dryRun: true, vendors: ["blankpeptides"] });
    expect(summary.vendors).toBe(1);
    expect(summary.rowsWritten).toBe(4);
    expect(repo.offers.size).toBe(0);
    expect([...repo.runs.values()][0]).toMatchObject({ dry_run: true, status: "committed" });
  });

  it("records whether it was scoped and which vendors it covered, so the gate can tell a slice from the corpus", async () => {
    const repo = setup();
    const full = await runRefresh({ repo, fetchText, mode: "feeds", dryRun: false, runLabel: "full" });
    expect(repo.runs.get(full.runId)?.metrics).toMatchObject({ vendor_scope: null, vendor_ids: ["v-blank", "v-blocked"] });
    const scoped = await runRefresh({ repo, fetchText, mode: "feeds", dryRun: false, runLabel: "scoped", vendors: ["blankpeptides"] });
    expect(repo.runs.get(scoped.runId)?.metrics).toMatchObject({ vendor_scope: ["blankpeptides"], vendor_ids: ["v-blank"] });
  });

  it("includes pending vendors only when asked, and refuses an unknown slug", async () => {
    const repo = setup();
    const summary = await runRefresh({ repo, fetchText, mode: "feeds", dryRun: true, status: "all", vendors: ["pending"] });
    expect(summary.vendors).toBe(1);
    await expect(runRefresh({ repo, fetchText, mode: "feeds", dryRun: true, vendors: ["nope"] })).rejects.toThrow(/nope/);
  });

  it("a vendor whose ledger row cannot even be claimed is an error for that vendor — the run goes on and is closed", async () => {
    const repo = setup();
    const claim = repo.claimAttempt.bind(repo);
    repo.claimAttempt = async (a) => {
      if (a.vendor_id === "v-blank") throw new Error("read ETIMEDOUT");
      return claim(a);
    };
    const summary = await runRefresh({ repo, fetchText, mode: "feeds", dryRun: false });
    expect(summary.errors).toEqual([{ slug: "blankpeptides", error: "read ETIMEDOUT" }]);
    expect(summary.byOutcome).toMatchObject({ blocked: 1 });
    const run = [...repo.runs.values()][0];
    expect(run.status).toBe("error");
    expect(run.finished_at).not.toBeNull();
  });

  it("a vendor whose ingest throws is recorded as an error and does not stop the run", async () => {
    const repo = setup();
    repo.listOffers = async (vendorId) => {
      if (vendorId === "v-blank") throw new Error("db exploded");
      return [];
    };
    const summary = await runRefresh({ repo, fetchText, mode: "feeds", dryRun: false, vendors: ["blankpeptides", "blocked"] });
    expect(summary.byOutcome).toMatchObject({ blocked: 1 });
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({ slug: "blankpeptides" });
    expect([...repo.runs.values()][0].status).toBe("error");
  });
});
