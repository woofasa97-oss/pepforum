// The pipeline's only database boundary. `PostgresRepo` speaks SQL to Postgres directly (the docker
// container locally, the hosted project's session pooler in production); `InMemoryRepo` backs the
// tests. Both implement the same `Repo` interface, so drivers never know which one they hold.
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import type { Database } from "./db-types.ts";
import type { Sleep } from "../fetch/pacing.ts";
import type { Platform } from "../ladder/types.ts";
import type { CompoundSeed, VendorSeed } from "../seed/types.ts";
import { withRetry } from "./retry.ts";

type Tables = Database["prices"]["Tables"];
export type CompoundRow = Tables["compounds"]["Row"];
export type VendorRow = Tables["vendors"]["Row"];
export type OfferRow = Tables["offers"]["Row"];
export type OfferInsert = Tables["offers"]["Insert"];
export type ObservationRow = Tables["offer_observations"]["Row"];
export type QuarantineRow = Tables["offer_quarantine"]["Row"];
export type CandidateInsert = Tables["offer_candidates"]["Insert"];
export type CandidateRow = Tables["offer_candidates"]["Row"];
export type RunRow = Tables["refresh_runs"]["Row"];
export type RunInsert = Tables["refresh_runs"]["Insert"];
export type AttemptRow = Tables["refresh_attempts"]["Row"];
export type AttemptInsert = Tables["refresh_attempts"]["Insert"];
export type FxRateRow = Tables["fx_rates"]["Row"];
/** One dated rate: 1 base = `rate` quote, on the provider's own reference date. */
export type FxRate = Pick<FxRateRow, "base_currency" | "quote_currency" | "rate" | "provider" | "rate_date">;
/** What one publish did (the JSON `publish_offers` returns). */
export interface PublishSummary {
  publication_id: string;
  offers: number;
  vendors: number;
  compounds: number;
  changed: number;
  removed: number;
  /** Comparable rows whose own run has not passed: not published, or left as last published. */
  waiting: number;
  /** Comparable rows in a currency with no rate to USD. */
  unconvertible: number;
}
/** What a publish would copy, counted without writing. */
export interface PublishPreview {
  eligible: number;
  waiting: number;
  unconvertible: number;
}

export type VendorStatusFilter = "active" | "pending" | "all";

/** Where a raw capture goes on a live run. Absent when no storage is configured: the local file stands. */
export interface CaptureStorage {
  upload(key: string, bytes: Buffer): Promise<{ uri: string | null; error: string | null }>;
}

export interface Repo {
  upsertCompounds(seeds: CompoundSeed[]): Promise<number>;
  upsertVendors(seeds: VendorSeed[]): Promise<number>;
  listVendors(filter: { status: VendorStatusFilter; slugs?: string[] }): Promise<VendorRow[]>;
  listCompounds(): Promise<CompoundRow[]>;
  /** Files a link as a candidate certificate of analysis. False when that vendor already has that link. */
  fileCoaCandidate(vendorId: string, compoundId: string | null, url: string): Promise<boolean>;
  listOffers(vendorId: string): Promise<OfferRow[]>;
  /** One row at a time: one row's failure is that row's failure. Returns the stored id. */
  upsertOffer(row: OfferInsert): Promise<{ id: string; inserted: boolean }>;
  insertObservations(rows: OfferInsert[], meta: { offerIds: Map<string, string>; runLabel: string }): Promise<number>;
  insertCandidates(rows: CandidateInsert[]): Promise<number>;
  quarantine(ids: string[], reason: string, runId: string): Promise<number>;
  restoreRun(runId: string): Promise<number>;
  createRun(run: RunInsert): Promise<RunRow>;
  finishRun(id: string, patch: Partial<RunRow>): Promise<void>;
  getRun(id: string): Promise<RunRow | null>;
  getRunByLabel(label: string): Promise<RunRow | null>;
  /** Committed, live (non-dry) runs, newest first: the gate's baseline candidates. */
  listCommittedRuns(limit?: number): Promise<RunRow[]>;
  /** Every live offer, all vendors: the gate's reference corpus. */
  listAllOffers(): Promise<OfferRow[]>;
  countRunOffers(runId: string): Promise<number>;
  /** Offers this run did not confirm and nobody has observed for `days`. */
  countStale(runId: string, days: number): Promise<number>;
  /** Moves those rows to quarantine as `stale_aged_out`. Lossless; restorable by run. */
  softDeleteStale(runId: string, days: number): Promise<number>;
  /** Counts what a publish would copy. Read-only. */
  previewPublish(): Promise<PublishPreview>;
  /** Copies the checked rows into the table the site reads. Refuses a run that is not a committed PASS. */
  publishOffers(runId: string): Promise<PublishSummary>;
  upsertFxRates(rates: FxRate[]): Promise<number>;
  claimAttempt(a: AttemptInsert): Promise<string>;
  finishAttempt(id: string, patch: Partial<AttemptRow>): Promise<void>;
  /** The vendor's latest complete LIVE hit — dry runs never count. */
  lastCompleteHit(vendorId: string): Promise<AttemptRow | null>;
  previousAttempt(vendorId: string, excludeId?: string | null): Promise<AttemptRow | null>;
  uploadCapture(key: string, bytes: Buffer): Promise<{ uri: string | null; error: string | null }>;
  /** Point a run's attempt for one vendor at its uploaded capture. Returns the rows touched (0 or 1). */
  setCaptureUri(runId: string, vendorSlug: string, uri: string): Promise<number>;
  updateVendorPlatform(id: string, platform: Platform, probedAt: string): Promise<void>;
  markVendorIngested(id: string, at: string): Promise<void>;
  close(): Promise<void>;
}

/** The key the offers upsert conflicts on, minus the vendor/compound half that is constant per vendor+compound. */
export const offerKey = (r: { compound_id: string; product_key: string; variant_key?: string | null }): string => `${r.compound_id}#${r.product_key}#${r.variant_key ?? ""}`;

const OFFER_COLUMNS = [
  "vendor_id", "compound_id", "product_key", "variant_key", "product_url", "product_name", "variant_label",
  "source_system", "source_product_id", "source_variant_id", "price_source", "native_currency", "price_minor",
  "list_price_minor", "on_sale", "price_kind", "mg_per_vial", "vials_per_pack", "total_mg", "form", "is_blend",
  "comparable", "quantity_reason", "per_mg_minor_e4", "availability", "availability_checked_at", "raw_price_text",
  "extraction_confidence", "observed_at", "price_changed_at", "run_id", "recipe_key",
] as const;

/**
 * Statements that are safe to repeat after a dropped connection: reads, and writes that land on
 * the same row whatever was written before (upserts, keyed updates, `on conflict do nothing`).
 * `createRun` and `claimAttempt` qualify because the id is made HERE, before the first try: a
 * repeat inserts the same row or nothing. NOT here, on purpose: `insertObservations` (append-only,
 * a repeat would be a second observation) and the quarantine / restore / prune functions.
 */
const REPEATABLE = [
  "upsertCompounds", "upsertVendors", "listVendors", "listCompounds", "listOffers", "upsertOffer", "insertCandidates", "finishRun",
  "getRun", "getRunByLabel", "listCommittedRuns", "listAllOffers", "countRunOffers", "countStale", "upsertFxRates", "finishAttempt",
  "lastCompleteHit", "previousAttempt", "updateVendorPlatform", "markVendorIngested", "createRun", "claimAttempt", "setCaptureUri", "previewPublish",
] as const satisfies readonly (keyof Repo)[];

export class PostgresRepo implements Repo {
  readonly sql: Sql;
  private readonly storage: CaptureStorage | null;

  constructor(dbUrl: string, opts: { storage?: CaptureStorage | null; sleep?: Sleep } = {}) {
    // int8 and numeric arrive as strings by default; the pipeline's amounts (minor units, mg) are
    // safe integers and small decimals, and a string price_minor would compare unequal to every
    // number the builder produces — a permanent "changed" on every row.
    this.sql = postgres(dbUrl, {
      max: 2,
      prepare: false,
      // A refresh spends minutes fetching a vendor between two queries. A connection left idle that
      // long can be dropped on the way to the hosted pooler, and the next query then dies with a
      // read timeout (first live run, 2026-10-01). Idle connections are closed and reopened instead.
      idle_timeout: 20,
      max_lifetime: 60 * 15,
      connect_timeout: 30,
      // Every table lives in the `prices` schema. The pepforum_prices login sets this itself; the owner
      // connection used for seeding and local development does not.
      connection: { search_path: "prices, pg_catalog" },
      types: {
        bigint: { to: 20, from: [20], serialize: (x: number | bigint) => x.toString(), parse: (x: string) => Number(x) },
        numeric: { to: 1700, from: [1700], serialize: (x: number) => x.toString(), parse: (x: string) => Number(x) },
        // timestamptz as the ISO string the generated types promise, never a Date object.
        timestamptz: { to: 1184, from: [1184, 1114], serialize: (x: string | Date) => (x instanceof Date ? x.toISOString() : x), parse: (x: string) => new Date(x).toISOString() },
        // A calendar date stays the YYYY-MM-DD text the provider wrote: a Date object would carry a timezone it never had.
        date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
      },
    });
    this.storage = opts.storage ?? null;
    const methods = this as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const name of REPEATABLE) {
      const statement = methods[name].bind(this);
      methods[name] = (...args) => {
        // The two inserts are repeatable only because their row id is fixed BEFORE the first try.
        const fixed = name === "createRun" || name === "claimAttempt" ? [{ ...(args[0] as { id?: string }), id: (args[0] as { id?: string }).id ?? randomUUID() }] : args;
        return withRetry(() => statement(...fixed), { sleep: opts.sleep });
      };
    }
  }

  async upsertCompounds(seeds: CompoundSeed[]): Promise<number> {
    let n = 0;
    for (const s of seeds) {
      await this.sql`
        insert into compounds (slug, name, type, aliases, known_sizes_mg, blend_components)
        values (${s.slug}, ${s.name}, ${s.type}, ${s.aliases}, ${s.known_sizes_mg}, ${s.blend_components ? this.sql.json(s.blend_components) : null})
        on conflict (slug) do update set
          name = excluded.name, type = excluded.type, aliases = excluded.aliases,
          known_sizes_mg = excluded.known_sizes_mg, blend_components = excluded.blend_components`;
      n++;
    }
    return n;
  }

  async upsertVendors(seeds: VendorSeed[]): Promise<number> {
    let n = 0;
    for (const s of seeds) {
      // Existing rows keep status, ships_to, evidence and probe results; only identity fields refresh.
      await this.sql`
        insert into vendors (slug, name, website_url, canonical_domain, origin_country, detected_platform)
        values (${s.slug}, ${s.name}, ${s.website_url}, ${s.canonical_domain}, ${s.origin_country}, ${s.detected_platform})
        on conflict (slug) do update set
          name = excluded.name, website_url = excluded.website_url, canonical_domain = excluded.canonical_domain,
          origin_country = excluded.origin_country,
          detected_platform = coalesce(vendors.detected_platform, excluded.detected_platform)`;
      n++;
    }
    return n;
  }

  async listVendors(filter: { status: VendorStatusFilter; slugs?: string[] }): Promise<VendorRow[]> {
    const rows = await this.sql<VendorRow[]>`
      select * from vendors
      where (${filter.status === "all"} or status = ${filter.status})
        and (${!filter.slugs} or slug = any(${filter.slugs ?? []}))
      order by slug`;
    return rows;
  }

  async listCompounds(): Promise<CompoundRow[]> {
    return this.sql<CompoundRow[]>`select * from compounds where is_active order by slug`;
  }

  async fileCoaCandidate(vendorId: string, compoundId: string | null, url: string): Promise<boolean> {
    const rows = await this.sql<{ filed: boolean }[]>`select file_coa_candidate(${vendorId}::uuid, ${compoundId}::uuid, null, ${url}) as filed`;
    return rows[0]?.filed === true;
  }

  async listOffers(vendorId: string): Promise<OfferRow[]> {
    return this.sql<OfferRow[]>`select * from offers where vendor_id = ${vendorId} order by product_key, variant_key`;
  }

  async upsertOffer(row: OfferInsert): Promise<{ id: string; inserted: boolean }> {
    const [out] = await this.sql<{ id: string; inserted: boolean }[]>`
      insert into offers ${this.sql({ ...row, recipe_key: row.recipe_key ?? null } as Record<string, unknown>, ...OFFER_COLUMNS)}
      on conflict (vendor_id, compound_id, product_key, variant_key) do update set
        product_url = excluded.product_url, product_name = excluded.product_name, variant_label = excluded.variant_label,
        source_system = excluded.source_system, source_product_id = excluded.source_product_id, source_variant_id = excluded.source_variant_id,
        price_source = excluded.price_source, native_currency = excluded.native_currency, price_minor = excluded.price_minor,
        list_price_minor = excluded.list_price_minor, on_sale = excluded.on_sale, price_kind = excluded.price_kind,
        mg_per_vial = excluded.mg_per_vial, vials_per_pack = excluded.vials_per_pack, total_mg = excluded.total_mg, form = excluded.form,
        is_blend = excluded.is_blend, comparable = excluded.comparable, quantity_reason = excluded.quantity_reason,
        per_mg_minor_e4 = excluded.per_mg_minor_e4, availability = excluded.availability, availability_checked_at = excluded.availability_checked_at,
        raw_price_text = excluded.raw_price_text, extraction_confidence = excluded.extraction_confidence,
        observed_at = excluded.observed_at, price_changed_at = excluded.price_changed_at, run_id = excluded.run_id, recipe_key = excluded.recipe_key
      returning id, (xmax = 0) as inserted`;
    return out;
  }

  async insertObservations(rows: OfferInsert[], meta: { offerIds: Map<string, string>; runLabel: string }): Promise<number> {
    if (rows.length === 0) return 0;
    const values = rows.map((r) => ({ ...pick(r, OFFER_COLUMNS), recipe_key: r.recipe_key ?? null, id: randomUUID(), offer_id: meta.offerIds.get(offerKey(r)) ?? null, run_label: meta.runLabel }));
    await this.sql`insert into offer_observations ${this.sql(values as Record<string, unknown>[], "id", ...OFFER_COLUMNS, "offer_id", "run_label")}`;
    return rows.length;
  }

  async insertCandidates(rows: CandidateInsert[]): Promise<number> {
    if (rows.length === 0) return 0;
    const values = rows.map((r) => ({ ...r, match_candidates: r.match_candidates ?? [], raw: this.sql.json(r.raw as never) }));
    const out = await this.sql`
      insert into offer_candidates ${this.sql(values as Record<string, unknown>[], "run_label", "vendor_id", "product_url", "product_name", "reject_reason", "match_candidates", "raw")}
      on conflict (run_label, vendor_id, product_url) do nothing`;
    return out.count;
  }

  async quarantine(ids: string[], reason: string, runId: string): Promise<number> {
    if (ids.length === 0) return 0;
    const [out] = await this.sql<{ n: number }[]>`select quarantine_offers(${ids}::uuid[], ${reason}, ${runId}::uuid) as n`;
    return Number(out?.n ?? 0);
  }

  async restoreRun(runId: string): Promise<number> {
    const [out] = await this.sql<{ n: number }[]>`select restore_quarantine_run(${runId}::uuid) as n`;
    return Number(out?.n ?? 0);
  }

  async createRun(run: RunInsert): Promise<RunRow> {
    // The id is fixed before the first try, so a repeat after an ambiguous failure lands on the
    // same row. A DIFFERENT run with this label still collides on the label, as it must.
    const id = run.id ?? randomUUID();
    await this.sql`
      insert into refresh_runs (id, run_label, mode, dry_run, started_at, notes)
      values (${id}, ${run.run_label}, ${run.mode}, ${run.dry_run ?? true}, ${run.started_at ?? new Date().toISOString()}, ${run.notes ?? null})
      on conflict (id) do nothing`;
    const [row] = await this.sql<RunRow[]>`select * from refresh_runs where id = ${id}::uuid`;
    return row;
  }

  async finishRun(id: string, patch: Partial<RunRow>): Promise<void> {
    await this.sql`
      update refresh_runs set
        finished_at = coalesce(${patch.finished_at ?? null}, finished_at),
        status = coalesce(${patch.status ?? null}, status),
        verdict = coalesce(${patch.verdict ?? null}, verdict),
        baseline_run_id = coalesce(${patch.baseline_run_id ?? null}::uuid, baseline_run_id),
        metrics = coalesce(${patch.metrics === undefined ? null : this.sql.json(patch.metrics as never)}, metrics),
        checks = coalesce(${patch.checks === undefined ? null : this.sql.json(patch.checks as never)}, checks),
        notes = coalesce(${patch.notes ?? null}, notes)
      where id = ${id}`;
  }

  async getRun(id: string): Promise<RunRow | null> {
    const [row] = await this.sql<RunRow[]>`select * from refresh_runs where id = ${id}::uuid`;
    return row ?? null;
  }

  async getRunByLabel(label: string): Promise<RunRow | null> {
    const [row] = await this.sql<RunRow[]>`select * from refresh_runs where run_label = ${label}`;
    return row ?? null;
  }

  async listCommittedRuns(limit = 200): Promise<RunRow[]> {
    return this.sql<RunRow[]>`
      select * from refresh_runs where status = 'committed' and not dry_run
      order by finished_at desc nulls last, started_at desc limit ${limit}`;
  }

  async listAllOffers(): Promise<OfferRow[]> {
    return this.sql<OfferRow[]>`select * from offers order by vendor_id, product_key, variant_key`;
  }

  async countRunOffers(runId: string): Promise<number> {
    const [out] = await this.sql<{ n: number }[]>`select count(*)::int as n from offers where run_id = ${runId}::uuid`;
    return Number(out?.n ?? 0);
  }

  async countStale(runId: string, days: number): Promise<number> {
    // The predicate of soft_delete_stale_offers, read-only.
    const [out] = await this.sql<{ n: number }[]>`
      select count(*)::int as n from offers
      where run_id is distinct from ${runId}::uuid and observed_at < now() - make_interval(days => ${days}::int)`;
    return Number(out?.n ?? 0);
  }

  async softDeleteStale(runId: string, days: number): Promise<number> {
    const [out] = await this.sql<{ n: number }[]>`select soft_delete_stale_offers(${runId}::uuid, ${days}::int) as n`;
    return Number(out?.n ?? 0);
  }

  async previewPublish(): Promise<PublishPreview> {
    // The predicates of publish_offers, read-only.
    const [out] = await this.sql<PublishPreview[]>`
      with c as (
        select coalesce(r.status = 'committed' and r.verdict = 'pass' and not r.dry_run, false) as passed,
               (o.native_currency = 'USD' or exists (
                  select 1 from fx_rates f where f.base_currency = o.native_currency and f.quote_currency = 'USD')) as convertible
        from offers o join compounds c on c.id = o.compound_id left join refresh_runs r on r.id = o.run_id
        where (o.comparable or (c.type = 'Blend' and o.is_blend and o.form = 'vial')) and o.vials_per_pack is not null)
      select count(*) filter (where passed and convertible)::int as eligible,
             count(*) filter (where not passed)::int as waiting,
             count(*) filter (where not convertible)::int as unconvertible
      from c`;
    return out;
  }

  async publishOffers(runId: string): Promise<PublishSummary> {
    const [out] = await this.sql<{ summary: PublishSummary }[]>`select publish_offers(${runId}::uuid) as summary`;
    return out.summary;
  }

  async upsertFxRates(rates: FxRate[]): Promise<number> {
    for (const r of rates) {
      await this.sql`
        insert into fx_rates (base_currency, quote_currency, rate, provider, rate_date)
        values (${r.base_currency}, ${r.quote_currency}, ${r.rate}, ${r.provider}, ${r.rate_date})
        on conflict (base_currency, quote_currency, rate_date) do update set
          rate = excluded.rate, provider = excluded.provider, fetched_at = now()`;
    }
    return rates.length;
  }

  async claimAttempt(a: AttemptInsert): Promise<string> {
    const id = a.id ?? randomUUID();
    await this.sql`
      insert into refresh_attempts (id, run_id, vendor_id, started_at)
      values (${id}, ${a.run_id}, ${a.vendor_id}, ${a.started_at ?? new Date().toISOString()})
      on conflict (id) do nothing`;
    return id;
  }

  async finishAttempt(id: string, patch: Partial<AttemptRow>): Promise<void> {
    await this.sql`
      update refresh_attempts set
        finished_at = ${patch.finished_at ?? new Date().toISOString()},
        outcome = ${patch.outcome ?? null}, run_complete = ${patch.run_complete ?? false}, rung = ${patch.rung ?? null},
        http_status = ${patch.http_status ?? null}, products_seen = ${patch.products_seen ?? null}, matched = ${patch.matched ?? null},
        rows_written = ${patch.rows_written ?? null}, counts = ${this.sql.json((patch.counts ?? {}) as never)},
        raw_capture_uri = ${patch.raw_capture_uri ?? null}, raw_capture_sha256 = ${patch.raw_capture_sha256 ?? null},
        raw_capture_bytes = ${patch.raw_capture_bytes ?? null}, error = ${patch.error ?? null}
      where id = ${id}`;
  }

  async lastCompleteHit(vendorId: string): Promise<AttemptRow | null> {
    const [row] = await this.sql<AttemptRow[]>`
      select a.* from refresh_attempts a join refresh_runs r on r.id = a.run_id
      where a.vendor_id = ${vendorId} and a.outcome = 'hit' and a.run_complete and not r.dry_run
      order by a.finished_at desc, a.started_at desc limit 1`;
    return row ?? null;
  }

  async previousAttempt(vendorId: string, excludeId: string | null = null): Promise<AttemptRow | null> {
    const [row] = await this.sql<AttemptRow[]>`
      select a.* from refresh_attempts a join refresh_runs r on r.id = a.run_id
      where a.vendor_id = ${vendorId} and a.finished_at is not null and not r.dry_run and (${excludeId}::uuid is null or a.id <> ${excludeId}::uuid)
      order by a.finished_at desc, a.started_at desc limit 1`;
    return row ?? null;
  }

  async uploadCapture(key: string, bytes: Buffer): Promise<{ uri: string | null; error: string | null }> {
    if (!this.storage) return { uri: null, error: "no capture storage configured: the local capture file stands" };
    return this.storage.upload(key, bytes);
  }

  async setCaptureUri(runId: string, vendorSlug: string, uri: string): Promise<number> {
    const out = await this.sql`
      update refresh_attempts a set raw_capture_uri = ${uri}
      from vendors v where v.id = a.vendor_id and v.slug = ${vendorSlug} and a.run_id = ${runId}::uuid`;
    return out.count;
  }

  async updateVendorPlatform(id: string, platform: Platform, probedAt: string): Promise<void> {
    await this.sql`update vendors set detected_platform = ${platform}, platform_probed_at = ${probedAt} where id = ${id}`;
  }

  async markVendorIngested(id: string, at: string): Promise<void> {
    await this.sql`update vendors set last_ingested_at = ${at} where id = ${id}`;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}

function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

/** The test double. Exposes its tables so a test can assert on what landed. */
export class InMemoryRepo implements Repo {
  readonly compounds = new Map<string, CompoundRow>();
  readonly vendors = new Map<string, VendorRow>();
  readonly offers = new Map<string, OfferRow>();
  readonly observations: ObservationRow[] = [];
  readonly quarantined: QuarantineRow[] = [];
  readonly candidates: CandidateRow[] = [];
  readonly runs = new Map<string, RunRow>();
  readonly attempts = new Map<string, AttemptRow>();
  readonly uploads: { key: string; bytes: number }[] = [];
  readonly fxRates: FxRate[] = [];
  /** What the site would read: offers.id → the row as last published. */
  readonly published = new Map<string, OfferRow>();
  /** Test hook: the clock `countStale` / `softDeleteStale` age rows against. */
  now: () => Date = () => new Date();
  /** Test hook: make `upsertOffer` reject rows this predicate accepts. */
  failUpsertFor: ((row: OfferInsert) => boolean) | null = null;
  private seq = 0;

  private nextId(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  seedCompound(row: CompoundRow): void {
    this.compounds.set(row.id, row);
  }
  seedVendor(row: VendorRow): void {
    this.vendors.set(row.id, row);
  }
  seedOffer(row: OfferRow): void {
    this.offers.set(row.id, row);
  }
  seedAttempt(row: AttemptRow): void {
    this.attempts.set(row.id, row);
  }

  async upsertCompounds(seeds: CompoundSeed[]): Promise<number> {
    for (const s of seeds) {
      const existing = [...this.compounds.values()].find((c) => c.slug === s.slug);
      const id = existing?.id ?? this.nextId("compound");
      this.compounds.set(id, { ...(existing ?? {}), id, slug: s.slug, name: s.name, type: s.type, aliases: s.aliases, known_sizes_mg: s.known_sizes_mg, blend_components: s.blend_components ?? null, is_active: true } as CompoundRow);
    }
    return seeds.length;
  }

  async upsertVendors(seeds: VendorSeed[]): Promise<number> {
    for (const s of seeds) {
      const existing = [...this.vendors.values()].find((v) => v.slug === s.slug);
      const id = existing?.id ?? this.nextId("vendor");
      this.vendors.set(id, { status: "pending", ...(existing ?? {}), id, slug: s.slug, name: s.name, website_url: s.website_url, canonical_domain: s.canonical_domain, origin_country: s.origin_country, detected_platform: existing?.detected_platform ?? s.detected_platform } as VendorRow);
    }
    return seeds.length;
  }

  async listVendors(filter: { status: VendorStatusFilter; slugs?: string[] }): Promise<VendorRow[]> {
    return [...this.vendors.values()]
      .filter((v) => (filter.status === "all" || v.status === filter.status) && (!filter.slugs || filter.slugs.includes(v.slug)))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async listCompounds(): Promise<CompoundRow[]> {
    return [...this.compounds.values()].filter((c) => c.is_active !== false);
  }

  readonly coaCandidates: { vendorId: string; compoundId: string | null; url: string }[] = [];
  async fileCoaCandidate(vendorId: string, compoundId: string | null, url: string): Promise<boolean> {
    if (!/^https:\/\/\S+$/.test(url) || this.coaCandidates.some((c) => c.vendorId === vendorId && c.url === url)) return false;
    this.coaCandidates.push({ vendorId, compoundId, url });
    return true;
  }

  async listOffers(vendorId: string): Promise<OfferRow[]> {
    return [...this.offers.values()].filter((o) => o.vendor_id === vendorId);
  }

  async upsertOffer(row: OfferInsert): Promise<{ id: string; inserted: boolean }> {
    if (this.failUpsertFor?.(row)) throw new Error(`upsert refused for ${row.product_key}#${row.variant_key ?? ""}`);
    const existing = [...this.offers.values()].find((o) => o.vendor_id === row.vendor_id && offerKey(o) === offerKey(row));
    const id = existing?.id ?? this.nextId("offer");
    this.offers.set(id, { ...(existing ?? { created_at: row.observed_at }), ...row, id, variant_key: row.variant_key ?? "", updated_at: row.observed_at } as OfferRow);
    return { id, inserted: !existing };
  }

  async insertObservations(rows: OfferInsert[], meta: { offerIds: Map<string, string>; runLabel: string }): Promise<number> {
    for (const r of rows) this.observations.push({ ...r, id: this.nextId("obs"), offer_id: meta.offerIds.get(offerKey(r)) ?? null, run_label: meta.runLabel } as ObservationRow);
    return rows.length;
  }

  async insertCandidates(rows: CandidateInsert[]): Promise<number> {
    let n = 0;
    for (const r of rows) {
      if (this.candidates.some((c) => c.run_label === r.run_label && c.vendor_id === r.vendor_id && c.product_url === r.product_url)) continue;
      this.candidates.push({ match_candidates: [], ...r, id: this.nextId("cand"), created_at: new Date().toISOString() } as CandidateRow);
      n++;
    }
    return n;
  }

  async quarantine(ids: string[], reason: string, runId: string): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const row = this.offers.get(id);
      if (!row) continue;
      this.offers.delete(id);
      this.quarantined.push({ ...row, id: this.nextId("q"), original_id: id, reason, quarantine_run_id: runId, quarantined_at: new Date().toISOString(), restored_at: null } as QuarantineRow);
      n++;
    }
    return n;
  }

  async restoreRun(runId: string): Promise<number> {
    let n = 0;
    for (const q of this.quarantined) {
      if (q.quarantine_run_id !== runId || q.restored_at) continue;
      const { original_id, reason: _reason, quarantine_run_id: _qr, quarantined_at: _qa, restored_at: _ra, ...rest } = q;
      void _reason;
      void _qr;
      void _qa;
      void _ra;
      this.offers.set(original_id, { ...rest, id: original_id } as OfferRow);
      q.restored_at = new Date().toISOString();
      n++;
    }
    return n;
  }

  async createRun(run: RunInsert): Promise<RunRow> {
    const row = { id: this.nextId("run"), started_at: new Date().toISOString(), finished_at: null, status: "running", verdict: null, baseline_run_id: null, metrics: {}, checks: {}, notes: null, dry_run: true, ...run } as RunRow;
    this.runs.set(row.id, row);
    return row;
  }

  async finishRun(id: string, patch: Partial<RunRow>): Promise<void> {
    const row = this.runs.get(id);
    if (!row) throw new Error(`run ${id} not found`);
    this.runs.set(id, { ...row, ...patch });
  }

  async getRun(id: string): Promise<RunRow | null> {
    return this.runs.get(id) ?? null;
  }

  async getRunByLabel(label: string): Promise<RunRow | null> {
    return [...this.runs.values()].find((r) => r.run_label === label) ?? null;
  }

  async listCommittedRuns(limit = 200): Promise<RunRow[]> {
    return [...this.runs.values()]
      .filter((r) => r.status === "committed" && !r.dry_run)
      .sort((a, b) => String(b.finished_at ?? "").localeCompare(String(a.finished_at ?? "")))
      .slice(0, limit);
  }

  async listAllOffers(): Promise<OfferRow[]> {
    return [...this.offers.values()];
  }

  async countRunOffers(runId: string): Promise<number> {
    return [...this.offers.values()].filter((o) => o.run_id === runId).length;
  }

  private stale(runId: string, days: number): OfferRow[] {
    const cutoff = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    return [...this.offers.values()].filter((o) => o.run_id !== runId && String(o.observed_at) < cutoff);
  }

  async countStale(runId: string, days: number): Promise<number> {
    return this.stale(runId, days).length;
  }

  async softDeleteStale(runId: string, days: number): Promise<number> {
    return this.quarantine(this.stale(runId, days).map((o) => o.id), "stale_aged_out", runId);
  }

  /** The publish rule, as migration 10 states it. */
  private isPublishable(o: OfferRow): boolean {
    const blendVial = o.is_blend && o.form === "vial" && this.compounds.get(o.compound_id)?.type === "Blend";
    return (o.comparable || blendVial) && o.vials_per_pack != null;
  }

  private publishable(): { eligible: OfferRow[]; waiting: number; unconvertible: number } {
    const passed = (o: OfferRow) => {
      const r = o.run_id ? this.runs.get(o.run_id) : undefined;
      return r?.status === "committed" && r.verdict === "pass" && !r.dry_run;
    };
    const convertible = (o: OfferRow) => o.native_currency === "USD" || this.fxRates.some((f) => f.base_currency === o.native_currency && f.quote_currency === "USD");
    const rows = [...this.offers.values()].filter((o) => this.isPublishable(o));
    return { eligible: rows.filter((o) => passed(o) && convertible(o)), waiting: rows.filter((o) => !passed(o)).length, unconvertible: rows.filter((o) => !convertible(o)).length };
  }

  async previewPublish(): Promise<PublishPreview> {
    const p = this.publishable();
    return { eligible: p.eligible.length, waiting: p.waiting, unconvertible: p.unconvertible };
  }

  async publishOffers(runId: string): Promise<PublishSummary> {
    const run = this.runs.get(runId);
    if (!run || run.status !== "committed" || run.verdict !== "pass" || run.dry_run) throw new Error(`publish_offers: run ${runId} is not a committed PASS run`);
    const p = this.publishable();
    let changed = 0;
    for (const o of p.eligible) {
      if (JSON.stringify(this.published.get(o.id)) === JSON.stringify(o)) continue;
      this.published.set(o.id, { ...o });
      changed++;
    }
    let removed = 0;
    for (const id of [...this.published.keys()]) {
      const o = this.offers.get(id);
      if (o && this.isPublishable(o)) continue;
      this.published.delete(id);
      removed++;
    }
    const rows = [...this.published.values()];
    return { publication_id: this.nextId("pub"), offers: rows.length, vendors: new Set(rows.map((r) => r.vendor_id)).size, compounds: new Set(rows.map((r) => r.compound_id)).size, changed, removed, waiting: p.waiting, unconvertible: p.unconvertible };
  }

  async upsertFxRates(rates: FxRate[]): Promise<number> {
    for (const r of rates) {
      const at = this.fxRates.findIndex((x) => x.base_currency === r.base_currency && x.quote_currency === r.quote_currency && x.rate_date === r.rate_date);
      if (at >= 0) this.fxRates[at] = r;
      else this.fxRates.push(r);
    }
    return rates.length;
  }

  async claimAttempt(a: AttemptInsert): Promise<string> {
    const id = this.nextId("attempt");
    this.attempts.set(id, { counts: {}, error: null, finished_at: null, http_status: null, matched: null, outcome: null, products_seen: null, raw_capture_bytes: null, raw_capture_sha256: null, raw_capture_uri: null, rows_written: null, run_complete: false, rung: null, started_at: new Date().toISOString(), ...a, id } as AttemptRow);
    return id;
  }

  async finishAttempt(id: string, patch: Partial<AttemptRow>): Promise<void> {
    const row = this.attempts.get(id);
    if (!row) throw new Error(`attempt ${id} not found`);
    this.attempts.set(id, { ...row, ...patch });
  }

  /** Latest finished first; on an equal timestamp the later-claimed attempt wins (ids are sequential). */
  private latest(rows: AttemptRow[]): AttemptRow | null {
    const seq = (id: string) => Number(id.split("-").pop());
    return rows.sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)) || seq(b.id) - seq(a.id))[0] ?? null;
  }

  /** A dry run reads but applies nothing, so its attempts are never a baseline for a later live run. */
  private live(a: AttemptRow): boolean {
    return this.runs.get(a.run_id)?.dry_run !== true;
  }

  async lastCompleteHit(vendorId: string): Promise<AttemptRow | null> {
    return this.latest([...this.attempts.values()].filter((a) => a.vendor_id === vendorId && a.outcome === "hit" && a.run_complete && a.finished_at && this.live(a)));
  }

  async previousAttempt(vendorId: string, excludeId: string | null = null): Promise<AttemptRow | null> {
    return this.latest([...this.attempts.values()].filter((a) => a.vendor_id === vendorId && a.finished_at && a.id !== excludeId && this.live(a)));
  }

  async uploadCapture(key: string, bytes: Buffer): Promise<{ uri: string | null; error: string | null }> {
    this.uploads.push({ key, bytes: bytes.length });
    return { uri: `storage://offer-raw/${key}`, error: null };
  }

  async setCaptureUri(runId: string, vendorSlug: string, uri: string): Promise<number> {
    const vendor = [...this.vendors.values()].find((v) => v.slug === vendorSlug);
    let n = 0;
    for (const [id, a] of this.attempts) {
      if (a.run_id !== runId || a.vendor_id !== vendor?.id) continue;
      this.attempts.set(id, { ...a, raw_capture_uri: uri });
      n++;
    }
    return n;
  }

  async updateVendorPlatform(id: string, platform: Platform, probedAt: string): Promise<void> {
    const v = this.vendors.get(id);
    if (v) this.vendors.set(id, { ...v, detected_platform: platform, platform_probed_at: probedAt });
  }

  async markVendorIngested(id: string, at: string): Promise<void> {
    const v = this.vendors.get(id);
    if (v) this.vendors.set(id, { ...v, last_ingested_at: at });
  }

  async close(): Promise<void> {}
}
