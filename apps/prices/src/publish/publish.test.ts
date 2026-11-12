import { describe, expect, it } from "vitest";
import { InMemoryRepo, type CompoundRow, type OfferRow, type RunRow } from "../ingest/repo.ts";
import { publishRun } from "./publish.ts";

const offer = (id: string, runId: string, over: Partial<OfferRow> = {}): OfferRow =>
  ({ id, vendor_id: "v1", compound_id: "c1", product_key: id, variant_key: "", comparable: true, vials_per_pack: 1, native_currency: "USD", price_minor: 4000, run_id: runId, observed_at: "2026-10-01T12:00:00.000Z", ...over }) as OfferRow;

async function setup() {
  const repo = new InMemoryRepo();
  const pass = await repo.createRun({ run_label: "pass", mode: "feeds", dry_run: false });
  await repo.finishRun(pass.id, { status: "committed", verdict: "pass" } as Partial<RunRow>);
  const held = await repo.createRun({ run_label: "held", mode: "feeds", dry_run: false });
  await repo.finishRun(held.id, { status: "held", verdict: "hold" } as Partial<RunRow>);
  const dry = await repo.createRun({ run_label: "dry", mode: "feeds", dry_run: true });
  await repo.finishRun(dry.id, { status: "committed", verdict: "pass" } as Partial<RunRow>);
  return { repo, pass: pass.id, held: held.id, dry: dry.id };
}

describe("publishRun", () => {
  it("refuses a run that is missing, was a dry run, or did not pass", async () => {
    const s = await setup();
    expect(await publishRun(s.repo, "nope", { dryRun: false })).toMatchObject({ ok: false });
    expect(await publishRun(s.repo, s.dry, { dryRun: false })).toMatchObject({ ok: false, refusal: expect.stringMatching(/dry run/) });
    expect(await publishRun(s.repo, s.held, { dryRun: false })).toMatchObject({ ok: false, refusal: expect.stringMatching(/did not pass/) });
    expect(s.repo.published.size).toBe(0);
  });

  it("a dry run counts what would be published and writes nothing", async () => {
    const s = await setup();
    s.repo.seedOffer(offer("a", s.pass));
    s.repo.seedOffer(offer("b", s.held));
    s.repo.seedOffer(offer("c", s.pass, { native_currency: "EUR" }));
    s.repo.seedOffer(offer("d", s.pass, { comparable: false }));
    expect(await publishRun(s.repo, s.pass, { dryRun: true })).toEqual({ ok: true, dryRun: true, preview: { eligible: 1, waiting: 1, unconvertible: 1 } });
    expect(s.repo.published.size).toBe(0);
  });

  it("publishes rows of passed runs, keeps a held row's last published values, removes rows that left offers, and records the publish on the run", async () => {
    const s = await setup();
    s.repo.seedOffer(offer("a", s.pass));
    s.repo.seedOffer(offer("gone", s.pass));
    const first = await publishRun(s.repo, s.pass, { dryRun: false });
    expect(first).toMatchObject({ ok: true, dryRun: false, summary: { offers: 2, changed: 2, removed: 0 } });

    s.repo.seedOffer(offer("a", s.held, { price_minor: 3000 }));
    s.repo.offers.delete("gone");
    const second = await publishRun(s.repo, s.pass, { dryRun: false });
    expect(second).toMatchObject({ ok: true, summary: { offers: 1, changed: 0, removed: 1, waiting: 1 } });
    expect(s.repo.published.get("a")?.price_minor).toBe(4000);
    expect((s.repo.runs.get(s.pass)?.metrics as { published: { offers: number } }).published.offers).toBe(1);
  });

  it("a vial blend under a blend compound is publishable — not a capsule blend, not one of unknown pack, not a blend filed under a single compound", async () => {
    const s = await setup();
    s.repo.seedCompound({ id: "c-blend", slug: "a-b", name: "A + B", type: "Blend", aliases: [], is_active: true } as unknown as CompoundRow);
    s.repo.seedCompound({ id: "c1", slug: "a", name: "A", type: "Single compound", aliases: [], is_active: true } as unknown as CompoundRow);
    const blend = { compound_id: "c-blend", comparable: false, is_blend: true, form: "vial" } as Partial<OfferRow>;
    s.repo.seedOffer(offer("vial", s.pass, blend));
    s.repo.seedOffer(offer("capsule", s.pass, { ...blend, form: "capsule" }));
    s.repo.seedOffer(offer("no-pack", s.pass, { ...blend, vials_per_pack: null }));
    s.repo.seedOffer(offer("under-single", s.pass, { ...blend, compound_id: "c1" }));
    expect(await publishRun(s.repo, s.pass, { dryRun: true })).toMatchObject({ preview: { eligible: 1 } });
    await publishRun(s.repo, s.pass, { dryRun: false });
    expect([...s.repo.published.keys()]).toEqual(["vial"]);
  });
});
