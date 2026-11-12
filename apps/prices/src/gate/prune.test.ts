import { describe, expect, it } from "vitest";
import { InMemoryRepo, type OfferRow, type RunRow } from "../ingest/repo.ts";
import { STALE_DAYS, pruneStale } from "./prune.ts";

const RUN = "run-pass";
const NOW = new Date("2026-12-15T06:30:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const run = (over: Partial<RunRow> = {}): RunRow =>
  ({ id: RUN, run_label: RUN, mode: "feeds", dry_run: false, status: "committed", verdict: "pass", finished_at: daysAgo(0), metrics: { vendor_scope: null, rows_written: 2 }, checks: {}, notes: null, ...over }) as RunRow;
const offer = (id: string, over: Partial<OfferRow> = {}): OfferRow => ({ id, vendor_id: "v1", compound_id: "c1", product_key: `k-${id}`, variant_key: "", run_id: "older-run", observed_at: daysAgo(1), ...over }) as OfferRow;

function setup(current: Partial<RunRow> = {}, offers: OfferRow[] = []) {
  const repo = new InMemoryRepo();
  repo.now = () => NOW;
  repo.runs.set(RUN, run(current));
  for (const o of offers) repo.seedOffer(o);
  return repo;
}

const corpus = () => [
  offer("confirmed-1", { run_id: RUN, observed_at: daysAgo(0) }),
  offer("confirmed-2", { run_id: RUN, observed_at: daysAgo(0) }),
  offer("recent", { observed_at: daysAgo(59) }),
  offer("aged", { observed_at: daysAgo(61) }),
  offer("aged-2", { observed_at: daysAgo(200) }),
];

describe("pruneStale", () => {
  it("soft-deletes rows nobody has observed for 60 days that this run did not confirm, and stamps the count", async () => {
    const repo = setup({}, corpus());
    const out = await pruneStale(repo, RUN, { dryRun: false });
    expect(out).toEqual({ ok: true, dryRun: false, pruned: 2, days: STALE_DAYS });
    expect([...repo.offers.keys()].sort()).toEqual(["confirmed-1", "confirmed-2", "recent"]);
    expect(repo.quarantined.map((q) => [q.original_id, q.reason, q.quarantine_run_id]).sort()).toEqual([
      ["aged", "stale_aged_out", RUN],
      ["aged-2", "stale_aged_out", RUN],
    ]);
    expect(repo.runs.get(RUN)?.metrics).toMatchObject({ rows_written: 2, stale_pruned: 2 });
  });

  it("a dry run reports what it would prune and touches nothing", async () => {
    const repo = setup({}, corpus());
    const out = await pruneStale(repo, RUN, { dryRun: true });
    expect(out).toEqual({ ok: true, dryRun: true, pruned: 2, days: STALE_DAYS });
    expect(repo.offers.size).toBe(5);
    expect(repo.quarantined).toEqual([]);
    expect(repo.runs.get(RUN)?.metrics).not.toHaveProperty("stale_pruned");
  });

  it("refuses a run the gate did not pass — held, ungated, or unknown", async () => {
    for (const current of [{ status: "held", verdict: "hold" }, { verdict: null }, { status: "error", verdict: null }] as Partial<RunRow>[]) {
      const repo = setup(current, corpus());
      const out = await pruneStale(repo, RUN, { dryRun: false });
      expect(out).toMatchObject({ ok: false, refusal: expect.stringContaining("did not pass the gate") });
      expect(repo.offers.size).toBe(5);
    }
    expect(await pruneStale(setup(), "nope", { dryRun: false })).toMatchObject({ ok: false, refusal: expect.stringContaining("not found") });
  });

  it("refuses a run that wrote 0 rows — pruning then removes coverage without adding any", async () => {
    const repo = setup({}, [offer("aged", { observed_at: daysAgo(61) })]);
    expect(await pruneStale(repo, RUN, { dryRun: false })).toMatchObject({ ok: false, refusal: expect.stringContaining("wrote 0 rows") });
    expect(repo.offers.size).toBe(1);
  });

  it("refuses a vendor-scoped or dry run — neither can license a corpus-wide prune", async () => {
    const scoped = setup({ metrics: { vendor_scope: ["v1"] } }, corpus());
    expect(await pruneStale(scoped, RUN, { dryRun: false })).toMatchObject({ ok: false, refusal: expect.stringContaining("scoped") });
    const dry = setup({ dry_run: true }, corpus());
    expect(await pruneStale(dry, RUN, { dryRun: false })).toMatchObject({ ok: false, refusal: expect.stringContaining("dry run") });
    expect(scoped.offers.size + dry.offers.size).toBe(10);
  });
});
