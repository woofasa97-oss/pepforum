import type { Repo } from "../ingest/repo.ts";
import type { CompoundSeed, VendorSeed } from "./types.ts";

/** Upserts by slug; safe to run repeatedly. Existing rows keep their status and evidence columns. */
export async function applySeeds(repo: Repo, seeds: { compounds: CompoundSeed[]; vendors: VendorSeed[] }) {
  const compounds = await repo.upsertCompounds(seeds.compounds);
  const vendors = await repo.upsertVendors(seeds.vendors);
  return { compounds, vendors };
}
