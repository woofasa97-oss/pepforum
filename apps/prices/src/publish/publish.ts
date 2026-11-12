/**
 * PUBLISH — copies what the gate has passed into the table the site reads. Runs ONLY for a run the
 * gate passed: the site must never show a price nobody checked. A held run publishes nothing, and
 * the site keeps the last checked prices, which age into "stale" on their own.
 *
 * Unlike the prune, a run scoped to some vendors may publish: the copy takes every row whose OWN
 * run passed, whichever run that was, so a slice adds its rows and removes nothing else.
 */
import type { PublishPreview, PublishSummary, Repo, RunRow } from "../ingest/repo.ts";

export type PublishResult =
  | { ok: true; dryRun: true; preview: PublishPreview }
  | { ok: true; dryRun: false; summary: PublishSummary }
  | { ok: false; refusal: string };

export async function publishRun(repo: Repo, runId: string, opts: { dryRun: boolean }): Promise<PublishResult> {
  const run = await repo.getRun(runId);
  if (!run) return { ok: false, refusal: `run ${runId} not found — nothing to publish.` };
  if (run.dry_run) return { ok: false, refusal: `run ${run.run_label} was a dry run: it wrote nothing, so there is nothing of its to publish.` };
  if (run.status !== "committed" || run.verdict !== "pass") {
    return { ok: false, refusal: `run ${run.run_label} did not pass the gate (status=${run.status}, verdict=${run.verdict ?? "none"}). Only checked prices are published.` };
  }
  if (opts.dryRun) return { ok: true, dryRun: true, preview: await repo.previewPublish() };
  const summary = await repo.publishOffers(runId);
  const published = { publication_id: summary.publication_id, offers: summary.offers, changed: summary.changed, removed: summary.removed };
  await repo.finishRun(runId, { metrics: { ...(run.metrics as object), published } as RunRow["metrics"] });
  return { ok: true, dryRun: false, summary };
}
