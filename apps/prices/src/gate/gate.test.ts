import { describe, expect, it } from "vitest";
import { InMemoryRepo, type CompoundRow, type OfferRow, type RunRow, type VendorRow } from "../ingest/repo.ts";
import { ABSOLUTE_CHECKS, CORPUS_CHECKS, GateRefusal, THRESHOLDS, acceptBaseline, describeBaseline, evaluateBaselineAcceptance, runGate, selectBaseline, type GateCheck } from "./gate.ts";

const RUN = "run-now";
const NOW = new Date("2026-10-02T06:30:00.000Z");

const run = (over: Partial<RunRow> & { id: string }): RunRow =>
  ({ run_label: over.id, mode: "feeds", dry_run: false, started_at: "2026-10-01T06:10:00.000Z", finished_at: "2026-10-01T06:40:00.000Z", status: "committed", verdict: null, baseline_run_id: null, metrics: {}, checks: {}, notes: null, ...over }) as RunRow;

/** A committed PASS run whose gate recorded these per-vendor row counts. */
const passRun = (id: string, rowsByVendor: Record<string, number>, over: Partial<RunRow> = {}): RunRow =>
  run({ id, verdict: "pass", metrics: { vendor_scope: null, gate: { rows_run: Object.values(rowsByVendor).reduce((a, b) => a + b, 0), rows_by_vendor: rowsByVendor } }, ...over });

let seq = 0;
/** US$100.00 for one 10 mg vial: 1,000 minor/mg. Consistent with itself in every check. */
const offer = (over: Partial<OfferRow> = {}): OfferRow => {
  const id = over.id ?? `o-${++seq}`;
  return {
    id,
    vendor_id: "v1",
    compound_id: "c1",
    product_key: `k-${id}`,
    variant_key: "",
    product_url: `https://v1.com/product/${id}/`,
    product_name: "Retatrutide 10mg",
    variant_label: null,
    native_currency: "USD",
    price_minor: 10_000,
    mg_per_vial: 10,
    vials_per_pack: 1,
    total_mg: 10,
    per_mg_minor_e4: 10_000_000,
    form: "vial",
    comparable: true,
    raw_price_text: "100.00",
    extraction_confidence: "high",
    observed_at: "2026-10-02T06:20:00.000Z",
    run_id: RUN,
    ...over,
  } as OfferRow;
};

function setup(opts: { runs?: RunRow[]; current?: Partial<RunRow>; offers?: OfferRow[] } = {}) {
  const repo = new InMemoryRepo();
  for (const id of ["v1", "v2", "v3", "v4", "v5"]) repo.seedVendor({ id, slug: id, name: id, website_url: `https://${id}.com`, status: "active" } as VendorRow);
  repo.seedCompound({ id: "c1", slug: "retatrutide", name: "Retatrutide", aliases: ["Reta"], is_active: true } as unknown as CompoundRow);
  repo.seedCompound({ id: "c2", slug: "tesamorelin", name: "Tesamorelin", aliases: [], is_active: true } as unknown as CompoundRow);
  for (const r of opts.runs ?? []) repo.runs.set(r.id, r);
  repo.runs.set(RUN, run({ id: RUN, started_at: "2026-10-02T06:10:00.000Z", finished_at: "2026-10-02T06:25:00.000Z", metrics: { rows_written: 0, errors: [], vendor_scope: null, vendor_ids: ["v1", "v2", "v3", "v4", "v5"] }, ...opts.current }));
  for (const o of opts.offers ?? []) repo.seedOffer(o);
  return repo;
}

const many = (n: number, over: Partial<OfferRow> = {}): OfferRow[] => Array.from({ length: n }, () => offer(over));
const healthy = () => [...many(15, { vendor_id: "v1" }), ...many(15, { vendor_id: "v2", product_url: undefined })].map((o) => ({ ...o, product_url: `https://${o.vendor_id}.com/product/${o.id}/` }));

describe("runGate — verdicts", () => {
  it("passes a healthy run and records checks with populations and epochs", async () => {
    const repo = setup({ runs: [passRun("base", { v1: 15, v2: 15 })], offers: healthy() });
    const out = await runGate(repo, RUN, { now: NOW });
    expect(out.verdict).toBe("pass");
    expect(out.noBaseline).toBe(false);
    expect(Object.values(out.checks).every((c: GateCheck) => c.pass && c.measured)).toBe(true);
    expect(out.metrics).toMatchObject({
      rows_run: 30,
      rows_baseline: 30,
      vendors_run: 2,
      vendors_baseline: 2,
      vendors_zero: 0,
      outlier_ratio: 0,
      outlier_population: 30,
      low_conf_ratio: 0,
      rows_by_vendor: { v1: 15, v2: 15 },
      baseline: { kind: "ok", run_id: "base", finished_at: "2026-10-01T06:40:00.000Z" },
      evaluated_at: NOW.toISOString(),
    });
    const stored = repo.runs.get(RUN) as RunRow;
    expect(stored).toMatchObject({ status: "committed", verdict: "pass", baseline_run_id: "base" });
    // The ingest's own metrics survive beside the gate's.
    expect(stored.metrics).toMatchObject({ vendor_ids: ["v1", "v2", "v3", "v4", "v5"], gate: { rows_run: 30 } });
    expect(Object.keys(stored.checks as object).sort()).toEqual([...CORPUS_CHECKS, ...ABSOLUTE_CHECKS].sort());
  });

  it("holds when this run wrote fewer than 70% of the baseline rows", async () => {
    const repo = setup({ runs: [passRun("base", { v1: 10 })], offers: many(6) });
    const out = await runGate(repo, RUN, { now: NOW });
    expect(out.verdict).toBe("hold");
    expect(out.checks.partial_failure).toMatchObject({ pass: false, measured: true });
    expect(out.checks.partial_failure.detail).toContain("rows_run=6 vs baseline=10 (ratio=0.60");
    expect(repo.runs.get(RUN)).toMatchObject({ status: "held", verdict: "hold" });
    // 7 of 10 is exactly the floor and passes.
    const edge = setup({ runs: [passRun("base", { v1: 10 })], offers: many(7) });
    expect((await runGate(edge, RUN, { now: NOW })).checks.partial_failure.pass).toBe(true);
  });

  it("holds when more than 20% of the baseline's vendors wrote nothing this run", async () => {
    const offers = [...many(3, { vendor_id: "v1" }), ...many(3, { vendor_id: "v2" }), ...many(2, { vendor_id: "v3" })];
    const repo = setup({ runs: [passRun("base", { v1: 2, v2: 2, v3: 2, v4: 2, v5: 2 })], offers });
    const out = await runGate(repo, RUN, { now: NOW });
    expect(out.checks.partial_failure.pass).toBe(true);
    expect(out.checks.vendor_zero).toMatchObject({ pass: false, measured: true, samples: ["v4", "v5"] });
    expect(out.metrics.vendors_zero).toBe(2);
    expect(out.verdict).toBe("hold");
  });

  it("leaves vendors an admin marked unreadable out of that count, so a known gap cannot hold every run", async () => {
    const offers = [...many(3, { vendor_id: "v1" }), ...many(3, { vendor_id: "v2" }), ...many(2, { vendor_id: "v3" })];
    const repo = setup({ runs: [passRun("base", { v1: 2, v2: 2, v3: 2, v4: 2, v5: 2 })], offers });
    for (const id of ["v4", "v5"]) repo.seedVendor({ ...repo.vendors.get(id)!, unreadable: true });
    const out = await runGate(repo, RUN, { now: NOW });
    expect(out.checks.vendor_zero).toMatchObject({ pass: true, measured: true, samples: [] });
    expect(out.checks.vendor_zero.detail).toContain("0/3 baseline vendors wrote 0 rows");
    expect(out.checks.vendor_zero.detail).toContain("2 marked unreadable left out");
    expect(out.metrics.vendors_zero).toBe(0);
  });

  it("holds when more than 40% of the run's rows are low-confidence", async () => {
    const repo = setup({ runs: [passRun("base", { v1: 10 })], offers: [...many(5), ...many(5, { extraction_confidence: "low" })] });
    const out = await runGate(repo, RUN, { now: NOW });
    expect(out.checks.low_confidence).toMatchObject({ pass: false });
    expect(out.verdict).toBe("hold");
  });

  it("holds an ingest in which more than 5% of the vendors ended in a driver error, however clean its rows", async () => {
    const errored = (n: number, vendors: number | undefined) => ({ status: "error", metrics: { errors: Array.from({ length: n }, (_, i) => ({ slug: `v${i}`, error: "read ETIMEDOUT" })), vendor_scope: null, ...(vendors === undefined ? {} : { vendors }) } }) as Partial<RunRow>;
    const gate = async (current: Partial<RunRow>) => runGate(setup({ runs: [passRun("base", { v1: 15, v2: 15 })], offers: healthy(), current }), RUN, { now: NOW });

    const many = await gate(errored(1, 5)); // 20%
    expect(many.checks.driver_errors).toMatchObject({ pass: false, measured: true });
    expect(many.verdict).toBe("hold");
    // One transient failure among 65 vendors (1.5%) is that vendor's bad day, not the run's.
    const one = await gate(errored(1, 65));
    expect(one.checks.driver_errors).toMatchObject({ pass: true, measured: true });
    expect(one.checks.driver_errors.detail).toContain("1/65");
    expect(one.verdict).toBe("pass");
    expect((await gate(errored(4, 65))).checks.driver_errors.pass).toBe(false); // 6.2%
    // Without a vendor count the share cannot be measured: any error holds.
    expect((await gate(errored(1, undefined))).checks.driver_errors.pass).toBe(false);
  });

  it("a blend row is judged against its own mix per vial, and identity goes through the blend matcher", async () => {
    const repo = setup({ runs: [passRun("base", { v1: 40 })] });
    repo.seedCompound({ id: "c-a", slug: "aaa-1", name: "AAA-1", aliases: [], type: "Single compound", is_active: true } as unknown as CompoundRow);
    repo.seedCompound({ id: "c-b", slug: "bbb-2", name: "BBB-2", aliases: [], type: "Single compound", is_active: true } as unknown as CompoundRow);
    repo.seedCompound({ id: "c-blend", slug: "aaa-1-bbb-2", name: "AAA-1 + BBB-2", aliases: [], type: "Blend", blend_components: [{ slug: "aaa-1" }, { slug: "bbb-2" }], is_active: true } as unknown as CompoundRow);
    for (const o of many(30)) repo.seedOffer(o);
    const blendRow = (id: string, price_minor: number) =>
      offer({ id, compound_id: "c-blend", product_name: "AAA-1 10mg + BBB-2 10mg", comparable: false, is_blend: true, per_mg_minor_e4: null, total_mg: null, mg_per_vial: 20, recipe_key: "aaa-1:10+bbb-2:10", price_minor, raw_price_text: (price_minor / 100).toFixed(2) } as Partial<OfferRow>);
    for (let i = 0; i < 6; i++) repo.seedOffer(blendRow(`mix-${i}`, 5_000));
    repo.seedOffer(blendRow("mix-wild", 90_000));
    repo.seedOffer(offer({ id: "blend-stray", compound_id: "c-blend", product_name: "AAA-1 10mg", comparable: false, is_blend: true, per_mg_minor_e4: null } as Partial<OfferRow>)); // one ingredient: not this blend
    // FINAL REVIEW I4: rows whose mix is not stated are judged within their stated total.
    const unstatedRow = (id: string, price_minor: number) =>
      offer({ id, compound_id: "c-blend", product_name: "AAA-1 + BBB-2 Blend 20mg", comparable: false, is_blend: true, per_mg_minor_e4: null, total_mg: null, mg_per_vial: 20, recipe_key: null, price_minor, raw_price_text: (price_minor / 100).toFixed(2) } as Partial<OfferRow>);
    for (let i = 0; i < 5; i++) repo.seedOffer(unstatedRow(`loose-${i}`, 5_000));
    repo.seedOffer(unstatedRow("loose-wild", 80_000));
    // A row that only carries the blend flag under a SINGLE compound is not judged per vial.
    const flagged = (id: string, price_minor: number) => offer({ id, comparable: false, is_blend: true, per_mg_minor_e4: null, price_minor, raw_price_text: (price_minor / 100).toFixed(2) } as Partial<OfferRow>);
    for (let i = 0; i < 5; i++) repo.seedOffer(flagged(`flag-${i}`, 5_000));
    repo.seedOffer(flagged("flag-wild", 80_000));
    const out = await runGate(repo, RUN, { now: NOW });
    expect(out.quarantined).toEqual({ structural_per_vial_out_of_band: 2, structural_compound_not_corroborated: 1 });
    expect(repo.quarantined.map((q) => q.original_id).sort()).toEqual(["blend-stray", "loose-wild", "mix-wild"]);
    expect(out.verdict).toBe("pass");
  });
});

describe("runGate — quarantine", () => {
  it("quarantines a kit whose per-mg divided by one vial, and a price 10× the compound median", async () => {
    const kit = offer({ id: "kit", price_minor: 20_000, raw_price_text: "200.00", vials_per_pack: 2, total_mg: 20, per_mg_minor_e4: 20_000_000 });
    const wild = offer({ id: "wild", price_minor: 110_000, raw_price_text: "1100.00", per_mg_minor_e4: 110_000_000 });
    const repo = setup({ runs: [passRun("base", { v1: 32 })], offers: [...many(30), kit, wild] });
    const out = await runGate(repo, RUN, { now: NOW });
    expect(out.quarantined).toEqual({ structural_kit_multiplier_ignored: 1, structural_per_mg_above_ceiling: 1 });
    expect(repo.quarantined.map((q) => [q.original_id, q.reason, q.quarantine_run_id]).sort()).toEqual([
      ["kit", "structural_kit_multiplier_ignored", RUN],
      ["wild", "structural_per_mg_above_ceiling", RUN],
    ]);
    expect(repo.offers.has("kit") || repo.offers.has("wild")).toBe(false);
    // 1 outlier in 32 priced rows is under the 5% ceiling: quarantined, and the run still passes.
    expect(out.checks.outliers).toMatchObject({ pass: true });
    expect(out.metrics).toMatchObject({ outlier_population: 32, rows_run: 32 });
    expect(out.verdict).toBe("pass");
  });

  it("wholesale kits are compared, not set aside — and they do not set the single-vial reference", async () => {
    // Ten 10 mg vials for $200 is $2.00/mg against a $10.00/mg single-vial market: a fifth, inside the ÷10 band.
    const kits = Array.from({ length: 12 }, (_, i) => offer({ id: `kit-${i}`, price_minor: 20_000, raw_price_text: "200.00", vials_per_pack: 10, total_mg: 100, per_mg_minor_e4: 2_000_000 }));
    const feedError = offer({ id: "feed-error", price_minor: 990, raw_price_text: "9.90", vials_per_pack: 10, total_mg: 100, per_mg_minor_e4: 99_000 });
    // A single vial at 2.5× the single-vial market. Were the 12 kits the reference ($2/mg), it would read as 12.5× and be removed.
    const pricey = offer({ id: "pricey", price_minor: 25_000, raw_price_text: "250.00", per_mg_minor_e4: 25_000_000 });
    const repo = setup({ runs: [passRun("base", { v1: 19 })], offers: [...many(5), pricey, ...kits, feedError] });
    const out = await runGate(repo, RUN, { now: NOW });
    expect(repo.quarantined.map((q) => q.original_id)).toEqual(["feed-error"]);
    expect(kits.every((k) => repo.offers.has(k.id)) && repo.offers.has("pricey")).toBe(true);
    expect(out.checks.outliers.detail).toContain("1/19");
  });

  it("kits of a compound with NO single-vial row in their currency are still judged — against that compound's other priced rows", async () => {
    // CAD: six kits at $2.00/mg and one at a twentieth of that. No CAD single vial exists.
    const cad = (id: string, perMg: number, priceMinor: number) =>
      offer({ id, native_currency: "CAD", vials_per_pack: 10, total_mg: 100, price_minor: priceMinor, raw_price_text: `CAD${priceMinor} (minor_unit=2)`, per_mg_minor_e4: perMg });
    const kits = Array.from({ length: 6 }, (_, i) => cad(`cad-kit-${i}`, 2_000_000, 20_000));
    const repo = setup({ runs: [passRun("base", { v1: 37 })], offers: [...many(30), ...kits, cad("cad-error", 100_000, 1_000)] });
    await runGate(repo, RUN, { now: NOW });
    expect(repo.quarantined.map((q) => q.original_id)).toEqual(["cad-error"]);
    expect(kits.every((k) => repo.offers.has(k.id))).toBe(true);
  });

  it("one kit among many single vials is not 'too cheap to be true'", async () => {
    const kit = offer({ id: "kit", price_minor: 20_000, raw_price_text: "200.00", vials_per_pack: 10, total_mg: 100, per_mg_minor_e4: 2_000_000 });
    const repo = setup({ runs: [passRun("base", { v1: 31 })], offers: [...many(30), kit] });
    const out = await runGate(repo, RUN, { now: NOW });
    expect(out.quarantined).toEqual({});
    expect(repo.offers.has("kit")).toBe(true);
  });

  it("holds when more than 5% of priced rows are outliers — and quarantines them regardless", async () => {
    const wild = [1, 2].map((i) => offer({ id: `wild-${i}`, price_minor: 150_000, raw_price_text: "1500.00", per_mg_minor_e4: 150_000_000 }));
    const repo = setup({ runs: [passRun("base", { v1: 10 })], offers: [...many(8), ...wild] });
    const out = await runGate(repo, RUN, { now: NOW });
    expect(out.checks.outliers.pass).toBe(false);
    expect(out.metrics.outlier_ratio).toBeCloseTo(0.2);
    expect(out.verdict).toBe("hold");
    expect(repo.quarantined).toHaveLength(2);
  });

  it("labels a thin-data outlier 'outlier': too few rows for the structural band, enough for a median", async () => {
    const thin = [offer({ compound_id: "c2", product_name: "Tesamorelin 10mg" }), offer({ compound_id: "c2", product_name: "Tesamorelin 10mg" }), offer({ id: "thin-wild", compound_id: "c2", product_name: "Tesamorelin 10mg", price_minor: 150_000, raw_price_text: "1500.00", per_mg_minor_e4: 150_000_000 })];
    const repo = setup({ runs: [passRun("base", { v1: 60 })], offers: [...many(60), ...thin] });
    const out = await runGate(repo, RUN, { now: NOW });
    expect(out.quarantined).toEqual({ outlier: 1 });
    expect(repo.quarantined[0]).toMatchObject({ original_id: "thin-wild", reason: "outlier" });
  });

  it("the outlier band is per currency: a CAD row is not judged against the USD median", async () => {
    const cad = offer({ id: "cad", native_currency: "CAD", price_minor: 1_050_000, raw_price_text: "CAD1050000 (minor_unit=2)", per_mg_minor_e4: 1_050_000_000 });
    const repo = setup({ runs: [passRun("base", { v1: 31 })], offers: [...many(30), cad] });
    const out = await runGate(repo, RUN, { now: NOW });
    // 105× the USD median, and above the thin-data absolute ceiling in its own currency: refused for that, not as a USD outlier.
    expect(out.quarantined).toEqual({ structural_per_mg_above_ceiling: 1 });
    expect(out.checks.outliers.detail).toContain("0/31");
  });

  it("structural failures never hold; an observe-only reason is reported and the row stays", async () => {
    const mismatch = offer({ id: "mismatch", raw_price_text: "89.00" });
    const bigVial = offer({ id: "big-vial", mg_per_vial: 90, total_mg: 90, price_minor: 90_000, raw_price_text: "900.00" });
    const repo = setup({ runs: [passRun("base", { v1: 32 })], offers: [...many(30), mismatch, bigVial] });
    const out = await runGate(repo, RUN, { now: NOW });
    expect(out.checks.structural).toMatchObject({ pass: true, measured: true });
    expect(out.verdict).toBe("pass");
    expect(out.quarantined).toEqual({ structural_price_ne_raw: 1 });
    expect(repo.offers.has("big-vial")).toBe(true);
    expect(out.metrics.structural_by_reason).toEqual({ price_ne_raw: 1, mg_per_vial_implausible: 1 });
    expect(out.metrics.structural_observed_only).toBe(1);
  });

  it("identity is judged by the matcher itself: a DAC variant filed under the DAC sibling stays; a row the matcher no longer files there goes", async () => {
    const repo = setup({ runs: [passRun("base", { v1: 32 })] });
    repo.seedCompound({ id: "c-cjc", slug: "cjc-1295", name: "CJC-1295", aliases: ["CJC-1295 no DAC"], is_active: true } as unknown as CompoundRow);
    repo.seedCompound({ id: "c-cjc-dac", slug: "cjc-1295-dac", name: "CJC-1295 DAC", aliases: ["CJC-1295 with DAC"], is_active: true } as unknown as CompoundRow);
    for (const o of many(30)) repo.seedOffer(o);
    repo.seedOffer(offer({ id: "dac", compound_id: "c-cjc-dac", product_name: "CJC-1295", variant_label: "Content: 10mg (w/ DAC)" }));
    repo.seedOffer(offer({ id: "stray", product_name: "SNAP-8 10mg" })); // stored under Retatrutide
    const out = await runGate(repo, RUN, { now: NOW });
    expect(out.quarantined).toEqual({ structural_compound_not_corroborated: 1 });
    expect(repo.quarantined.map((q) => q.original_id)).toEqual(["stray"]);
    expect(repo.offers.has("dac")).toBe(true);
  });

  it("judges only this run's rows, against a reference drawn from the whole live corpus", async () => {
    // An older row from another run would be an outlier — it is reference, not subject.
    const old = offer({ id: "old", run_id: "earlier", price_minor: 150_000, raw_price_text: "1500.00", per_mg_minor_e4: 150_000_000 });
    const repo = setup({ runs: [passRun("base", { v1: 30 })], offers: [...many(30), old] });
    const out = await runGate(repo, RUN, { now: NOW });
    expect(out.quarantined).toEqual({});
    expect(repo.offers.has("old")).toBe(true);
    expect(out.metrics.rows_run).toBe(30);
  });
});

describe("runGate — rows an earlier run left behind (data audit, 2026-10-02)", () => {
  it("a row the matcher no longer files under its compound is set aside whichever run wrote it — identity only, nothing else about it is judged", async () => {
    // Stored under Retatrutide by older code; the product is still in the feed but matches nothing
    // now, so no later run rewrites it and the two-read delisting rule never sees it as absent.
    const stale = offer({ id: "stale-identity", run_id: "earlier", product_name: "SNAP-8 10mg" });
    const oldOutlier = offer({ id: "old-outlier", run_id: "earlier", price_minor: 150_000, raw_price_text: "1500.00", per_mg_minor_e4: 150_000_000 });
    const repo = setup({ runs: [passRun("base", { v1: 30 })], offers: [...many(30), stale, oldOutlier] });
    const out = await runGate(repo, RUN, { now: NOW });
    expect(out.quarantined).toEqual({ structural_compound_not_corroborated: 1 });
    expect(repo.quarantined.map((q) => q.original_id)).toEqual(["stale-identity"]);
    expect(repo.offers.has("old-outlier")).toBe(true);
    expect(out.metrics.rows_run).toBe(30);
    expect(out.metrics.stale_identity).toBe(1);
    expect(out.verdict).toBe("pass");
  });
});

describe("runGate — baseline", () => {
  it("holds with no baseline: the corpus checks are UNMEASURED, not passed", async () => {
    const repo = setup({ offers: healthy() });
    const out = await runGate(repo, RUN, { now: NOW });
    expect(out.verdict).toBe("hold");
    expect(out.noBaseline).toBe(true);
    expect(out.baseline).toEqual({ kind: "no_committed_run", runId: null });
    for (const name of CORPUS_CHECKS) expect(out.checks[name]).toMatchObject({ measured: false, pass: false });
    for (const name of ABSOLUTE_CHECKS) expect(out.checks[name]).toMatchObject({ measured: true, pass: true });
    expect(repo.runs.get(RUN)).toMatchObject({ status: "held", verdict: "hold", baseline_run_id: null });
  });

  it("a scoped run is measured against the baseline's slice for its own vendors", async () => {
    const repo = setup({
      runs: [passRun("base", { v1: 5, v2: 5, v3: 5, v4: 5, v5: 5 })],
      offers: many(5),
      current: { metrics: { errors: [], vendor_scope: ["v1"], vendor_ids: ["v1"] } },
    });
    const out = await runGate(repo, RUN, { now: NOW });
    expect(out.metrics).toMatchObject({ rows_run: 5, rows_baseline: 5, vendors_baseline: 1, vendors_zero: 0 });
    expect(out.verdict).toBe("pass");
  });

  it("refuses to gate a run twice: the first evaluation removed its bad rows, so a second would pass by construction", async () => {
    const wild = [1, 2].map((i) => offer({ id: `wild-${i}`, price_minor: 150_000, raw_price_text: "1500.00", per_mg_minor_e4: 150_000_000 }));
    const repo = setup({ runs: [passRun("base", { v1: 10 })], offers: [...many(8), ...wild] });
    expect((await runGate(repo, RUN, { now: NOW })).verdict).toBe("hold");
    await expect(runGate(repo, RUN, { now: NOW })).rejects.toThrow(/already gated/);
    expect(repo.runs.get(RUN)).toMatchObject({ status: "held", verdict: "hold" });
  });

  it("a gate that fails part-way leaves the run HELD: it cannot be re-run into a pass, and cannot be accepted", async () => {
    const wild = offer({ id: "wild", price_minor: 150_000, raw_price_text: "1500.00", per_mg_minor_e4: 150_000_000 });
    const repo = setup({ runs: [passRun("base", { v1: 31 })], offers: [...many(30), wild] });
    repo.quarantine = async () => {
      throw Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" });
    };
    await expect(runGate(repo, RUN, { now: NOW })).rejects.toThrow("ETIMEDOUT");
    expect(repo.runs.get(RUN)).toMatchObject({ status: "held", verdict: "hold" });
    await expect(runGate(repo, RUN, { now: NOW })).rejects.toThrow(/already gated/);
    expect(await acceptBaseline(repo, RUN, { approver: "Owner", reason: "x", now: NOW })).toMatchObject({ ok: false, refusal: expect.stringContaining("missing absolute check") });
  });

  it("refuses a run it cannot evaluate: unknown, still running, or a dry run", async () => {
    const repo = setup();
    await expect(runGate(repo, "nope")).rejects.toBeInstanceOf(GateRefusal);
    repo.runs.set("dry", run({ id: "dry", dry_run: true }));
    await expect(runGate(repo, "dry")).rejects.toThrow(/dry run/);
    repo.runs.set("open", run({ id: "open", status: "running", finished_at: null }));
    await expect(runGate(repo, "open")).rejects.toThrow(/still running/);
  });
});

describe("selectBaseline — only a gated PASS of the same kind of run is a reference", () => {
  const current = { id: RUN, mode: "feeds" };

  it("selects the older PASS run over a newer committed run that never passed the gate", () => {
    const runs = [run({ id: "newer-ungated", finished_at: "2026-10-01T09:00:00.000Z" }), passRun("older-pass", { v1: 1 }, { finished_at: "2026-09-30T09:00:00.000Z" })];
    expect(selectBaseline(runs, current)).toMatchObject({ kind: "ok", run: { id: "older-pass" } });
  });
  it("takes the newest of several eligible runs, whatever order they arrive in", () => {
    const runs = [passRun("a", { v1: 1 }, { finished_at: "2026-09-29T09:00:00.000Z" }), passRun("b", { v1: 1 }, { finished_at: "2026-09-30T09:00:00.000Z" })];
    expect(selectBaseline(runs, current)).toMatchObject({ kind: "ok", run: { id: "b" } });
  });
  it("never selects the run being gated, a dry run, a held run, or a run of another mode", () => {
    const runs = [
      passRun(RUN, { v1: 1 }),
      passRun("dry", { v1: 1 }, { dry_run: true }),
      run({ id: "held", status: "held", verdict: "hold" }),
      passRun("pages", { v1: 1 }, { mode: "pages" }),
    ];
    expect(selectBaseline(runs, current).kind).toBe("no_committed_run");
  });
  it("no_passing_run: committed runs exist and none passed the gate", () => {
    expect(selectBaseline([run({ id: "ungated" })], current)).toMatchObject({ kind: "no_passing_run", shadow: { id: "ungated" } });
  });
  it("scoped_only: the only passing run is a vendor-scoped slice", () => {
    const scoped = passRun("scoped", { v1: 5 });
    scoped.metrics = { vendor_scope: ["v1"], gate: { rows_by_vendor: { v1: 5 } } };
    expect(selectBaseline([scoped], current)).toMatchObject({ kind: "scoped_only", shadow: { id: "scoped" } });
  });
  it("no_committed_run: a genuine first run", () => {
    expect(selectBaseline([], current)).toEqual({ kind: "no_committed_run" });
  });
  it("every kind of absence prints a distinct line", () => {
    const lines = [
      describeBaseline({ kind: "ok", run: passRun("p", { v1: 1 }) }),
      describeBaseline({ kind: "scoped_only", shadow: run({ id: "s" }) }),
      describeBaseline({ kind: "no_passing_run", shadow: run({ id: "n" }) }),
      describeBaseline({ kind: "no_committed_run" }),
    ];
    expect(new Set(lines).size).toBe(4);
    expect(lines.every((l) => l.length > 0)).toBe(true);
  });
});

describe("evaluateBaselineAcceptance — an attributed exit from 'no baseline'", () => {
  const check = (pass: boolean, measured = true, detail = "d"): GateCheck => ({ pass, measured, detail, samples: [] });
  const held = (over: Partial<RunRow> = {}): RunRow =>
    run({
      id: "held",
      status: "held",
      verdict: "hold",
      metrics: { vendor_scope: null },
      checks: { partial_failure: check(false, false, "NO BASELINE"), vendor_zero: check(false, false, "NO BASELINE"), outliers: check(true), structural: check(true), low_confidence: check(true), driver_errors: check(true) } as unknown as RunRow["checks"],
      ...over,
    });
  const who = { approver: "Owner", reason: "first full run, checked by hand", now: NOW };

  it("refuses without an approver or without a reason", () => {
    expect(evaluateBaselineAcceptance(held(), { ...who, approver: " " })).toHaveProperty("refusal");
    expect(evaluateBaselineAcceptance(held(), { ...who, reason: "" })).toHaveProperty("refusal");
  });
  it("refuses a missing run, a committed run, a running run and a dry run", () => {
    expect(evaluateBaselineAcceptance(null, who)).toMatchObject({ refusal: expect.stringContaining("not found") });
    expect(evaluateBaselineAcceptance(held({ status: "committed", verdict: "pass" }), who)).toMatchObject({ refusal: expect.stringContaining("only a HELD run") });
    expect(evaluateBaselineAcceptance(held({ status: "running", verdict: null }), who)).toMatchObject({ refusal: expect.stringContaining("only a HELD run") });
    expect(evaluateBaselineAcceptance(held({ dry_run: true }), who)).toMatchObject({ refusal: expect.stringContaining("dry run") });
  });
  it("refuses a vendor-scoped run — a slice must never become the corpus baseline", () => {
    expect(evaluateBaselineAcceptance(held({ metrics: { vendor_scope: ["v1"] } }), who)).toMatchObject({ refusal: expect.stringContaining("SCOPED") });
  });
  it("refuses when an absolute check FAILED, naming it with its detail", () => {
    const r = held();
    (r.checks as unknown as Record<string, GateCheck>).outliers = check(false, true, "9/30 outliers");
    expect(evaluateBaselineAcceptance(r, who)).toMatchObject({ refusal: expect.stringContaining("outliers (9/30 outliers)") });
  });
  it("refuses when an absolute check is missing from the record — unmeasured is not passed", () => {
    const r = held();
    delete (r.checks as unknown as Record<string, GateCheck>).low_confidence;
    expect(evaluateBaselineAcceptance(r, who)).toMatchObject({ refusal: expect.stringContaining("low_confidence") });
    expect(evaluateBaselineAcceptance(held({ checks: {} }), who)).toHaveProperty("refusal");
  });
  it("accepts a held, unscoped run whose absolute checks passed, and records who, why, when and what it waived", () => {
    const out = evaluateBaselineAcceptance(held(), who);
    expect(out).toMatchObject({ update: { verdict: "pass", status: "committed" } });
    const notes = JSON.parse((out as { update: { notes: string } }).update.notes);
    expect(notes).toMatchObject({ accepted_baseline: true, approver: "Owner", reason: "first full run, checked by hand", accepted_at: NOW.toISOString(), prior: { status: "held", verdict: "hold" } });
    expect(notes.waived_checks.map((c: { name: string }) => c.name)).toEqual([...CORPUS_CHECKS]);
    expect(notes.waived_checks[0].recorded).toEqual({ pass: false, measured: false, detail: "NO BASELINE" });
    expect(notes.absolute_checks_passed.map((c: { name: string }) => c.name)).toEqual([...ABSOLUTE_CHECKS]);
  });
});

describe("acceptBaseline — gate-table writes only", () => {
  it("flips a held first run to PASS, which the next run then measures against", async () => {
    const repo = setup({ offers: healthy() });
    expect((await runGate(repo, RUN, { now: NOW })).verdict).toBe("hold");
    const offersBefore = repo.offers.size;
    const accepted = await acceptBaseline(repo, RUN, { approver: "Owner", reason: "first run", now: NOW });
    expect(accepted).toEqual({ ok: true });
    expect(repo.runs.get(RUN)).toMatchObject({ status: "committed", verdict: "pass" });
    expect(repo.offers.size).toBe(offersBefore);
    expect(repo.quarantined).toEqual([]);

    repo.runs.set("next", run({ id: "next", finished_at: "2026-10-03T06:25:00.000Z", metrics: { errors: [], vendor_scope: null } }));
    for (const o of [...repo.offers.values()]) repo.offers.set(o.id, { ...o, run_id: "next" });
    const next = await runGate(repo, "next", { now: NOW });
    expect(next.baseline).toEqual({ kind: "ok", runId: RUN });
    expect(next.verdict).toBe("pass");
  });
  it("reports a refusal and writes nothing", async () => {
    const repo = setup({ offers: healthy(), runs: [passRun("base", { v1: 15, v2: 15 })] });
    await runGate(repo, RUN, { now: NOW });
    const before = repo.runs.get(RUN);
    expect(await acceptBaseline(repo, RUN, { approver: "Owner", reason: "x", now: NOW })).toMatchObject({ ok: false, refusal: expect.stringContaining("only a HELD run") });
    expect(repo.runs.get(RUN)).toEqual(before);
  });
  it("the thresholds are the reference's", () => {
    expect(THRESHOLDS).toEqual({ PARTIAL_FAILURE_MIN_RATIO: 0.7, VENDOR_ZERO_MAX_RATIO: 0.2, OUTLIER_K: 10, OUTLIER_MAX_RATIO: 0.05, LOW_CONF_MAX_RATIO: 0.4, DRIVER_ERROR_MAX_RATIO: 0.05 });
  });
});
