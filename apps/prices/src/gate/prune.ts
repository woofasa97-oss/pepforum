/**
 * STALE PRUNE — ages out offers nobody has observed for 60 days. Runs ONLY on a run the gate
 * passed: a held or ungated run has not shown the pipeline was healthy, and pruning on it removes
 * coverage on the strength of a read nobody trusts. The move is a soft delete (quarantine as
 * `stale_aged_out`), restorable by run. There is no force path.
 *
 * Ported from PeptideBase's prune-stale-prices.mjs, without its `--force` and without the
 * irreversible quarantine purge.
 */
import type { Repo, RunRow } from "../ingest/repo.ts";
import { vendorScopeOf } from "./gate.ts";

export const STALE_DAYS = 60;

export type PruneResult = { ok: true; dryRun: boolean; pruned: number; days: number } | { ok: false; refusal: string };

export async function pruneStale(repo: Repo, runId: string, opts: { days?: number; dryRun: boolean }): Promise<PruneResult> {
  const days = opts.days ?? STALE_DAYS;
  const run = await repo.getRun(runId);
  if (!run) return { ok: false, refusal: `run ${runId} not found — nothing to prune against.` };
  if (run.dry_run) return { ok: false, refusal: `run ${run.run_label} was a dry run: it confirmed nothing, so it cannot say what is stale.` };
  if (run.status !== "committed" || run.verdict !== "pass") {
    return { ok: false, refusal: `run ${run.run_label} did not pass the gate (status=${run.status}, verdict=${run.verdict ?? "none"}). The prune runs only after a PASS.` };
  }
  if (vendorScopeOf(run)) return { ok: false, refusal: `run ${run.run_label} was scoped to some vendors — a slice cannot license a corpus-wide prune.` };
  // The prune removes the whole aged backlog whatever this run wrote, so a zero-write run must
  // not reach it: that would remove coverage without having added any.
  if ((await repo.countRunOffers(runId)) === 0) return { ok: false, refusal: `run ${run.run_label} wrote 0 rows — check the run, or investigate the refresh.` };

  if (opts.dryRun) return { ok: true, dryRun: true, pruned: await repo.countStale(runId, days), days };
  const pruned = await repo.softDeleteStale(runId, days);
  await repo.finishRun(runId, { metrics: { ...(run.metrics as object), stale_pruned: pruned } as RunRow["metrics"] });
  return { ok: true, dryRun: false, pruned, days };
}
