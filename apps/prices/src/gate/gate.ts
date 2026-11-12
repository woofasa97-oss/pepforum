/**
 * THE RUN GATE — judges what one refresh run wrote, against the last run that passed.
 *
 * Two classes of check, and the split is what acceptance hangs on:
 *   corpus    partial_failure, vendor_zero — "did this run lose ground?", need a baseline
 *   absolute  outliers, structural, low_confidence, driver_errors — per-row / per-run, need none
 *
 * Outliers and structural failures are QUARANTINED regardless of the verdict (a lossless move,
 * restorable by run): users are protected immediately, and the verdict only decides whether the
 * run may become a baseline and license the stale prune. A check with nothing to compare against
 * is UNMEASURED and does not pass — a vacuous pass is the fail-open this gate exists to close.
 *
 * Ported from PeptideBase's price-gate.mjs / price-gate-shared.mjs.
 */
import type { OfferRow, Repo, RunRow } from "../ingest/repo.ts";
import { buildProductIndex, resolveProduct } from "../units/blend-match.ts";
import { OBSERVE_ONLY_REASONS, blendVialReason, buildCompoundRefs, classifyOfferRow, median, refKey, type StructuralReason } from "./plausibility.ts";

export const THRESHOLDS = {
  PARTIAL_FAILURE_MIN_RATIO: 0.7, // HOLD if this run's rows < 70% of the baseline's
  VENDOR_ZERO_MAX_RATIO: 0.2, // HOLD if > 20% of the baseline's vendors wrote nothing
  OUTLIER_K: 10, // outlier if per-mg outside [median / K, median × K] within a compound and currency
  OUTLIER_MAX_RATIO: 0.05, // HOLD if > 5% of priced rows are outliers
  LOW_CONF_MAX_RATIO: 0.4, // HOLD if > 40% of the run's rows are low-confidence
  DRIVER_ERROR_MAX_RATIO: 0.05, // HOLD if > 5% of the run's vendors ended in a driver error
} as const;

export const CORPUS_CHECKS = ["partial_failure", "vendor_zero"] as const;
export const ABSOLUTE_CHECKS = ["outliers", "structural", "low_confidence", "driver_errors"] as const;
export type CheckName = (typeof CORPUS_CHECKS)[number] | (typeof ABSOLUTE_CHECKS)[number];

export interface GateCheck {
  pass: boolean;
  /** False when the check had nothing to compare against. Unmeasured never reads as passed. */
  measured: boolean;
  detail: string;
  samples: unknown[];
}
export type GateChecks = Record<CheckName, GateCheck>;

export interface GateMetrics {
  rows_run: number;
  vendors_run: number;
  rows_by_vendor: Record<string, number>;
  rows_baseline: number | null;
  vendors_baseline: number | null;
  vendors_zero: number | null;
  outlier_ratio: number;
  outlier_population: number;
  low_conf_ratio: number;
  structural_by_reason: Partial<Record<StructuralReason, number>>;
  structural_observed_only: number;
  /** Rows an earlier run left behind that the matcher no longer files under their compound. */
  stale_identity: number;
  driver_errors: number;
  baseline: { kind: BaselineResult["kind"]; run_id: string | null; finished_at: string | null };
  evaluated_at: string;
}

export interface GateResult {
  runId: string;
  runLabel: string;
  verdict: "pass" | "hold";
  /** True when the hold is "nothing to compare against", not "measured and failed". */
  noBaseline: boolean;
  baseline: { kind: BaselineResult["kind"]; runId: string | null };
  checks: GateChecks;
  quarantined: Record<string, number>;
  metrics: GateMetrics;
}

/** The gate was asked to judge something it cannot judge. Nothing was written. */
export class GateRefusal extends Error {}

const NO_BASELINE_DETAIL = "NO BASELINE — UNMEASURED, not passed (nothing to compare against)";

// ── baseline ─────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const asObject = (v: unknown): Json => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const gateMetricsOf = (run: RunRow): Json => asObject(asObject(run.metrics).gate);

/** The vendor slugs a run was restricted to, or null for a full run. */
export function vendorScopeOf(run: RunRow): string[] | null {
  const scope = asObject(run.metrics).vendor_scope;
  return Array.isArray(scope) && scope.length > 0 ? scope.filter((s): s is string => typeof s === "string") : null;
}

export type BaselineResult =
  | { kind: "ok"; run: RunRow }
  | { kind: "scoped_only"; shadow: RunRow }
  | { kind: "no_passing_run"; shadow: RunRow }
  | { kind: "no_committed_run" };

/**
 * The ONE place that decides what a run is measured against: the newest committed, live,
 * same-mode run the gate PASSED and that covered the whole corpus. `status = committed` alone is
 * not enough — an ingest commits before it is ever gated — and absence is not one state: each
 * cause gets its own kind so the log can never report one while another is true.
 */
export function selectBaseline(runs: readonly RunRow[], current: { id: string; mode: string }): BaselineResult {
  const candidates = runs
    .filter((r) => r.id !== current.id && r.mode === current.mode && r.status === "committed" && !r.dry_run)
    .sort((a, b) => String(b.finished_at ?? "").localeCompare(String(a.finished_at ?? "")));
  const passing = candidates.filter((r) => r.verdict === "pass");
  const unscoped = passing.find((r) => vendorScopeOf(r) === null);
  if (unscoped) return { kind: "ok", run: unscoped };
  if (passing.length > 0) return { kind: "scoped_only", shadow: passing[0] };
  if (candidates.length > 0) return { kind: "no_passing_run", shadow: candidates[0] };
  return { kind: "no_committed_run" };
}

/** One line per kind, kept beside selectBaseline so a new kind cannot be added without a message. */
export function describeBaseline(result: BaselineResult): string {
  switch (result.kind) {
    case "ok":
      return `baseline = committed PASS run ${result.run.run_label} (finished ${result.run.finished_at}).`;
    case "scoped_only":
      return `no full-corpus PASS run to measure against: the newest passing run (${result.shadow.run_label}) covered only some vendors and is deliberately skipped.`;
    case "no_passing_run":
      return `no passing run to measure against: the newest committed run (${result.shadow.run_label}) has verdict=${JSON.stringify(result.shadow.verdict)}.`;
    case "no_committed_run":
      return "no committed run at all — this is a first run and has nothing to measure against.";
  }
}

// ── the gate ─────────────────────────────────────────────────────────────────

const countBy = <T>(items: readonly T[], key: (item: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
};

export async function runGate(repo: Repo, runId: string, opts: { now?: Date } = {}): Promise<GateResult> {
  const now = opts.now ?? new Date();
  const run = await repo.getRun(runId);
  if (!run) throw new GateRefusal(`run ${runId} not found — nothing to gate.`);
  if (run.dry_run) throw new GateRefusal(`run ${run.run_label} was a dry run: it wrote nothing, so there is nothing to gate.`);
  if (run.status === "running") throw new GateRefusal(`run ${run.run_label} is still running — gate it once the refresh has finished.`);
  if (run.mode !== "feeds" && run.mode !== "pages") throw new GateRefusal(`run ${run.run_label} is a ${run.mode} run, not a price refresh.`);
  // The first evaluation already moved this run's outliers and structural failures to quarantine,
  // so a second one would measure a cleaned population and pass by construction.
  if (run.verdict !== null) throw new GateRefusal(`run ${run.run_label} was already gated (verdict=${run.verdict}); a run is judged once. The next refresh is judged afresh.`);

  const corpus = await repo.listAllOffers();
  const runRows = corpus.filter((o) => o.run_id === runId);
  const rowsByVendor = countBy(runRows, (o) => o.vendor_id);
  const lowConf = runRows.filter((o) => o.extraction_confidence === "low").length;
  const ingestMetrics = asObject(run.metrics);
  const driverErrors = Array.isArray(ingestMetrics.errors) ? ingestMetrics.errors.length : 0;
  // One vendor's transient failure (a dropped connection) is that vendor's bad day: its rows are
  // simply not refreshed. A SHARE of vendors failing is the run's. With no vendor count recorded
  // the share cannot be measured, and then any error holds.
  const runVendors = typeof ingestMetrics.vendors === "number" && ingestMetrics.vendors > 0 ? ingestMetrics.vendors : null;
  const driverErrorRatio = driverErrors === 0 ? 0 : runVendors === null ? 1 : driverErrors / runVendors;

  // Baseline, sliced to this run's own vendors when the run was scoped.
  const baseline = selectBaseline(await repo.listCommittedRuns(), { id: runId, mode: run.mode });
  let priorByVendor: Record<string, number> | null = null;
  if (baseline.kind === "ok") {
    const recorded = asObject(gateMetricsOf(baseline.run).rows_by_vendor);
    const scopeIds = vendorScopeOf(run) ? (Array.isArray(ingestMetrics.vendor_ids) ? new Set(ingestMetrics.vendor_ids as unknown[]) : new Set<unknown>()) : null;
    priorByVendor = {};
    for (const [vendorId, n] of Object.entries(recorded)) {
      if (Number(n) > 0 && (scopeIds === null || scopeIds.has(vendorId))) priorByVendor[vendorId] = Number(n);
    }
  }
  const rowsBaseline = priorByVendor ? Object.values(priorByVendor).reduce((a, b) => a + b, 0) : null;
  const baselineVendors = priorByVendor ? Object.keys(priorByVendor) : null;
  const unmeasured: GateCheck = { pass: false, measured: false, detail: NO_BASELINE_DETAIL, samples: [] };

  // ── corpus checks ──
  let partialFailure = unmeasured;
  if (rowsBaseline !== null && rowsBaseline > 0) {
    const ratio = runRows.length / rowsBaseline;
    partialFailure = {
      pass: ratio >= THRESHOLDS.PARTIAL_FAILURE_MIN_RATIO,
      measured: true,
      detail: `rows_run=${runRows.length} vs baseline=${rowsBaseline} (ratio=${ratio.toFixed(2)}, floor=${THRESHOLDS.PARTIAL_FAILURE_MIN_RATIO})`,
      samples: [],
    };
  }
  let vendorZero = unmeasured;
  let vendorsZero: number | null = null;
  if (baselineVendors !== null && baselineVendors.length > 0) {
    // A store an admin has marked unreadable (it refuses our reader) is a known gap, not news: it
    // is left out of both sides of this check, so a growing list of such stores cannot hold every
    // run for the vendors that do answer. Its last checked prices age into "stale" on their own.
    const unreadable = new Set((await repo.listVendors({ status: "all" })).filter((v) => v.unreadable).map((v) => v.id));
    const expected = baselineVendors.filter((v) => !unreadable.has(v));
    const missing = expected.filter((v) => !(rowsByVendor[v] > 0)).sort();
    vendorsZero = missing.length;
    const ratio = expected.length === 0 ? 0 : missing.length / expected.length;
    vendorZero = {
      pass: ratio <= THRESHOLDS.VENDOR_ZERO_MAX_RATIO,
      measured: true,
      detail: `${missing.length}/${expected.length} baseline vendors wrote 0 rows (ratio=${ratio.toFixed(2)}, max=${THRESHOLDS.VENDOR_ZERO_MAX_RATIO}; ${baselineVendors.length - expected.length} marked unreadable left out)`,
      samples: missing.slice(0, 10),
    };
  }

  // ── absolute checks ──
  // REFERENCE population: every live comparable single-vial row with a per-mg. SUBJECT population: this run's rows.
  const priced = (o: OfferRow) => o.comparable && Number(o.per_mg_minor_e4) > 0;
  // The market reference is the SINGLE-VIAL market. Kits are judged against it (within the ÷K band)
  // but never set it: a dozen wholesale kits must not make an ordinary vial look overpriced.
  const singleVialRefs = buildCompoundRefs(corpus.filter((o) => priced(o) && !(Number(o.vials_per_pack) > 1)));
  // Where a compound has NO single-vial row in a currency (CAD kits, mostly), its kits would be
  // judged against nothing at all. They are judged against each other instead.
  const anyRowRefs = buildCompoundRefs(corpus.filter(priced));
  const refs = { get: (key: string) => singleVialRefs.get(key) ?? anyRowRefs.get(key) };
  const [vendors, compounds] = await Promise.all([repo.listVendors({ status: "all" }), repo.listCompounds()]);
  const websiteByVendor = new Map(vendors.map((v) => [v.id, v.website_url]));
  const products = buildProductIndex(compounds.map((c) => ({ id: c.id, name: c.name, slug: c.slug, aliases: c.aliases, type: c.type, blend_components: c.blend_components as { slug: string }[] | null })));
  // Per-vial reference for blend vials over the whole live corpus: compound + currency + the exact
  // mix, or the stated total when the mix is not stated.
  const mixKey = (o: OfferRow) => `${o.compound_id}|${o.native_currency}|${o.recipe_key ?? `total:${o.mg_per_vial === null ? "none" : Number(o.mg_per_vial)}`}`;
  // Only rows filed under a blend compound: the blend flag alone also marks rows under single compounds.
  const blendIds = new Set(compounds.filter((c) => c.type === "Blend").map((c) => c.id));
  const perVialByMix = new Map<string, number[]>();
  for (const o of corpus) {
    if (!blendIds.has(o.compound_id) || !o.is_blend || o.form !== "vial" || !(Number(o.vials_per_pack) >= 1)) continue;
    perVialByMix.set(mixKey(o), [...(perVialByMix.get(mixKey(o)) ?? []), Number(o.price_minor) / Number(o.vials_per_pack)]);
  }

  const reasonById = new Map<string, string>();
  const outlierSamples: unknown[] = [];
  const structuralSamples: unknown[] = [];
  const structuralByReason: Partial<Record<StructuralReason, number>> = {};
  let outliers = 0;
  let observedOnly = 0;
  const eligible = runRows.filter(priced);
  for (const o of runRows) {
    const ref = refs.get(refKey(o));
    if (priced(o) && ref?.medianPerMg) {
      const v = Number(o.per_mg_minor_e4);
      if (v < ref.medianPerMg / THRESHOLDS.OUTLIER_K || v > ref.medianPerMg * THRESHOLDS.OUTLIER_K) {
        outliers++;
        reasonById.set(o.id, "outlier");
        if (outlierSamples.length < 10) outlierSamples.push({ id: o.id, compound_id: o.compound_id, currency: o.native_currency, per_mg_minor_e4: v, median: ref.medianPerMg });
      }
    }
    const reason = classifyOfferRow(o, { ...ref, vendorWebsiteUrl: websiteByVendor.get(o.vendor_id) ?? null, matchedCompoundId: resolveProduct({ name: o.product_name, variantLabel: o.variant_label }, products) });
    const mixRows = blendIds.has(o.compound_id) ? (perVialByMix.get(mixKey(o)) ?? []) : [];
    const structural = reason ?? blendVialReason(o, median(mixRows), mixRows.length);
    if (structural === null) continue;
    structuralByReason[structural] = (structuralByReason[structural] ?? 0) + 1;
    if (structuralSamples.length < 10) structuralSamples.push({ id: o.id, compound_id: o.compound_id, reason: structural });
    if (OBSERVE_ONLY_REASONS.has(structural)) observedOnly++;
    // A structural verdict is the more specific audit trail, so it names the row when both apply.
    else reasonById.set(o.id, `structural_${structural}`);
  }
  // Rows an EARLIER run left behind are reference, not subject — with one exception. Identity has
  // one owner, the matcher, and it is a fact about the stored text: a row it no longer files under
  // its compound is wrong whichever run wrote it. Such a product is usually still in the feed and
  // now matches nothing, so no later run rewrites the row and the two-read delisting rule never
  // sees it as absent in time. (Data audit, 2026-10-02: a blend filed under one ingredient.)
  let staleIdentity = 0;
  for (const o of corpus) {
    if (o.run_id === runId) continue;
    if (resolveProduct({ name: o.product_name, variantLabel: o.variant_label }, products) === o.compound_id) continue;
    staleIdentity++;
    reasonById.set(o.id, "structural_compound_not_corroborated");
  }
  const outlierRatio = eligible.length ? outliers / eligible.length : 0;
  const lowRatio = runRows.length ? lowConf / runRows.length : 0;
  const structuralTotal = Object.values(structuralByReason).reduce((a, b) => a + (b ?? 0), 0);

  const checks: GateChecks = {
    partial_failure: partialFailure,
    vendor_zero: vendorZero,
    outliers: {
      pass: outlierRatio <= THRESHOLDS.OUTLIER_MAX_RATIO,
      measured: true,
      detail: `${outliers}/${eligible.length} priced rows outside [median/${THRESHOLDS.OUTLIER_K}, median×${THRESHOLDS.OUTLIER_K}] (ratio=${outlierRatio.toFixed(3)}, max=${THRESHOLDS.OUTLIER_MAX_RATIO}); rows quarantined regardless`,
      samples: outlierSamples,
    },
    structural: {
      pass: true, // report-and-quarantine, never HOLD: a deterministic per-row verdict is not a run-health signal
      measured: true,
      detail: `${structuralTotal}/${runRows.length} rows failed structural checks ${JSON.stringify(structuralByReason)}; ${observedOnly} observe-only, the rest quarantined regardless; ${staleIdentity} rows of earlier runs no longer match their compound and are quarantined too`,
      samples: structuralSamples,
    },
    low_confidence: {
      pass: lowRatio <= THRESHOLDS.LOW_CONF_MAX_RATIO,
      measured: true,
      detail: `${lowConf}/${runRows.length} rows low-confidence (ratio=${lowRatio.toFixed(2)}, max=${THRESHOLDS.LOW_CONF_MAX_RATIO})`,
      samples: [],
    },
    driver_errors: {
      pass: driverErrorRatio <= THRESHOLDS.DRIVER_ERROR_MAX_RATIO,
      measured: true,
      detail: `${driverErrors}/${runVendors ?? "?"} vendors ended in a driver error during the refresh (ratio=${driverErrorRatio.toFixed(3)}, max=${THRESHOLDS.DRIVER_ERROR_MAX_RATIO})`,
      samples: Array.isArray(ingestMetrics.errors) ? ingestMetrics.errors.slice(0, 10) : [],
    },
  };

  // HELD FIRST. The moves below change the population a second evaluation would see, so a gate
  // that dies between here and its verdict must leave a hold — never a blank a re-run could
  // turn into a pass. (A hold without recorded checks cannot be accepted as a baseline either.)
  await repo.finishRun(runId, { status: "held", verdict: "hold", notes: `gate started ${now.toISOString()}` });

  // ── quarantine: one call per REAL reason, always ──
  const idsByReason = new Map<string, string[]>();
  for (const [id, reason] of reasonById) idsByReason.set(reason, [...(idsByReason.get(reason) ?? []), id]);
  const quarantined: Record<string, number> = {};
  for (const [reason, ids] of idsByReason) quarantined[reason] = await repo.quarantine(ids, reason, runId);

  const noBaseline = baseline.kind !== "ok";
  const verdict = Object.values(checks).every((c) => c.pass) ? "pass" : "hold";
  const metrics: GateMetrics = {
    rows_run: runRows.length,
    vendors_run: Object.keys(rowsByVendor).length,
    rows_by_vendor: rowsByVendor,
    rows_baseline: rowsBaseline,
    vendors_baseline: baselineVendors?.length ?? null,
    vendors_zero: vendorsZero,
    outlier_ratio: outlierRatio,
    outlier_population: eligible.length,
    low_conf_ratio: lowRatio,
    structural_by_reason: structuralByReason,
    structural_observed_only: observedOnly,
    stale_identity: staleIdentity,
    driver_errors: driverErrors,
    baseline: { kind: baseline.kind, run_id: baseline.kind === "ok" ? baseline.run.id : null, finished_at: baseline.kind === "ok" ? baseline.run.finished_at : null },
    evaluated_at: now.toISOString(),
  };

  await repo.finishRun(runId, {
    status: verdict === "pass" ? "committed" : "held",
    verdict,
    baseline_run_id: baseline.kind === "ok" ? baseline.run.id : null,
    checks: checks as unknown as RunRow["checks"],
    metrics: { ...ingestMetrics, gate: { ...metrics, quarantined, baseline_note: describeBaseline(baseline) } } as unknown as RunRow["metrics"],
    notes: `gated ${now.toISOString()}`,
  });

  return { runId, runLabel: run.run_label, verdict, noBaseline, baseline: { kind: baseline.kind, runId: baseline.kind === "ok" ? baseline.run.id : null }, checks, quarantined, metrics };
}

// ── accept-baseline ──────────────────────────────────────────────────────────

/**
 * The sanctioned exit from "no baseline": an ATTRIBUTED acceptance of an already-evaluated HELD
 * run. Fail-closed — approver and reason are mandatory and persisted; the ABSOLUTE checks must
 * have passed in the stored evaluation (missing is a refusal, not a waiver); the CORPUS checks are
 * waived BY NAME with their recorded state; and only a full, live, held run is acceptable.
 */
export function evaluateBaselineAcceptance(run: RunRow | null, opts: { approver?: string; reason?: string; now?: Date }): { refusal: string } | { update: { verdict: "pass"; status: "committed"; notes: string } } {
  const approver = opts.approver?.trim();
  const reason = opts.reason?.trim();
  if (!approver || !reason) return { refusal: "--accept-baseline requires --approver <name> and --reason <why this held run is safe to measure against>. Nothing was read or written." };
  if (!run) return { refusal: "run not found — nothing to accept." };
  if (run.status !== "held" || run.verdict !== "hold") {
    return { refusal: `only a HELD run can be accepted as baseline; this run is status=${run.status ?? "?"} verdict=${run.verdict ?? "?"}. A committed run needs no acceptance; a running or errored run has no evaluation to accept.` };
  }
  if (run.dry_run) return { refusal: "this was a dry run: it wrote nothing and cannot be a baseline." };
  const scope = vendorScopeOf(run);
  if (scope) return { refusal: `run is SCOPED to vendors [${scope.join(", ")}] — a slice must never become the corpus baseline.` };

  const checks = asObject(run.checks) as Partial<Record<CheckName, GateCheck>>;
  const missing = ABSOLUTE_CHECKS.filter((n) => !checks[n]);
  if (missing.length > 0) {
    return { refusal: `stored evaluation is missing absolute check(s): ${missing.join(", ")}. A check absent from the record is UNMEASURED, and unmeasured must not read as passed. This run cannot be accepted; gate the next refresh.` };
  }
  const failed = ABSOLUTE_CHECKS.filter((n) => !checks[n]?.pass);
  if (failed.length > 0) {
    return { refusal: `absolute check(s) FAILED in the stored evaluation: ${failed.map((n) => `${n} (${checks[n]?.detail ?? "no detail"})`).join("; ")}. Acceptance may waive the comparison with a baseline, never a data-quality failure — fix the cause and accept a later run.` };
  }
  return {
    update: {
      verdict: "pass",
      status: "committed",
      notes: JSON.stringify({
        accepted_baseline: true,
        approver,
        reason,
        accepted_at: (opts.now ?? new Date()).toISOString(),
        prior: { status: run.status, verdict: run.verdict },
        waived_checks: CORPUS_CHECKS.map((name) => {
          const c = checks[name];
          return { name, recorded: c ? { pass: c.pass, measured: c.measured, detail: c.detail } : "ABSENT_FROM_RECORD" };
        }),
        absolute_checks_passed: ABSOLUTE_CHECKS.map((name) => ({ name, detail: checks[name]?.detail })),
      }),
    },
  };
}

/** Applies an acceptance. Touches the run row and NOTHING else — no quarantine, no prune, no offer. */
export async function acceptBaseline(repo: Repo, runId: string, opts: { approver?: string; reason?: string; now?: Date }): Promise<{ ok: true } | { ok: false; refusal: string }> {
  const approver = opts.approver?.trim();
  const reason = opts.reason?.trim();
  // Attribution is checked before any read, so a refusal provably touched nothing.
  const run = approver && reason ? await repo.getRun(runId) : null;
  const decision = evaluateBaselineAcceptance(run, opts);
  if ("refusal" in decision) return { ok: false, refusal: decision.refusal };
  await repo.finishRun(runId, decision.update);
  return { ok: true };
}
