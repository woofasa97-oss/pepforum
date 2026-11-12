/**
 * The whole-run driver: one `refresh_runs` row, the vendors this mode covers taken in turn, an
 * aggregate summary, and the run closed as `committed` or `error`. Sequential on purpose — the
 * vendors we read are asked to tolerate us, and one vendor at a time is what an honest crawler
 * looks like from the other side.
 */
import { createFetcher } from "../fetch/http.ts";
import { createRawCapture } from "../fetch/raw-capture.ts";
import type { Sleep } from "../fetch/pacing.ts";
import type { FetchText } from "../fetch/types.ts";
import type { Platform } from "../ladder/types.ts";
import { buildProductIndex } from "../units/blend-match.ts";
import { ingestVendor, type VendorResult } from "./ingest-vendor.ts";
import type { Repo, VendorRow, VendorStatusFilter } from "./repo.ts";

export type RunMode = "feeds" | "pages";

const FEED_PLATFORMS: readonly (Platform | null)[] = ["woocommerce", "shopify", null];
const PAGE_PLATFORMS: readonly Platform[] = ["woocommerce_closed_api", "shopify_closed_api", "jsonld", "custom"];

/** Feeds mode takes the feed platforms and unprobed vendors; pages mode the closed/page platforms. */
export function selectVendors(vendors: VendorRow[], mode: RunMode): VendorRow[] {
  return vendors.filter((v) => {
    const platform = (v.detected_platform as Platform | null) ?? null;
    return mode === "feeds" ? FEED_PLATFORMS.includes(platform) : platform !== null && PAGE_PLATFORMS.includes(platform);
  });
}

export function defaultRunLabel(mode: RunMode, now: Date): string {
  return `refresh-${mode}-${now.toISOString().slice(0, 16).replace(":", "-")}Z`;
}

export interface RunOptions {
  repo: Repo;
  mode: RunMode;
  dryRun: boolean;
  /** Vendor slugs to run; every other selected vendor is skipped. An unknown slug refuses the run. */
  vendors?: string[];
  /** Which vendor statuses to consider. Default `active`. */
  status?: VendorStatusFilter;
  runLabel?: string;
  now?: Date;
  /** Injectable for tests. Default: the honest fetcher, one capture per vendor. */
  fetchText?: FetchText;
  /** A keyed vendor's Authorization header for its own site (`vendorAuthorizationFromEnv`); given to the default fetcher. */
  authorization?: (url: URL) => string | null;
  captureDir?: string;
  /** Injectable pause between requests to one vendor (tests). */
  sleep?: Sleep;
  /** Accept a smaller catalogue for the vendors of this run (the operator's release of a SKU-drop hold). */
  acceptSkuDrop?: boolean;
  onVendor?: (result: VendorResult) => void;
}

export interface RunSummary {
  runId: string;
  runLabel: string;
  mode: RunMode;
  dryRun: boolean;
  vendors: number;
  byOutcome: Record<string, number>;
  rowsWritten: number;
  changed: number;
  candidates: number;
  quarantined: Record<string, number>;
  fetches: number;
  held: string[];
  errors: { slug: string; error: string }[];
  results: VendorResult[];
}

export async function runRefresh(opts: RunOptions): Promise<RunSummary> {
  const { repo, mode, dryRun } = opts;
  const now = opts.now ?? new Date();
  const runLabel = opts.runLabel ?? defaultRunLabel(mode, now);

  const all = await repo.listVendors({ status: opts.status ?? "active", slugs: opts.vendors });
  if (opts.vendors) {
    const missing = opts.vendors.filter((s) => !all.some((v) => v.slug === s));
    if (missing.length) throw new Error(`unknown or excluded vendor slug(s): ${missing.join(", ")}`);
  }
  const vendors = selectVendors(all, mode);
  const compounds = await repo.listCompounds();
  const products = buildProductIndex(compounds.map((c) => ({ id: c.id, name: c.name, slug: c.slug, aliases: c.aliases, type: c.type, blend_components: c.blend_components as { slug: string }[] | null })));
  const compoundsById = new Map(compounds.map((c) => [c.id, c]));

  const run = await repo.createRun({ run_label: runLabel, mode, dry_run: dryRun, started_at: now.toISOString() });
  const summary: RunSummary = { runId: run.id, runLabel, mode, dryRun, vendors: vendors.length, byOutcome: {}, rowsWritten: 0, changed: 0, candidates: 0, quarantined: {}, fetches: 0, held: [], errors: [], results: [] };

  for (const vendor of vendors) {
    const capture = createRawCapture({ runLabel, vendorSlug: vendor.slug, header: { run_id: run.id, mode, base_url: vendor.website_url, platform: vendor.detected_platform }, startedAt: now });
    const fetchText = opts.fetchText ?? createFetcher({ capture, authorization: opts.authorization });
    let result: VendorResult;
    try {
      result = await ingestVendor(vendor, { repo, fetchText, products, compoundsById, runId: run.id, runLabel, now, dryRun, capture, captureDir: opts.captureDir, acceptSkuDrop: opts.acceptSkuDrop, sleep: opts.sleep });
    } catch (err) {
      // ingestVendor reports its own failures; this is the one it cannot — its ledger row could
      // not be claimed. Still one vendor's failure: the run goes on and is closed.
      result = { vendorId: vendor.id, slug: vendor.slug, outcome: "unknown", state: null, rung: null, reason: null, productsSeen: 0, matched: 0, rowsWritten: 0, changed: 0, unchanged: 0, candidates: 0, refusals: {}, quarantined: {}, undecided: {}, rowFailures: [], fetches: 0, held: false, attemptId: "", capture: null, error: err instanceof Error ? err.message : String(err) };
    }
    summary.results.push(result);
    summary.byOutcome[result.outcome] = (summary.byOutcome[result.outcome] ?? 0) + 1;
    summary.rowsWritten += result.rowsWritten;
    summary.changed += result.changed;
    summary.candidates += result.candidates;
    summary.fetches += result.fetches;
    for (const [reason, n] of Object.entries(result.quarantined)) summary.quarantined[reason] = (summary.quarantined[reason] ?? 0) + (n ?? 0);
    if (result.held) summary.held.push(vendor.slug);
    if (result.error) summary.errors.push({ slug: vendor.slug, error: result.error });
    opts.onVendor?.(result);
  }

  const metrics = {
    // A run restricted to named vendors is a SLICE: the gate never takes it as a baseline.
    vendor_scope: opts.vendors && opts.vendors.length > 0 ? opts.vendors : null,
    vendor_ids: vendors.map((v) => v.id),
    vendors: summary.vendors,
    by_outcome: summary.byOutcome,
    rows_written: summary.rowsWritten,
    changed: summary.changed,
    candidates: summary.candidates,
    quarantined: summary.quarantined,
    fetches: summary.fetches,
    held: summary.held,
    errors: summary.errors,
  };
  await repo.finishRun(run.id, { finished_at: new Date().toISOString(), status: summary.errors.length ? "error" : "committed", metrics });
  return summary;
}
