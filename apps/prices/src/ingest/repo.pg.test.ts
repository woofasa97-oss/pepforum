import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresRepo, type CompoundRow, type OfferInsert, type VendorRow } from "./repo.ts";

// Exercises PostgresRepo's SQL against whatever PRICES_DB_URL points at (the local container in
// development). Skipped without it. Everything it writes carries the `zz-repo-test` slug family and
// is removed afterwards — except offer_observations, which is append-only by design; its test rows
// stay in the local database, inert.
const dbUrl = process.env.PRICES_DB_URL;
// LOCAL DATABASE ONLY. This suite creates committed runs, quarantines, restores and prunes; with
// the hosted project's URL in the environment it would do all of that to production.
const isLocal = (() => {
  try {
    return ["127.0.0.1", "localhost"].includes(new URL(dbUrl ?? "").hostname);
  } catch {
    return false;
  }
})();
const suite = isLocal ? describe : describe.skip;

suite("PostgresRepo against a real database", () => {
  const repo = new PostgresRepo(dbUrl ?? "");
  // This suite puts comparable offers under a PASSED run and later deletes their vendor. A
  // publish_offers() in another test file acts on the whole database and would trip over that
  // vendor mid-statement, so this file takes the same turn as the files that publish: the lock is
  // held on its own connection until afterAll closes it.
  const turn = postgres(dbUrl ?? "", { max: 1 });
  let vendor: VendorRow;
  let compound: CompoundRow;
  const cleanup = async () => {
    await repo.sql`delete from offer_quarantine where vendor_id in (select id from vendors where slug like 'zz-repo-test%')`;
    await repo.sql`delete from offer_candidates where vendor_id in (select id from vendors where slug like 'zz-repo-test%')`;
    await repo.sql`delete from refresh_runs where run_label like 'zz-repo-test%'`;
    await repo.sql`delete from fx_rates where provider = 'zz-repo-test'`;
    await repo.sql`delete from vendors where slug like 'zz-repo-test%'`;
    await repo.sql`delete from compounds where slug like 'zz-repo-test%'`;
  };

  beforeAll(async () => {
    await turn`select pg_advisory_lock(820261003)`;
    await cleanup();
    await repo.upsertVendors([{ slug: "zz-repo-test-vendor", name: "Repo Test", website_url: "https://repo-test.example", canonical_domain: "repo-test.example", origin_country: "US", detected_platform: "woocommerce", status: "pending" }]);
    await repo.upsertCompounds([{ slug: "zz-repo-test-compound", name: "Testide", type: "Single compound", aliases: ["TST-1"], known_sizes_mg: [5] }]);
    [vendor] = await repo.listVendors({ status: "all", slugs: ["zz-repo-test-vendor"] });
    compound = (await repo.listCompounds()).find((c) => c.slug === "zz-repo-test-compound") as CompoundRow;
  });
  afterAll(async () => {
    await cleanup();
    await repo.close();
    await turn.end();
  });

  const offer = (over: Partial<OfferInsert> = {}): OfferInsert => ({
    vendor_id: vendor.id,
    compound_id: compound.id,
    product_key: `${vendor.id}:${compound.id}:repo-test.example/product/testide`,
    variant_key: "1",
    product_url: "https://repo-test.example/product/testide/",
    product_name: "Testide",
    variant_label: "Size: 5mg",
    source_system: "woocommerce",
    source_product_id: "10",
    source_variant_id: "1",
    price_source: "woo_store_api",
    native_currency: "USD",
    price_minor: 4999,
    list_price_minor: null,
    on_sale: false,
    price_kind: "per_pack",
    mg_per_vial: 5,
    vials_per_pack: 1,
    total_mg: 5,
    form: "vial",
    is_blend: false,
    comparable: true,
    quantity_reason: null,
    per_mg_minor_e4: 9998000,
    availability: "in_stock",
    availability_checked_at: "2026-10-01T12:00:00.000Z",
    raw_price_text: "USD4999 (minor_unit=2)",
    extraction_confidence: "high",
    observed_at: "2026-10-01T12:00:00.000Z",
    price_changed_at: "2026-10-01T12:00:00.000Z",
    run_id: null,
    ...over,
  });

  it("lists vendors and compounds by filter", async () => {
    expect(vendor.slug).toBe("zz-repo-test-vendor");
    expect(compound.aliases).toEqual(["TST-1"]);
    expect((await repo.listVendors({ status: "active", slugs: ["zz-repo-test-vendor"] })).length).toBe(0);
  });

  it("runs, attempts and the last-complete-hit / previous-attempt lookups", async () => {
    const run = await repo.createRun({ run_label: "zz-repo-test-run", mode: "feeds", dry_run: false, started_at: "2026-10-01T12:00:00.000Z" });
    expect(run.status).toBe("running");
    const a1 = await repo.claimAttempt({ run_id: run.id, vendor_id: vendor.id, started_at: "2026-10-01T12:00:00.000Z" });
    await repo.finishAttempt(a1, { outcome: "hit", run_complete: true, rows_written: 3, rung: "woo_store_api", http_status: 200, counts: { missing_product_keys: ["k1"], dead_urls: [] }, finished_at: "2026-10-01T12:01:00.000Z" });
    const a2 = await repo.claimAttempt({ run_id: run.id, vendor_id: vendor.id, started_at: "2026-10-01T12:02:00.000Z" });
    await repo.finishAttempt(a2, { outcome: "blocked", run_complete: false, rows_written: 0, http_status: 403, counts: {}, finished_at: "2026-10-01T12:03:00.000Z" });
    const a3 = await repo.claimAttempt({ run_id: run.id, vendor_id: vendor.id, started_at: "2026-10-01T12:04:00.000Z" });
    expect((await repo.lastCompleteHit(vendor.id))?.id).toBe(a1);
    expect((await repo.lastCompleteHit(vendor.id))?.counts).toEqual({ missing_product_keys: ["k1"], dead_urls: [] });
    expect((await repo.previousAttempt(vendor.id, a3))?.id).toBe(a2);
    await repo.finishRun(run.id, { finished_at: "2026-10-01T12:05:00.000Z", status: "committed", metrics: { rows_written: 3 } });
    const [stored] = await repo.sql<{ status: string; metrics: unknown }[]>`select status, metrics from refresh_runs where id = ${run.id}`;
    expect(stored).toEqual({ status: "committed", metrics: { rows_written: 3 } });
    await repo.finishAttempt(a3, { outcome: "miss", finished_at: "2026-10-01T12:06:00.000Z" });

    // A later DRY run's attempts are never a baseline for a live one.
    const dry = await repo.createRun({ run_label: "zz-repo-test-run-dry", mode: "feeds", dry_run: true, started_at: "2026-10-01T13:00:00.000Z" });
    const d1 = await repo.claimAttempt({ run_id: dry.id, vendor_id: vendor.id, started_at: "2026-10-01T13:00:00.000Z" });
    await repo.finishAttempt(d1, { outcome: "hit", run_complete: true, rows_written: 99, counts: {}, finished_at: "2026-10-01T13:01:00.000Z" });
    expect((await repo.lastCompleteHit(vendor.id))?.id).toBe(a1);
    expect((await repo.previousAttempt(vendor.id))?.id).toBe(a3);
  });

  it("upserts an offer (insert, then update), records observations and candidates, quarantines and restores", async () => {
    const run = await repo.createRun({ run_label: "zz-repo-test-run-2", mode: "feeds", dry_run: false });
    const first = await repo.upsertOffer(offer({ run_id: run.id }));
    expect(first.inserted).toBe(true);
    const second = await repo.upsertOffer(offer({ price_minor: 5999, raw_price_text: "USD5999 (minor_unit=2)", per_mg_minor_e4: 11998000, run_id: run.id }));
    expect(second).toEqual({ id: first.id, inserted: false });
    const rows = await repo.listOffers(vendor.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ price_minor: 5999, per_mg_minor_e4: 11998000, variant_key: "1" });

    const ids = new Map([[`${compound.id}#${rows[0].product_key}#1`, first.id]]);
    expect(await repo.insertObservations([offer({ run_id: run.id })], { offerIds: ids, runLabel: "zz-repo-test-run-2" })).toBe(1);
    const [obs] = await repo.sql<{ offer_id: string; run_label: string }[]>`select offer_id, run_label from offer_observations where vendor_id = ${vendor.id} and run_label = 'zz-repo-test-run-2' order by created_at desc limit 1`;
    expect(obs).toEqual({ offer_id: first.id, run_label: "zz-repo-test-run-2" });

    const candidate = { run_label: "zz-repo-test-run-2", vendor_id: vendor.id, product_url: "https://repo-test.example/product/mystery/", product_name: "Mystery 5mg", reject_reason: "no_compound_match", match_candidates: [], raw: { name: "Mystery 5mg" } };
    expect(await repo.insertCandidates([candidate])).toBe(1);
    expect(await repo.insertCandidates([candidate])).toBe(0); // same run + vendor + url: ignored

    expect(await repo.quarantine([first.id], "variant_gone", run.id)).toBe(1);
    expect(await repo.listOffers(vendor.id)).toEqual([]);
    const [q] = await repo.sql<{ reason: string; original_id: string }[]>`select reason, original_id from offer_quarantine where vendor_id = ${vendor.id}`;
    expect(q).toEqual({ reason: "variant_gone", original_id: first.id });
    expect(await repo.restoreRun(run.id)).toBe(1);
    expect((await repo.listOffers(vendor.id)).map((r) => r.id)).toEqual([first.id]);

    await repo.updateVendorPlatform(vendor.id, "shopify", "2026-10-01T12:00:00.000Z");
    await repo.markVendorIngested(vendor.id, "2026-10-01T12:00:00.000Z");
    const [v] = await repo.listVendors({ status: "all", slugs: [vendor.slug] });
    expect(v).toMatchObject({ detected_platform: "shopify", platform_probed_at: expect.any(String), last_ingested_at: expect.any(String) });
    expect(await repo.uploadCapture("k", Buffer.from("x"))).toMatchObject({ uri: null, error: expect.stringContaining("no capture storage") });
  });

  it("reads runs by id and label, lists baseline candidates, and ages out only rows this run did not confirm", async () => {
    const run = await repo.createRun({ run_label: "zz-repo-test-run-3", mode: "feeds", dry_run: false });
    expect((await repo.getRun(run.id))?.run_label).toBe("zz-repo-test-run-3");
    expect((await repo.getRunByLabel("zz-repo-test-run-3"))?.id).toBe(run.id);
    expect(await repo.getRunByLabel("zz-repo-test-nope")).toBeNull();
    expect((await repo.listCommittedRuns()).some((r) => r.id === run.id)).toBe(false); // still running

    await repo.finishRun(run.id, { status: "committed", verdict: "pass", finished_at: "2026-10-01T12:05:00.000Z", checks: { outliers: { pass: true, measured: true, detail: "0/1", samples: [] } }, metrics: { gate: { rows_by_vendor: { [vendor.id]: 1 } } } });
    const listed = (await repo.listCommittedRuns()).find((r) => r.id === run.id);
    expect(listed).toMatchObject({ verdict: "pass", dry_run: false, finished_at: "2026-10-01T12:05:00.000Z", checks: { outliers: { pass: true } }, metrics: { gate: { rows_by_vendor: { [vendor.id]: 1 } } } });

    // One row this run confirmed, one nobody has observed since 1971. 19,000 days reaches back to ~1974,
    // so nothing real in a development database can be caught by this prune.
    const key = (slug: string) => `${vendor.id}:${compound.id}:repo-test.example/product/${slug}`;
    const confirmed = await repo.upsertOffer(offer({ product_key: key("confirmed"), variant_key: "3", source_product_id: "12", source_variant_id: "3", run_id: run.id }));
    const ancient = await repo.upsertOffer(offer({ product_key: key("ancient"), variant_key: "2", source_product_id: "11", source_variant_id: "2", observed_at: "1971-01-01T00:00:00.000Z", run_id: null }));
    expect(await repo.countRunOffers(run.id)).toBe(1);
    expect(await repo.countStale(run.id, 19_000)).toBe(1);
    expect(await repo.softDeleteStale(run.id, 19_000)).toBe(1);
    expect(await repo.countStale(run.id, 19_000)).toBe(0);
    const live = (await repo.listAllOffers()).filter((o) => o.vendor_id === vendor.id).map((o) => o.id);
    expect(live).toContain(confirmed.id);
    expect(live).not.toContain(ancient.id);
    const [q] = await repo.sql<{ reason: string; quarantine_run_id: string }[]>`select reason, quarantine_run_id from offer_quarantine where original_id = ${ancient.id}`;
    expect(q).toEqual({ reason: "stale_aged_out", quarantine_run_id: run.id });
  });

  it("an offer can be quarantined, restored and quarantined AGAIN — each removal is its own record", async () => {
    const run = await repo.createRun({ run_label: "zz-repo-test-run-4", mode: "feeds", dry_run: false });
    const key = `${vendor.id}:${compound.id}:repo-test.example/product/cycle`;
    const { id } = await repo.upsertOffer(offer({ product_key: key, variant_key: "7", source_product_id: "17", source_variant_id: "7", run_id: run.id }));
    expect(await repo.quarantine([id], "outlier", run.id)).toBe(1);
    expect(await repo.restoreRun(run.id)).toBe(1);
    expect(await repo.quarantine([id], "outlier", run.id)).toBe(1);
    const records = await repo.sql<{ id: string; original_id: string; restored: boolean }[]>`select id, original_id, restored_at is not null as restored from offer_quarantine where original_id = ${id} order by quarantined_at`;
    expect(records.map((r) => [r.original_id, r.restored])).toEqual([[id, true], [id, false]]);
    expect(records.every((r) => r.id !== id)).toBe(true);
    // A restore that cannot land (the key is live again under a new row) leaves its record unrestored.
    const replacement = await repo.upsertOffer(offer({ product_key: key, variant_key: "7", source_product_id: "17", source_variant_id: "7", run_id: run.id }));
    expect(replacement.id).not.toBe(id);
    expect(await repo.restoreRun(run.id)).toBe(0);
    const [open] = await repo.sql<{ n: number }[]>`select count(*)::int as n from offer_quarantine where original_id = ${id} and restored_at is null`;
    expect(open.n).toBe(1);
  });

  it("a blend's mix travels with the row into quarantine and back", async () => {
    const run = await repo.createRun({ run_label: "zz-repo-test-recipe", mode: "feeds", dry_run: false });
    const { id } = await repo.upsertOffer(offer({ product_key: "zz-recipe", variant_key: "9", source_product_id: "19", source_variant_id: "9", run_id: run.id, comparable: false, per_mg_minor_e4: null, total_mg: null, is_blend: true, quantity_reason: "blend", recipe_key: "a:1+b:2" }));
    expect(await repo.quarantine([id], "outlier", run.id)).toBe(1);
    const [q] = await repo.sql<{ recipe_key: string | null }[]>`select recipe_key from offer_quarantine where original_id = ${id}`;
    expect(q.recipe_key).toBe("a:1+b:2");
    expect(await repo.restoreRun(run.id)).toBe(1);
    expect((await repo.listOffers(vendor.id)).find((o) => o.id === id)?.recipe_key).toBe("a:1+b:2");
  });

  it("upserts exchange rates on (base, quote, date) and reads the date back as the provider wrote it", async () => {
    const rate = { base_currency: "USD", quote_currency: "CAD", provider: "zz-repo-test", rate_date: "1999-01-04" };
    expect(await repo.upsertFxRates([{ ...rate, rate: 1.36712 }])).toBe(1);
    await repo.upsertFxRates([{ ...rate, rate: 1.37 }]);
    const rows = await repo.sql<{ rate: number; rate_date: string }[]>`select rate, rate_date from fx_rates where provider = 'zz-repo-test'`;
    expect([...rows]).toEqual([{ rate: 1.37, rate_date: "1999-01-04" }]);
  });
});
