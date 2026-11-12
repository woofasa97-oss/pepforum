/**
 * Ingest one vendor through the ladder: claim the attempt → ladder → quantity → compound match →
 * build rows → SKU-drop guard → reconcile (quarantine) → upsert → observations → candidates →
 * capture → finish the attempt. Deps are injected so the ordering is testable without a database,
 * and so one row's failure is provably that row's failure and never the catalogue's.
 *
 * ONE VENDOR'S FAILURE IS ONE VENDOR'S FAILURE: a throw anywhere here closes the attempt as not
 * complete (it licenses nothing) and is returned as `error`; the run moves on.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { captureObjectKey, type RawCapture } from "../fetch/raw-capture.ts";
import type { Sleep } from "../fetch/pacing.ts";
import type { FetchText } from "../fetch/types.ts";
import { attemptFeeds, withCanonicalQuantity } from "../ladder/ladder.ts";
import type { FetchState, Platform, PriceSource, Product } from "../ladder/types.ts";
import { resolveProduct, type ProductIndex } from "../units/blend-match.ts";
import { buildAttemptPatch, carriedLists, classifyOutcome, deadUrlsFromAttempts, type Outcome } from "./attempts.ts";
import { buildOfferRow, resolveProductIdentity, type BuildRefusal } from "./build-offer.ts";
import { decideQuarantine, type QuarantineReason } from "./reconcile.ts";
import { offerKey, type CandidateInsert, type CompoundRow, type OfferInsert, type Repo, type VendorRow } from "./repo.ts";

/** A run that builds fewer than this share of the last complete hit's rows is HELD, not applied. */
export const SKU_DROP_FLOOR = 0.7;
const FEED_RUNGS: readonly PriceSource[] = ["woo_store_api", "shopify_products_json"];
const CANDIDATE_REASONS: ReadonlySet<string> = new Set(["no_compound_match", "currency_unresolved", "invalid_product_url", "raw_text_mismatch"]);

export interface IngestDeps {
  repo: Repo;
  fetchText: FetchText;
  products: ProductIndex;
  compoundsById: Map<string, CompoundRow>;
  runId: string;
  runLabel: string;
  now: Date;
  dryRun: boolean;
  capture?: RawCapture;
  /** Where the capture is written locally (always, dry runs included) when given. */
  captureDir?: string;
  /** Injectable pause between requests to one vendor (tests). Default: the real clock. */
  sleep?: Sleep;
  /** An operator's explicit acceptance of a smaller catalogue: skips the SKU-drop hold for this run and makes it the new baseline. */
  acceptSkuDrop?: boolean;
}

export interface VendorResult {
  vendorId: string;
  slug: string;
  outcome: Outcome;
  state: FetchState | null;
  rung: PriceSource | null;
  reason: string | null;
  productsSeen: number;
  matched: number;
  rowsWritten: number;
  changed: number;
  unchanged: number;
  candidates: number;
  refusals: Record<string, number>;
  quarantined: Partial<Record<QuarantineReason, number>>;
  undecided: Record<string, number>;
  rowFailures: { productKey: string; variantKey: string; error: string }[];
  fetches: number;
  held: boolean;
  attemptId: string;
  capture: { uri: string | null; sha256: string | null; bytes: number | null; records: number; error: string | null } | null;
  error: string | null;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function ingestVendor(vendor: VendorRow, deps: IngestDeps): Promise<VendorResult> {
  const { repo, now } = deps;
  const result: VendorResult = {
    vendorId: vendor.id,
    slug: vendor.slug,
    outcome: "unknown",
    state: null,
    rung: null,
    reason: null,
    productsSeen: 0,
    matched: 0,
    rowsWritten: 0,
    changed: 0,
    unchanged: 0,
    candidates: 0,
    refusals: {},
    quarantined: {},
    undecided: {},
    rowFailures: [],
    fetches: 0,
    held: false,
    attemptId: "",
    capture: null,
    error: null,
  };
  const refuse = (reason: string) => (result.refusals[reason] = (result.refusals[reason] ?? 0) + 1);

  // The OPEN ledger row, written before the first fetch: a killed run stays visible.
  result.attemptId = await repo.claimAttempt({ run_id: deps.runId, vendor_id: vendor.id, started_at: now.toISOString() });

  // BEST-EFFORT by contract: the capture is an audit artefact, and losing it must not cost the prices.
  const flushCapture = async (): Promise<VendorResult["capture"]> => {
    if (!deps.capture) return null;
    try {
      const gz = deps.capture.serialize();
      const key = captureObjectKey(deps.runLabel, vendor.slug);
      let uri: string | null = null;
      let error: string | null = null;
      if (deps.captureDir) {
        const path = join(deps.captureDir, key);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, gz.buffer);
        uri = `file://${path}`;
      }
      if (!deps.dryRun) {
        if (gz.overCap) error = `capture is ${gz.bytes} bytes, over the bucket's object cap — not uploaded`;
        else {
          const up = await repo.uploadCapture(key, gz.buffer);
          if (up.uri) uri = up.uri;
          else error = up.error;
        }
      }
      return { uri, sha256: gz.sha256, bytes: gz.bytes, records: deps.capture.count, error };
    } catch (err) {
      return { uri: null, sha256: null, bytes: null, records: deps.capture.count, error: message(err) };
    }
  };

  let ladderState: FetchState = "unknown";
  let ladderAttempts: Awaited<ReturnType<typeof attemptFeeds>>["attempts"] = [];
  let counts: Record<string, unknown> = {};

  try {
    const stored = await repo.listOffers(vendor.id);
    const knownProductUrls = [...new Set(stored.map((o) => o.product_url).filter((u): u is string => typeof u === "string" && u.length > 0))];
    const ladder = await attemptFeeds(vendor.website_url, deps.fetchText, { platform: (vendor.detected_platform as Platform | null) ?? null, knownProductUrls, sleep: deps.sleep });
    ladderState = ladder.state;
    ladderAttempts = ladder.attempts;
    result.state = ladder.state;
    result.rung = ladder.rung;
    result.reason = ladder.reason;
    result.fetches = ladder.fetches;
    const deadUrlsThisRun = deadUrlsFromAttempts(ladder.attempts);
    // Only a FEED read that reached its end is a statement about the whole catalogue. A page rung
    // never is; a feed read cut short is a HIT whose silence about a product means nothing.
    const isFeed = ladder.rung !== null && FEED_RUNGS.includes(ladder.rung);
    // A page read is complete when every URL it was given was answered; one cut short (a 429, a
    // timeout) is no more a baseline than a feed read that lost a page.
    const catalogueComplete = isFeed ? ladder.complete : !ladder.attempts.some((a) => a.state === "unknown");
    const truncatedParents = new Set(ladder.truncatedParentIds);
    const unenumeratedParents = new Set(ladder.unenumeratedParentIds);
    counts = { fetches: ladder.fetches, variation_fetches: ladder.variationFetches ?? 0, dead_urls: deadUrlsThisRun, catalogue_complete: catalogueComplete, attempts: ladder.attempts };

    // NOT A HIT: record what happened and remove NOTHING.
    if (ladder.state !== "hit") {
      result.outcome = classifyOutcome({ ladderState: ladder.state, attempts: ladder.attempts });
      result.capture = await flushCapture();
      await repo.finishAttempt(result.attemptId, buildAttemptPatch({ ladderState: ladder.state, attempts: ladder.attempts, applied: false, rung: ladder.rung, productsSeen: 0, matched: 0, rowsWritten: 0, counts, capture: result.capture, finishedAt: new Date() }));
      return result;
    }

    const products = withCanonicalQuantity(ladder.products);
    result.productsSeen = products.length;
    const storedByKey = new Map(stored.map((r) => [offerKey(r), r]));

    // BUILD
    const built: { row: OfferInsert; changed: boolean; isNew: boolean }[] = [];
    const candidates: CandidateInsert[] = [];
    const degradedProductKeys = new Set<string>();
    const candidate =(p: Product, reason: string) => {
      if (!p.productUrl) {
        refuse("candidate_without_url");
        return;
      }
      candidates.push({ run_label: deps.runLabel, vendor_id: vendor.id, product_url: p.productUrl, product_name: p.name || p.variantLabel || "(unnamed)", reject_reason: reason, match_candidates: [], raw: JSON.parse(JSON.stringify(p)) });
    };
    for (const p of products) {
      const compoundId = resolveProduct(p, deps.products);
      const compound = compoundId ? deps.compoundsById.get(compoundId) : undefined;
      if (!compound) {
        refuse("no_compound_match");
        candidate(p, "no_compound_match");
        continue;
      }
      const first = buildOfferRow(p, { vendor, compound, runId: deps.runId, now, previous: null, blends: deps.products.blends });
      if (!first.ok) {
        refuse(first.reason);
        // A range fallback is a product the feed LISTED and the run could not enumerate: seen, not absent.
        if (p.fallbackRange) {
          const identity = resolveProductIdentity(p, { vendor, compound });
          if (identity.ok) degradedProductKeys.add(identity.productKey);
        }
        if (CANDIDATE_REASONS.has(first.reason)) candidate(p, first.reason as BuildRefusal);
        continue;
      }
      // The key is the builder's own output, so the previous row can only be looked up afterwards.
      const previous = storedByKey.get(offerKey(first.row)) ?? null;
      const out = previous ? buildOfferRow(p, { vendor, compound, runId: deps.runId, now, previous, blends: deps.products.blends }) : first;
      if (!out.ok) continue; // unreachable: same inputs, same refusals
      if (out.urlRejected) refuse("placeholder_url_degraded");
      // A parent whose variation list was cut short was READ, not ENUMERATED: its unseen variants stay.
      if (p.sourceProductId !== null && truncatedParents.has(p.sourceProductId)) degradedProductKeys.add(out.row.product_key);
      result.matched++;
      built.push({ row: out.row, changed: out.changed, isNew: out.isNew });
    }
    // Stored rows of a parent the feed listed but this read did not enumerate are SEEN, whatever
    // compound their variant labels filed them under — not only the ones a fallback row points at.
    for (const row of stored) {
      if (row.source_product_id !== null && unenumeratedParents.has(row.source_product_id)) degradedProductKeys.add(row.product_key);
    }
    counts = { ...counts, products_seen: products.length, built: built.length, refusals: result.refusals };

    // SKU-DROP GUARD, before any write or quarantine.
    const baseline = await repo.lastCompleteHit(vendor.id);
    const priorWritten = Number(baseline?.rows_written ?? 0);
    const dropped = priorWritten > 0 && built.length < SKU_DROP_FLOOR * priorWritten;
    if (dropped && deps.acceptSkuDrop) counts = { ...counts, sku_drop_accepted: { built: built.length, baseline: priorWritten } };
    if (dropped && !deps.acceptSkuDrop) {
      result.held = true;
      result.outcome = "held";
      result.reason = `sku_drop_guard: ${built.length} < ${SKU_DROP_FLOOR} × ${priorWritten}`;
      // Observations still record what was SEEN; nothing is served and nothing is removed.
      if (!deps.dryRun && built.length > 0) await repo.insertObservations(built.map((b) => b.row), { offerIds: new Map(), runLabel: deps.runLabel });
      result.capture = await flushCapture();
      await repo.finishAttempt(result.attemptId, buildAttemptPatch({ ladderState: ladder.state, attempts: ladder.attempts, held: true, applied: false, rung: ladder.rung, productsSeen: products.length, matched: result.matched, rowsWritten: 0, counts: { ...counts, held_reason: result.reason }, capture: result.capture, finishedAt: new Date() }));
      return result;
    }

    // RECONCILE, then upsert. Order is load-bearing: a moved URL keeps its platform SKU, and the
    // stale-URL row must leave before the new one can land under the platform-SKU index.
    const priorAttempt = await repo.previousAttempt(vendor.id, result.attemptId);
    const decision = decideQuarantine({
      ladderState: ladder.state,
      stored,
      emitted: built.map((b) => b.row),
      fullCatalogue: isFeed && ladder.complete,
      degradedProductKeys: [...degradedProductKeys],
      deadUrlsThisRun,
      priorDeadUrls: carriedLists(priorAttempt).deadUrls,
      priorMissingProductKeys: carriedLists(baseline).missingProductKeys,
    });
    result.undecided = decision.undecided;
    for (const batch of decision.batches) {
      result.quarantined[batch.reason] = deps.dryRun ? batch.ids.length : await repo.quarantine(batch.ids, batch.reason, deps.runId);
    }

    // UPSERT: one row's failure is that row's failure.
    const offerIds = new Map<string, string>();
    for (const b of built) {
      if (deps.dryRun) {
        result.rowsWritten++;
        if (b.changed) result.changed++;
        else result.unchanged++;
        continue;
      }
      try {
        const { id } = await repo.upsertOffer(b.row);
        offerIds.set(offerKey(b.row), id);
        result.rowsWritten++;
        if (b.changed) result.changed++;
        else result.unchanged++;
      } catch (err) {
        result.rowFailures.push({ productKey: b.row.product_key, variantKey: b.row.variant_key ?? "", error: message(err) });
      }
    }

    // OBSERVATIONS and CANDIDATES: best-effort by contract; counted, never fatal.
    if (!deps.dryRun && built.length > 0) {
      try {
        await repo.insertObservations(built.map((b) => b.row), { offerIds, runLabel: deps.runLabel });
      } catch (err) {
        counts = { ...counts, observations_error: message(err) };
      }
    }
    result.candidates = candidates.length;
    if (!deps.dryRun && candidates.length > 0) {
      try {
        await repo.insertCandidates(candidates);
      } catch (err) {
        counts = { ...counts, candidates_error: message(err) };
      }
    }
    result.capture = await flushCapture();
    if (!deps.dryRun) await repo.markVendorIngested(vendor.id, now.toISOString());

    result.outcome = "hit";
    await repo.finishAttempt(
      result.attemptId,
      buildAttemptPatch({
        ladderState: ladder.state,
        attempts: ladder.attempts,
        // An incomplete catalogue read is not a baseline: neither for the SKU-drop guard nor for the two-run rules.
        applied: result.rowFailures.length === 0 && catalogueComplete,
        rung: ladder.rung,
        productsSeen: products.length,
        matched: result.matched,
        rowsWritten: result.rowsWritten,
        counts: {
          ...counts,
          changed: result.changed,
          unchanged: result.unchanged,
          candidates: result.candidates,
          quarantined: result.quarantined,
          undecided: result.undecided,
          row_failures: result.rowFailures,
          missing_product_keys: decision.missingProductKeys,
          missing_keys_truncated: decision.missingKeysTruncated,
        },
        capture: result.capture,
        finishedAt: new Date(),
      }),
    );
    return result;
  } catch (err) {
    result.error = message(err);
    result.outcome = classifyOutcome({ ladderState, attempts: ladderAttempts });
    try {
      // Closed as NOT complete, with the error as the reason: a throw after a HIT is still not a hit that was applied.
      await repo.finishAttempt(result.attemptId, buildAttemptPatch({ ladderState, attempts: ladderAttempts, applied: false, rung: result.rung, productsSeen: result.productsSeen, matched: result.matched, rowsWritten: result.rowsWritten, counts, error: `driver_error: ${result.error}`, finishedAt: new Date() }));
    } catch (closeErr) {
      result.error = `${result.error}; ledger: ${message(closeErr)}`;
    }
    return result;
  }
}
