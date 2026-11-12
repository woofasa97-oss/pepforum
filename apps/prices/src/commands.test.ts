import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EXIT, parseArgs, runCommand, type CliDeps } from "./commands.ts";
import { createRawCapture } from "./fetch/raw-capture.ts";
import type { FetchResult, FetchText } from "./fetch/types.ts";
import { InMemoryRepo, type AttemptRow, type CompoundRow, type OfferRow, type RunRow, type VendorRow } from "./ingest/repo.ts";

const VARIABLE = readFileSync(new URL("./ladder/__fixtures__/woo-store-products-variable.json", import.meta.url), "utf8");
const VARIATIONS_181 = readFileSync(new URL("./ladder/__fixtures__/woo-store-variations-parent-181.json", import.meta.url), "utf8");
const res = (url: string, status: number, body = ""): FetchResult => ({ url, status, state: status === 200 ? "hit" : status === 404 ? "miss" : "unknown", body, fetchedAt: "2026-10-01T00:00:00.000Z" });
const failed = (url: string): FetchResult => ({ url, status: null, state: "unknown", body: null, fetchedAt: "2026-10-01T00:00:00.000Z", error: "getaddrinfo ENOTFOUND" });

/** blankpeptides is a Woo store with a catalogue; shopco is Shopify; everything else does not resolve. */
const network: FetchText = async (url) => {
  if (url.startsWith("https://blankpeptides.com")) {
    if (url.includes("parent=181")) return res(url, 200, VARIATIONS_181);
    if (url.includes("parent=286")) return res(url, 200, "[]");
    if (url.includes("wc/store")) return res(url, 200, VARIABLE);
    return res(url, 404);
  }
  if (url.startsWith("https://shopco.com")) return url.includes("products.json") ? res(url, 200, '{"products":[]}') : res(url, 404);
  return failed(url);
};

const vendor = (id: string, slug: string, over: Partial<VendorRow> = {}): VendorRow =>
  ({ id, slug, name: slug, website_url: `https://${slug}.com`, canonical_domain: `${slug}.com`, origin_country: "US", status: "active", detected_platform: "woocommerce", ...over }) as VendorRow;

function setup(over: Partial<CliDeps> = {}) {
  const repo = new InMemoryRepo();
  repo.seedVendor(vendor("v-blank", "blankpeptides"));
  repo.seedVendor(vendor("v-shop", "shopco", { detected_platform: null }));
  repo.seedVendor(vendor("v-pending", "pendingco", { status: "pending" }));
  repo.seedCompound({ id: "c-reta", slug: "retatrutide", name: "Retatrutide", aliases: [], is_active: true } as unknown as CompoundRow);
  const printed: Record<string, unknown>[] = [];
  const logged: { event: string; fields: Record<string, unknown> }[] = [];
  const deps: CliDeps = {
    openRepo: () => repo,
    fetchText: () => network,
    fetchJson: async () => ({ base: "USD", date: "2026-10-01", rates: { CAD: 1.36712 } }),
    isTTY: false,
    env: {},
    out: (summary) => printed.push(summary),
    log: (event, fields = {}) => logged.push({ event, fields }),
    seeds: { compounds: [], vendors: [] },
    sleep: async () => {},
    ...over,
  };
  return { repo, deps, printed, logged };
}

describe("parseArgs", () => {
  it("reads a command, value flags in both spellings, and boolean flags", () => {
    expect(parseArgs(["refresh", "--mode", "feeds", "--vendors=a,b", "--live"])).toEqual({ command: "refresh", flags: { mode: "feeds", vendors: "a,b", live: true }, errors: [] });
  });
  it("reports an unknown flag, a missing value and a stray word instead of guessing", () => {
    expect(parseArgs(["refresh", "--vendor", "a"]).errors).toEqual(["unknown flag --vendor for refresh"]);
    expect(parseArgs(["refresh", "--mode"]).errors).toEqual(["--mode needs a value"]);
    expect(parseArgs(["refresh", "--mode", "--live"]).errors).toEqual(["--mode needs a value"]);
    expect(parseArgs(["refresh", "feeds"]).errors).toEqual(["unexpected argument feeds"]);
    expect(parseArgs(["refresh", "--live=yes"]).errors).toEqual(["--live takes no value"]);
    expect(parseArgs(["frobnicate"]).errors).toEqual(["unknown command frobnicate"]);
    expect(parseArgs([]).errors).toEqual(["no command given"]);
  });
  it("an empty value is kept as empty — the workflow passes --vendors \"\" for 'all'", () => {
    expect(parseArgs(["refresh", "--vendors", ""]).flags).toEqual({ vendors: "" });
  });
});

describe("usage and environment refusals", () => {
  it("refuses bad arguments with exit 2 and touches nothing", async () => {
    const { deps, repo, logged } = setup();
    expect(await runCommand(["refresh", "--vendor", "a"], deps)).toBe(EXIT.refused);
    expect(await runCommand(["nope"], deps)).toBe(EXIT.refused);
    expect(repo.runs.size).toBe(0);
    expect(logged.map((l) => l.event)).toEqual(["refused", "refused"]);
  });
  it("a missing environment is a refusal, not an error", async () => {
    const { deps } = setup({
      openRepo: () => {
        throw new Error("PRICES_DB_URL is required");
      },
    });
    expect(await runCommand(["fx"], deps)).toBe(EXIT.refused);
  });
  it("a failure during the work is exit 1", async () => {
    const { deps } = setup({ fetchJson: async () => ({ base: "USD", date: "2026-10-01", rates: { CAD: 13.6 } }) });
    expect(await runCommand(["fx"], deps)).toBe(EXIT.error);
  });
});

describe("refresh", () => {
  it("is a dry run unless told otherwise, and reports what it would write", async () => {
    const { deps, repo, printed } = setup();
    expect(await runCommand(["refresh", "--mode", "feeds", "--label", "t1"], deps)).toBe(EXIT.ok);
    expect(repo.offers.size).toBe(0);
    expect(printed[0]).toMatchObject({ command: "refresh", run_label: "t1", mode: "feeds", dry_run: true, vendors: 2, rows_would_write: 4, driver_errors: 0 });
    expect((printed[0].by_outcome as Record<string, number>).hit).toBeGreaterThanOrEqual(1);
    expect(printed[0]).not.toHaveProperty("rows_written");
    expect(repo.runs.size).toBe(1);
  });

  it("refuses --live from a non-interactive shell unless PIPELINE_ALLOW_LIVE=1 — before any read", async () => {
    const { deps, repo } = setup();
    expect(await runCommand(["refresh", "--mode", "feeds", "--live"], deps)).toBe(EXIT.refused);
    expect(repo.runs.size).toBe(0);
    expect(await runCommand(["refresh", "--mode", "feeds", "--live"], { ...deps, env: { PIPELINE_ALLOW_LIVE: "true" } })).toBe(EXIT.refused);
  });

  it("writes on --live from a terminal, or with PIPELINE_ALLOW_LIVE=1", async () => {
    const tty = setup({ isTTY: true });
    expect(await runCommand(["refresh", "--mode", "feeds", "--live", "--label", "live-1"], tty.deps)).toBe(EXIT.ok);
    expect(tty.repo.offers.size).toBe(4);
    expect(tty.printed[0]).toMatchObject({ dry_run: false, rows_written: 4 });
    const ci = setup({ env: { PIPELINE_ALLOW_LIVE: "1" } });
    expect(await runCommand(["refresh", "--mode", "feeds", "--live"], ci.deps)).toBe(EXIT.ok);
    expect(ci.repo.offers.size).toBe(4);
  });

  it("refuses contradictory or invalid flags", async () => {
    const { deps } = setup({ isTTY: true });
    expect(await runCommand(["refresh", "--mode", "feeds", "--live", "--dry-run"], deps)).toBe(EXIT.refused);
    expect(await runCommand(["refresh", "--mode", "everything"], deps)).toBe(EXIT.refused);
    expect(await runCommand(["refresh"], deps)).toBe(EXIT.refused);
    expect(await runCommand(["refresh", "--mode", "feeds", "--status", "deleted"], deps)).toBe(EXIT.refused);
  });

  it("an empty --vendors means every active vendor; a named vendor scopes the run", async () => {
    const { deps, printed } = setup();
    await runCommand(["refresh", "--mode", "feeds", "--vendors", "", "--label", "all"], deps);
    await runCommand(["refresh", "--mode", "feeds", "--vendors", "blankpeptides", "--label", "one"], deps);
    expect(printed.map((p) => p.vendors)).toEqual([2, 1]);
  });

  it("a dry run may name a pending vendor; a live run may not, unless --status says so", async () => {
    const { deps, repo } = setup({ isTTY: true });
    expect(await runCommand(["refresh", "--mode", "feeds", "--vendors", "pendingco", "--label", "p-dry"], deps)).toBe(EXIT.ok);
    expect(await runCommand(["refresh", "--mode", "feeds", "--vendors", "pendingco", "--live", "--label", "p-live"], deps)).toBe(EXIT.refused);
    expect(await repo.getRunByLabel("p-live")).toBeNull();
    expect(await runCommand(["refresh", "--mode", "feeds", "--vendors", "pendingco", "--live", "--status", "all", "--label", "p-live-2"], deps)).toBe(EXIT.ok);
    expect(await runCommand(["refresh", "--mode", "feeds", "--vendors", "nope"], deps)).toBe(EXIT.refused);
  });

  it("a held vendor is released only by --accept-drop on a live run that names it", async () => {
    const { deps, repo, printed } = setup({ isTTY: true });
    repo.seedAttempt({ id: "prior", vendor_id: "v-blank", run_id: "r0", outcome: "hit", run_complete: true, rows_written: 100, finished_at: "2026-09-30T00:00:00.000Z", counts: {} } as AttemptRow);
    expect(await runCommand(["refresh", "--mode", "feeds", "--vendors", "blankpeptides", "--live", "--label", "held-1"], deps)).toBe(EXIT.ok);
    expect(printed.at(-1)).toMatchObject({ held: ["blankpeptides"], rows_written: 0 });
    expect(await runCommand(["refresh", "--mode", "feeds", "--live", "--accept-drop"], deps)).toBe(EXIT.refused); // every vendor at once
    expect(await runCommand(["refresh", "--mode", "feeds", "--vendors", "blankpeptides", "--accept-drop"], deps)).toBe(EXIT.refused); // a dry run accepts nothing
    expect(await runCommand(["refresh", "--mode", "feeds", "--vendors", "blankpeptides", "--live", "--accept-drop", "--label", "released-1"], deps)).toBe(EXIT.ok);
    expect(printed.at(-1)).toMatchObject({ held: [], rows_written: 4, accepted_drop: true });
  });

  it("one vendor's error among many does not fail the command — the gate's own 5% rule decides the run", async () => {
    const { deps, repo, printed } = setup();
    for (let i = 0; i < 20; i++) repo.seedVendor(vendor(`v-extra-${i}`, `extra${i}`));
    const list = repo.listOffers.bind(repo);
    repo.listOffers = async (vendorId) => {
      if (vendorId === "v-blank") throw new Error("db exploded");
      return list(vendorId);
    };
    expect(await runCommand(["refresh", "--mode", "feeds"], deps)).toBe(EXIT.ok);
    expect(printed[0]).toMatchObject({ vendors: 22, driver_errors: 1 });
  });

  it("exits 1 when a vendor ended in a driver error, and still prints the summary", async () => {
    const { deps, repo, printed } = setup();
    repo.listOffers = async () => {
      throw new Error("db exploded");
    };
    expect(await runCommand(["refresh", "--mode", "feeds"], deps)).toBe(EXIT.error);
    expect(printed[0]).toMatchObject({ driver_errors: 2 });
  });
});

describe("gate", () => {
  const liveRun = async (s: ReturnType<typeof setup>, label: string) => runCommand(["refresh", "--mode", "feeds", "--live", "--label", label], { ...s.deps, isTTY: true });

  it("exit 11 for a first run with nothing to compare against; accepting it makes it the baseline; the next run passes with 0", async () => {
    const s = setup();
    await liveRun(s, "first");
    expect(await runCommand(["gate", "--run", "first"], s.deps)).toBe(EXIT.holdNoBaseline);
    expect(s.printed.at(-1)).toMatchObject({ command: "gate", run_label: "first", verdict: "hold", no_baseline: true });
    expect(await runCommand(["gate", "--run", "first", "--accept-baseline", "--approver", "Owner", "--reason", "first run, checked"], s.deps)).toBe(EXIT.ok);
    expect(s.printed.at(-1)).toMatchObject({ command: "gate", accepted_baseline: true });
    await liveRun(s, "second");
    expect(await runCommand(["gate", "--run", "second"], s.deps)).toBe(EXIT.ok);
    expect(s.printed.at(-1)).toMatchObject({ verdict: "pass", no_baseline: false });
  });

  it("exit 10 for a measured failure — even when there is also no baseline", async () => {
    const s = setup();
    await liveRun(s, "first");
    for (const o of [...s.repo.offers.values()]) s.repo.offers.set(o.id, { ...o, extraction_confidence: "low" } as OfferRow);
    expect(await runCommand(["gate", "--run", "first"], s.deps)).toBe(EXIT.hold);
  });

  it("refuses an unknown run, a dry run, a missing --run, and an unattributed acceptance", async () => {
    const s = setup();
    await runCommand(["refresh", "--mode", "feeds", "--label", "dry"], s.deps);
    expect(await runCommand(["gate", "--run", "nope"], s.deps)).toBe(EXIT.refused);
    expect(await runCommand(["gate", "--run", "dry"], s.deps)).toBe(EXIT.refused);
    expect(await runCommand(["gate"], s.deps)).toBe(EXIT.refused);
    await liveRun(s, "first");
    await runCommand(["gate", "--run", "first"], s.deps);
    expect(await runCommand(["gate", "--run", "first", "--accept-baseline", "--reason", "x"], s.deps)).toBe(EXIT.refused);
    expect(await runCommand(["gate", "--run", "first", "--approver", "Owner"], s.deps)).toBe(EXIT.refused); // approver without --accept-baseline
    expect((s.repo.runs.get((await s.repo.getRunByLabel("first"))?.id ?? "") as RunRow).verdict).toBe("hold");
  });
});

describe("prune", () => {
  it("is a dry run by default, prunes on --live, and refuses a run that did not pass", async () => {
    const s = setup();
    s.repo.now = () => new Date("2027-01-15T00:00:00.000Z");
    await runCommand(["refresh", "--mode", "feeds", "--live", "--label", "first"], { ...s.deps, isTTY: true });
    s.repo.seedOffer({ id: "aged", vendor_id: "v-blank", compound_id: "c-reta", product_key: "k-aged", variant_key: "", product_name: "Retatrutide 10mg", variant_label: null, run_id: "older", observed_at: "2026-01-01T00:00:00.000Z" } as OfferRow);
    expect(await runCommand(["prune", "--run", "first"], s.deps)).toBe(EXIT.refused); // not gated yet
    await runCommand(["gate", "--run", "first"], s.deps);
    await runCommand(["gate", "--run", "first", "--accept-baseline", "--approver", "Owner", "--reason", "first"], s.deps);
    expect(await runCommand(["prune", "--run", "first"], s.deps)).toBe(EXIT.ok);
    expect(s.printed.at(-1)).toMatchObject({ command: "prune", run_label: "first", dry_run: true, would_prune: 1 });
    expect(s.repo.offers.has("aged")).toBe(true);
    expect(await runCommand(["prune", "--run", "first", "--live"], s.deps)).toBe(EXIT.ok);
    expect(s.printed.at(-1)).toMatchObject({ dry_run: false, pruned: 1 });
    expect(s.repo.offers.has("aged")).toBe(false);
    expect(await runCommand(["prune", "--run", "nope"], s.deps)).toBe(EXIT.refused);
  });
});

describe("publish", () => {
  it("is a dry run by default, publishes on --live, and refuses a run that did not pass", async () => {
    const s = setup();
    await runCommand(["refresh", "--mode", "feeds", "--live", "--label", "first"], { ...s.deps, isTTY: true });
    expect(await runCommand(["publish", "--run", "first"], s.deps)).toBe(EXIT.refused); // not gated yet
    await runCommand(["gate", "--run", "first"], s.deps);
    await runCommand(["gate", "--run", "first", "--accept-baseline", "--approver", "Owner", "--reason", "first"], s.deps);
    const { eligible } = await s.repo.previewPublish();
    expect(eligible).toBeGreaterThan(0);

    expect(await runCommand(["publish", "--run", "first"], s.deps)).toBe(EXIT.ok);
    expect(s.printed.at(-1)).toMatchObject({ command: "publish", run_label: "first", dry_run: true, would_publish: eligible });
    expect(s.repo.published.size).toBe(0);

    expect(await runCommand(["publish", "--run", "first", "--live"], s.deps)).toBe(EXIT.ok);
    expect(s.printed.at(-1)).toMatchObject({ command: "publish", dry_run: false, offers: eligible, changed: eligible, removed: 0 });
    expect(s.repo.published.size).toBe(eligible);

    expect(await runCommand(["publish", "--run", "nope"], s.deps)).toBe(EXIT.refused);
    expect(await runCommand(["publish"], s.deps)).toBe(EXIT.refused);
    expect(await runCommand(["publish", "--run", "first", "--live", "--dry-run"], s.deps)).toBe(EXIT.refused);
  });
});

describe("captures — uploading a run's raw captures as its own step, away from the vendor-facing code", () => {
  const files = [{ slug: "blankpeptides", bytes: Buffer.from("gz-1") }, { slug: "shopco", bytes: Buffer.from("gz-2") }];

  it("uploads each local capture and points the attempt at it", async () => {
    const s = setup({ isTTY: true, readCaptures: () => files });
    await runCommand(["refresh", "--mode", "feeds", "--live", "--label", "cap-1"], s.deps);
    s.repo.uploads.length = 0;
    expect(await runCommand(["captures", "--run", "cap-1"], s.deps)).toBe(EXIT.ok);
    expect(s.printed.at(-1)).toMatchObject({ command: "captures", run_label: "cap-1", files: 2, uploaded: 2, failed: [] });
    expect(s.repo.uploads.map((u) => u.key)).toEqual(["cap-1/blankpeptides.ndjson.gz", "cap-1/shopco.ndjson.gz"]);
    const uris = [...s.repo.attempts.values()].map((a) => a.raw_capture_uri).sort();
    expect(uris).toEqual(["storage://offer-raw/cap-1/blankpeptides.ndjson.gz", "storage://offer-raw/cap-1/shopco.ndjson.gz"]);
  });

  it("reports the uploads that failed and exits 1; refuses when there is nothing local or no such run", async () => {
    const s = setup({ isTTY: true, readCaptures: () => files });
    await runCommand(["refresh", "--mode", "feeds", "--live", "--label", "cap-2"], s.deps);
    s.repo.uploadCapture = async (key) => (key.includes("shopco") ? { uri: null, error: "bucket not found" } : { uri: `storage://offer-raw/${key}`, error: null });
    expect(await runCommand(["captures", "--run", "cap-2"], s.deps)).toBe(EXIT.error);
    expect(s.printed.at(-1)).toMatchObject({ uploaded: 1, failed: [{ slug: "shopco", error: "bucket not found" }] });
    expect(await runCommand(["captures", "--run", "cap-2"], { ...s.deps, readCaptures: () => [] })).toBe(EXIT.refused);
    expect(await runCommand(["captures", "--run", "nope"], s.deps)).toBe(EXIT.refused);
    expect(await runCommand(["captures"], s.deps)).toBe(EXIT.refused);
  });
});

describe("fx", () => {
  it("stores both directions and prints them", async () => {
    const { deps, repo, printed } = setup();
    expect(await runCommand(["fx"], deps)).toBe(EXIT.ok);
    expect(repo.fxRates).toHaveLength(2);
    expect(printed[0]).toMatchObject({ command: "fx", rate_date: "2026-10-01", written: 2 });
  });
});

describe("probe", () => {
  const controls = ["--control-woo", "blankpeptides", "--control-shopify", "shopco"];

  it("classifies the vendors it was asked about and writes nothing without --apply", async () => {
    const { deps, repo, printed } = setup();
    expect(await runCommand(["probe", "--vendors", "shopco", ...controls], deps)).toBe(EXIT.ok);
    expect(printed[0]).toMatchObject({ command: "probe", applied: false, probed: 1, by_platform: { shopify: 1 }, would_write: 1, written: 0 });
    expect(repo.vendors.get("v-shop")?.detected_platform).toBeNull();
  });

  it("writes measured platforms with --apply", async () => {
    const { deps, repo, printed } = setup();
    expect(await runCommand(["probe", "--vendors", "shopco,blankpeptides", "--apply", ...controls], deps)).toBe(EXIT.ok);
    expect(repo.vendors.get("v-shop")).toMatchObject({ detected_platform: "shopify", platform_probed_at: expect.any(String) });
    expect(printed[0]).toMatchObject({ applied: true, written: 2 });
  });

  it("refuses when a control does not classify, and writes nothing", async () => {
    const { deps, repo, printed } = setup({ fetchText: () => async (url) => failed(url) });
    expect(await runCommand(["probe", "--apply", ...controls], deps)).toBe(EXIT.refused);
    expect(repo.vendors.get("v-blank")?.detected_platform).toBe("woocommerce");
    expect(printed[0]).toMatchObject({ command: "probe", refused: expect.stringContaining("control") });
  });

  it("refuses the whole sweep when too many vendors are unreachable — a network failure is not a finding", async () => {
    const { deps, repo, printed } = setup();
    // pendingco does not resolve: 1 of 1 probed is unreachable, over the 25% guard.
    expect(await runCommand(["probe", "--vendors", "pendingco", "--apply", ...controls], deps)).toBe(EXIT.refused);
    expect(repo.vendors.get("v-pending")?.detected_platform).toBe("woocommerce");
    expect(printed[0]).toMatchObject({ refused: expect.stringContaining("unreachable share") });
  });

  it("refuses a control slug or a vendor slug it does not know", async () => {
    const { deps } = setup();
    expect(await runCommand(["probe", "--control-woo", "nope", "--control-shopify", "shopco"], deps)).toBe(EXIT.refused);
    expect(await runCommand(["probe", "--vendors", "nope", ...controls], deps)).toBe(EXIT.refused);
  });
});

describe("coa-scan — filing certificate links found in a run's captures as candidates", () => {
  const capture = (slug: string, body: string) => {
    const c = createRawCapture({ runLabel: "coa-1", vendorSlug: slug });
    c.record(res(`https://${slug}.com/product/retatrutide`, 200, body));
    return { slug, bytes: c.serialize().buffer };
  };
  const files = () => [
    capture("blankpeptides", `<a href="/coa/retatrutide-lot7.pdf">COA</a> <a href="/coa/lot-8.pdf">COA</a> <a href="/product/retatrutide">x</a>`),
    capture("shopco", "<p>No documents here</p>"),
    capture("unknown-vendor", `<a href="/coa/x.pdf">COA</a>`),
  ];

  it("is a dry run unless --live: it counts and files nothing", async () => {
    const s = setup({ isTTY: true, readCaptures: files });
    await runCommand(["refresh", "--mode", "feeds", "--live", "--label", "coa-1"], s.deps);
    expect(await runCommand(["coa-scan", "--run", "coa-1"], s.deps)).toBe(EXIT.ok);
    expect(s.printed.at(-1)).toMatchObject({ command: "coa-scan", dry_run: true, found: 2, filed: 0 });
    expect(s.repo.coaCandidates).toEqual([]);
  });

  it("files each link once, with the compound its address names, for known vendors only", async () => {
    const s = setup({ isTTY: true, readCaptures: files });
    await runCommand(["refresh", "--mode", "feeds", "--live", "--label", "coa-1"], s.deps);
    expect(await runCommand(["coa-scan", "--run", "coa-1", "--live"], s.deps)).toBe(EXIT.ok);
    expect(s.printed.at(-1)).toMatchObject({ found: 2, filed: 2, by_vendor: [{ slug: "blankpeptides", found: 2, filed: 2 }] });
    expect(s.repo.coaCandidates).toEqual([
      { vendorId: "v-blank", compoundId: "c-reta", url: "https://blankpeptides.com/coa/retatrutide-lot7.pdf" },
      { vendorId: "v-blank", compoundId: null, url: "https://blankpeptides.com/coa/lot-8.pdf" },
    ]);
    await runCommand(["coa-scan", "--run", "coa-1", "--live"], s.deps);
    expect(s.printed.at(-1)).toMatchObject({ found: 2, filed: 0 });
  });

  it("refuses without a run, an unknown run, or no local captures", async () => {
    const s = setup({ isTTY: true, readCaptures: () => [] });
    await runCommand(["refresh", "--mode", "feeds", "--live", "--label", "coa-1"], s.deps);
    expect(await runCommand(["coa-scan"], s.deps)).toBe(EXIT.refused);
    expect(await runCommand(["coa-scan", "--run", "nope"], s.deps)).toBe(EXIT.refused);
    expect(await runCommand(["coa-scan", "--run", "coa-1"], s.deps)).toBe(EXIT.refused);
  });
});

describe("the daily workflow (source-level: the file cannot run here)", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/refresh-prices.yml", import.meta.url), "utf8");
  const at = (name: string) => workflow.indexOf(`- name: ${name}`);

  it("runs every step with pipefail, so `prices … | tee` fails the step when the pipeline does", () => {
    // Without an explicit shell GitHub runs `bash -e {0}` — no pipefail — and a HOLD or an error behind `| tee` is green.
    expect(workflow).toMatch(/\ndefaults:\n {2}run:\n {4}shell: bash\n/);
  });

  it("holds only the restricted database login: never the Supabase secret key", () => {
    expect(workflow).toContain("secrets.PRICES_DB_URL");
    expect(workflow).not.toMatch(/SERVICE_ROLE|SUPABASE_SECRET_KEY|SUPABASE_URL/);
    expect([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].every((m) => m[1] === "PRICES_DB_URL")).toBe(true);
  });

  it("keeps the raw captures as a private artifact", () => {
    expect(workflow).toContain("path: apps/prices/.raw-capture/");
  });

  // Custom-built shops (no product feed) are read from their product pages in a second, separate run.
  it("reads page-platform shops in their own run after the feeds publish, gated and published only when it read any", () => {
    expect(at("pages refresh")).toBeGreaterThan(at("publish"));
    const pages = workflow.slice(at("pages refresh"), at("pages gate"));
    expect(pages).toContain("--mode pages --live");
    expect(pages).toContain("$RUN_LABEL-pages");
    expect(pages).toContain("github.event_name == 'schedule'");
    expect(pages).toContain("steps.gate.outcome == 'success'");
    const gate = workflow.slice(at("pages gate"), at("pages publish"));
    expect(gate).toContain("steps.pages.outputs.vendors != '0'");
    expect(gate).toContain('gate --run "$RUN_LABEL-pages"');
    const publish = workflow.slice(at("pages publish"), at("certificate links"));
    expect(publish).toContain("steps.pagesgate.outcome == 'success'");
    expect(publish).toContain('publish --run "$RUN_LABEL-pages" --live');
  });

  it("publishes only after the gate passed", () => {
    const publish = workflow.slice(at("publish"), at("pages refresh"));
    expect(publish).toContain("steps.gate.outcome == 'success'");
  });

  it("hands secrets only to the steps that need them, never to the whole job", () => {
    const beforeSteps = workflow.slice(0, workflow.indexOf("    steps:"));
    expect(beforeSteps).not.toContain("secrets.");
    const install = workflow.slice(at("install"), at("exchange rates"));
    expect(install).not.toContain("secrets.");
  });
});

describe("seed", () => {
  it("applies the committed seeds", async () => {
    const { deps, printed } = setup();
    expect(await runCommand(["seed"], deps)).toBe(EXIT.ok);
    expect(printed[0]).toEqual({ command: "seed", compounds: 0, vendors: 0 });
  });
});
