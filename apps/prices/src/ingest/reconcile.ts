/**
 * RECONCILE — what a successful fetch licenses us to REMOVE. "We could not see it" and "it is
 * gone" are different facts, and only the second justifies taking a row off the site: every
 * decision here is gated on a HIT, so a 403 / timeout / challenge page / MISS removes nothing.
 *
 * Pure: stored rows + emitted rows + attempt history in, `{ reason, ids }[]` out. Five reasons,
 * in precedence order, and every row lands in at most one batch:
 *   duplicate_url            one platform SKU living under two product_keys
 *   superseded_by_variants   the whole-product row is replaced by per-variant rows
 *   variant_gone             the product was read this run and this variant was not in it
 *   dead_url                 the URL 404/410'd this run AND on the previous attempt
 *   delisted                 absent from a FULL-CATALOGUE feed on two consecutive complete hits
 * Ported from PeptideBase's variant-reconcile.mjs.
 */
import type { FetchState } from "../fetch/types.ts";
import type { OfferInsert, OfferRow } from "./repo.ts";

export type QuarantineReason = "duplicate_url" | "superseded_by_variants" | "variant_gone" | "dead_url" | "delisted";

/** First wins. A row is recorded under the most specific fact that explains it. */
export const REASON_PRECEDENCE: readonly QuarantineReason[] = ["duplicate_url", "superseded_by_variants", "variant_gone", "dead_url", "delisted"];

/** How many absent product_keys one attempt row carries forward, SORTED before truncation so
 *  the same keys are carried every run and the two-run rule stays exact for them. */
export const MAX_MISSING_PRODUCT_KEYS = 500;

type KeyFields = { product_key: string; variant_key?: string | null; source_product_id?: string | null; source_variant_id?: string | null; product_url?: string | null };

/** `(source_product_id, source_variant_id)` as the platform-SKU unique index spells it. */
export function skuKey(row: { source_product_id?: string | null; source_variant_id?: string | null }): string | null {
  const pid = row.source_product_id;
  if (pid == null || pid === "") return null;
  return `${pid}|${row.source_variant_id ?? ""}`;
}

const rowKey = (r: KeyFields): string => `${r.product_key}#${r.variant_key ?? ""}`;

export interface ReconcileInput {
  ladderState: FetchState;
  stored: OfferRow[];
  emitted: OfferInsert[];
  /** True only when a FEED rung answered — a page rung cannot say a product is absent from a catalogue it never read. */
  fullCatalogue: boolean;
  /** product_keys the run saw only as a variable-parent fallback (a range, never written): read, not enumerated. */
  degradedProductKeys: string[];
  deadUrlsThisRun: string[];
  priorDeadUrls: string[];
  priorMissingProductKeys: string[];
}

export interface ReconcileDecision {
  batches: { reason: QuarantineReason; ids: string[] }[];
  missingProductKeys: string[];
  missingKeysTruncated: boolean;
  undecided: Record<string, number>;
}

export function decideQuarantine(input: ReconcileInput): ReconcileDecision {
  const empty: ReconcileDecision = { batches: [], missingProductKeys: [], missingKeysTruncated: false, undecided: {} };
  // THE GATE. A MISS is excluded too: an empty read must never delist a whole vendor in one pass.
  if (input.ladderState !== "hit") return empty;
  const { stored, emitted } = input;

  const undecided: Record<string, number> = {};
  const bump = (k: string, n = 1) => (undecided[k] = (undecided[k] ?? 0) + n);
  const claimed = new Map<string, QuarantineReason>();
  const claim = (id: string, reason: QuarantineReason) => {
    if (!claimed.has(id)) claimed.set(id, reason);
  };

  const emittedByRowKey = new Set(emitted.map(rowKey));
  const emittedProductKeys = new Set(emitted.map((r) => r.product_key));
  const degraded = new Set(input.degradedProductKeys);
  const emittedBySku = new Map<string, OfferInsert>();
  for (const r of emitted) {
    const k = skuKey(r);
    if (k !== null && !emittedBySku.has(k)) emittedBySku.set(k, r);
  }
  const productsWithEmittedVariants = new Set(emitted.filter((r) => (r.variant_key ?? "") !== "").map((r) => r.product_key));

  // 1. duplicate_url — the emitted row names the keeper; a SKU no emitted row names is UNDECIDED.
  const storedBySku = new Map<string, OfferRow[]>();
  for (const r of stored) {
    const k = skuKey(r);
    if (k === null) continue;
    storedBySku.set(k, [...(storedBySku.get(k) ?? []), r]);
  }
  for (const [k, rows] of storedBySku) {
    const em = emittedBySku.get(k);
    if (em) {
      for (const r of rows) if (r.product_key !== em.product_key) claim(r.id, "duplicate_url");
      continue;
    }
    if (new Set(rows.map((r) => r.product_key)).size > 1) bump("duplicate_url_unresolved", rows.length);
  }

  // 2. superseded_by_variants — the whole-product row of a product that now yields variant rows.
  for (const r of stored) {
    if ((r.variant_key ?? "") !== "") continue;
    if (productsWithEmittedVariants.has(r.product_key)) claim(r.id, "superseded_by_variants");
  }

  // 3. variant_gone — scoped to products the run actually READ, and not a degraded one.
  for (const r of stored) {
    if ((r.variant_key ?? "") === "") continue;
    if (degraded.has(r.product_key)) {
      bump("variant_gone_unenumerated");
      continue;
    }
    if (!emittedProductKeys.has(r.product_key)) continue;
    if (!emittedByRowKey.has(rowKey(r))) claim(r.id, "variant_gone");
  }

  // 4. dead_url — TWO consecutive 404/410s on the same URL.
  const priorDead = new Set(input.priorDeadUrls);
  const deadTwice = new Set(input.deadUrlsThisRun.filter((u) => priorDead.has(u)));
  if (deadTwice.size > 0) {
    for (const r of stored) if (r.product_url && deadTwice.has(r.product_url)) claim(r.id, "dead_url");
  }

  // 5. delisted — absent from a full-catalogue read on two consecutive complete hits. A
  //    successful read that emitted NOTHING cannot delist anything, and a degraded product was
  //    SEEN: the feed listed it, so it is not absent however many runs fail to enumerate it.
  let missingProductKeys: string[] = [];
  let missingKeysTruncated = false;
  if (input.fullCatalogue && emitted.length > 0) {
    const absent = new Set<string>();
    for (const r of stored) if (!emittedProductKeys.has(r.product_key) && !degraded.has(r.product_key)) absent.add(r.product_key);
    const sorted = [...absent].sort();
    missingKeysTruncated = sorted.length > MAX_MISSING_PRODUCT_KEYS;
    missingProductKeys = sorted.slice(0, MAX_MISSING_PRODUCT_KEYS);
    const priorMissing = new Set(input.priorMissingProductKeys);
    for (const r of stored) if (absent.has(r.product_key) && priorMissing.has(r.product_key)) claim(r.id, "delisted");
  }

  const byReason = new Map<QuarantineReason, string[]>();
  for (const [id, reason] of claimed) byReason.set(reason, [...(byReason.get(reason) ?? []), id]);
  const batches = REASON_PRECEDENCE.filter((reason) => byReason.has(reason)).map((reason) => ({ reason, ids: byReason.get(reason) ?? [] }));
  return { batches, missingProductKeys, missingKeysTruncated, undecided };
}
