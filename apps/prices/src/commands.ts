/**
 * The pipeline's commands, behind `pnpm pipeline <command>`. Every command prints ONE JSON summary
 * on stdout and returns an exit code; logs go to stderr. Dependencies are injected so the whole
 * surface — argument refusals, the live-run guard, exit codes — is tested without a database or
 * a network.
 *
 * Exit codes: 0 ok / gate PASS · 10 gate HOLD (a measured failure) · 11 gate HOLD only because
 * there is no baseline yet · 2 refused (bad arguments, missing environment, a failed instrument
 * check, a run that may not be gated, pruned or published) · 1 error.
 */
import type { FetchText } from "./fetch/types.ts";
import { fetchFxRates, upsertFxRates, type FetchJson } from "./fx/fx.ts";
import { findCoaLinks, matchCompoundSlug } from "./coa/scan.ts";
import { captureObjectKey, gunzipCapture, parseCapture } from "./fetch/raw-capture.ts";
import { CORPUS_CHECKS, GateRefusal, THRESHOLDS, acceptBaseline, runGate } from "./gate/gate.ts";
import { pruneStale } from "./gate/prune.ts";
import type { Repo, VendorRow, VendorStatusFilter } from "./ingest/repo.ts";
import { runRefresh, type RunMode } from "./ingest/run.ts";
import type { Platform } from "./ladder/types.ts";
import { assessNetworkHealth, listRegressions, probeVendors, runControls, shouldWritePlatform, type Sleep } from "./probe/probe.ts";
import { publishRun } from "./publish/publish.ts";
import { applySeeds } from "./seed/apply-seeds.ts";
import type { CompoundSeed, VendorSeed } from "./seed/types.ts";

export const EXIT = { ok: 0, error: 1, refused: 2, hold: 10, holdNoBaseline: 11 } as const;

/**
 * The probe's instrument check: a vendor known to be an open WooCommerce store, and one known to be
 * an open Shopify store. No seeded Canadian vendor is a confirmed Shopify store yet, so that control
 * is off by default; name one with --control-shopify once there is one.
 */
export const DEFAULT_CONTROLS: { woo: string; shopify: string | null } = { woo: "maple-research-labs", shopify: null };

const COMMANDS = {
  seed: { bool: [], value: [] },
  probe: { bool: ["apply"], value: ["vendors", "control-woo", "control-shopify"] },
  refresh: { bool: ["dry-run", "live", "accept-drop"], value: ["mode", "vendors", "label", "status"] },
  gate: { bool: ["accept-baseline"], value: ["run", "approver", "reason"] },
  prune: { bool: ["dry-run", "live"], value: ["run"] },
  publish: { bool: ["dry-run", "live"], value: ["run"] },
  fx: { bool: [], value: ["date"] },
  captures: { bool: [], value: ["run"] },
  "coa-scan": { bool: ["dry-run", "live"], value: ["run"] },
} as const satisfies Record<string, { bool: readonly string[]; value: readonly string[] }>;
type Command = keyof typeof COMMANDS;
type Flags = Record<string, string | true>;

export interface ParsedArgs {
  command: string | null;
  flags: Flags;
  errors: string[];
}

/** `<command> [--flag value | --flag=value | --switch]…`. Stops at the first thing it does not understand. */
export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command) return { command: null, flags: {}, errors: ["no command given"] };
  if (!(command in COMMANDS)) return { command, flags: {}, errors: [`unknown command ${command}`] };
  const spec: { bool: readonly string[]; value: readonly string[] } = COMMANDS[command as Command];
  const flags: Flags = {};
  const fail = (error: string): ParsedArgs => ({ command, flags, errors: [error] });
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) return fail(`unexpected argument ${arg}`);
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (spec.bool.includes(name)) {
      if (eq !== -1) return fail(`--${name} takes no value`);
      flags[name] = true;
    } else if (spec.value.includes(name)) {
      if (eq !== -1) flags[name] = arg.slice(eq + 1);
      else if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) flags[name] = rest[++i];
      else return fail(`--${name} needs a value`);
    } else {
      return fail(`unknown flag --${name} for ${command}`);
    }
  }
  return { command, flags, errors: [] };
}

export interface CliDeps {
  /** Opens the database boundary. Throws when the environment is incomplete — a refusal. */
  openRepo(): Repo;
  /** Test override. Absent in production: the probe builds the honest fetcher, a refresh one capturing fetcher per vendor. */
  fetchText?: () => FetchText;
  /** A keyed vendor's Authorization header for its own site, for a refresh's fetchers (pipeline/env.ts). */
  authorization?: (url: URL) => string | null;
  fetchJson: FetchJson;
  isTTY: boolean;
  env: Record<string, string | undefined>;
  out(summary: Record<string, unknown>): void;
  log(event: string, fields?: Record<string, unknown>): void;
  seeds: { compounds: CompoundSeed[]; vendors: VendorSeed[] };
  /** Where a refresh keeps its raw captures locally. */
  captureDir?: string;
  /** The local capture files of one run, by vendor slug. */
  readCaptures?: (runLabel: string) => { slug: string; bytes: Buffer }[];
  sleep?: Sleep;
}

/** A condition the command will not run under. Exit 2; by construction nothing was written. */
class Refusal extends Error {}

const text = (flags: Flags, name: string): string | undefined => (typeof flags[name] === "string" && flags[name] !== "" ? (flags[name] as string) : undefined);
const slugList = (flags: Flags, name: string): string[] | undefined => {
  const slugs = text(flags, name)?.split(",").map((s) => s.trim()).filter(Boolean);
  return slugs && slugs.length > 0 ? slugs : undefined;
};
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runCommand(argv: string[], deps: CliDeps): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.errors.length > 0 || parsed.command === null) {
    deps.log("refused", { errors: parsed.errors, commands: Object.keys(COMMANDS) });
    return EXIT.refused;
  }
  const command = parsed.command as Command;
  let repo: Repo | null = null;
  try {
    // Argument-only refusals come before the database is opened, so they provably read nothing.
    const plan = HANDLERS[command](parsed.flags, deps);
    try {
      repo = deps.openRepo();
    } catch (err) {
      throw new Refusal(message(err));
    }
    return await plan(repo);
  } catch (err) {
    if (err instanceof Refusal || err instanceof GateRefusal) {
      deps.log("refused", { command, reason: err.message });
      return EXIT.refused;
    }
    deps.log("error", { command, error: message(err) });
    return EXIT.error;
  } finally {
    await repo?.close();
  }
}

type Handler = (flags: Flags, deps: CliDeps) => (repo: Repo) => Promise<number>;

async function requireVendors(repo: Repo, slugs: string[] | undefined, status: VendorStatusFilter): Promise<VendorRow[]> {
  const rows = await repo.listVendors({ status, slugs });
  const missing = (slugs ?? []).filter((s) => !rows.some((v) => v.slug === s));
  if (missing.length > 0) throw new Refusal(`unknown vendor slug(s), or not ${status}: ${missing.join(", ")}`);
  return rows;
}

async function requireRun(repo: Repo, label: string) {
  const run = await repo.getRunByLabel(label);
  if (!run) throw new Refusal(`no run labelled ${label}`);
  return run;
}

const seed: Handler = (_flags, deps) => async (repo) => {
  const result = await applySeeds(repo, deps.seeds);
  deps.out({ command: "seed", ...result });
  return EXIT.ok;
};

const refresh: Handler = (flags, deps) => {
  const mode = text(flags, "mode");
  if (mode !== "feeds" && mode !== "pages") throw new Refusal("refresh needs --mode feeds|pages");
  if (flags.live && flags["dry-run"]) throw new Refusal("--live and --dry-run contradict each other");
  const dryRun = !flags.live;
  // A live run from a non-interactive shell needs the explicit opt-in: a workflow that forgot the flag must not write.
  if (!dryRun && !deps.isTTY && deps.env.PIPELINE_ALLOW_LIVE !== "1") throw new Refusal("--live from a non-interactive shell requires PIPELINE_ALLOW_LIVE=1");
  const vendors = slugList(flags, "vendors");
  // Releasing a SKU-drop hold is a decision about named vendors, and only a live run can make it.
  const acceptDrop = flags["accept-drop"] === true;
  if (acceptDrop && (!vendors || dryRun)) throw new Refusal("--accept-drop accepts a smaller catalogue for the vendors you name: it needs --vendors and --live");
  const statusFlag = text(flags, "status");
  if (statusFlag !== undefined && statusFlag !== "active" && statusFlag !== "pending" && statusFlag !== "all") throw new Refusal("--status must be active, pending or all");
  // A dry run may look at any named vendor; a live run writes only for active ones unless told otherwise.
  const status: VendorStatusFilter = statusFlag ?? (vendors && dryRun ? "all" : "active");

  return async (repo) => {
    await requireVendors(repo, vendors, status);
    const summary = await runRefresh({ repo, mode: mode as RunMode, dryRun, vendors, status, runLabel: text(flags, "label"), fetchText: deps.fetchText?.(), authorization: deps.authorization, captureDir: deps.captureDir, acceptSkuDrop: acceptDrop, sleep: deps.sleep, onVendor: (r) => deps.log("vendor", { slug: r.slug, outcome: r.outcome, rows: r.rowsWritten, candidates: r.candidates, error: r.error }) });
    deps.out({
      command: "refresh",
      run_label: summary.runLabel,
      run_id: summary.runId,
      mode: summary.mode,
      dry_run: summary.dryRun,
      vendors: summary.vendors,
      by_outcome: summary.byOutcome,
      [summary.dryRun ? "rows_would_write" : "rows_written"]: summary.rowsWritten,
      changed: summary.changed,
      candidates: summary.candidates,
      quarantined: summary.quarantined,
      fetches: summary.fetches,
      held: summary.held,
      ...(acceptDrop ? { accepted_drop: true } : {}),
      driver_errors: summary.errors.length,
      errors: summary.errors,
    });
    // One vendor's transient failure does not fail the command: the gate judges the run by the
    // same share. Above it, the refresh itself is the problem.
    return summary.vendors > 0 && summary.errors.length / summary.vendors > THRESHOLDS.DRIVER_ERROR_MAX_RATIO ? EXIT.error : EXIT.ok;
  };
};

/**
 * Upload a finished run's local raw captures to the private bucket and point each attempt at its
 * file. Its own command so the step that holds the service-role key runs no vendor-facing code.
 */
const captures: Handler = (flags, deps) => {
  const label = text(flags, "run");
  if (!label) throw new Refusal("captures needs --run <label>");
  return async (repo) => {
    const run = await requireRun(repo, label);
    const files = deps.readCaptures?.(label) ?? [];
    if (files.length === 0) throw new Refusal(`no local captures for run ${label}`);
    const failed: { slug: string; error: string }[] = [];
    let uploaded = 0;
    for (const file of files) {
      const out = await repo.uploadCapture(captureObjectKey(label, file.slug), file.bytes);
      if (!out.uri) {
        failed.push({ slug: file.slug, error: out.error ?? "upload failed" });
        continue;
      }
      await repo.setCaptureUri(run.id, file.slug, out.uri);
      uploaded++;
    }
    deps.out({ command: "captures", run_label: label, run_id: run.id, files: files.length, uploaded, failed });
    return failed.length > 0 ? EXIT.error : EXIT.ok;
  };
};

/**
 * Files the links in a run's raw captures that look like certificates of analysis as CANDIDATES
 * for an admin to open and check (/admin/prices). It reads nothing new from any vendor, never reads
 * a figure out of a document, and cannot publish: the database function it calls only ever inserts
 * a candidate.
 */
const coaScan: Handler = (flags, deps) => {
  const label = text(flags, "run");
  if (!label) throw new Refusal("coa-scan needs --run <label>");
  if (flags.live && flags["dry-run"]) throw new Refusal("--live and --dry-run contradict each other");
  const dryRun = !flags.live;
  return async (repo) => {
    await requireRun(repo, label);
    const files = deps.readCaptures?.(label) ?? [];
    if (files.length === 0) throw new Refusal(`no local captures for run ${label}`);
    const [vendors, compounds] = await Promise.all([repo.listVendors({ status: "all" }), repo.listCompounds()]);
    const slugs = compounds.map((c) => c.slug);
    const perVendor: { slug: string; found: number; filed: number }[] = [];
    let found = 0;
    let filed = 0;
    for (const file of files) {
      const vendor = vendors.find((v) => v.slug === file.slug);
      if (!vendor) continue;
      const links = new Set<string>();
      for (const record of parseCapture(gunzipCapture(file.bytes)).records) {
        if (record.body) for (const link of findCoaLinks(record.body, record.url)) links.add(link);
      }
      let vendorFiled = 0;
      for (const url of links) {
        if (dryRun) continue;
        const compound = compounds.find((c) => c.slug === matchCompoundSlug(url, slugs));
        if (await repo.fileCoaCandidate(vendor.id, compound?.id ?? null, url)) vendorFiled++;
      }
      found += links.size;
      filed += vendorFiled;
      if (links.size > 0) perVendor.push({ slug: vendor.slug, found: links.size, filed: vendorFiled });
    }
    deps.out({ command: "coa-scan", run_label: label, dry_run: dryRun, vendors: files.length, found, filed, by_vendor: perVendor });
    return EXIT.ok;
  };
};

const gate: Handler = (flags, deps) => {
  const label = text(flags, "run");
  if (!label) throw new Refusal("gate needs --run <label>");
  const accept = flags["accept-baseline"] === true;
  const approver = text(flags, "approver");
  const reason = text(flags, "reason");
  if (!accept && (approver !== undefined || reason !== undefined)) throw new Refusal("--approver and --reason belong to --accept-baseline");
  if (accept && (!approver || !reason)) throw new Refusal("--accept-baseline requires --approver <name> and --reason <why this held run is safe to measure against>");

  return async (repo) => {
    const run = await requireRun(repo, label);
    if (accept) {
      const accepted = await acceptBaseline(repo, run.id, { approver, reason });
      if (!accepted.ok) throw new Refusal(accepted.refusal);
      deps.out({ command: "gate", run_label: label, run_id: run.id, accepted_baseline: true, approver, reason });
      return EXIT.ok;
    }
    const result = await runGate(repo, run.id);
    deps.out({ command: "gate", run_label: label, run_id: run.id, verdict: result.verdict, no_baseline: result.noBaseline, baseline: result.baseline, checks: result.checks, quarantined: result.quarantined, metrics: result.metrics });
    if (result.verdict === "pass") return EXIT.ok;
    // 11 only when the sole failures are the unmeasured corpus checks — the case --accept-baseline exists for.
    const measuredFailure = Object.entries(result.checks).some(([name, c]) => !c.pass && !((CORPUS_CHECKS as readonly string[]).includes(name) && !c.measured));
    return measuredFailure ? EXIT.hold : EXIT.holdNoBaseline;
  };
};

const prune: Handler = (flags, deps) => {
  const label = text(flags, "run");
  if (!label) throw new Refusal("prune needs --run <label>");
  if (flags.live && flags["dry-run"]) throw new Refusal("--live and --dry-run contradict each other");
  const dryRun = !flags.live;

  return async (repo) => {
    const run = await requireRun(repo, label);
    const result = await pruneStale(repo, run.id, { dryRun });
    if (!result.ok) throw new Refusal(result.refusal);
    deps.out({ command: "prune", run_label: label, run_id: run.id, dry_run: result.dryRun, days: result.days, [result.dryRun ? "would_prune" : "pruned"]: result.pruned });
    return EXIT.ok;
  };
};

/** Copy a passed run's checked rows to the table the site reads. A dry run only counts them. */
const publish: Handler = (flags, deps) => {
  const label = text(flags, "run");
  if (!label) throw new Refusal("publish needs --run <label>");
  if (flags.live && flags["dry-run"]) throw new Refusal("--live and --dry-run contradict each other");
  const dryRun = !flags.live;

  return async (repo) => {
    const run = await requireRun(repo, label);
    const result = await publishRun(repo, run.id, { dryRun });
    if (!result.ok) throw new Refusal(result.refusal);
    deps.out(
      result.dryRun
        ? { command: "publish", run_label: label, run_id: run.id, dry_run: true, would_publish: result.preview.eligible, waiting: result.preview.waiting, unconvertible: result.preview.unconvertible }
        : { command: "publish", run_label: label, run_id: run.id, dry_run: false, ...result.summary },
    );
    return EXIT.ok;
  };
};

const fx: Handler = (flags, deps) => async (repo) => {
  const rates = await fetchFxRates(deps.fetchJson, text(flags, "date"));
  const written = await upsertFxRates(repo, rates);
  deps.out({ command: "fx", rate_date: rates[0].rate_date, written, rates });
  return EXIT.ok;
};

const probe: Handler = (flags, deps) => async (repo) => {
  if (!deps.fetchText) throw new Error("probe: no fetcher configured");
  const fetchText = deps.fetchText();
  const apply = flags.apply === true;
  const controlSlugs = { woo: text(flags, "control-woo") ?? DEFAULT_CONTROLS.woo, shopify: text(flags, "control-shopify") ?? DEFAULT_CONTROLS.shopify };
  const wanted = [controlSlugs.woo, controlSlugs.shopify].filter((slug): slug is string => slug !== null);
  const [wooControl, shopifyControl] = await requireVendors(repo, wanted, "all").then((rows) => [rows.find((v) => v.slug === controlSlugs.woo), rows.find((v) => v.slug === controlSlugs.shopify)]);
  const vendors = await requireVendors(repo, slugList(flags, "vendors"), "all");
  const controlOpts = { wooOrigin: wooControl?.website_url ?? "", shopifyOrigin: controlSlugs.shopify === null ? null : (shopifyControl?.website_url ?? ""), sleep: deps.sleep };
  const refuse = (reason: string, extra: Record<string, unknown> = {}) => {
    deps.out({ command: "probe", applied: false, refused: reason, written: 0, ...extra });
    return EXIT.refused;
  };

  // No control → no finding: the instrument is checked before the sweep and again after it.
  const before = await runControls(fetchText, controlOpts);
  const broken = before.filter((c) => c.got !== c.expect);
  if (broken.length > 0) return refuse(`start-of-run control mismatch: ${broken.map((c) => `${c.kind} → ${c.got} (expected ${c.expect})`).join("; ")}`, { controls: before });

  const rows = await probeVendors(vendors.map((v) => ({ id: v.id, slug: v.slug, website: v.website_url, detectedPlatform: (v.detected_platform as Platform | null) ?? null })), fetchText, { concurrency: 4, sleep: deps.sleep });
  for (const r of rows) deps.log("probed", { slug: r.slug, platform: r.platform, previous: r.previousPlatform, reason: r.reason });
  const after = await runControls(fetchText, controlOpts);
  const health = assessNetworkHealth(rows, after);
  if (!health.ok) return refuse(health.reason ?? "network health check failed", { controls: after, probed: health.probed, unreachable: health.unreachable });

  const byPlatform: Record<string, number> = {};
  for (const r of rows) byPlatform[r.platform] = (byPlatform[r.platform] ?? 0) + 1;
  const writable = rows.filter((r) => shouldWritePlatform(r.previousPlatform, r.platform));
  let written = 0;
  if (apply) {
    const probedAt = new Date().toISOString();
    for (const r of writable) {
      await repo.updateVendorPlatform(r.vendorId, r.platform as Platform, probedAt);
      written++;
    }
  }
  deps.out({
    command: "probe",
    applied: apply,
    probed: health.probed,
    by_platform: byPlatform,
    changed: rows.filter((r) => r.platform !== "no_origin" && r.platform !== r.previousPlatform).map((r) => ({ slug: r.slug, from: r.previousPlatform, to: r.platform })),
    regressions: listRegressions(rows),
    would_write: writable.length,
    written,
    controls: after,
  });
  return EXIT.ok;
};

const HANDLERS: Record<Command, Handler> = { seed, probe, refresh, gate, prune, publish, fx, captures, "coa-scan": coaScan };
