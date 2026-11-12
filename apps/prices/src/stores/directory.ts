// The Stores directory's data (…035, ADR-0011): stores.json, labs.json and store-audits.json in seed/.
// Pure: validation, the rule for unverified quotes, and the SQL that loads the files. Nothing here
// touches the network or a database; directory-cli.ts does.
import { COUNTRIES, LAB_TIERS, STORE_AUDIT_CRITERIA, STORE_AUDIT_RESULTS, STORE_KINDS } from "@pepforum/database";
import type { LabTier, StoreAuditCriterion, StoreAuditResult, StoreKind } from "@pepforum/database";

export interface StoreSeed {
  slug: string;
  name: string;
  website_url: string;
  canonical_domain: string;
  kind: StoreKind;
  /** ISO 3166-1 alpha-2 from the store's own pages, or null when they don't say. */
  origin_country: string | null;
  /** The page that says where it is based. */
  origin_source: string | null;
  /** Countries its own pages say it ships to. */
  ships_to: string[];
  ships_worldwide: boolean;
  native_currency: string | null;
}

export interface LabSeed {
  slug: string;
  name: string;
  website_url: string | null;
  country: string | null;
  tier: LabTier;
  accreditation_body: string | null;
  accreditation_number: string | null;
  verify_how: string | null;
  evidence_url: string | null;
  evidence_quote: string | null;
  checked_on: string;
}

export interface CheckSeed {
  result: StoreAuditResult;
  /** A short fact, e.g. the labs named. */
  value: string | null;
  source_url: string | null;
  /** The store's words, verbatim ("…" between fragments). */
  quote: string | null;
  /** The day our reader found the quote on its page; null when not (yet) re-checked. */
  quote_verified_on: string | null;
}

export interface AuditSeed {
  slug: string;
  standard_version: string;
  audited_on: string;
  reachable: boolean;
  pages_read: string[];
  checks: Record<StoreAuditCriterion, CheckSeed>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const countries = new Set<string>(COUNTRIES);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const https = (v: unknown, max = 600): v is string => typeof v === "string" && /^https:\/\/[^\s]+$/.test(v) && v.length <= max;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() !== "" && v.length <= max;
const orNull = <T>(v: unknown, ok: (x: unknown) => x is T): v is T | null => v === null || v === undefined || ok(v);
const isDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

const fail = (file: string, key: unknown, why: string): never => {
  throw new Error(`${file} ${JSON.stringify(key)}: ${why}`);
};

/** A slug for a store or lab name: lower case, dashes, at most 60 characters. */
export function slugify(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
}

/** The site's host without "www.": the key the directory deduplicates on. */
export function domainOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

export function validateStores(raw: unknown): StoreSeed[] {
  if (!Array.isArray(raw)) fail("stores.json", null, "is not an array");
  const slugs = new Set<string>();
  const domains = new Set<string>();
  for (const s of raw as Record<string, unknown>[]) {
    const key = s.slug;
    if (typeof key !== "string" || !SLUG.test(key) || key.length > 60) fail("stores.json", key, "bad slug");
    if (slugs.has(key as string)) fail("stores.json", key, "duplicate slug");
    slugs.add(key as string);
    if (!text(s.name, 120)) fail("stores.json", key, "bad name");
    if (!https(s.website_url, 300)) fail("stores.json", key, "website_url must be https");
    if (s.canonical_domain !== domainOf(s.website_url as string)) fail("stores.json", key, "canonical_domain must be the website's host");
    if (domains.has(s.canonical_domain as string)) fail("stores.json", key, "duplicate domain");
    domains.add(s.canonical_domain as string);
    if (!oneOf(STORE_KINDS, s.kind)) fail("stores.json", key, "bad kind");
    if (!orNull(s.origin_country, (v): v is string => typeof v === "string" && countries.has(v))) fail("stores.json", key, "origin_country must be an ISO code or null");
    if (!orNull(s.origin_source, https)) fail("stores.json", key, "origin_source must be https or null");
    if (s.origin_country && !s.origin_source) fail("stores.json", key, "a country needs the page that says so");
    if (!Array.isArray(s.ships_to) || !s.ships_to.every((c) => typeof c === "string" && countries.has(c))) fail("stores.json", key, "ships_to must be ISO codes");
    if (typeof s.ships_worldwide !== "boolean") fail("stores.json", key, "ships_worldwide must be true or false");
    if (!orNull(s.native_currency, (v): v is string => typeof v === "string" && /^[A-Z]{3}$/.test(v))) fail("stores.json", key, "native_currency must be ISO 4217 or null");
  }
  return raw as StoreSeed[];
}

export function validateLabs(raw: unknown): LabSeed[] {
  if (!Array.isArray(raw)) fail("labs.json", null, "is not an array");
  const slugs = new Set<string>();
  for (const l of raw as Record<string, unknown>[]) {
    const key = l.slug;
    if (typeof key !== "string" || !SLUG.test(key) || key.length > 60 || slugs.has(key)) fail("labs.json", key, "bad or duplicate slug");
    slugs.add(key as string);
    if (!text(l.name, 120)) fail("labs.json", key, "bad name");
    if (!orNull(l.website_url, https)) fail("labs.json", key, "website_url must be https or null");
    if (!orNull(l.country, (v): v is string => typeof v === "string" && countries.has(v))) fail("labs.json", key, "bad country");
    if (!oneOf(LAB_TIERS, l.tier)) fail("labs.json", key, "bad tier");
    if (!orNull(l.accreditation_body, (v): v is string => text(v, 120))) fail("labs.json", key, "accreditation_body too long");
    if (!orNull(l.accreditation_number, (v): v is string => text(v, 60))) fail("labs.json", key, "accreditation_number too long");
    if (!orNull(l.verify_how, (v): v is string => text(v, 400))) fail("labs.json", key, "verify_how too long");
    if (!orNull(l.evidence_url, https)) fail("labs.json", key, "evidence_url must be https or null");
    if (!orNull(l.evidence_quote, (v): v is string => text(v, 600))) fail("labs.json", key, "evidence_quote too long");
    if (l.evidence_quote && !l.evidence_url) fail("labs.json", key, "a quote needs its page");
    if (l.tier === "accredited" && !(l.accreditation_body && l.accreditation_number)) fail("labs.json", key, "accredited needs the body and certificate number");
    if (!isDay(l.checked_on)) fail("labs.json", key, "checked_on must be YYYY-MM-DD");
  }
  return raw as LabSeed[];
}

export function validateAudits(raw: unknown, stores: StoreSeed[]): AuditSeed[] {
  if (!Array.isArray(raw)) fail("store-audits.json", null, "is not an array");
  const known = new Set(stores.map((s) => s.slug));
  const seen = new Set<string>();
  for (const a of raw as Record<string, unknown>[]) {
    const key = `${String(a.slug)} ${String(a.audited_on)}`;
    if (!known.has(a.slug as string)) fail("store-audits.json", key, "no such store in stores.json");
    if (seen.has(key)) fail("store-audits.json", key, "two audits of one store on one day");
    seen.add(key);
    if (typeof a.standard_version !== "string" || !/^\d+\.\d+(\.\d+)?$/.test(a.standard_version)) fail("store-audits.json", key, "bad standard_version");
    if (!isDay(a.audited_on)) fail("store-audits.json", key, "audited_on must be YYYY-MM-DD");
    if (typeof a.reachable !== "boolean") fail("store-audits.json", key, "reachable must be true or false");
    if (!Array.isArray(a.pages_read) || !a.pages_read.every((p) => https(p))) fail("store-audits.json", key, "pages_read must be https addresses");
    const checks = a.checks as Record<string, Record<string, unknown>> | undefined;
    if (!checks || typeof checks !== "object") fail("store-audits.json", key, "no checks");
    const names = Object.keys(checks as object);
    const missing = STORE_AUDIT_CRITERIA.filter((c) => !names.includes(c));
    if (missing.length) fail("store-audits.json", key, `missing checks: ${missing.join(", ")}`);
    for (const name of names) {
      const c = (checks as Record<string, Record<string, unknown>>)[name];
      const where = `${key} ${name}`;
      if (!oneOf(STORE_AUDIT_CRITERIA, name)) fail("store-audits.json", where, "unknown check");
      if (!oneOf(STORE_AUDIT_RESULTS, c.result)) fail("store-audits.json", where, "bad result");
      if (!a.reachable && c.result !== "unchecked") fail("store-audits.json", where, "an unreachable site has only unchecked results");
      if (!orNull(c.value, (v): v is string => text(v, 300))) fail("store-audits.json", where, "value too long");
      if (!orNull(c.source_url, https)) fail("store-audits.json", where, "source_url must be https or null");
      if (!orNull(c.quote, (v): v is string => text(v, 600))) fail("store-audits.json", where, "quote too long");
      if (c.quote && !c.source_url) fail("store-audits.json", where, "a quote needs its page");
      if (!orNull(c.quote_verified_on, isDay)) fail("store-audits.json", where, "quote_verified_on must be YYYY-MM-DD or null");
      if (c.quote_verified_on && !c.quote) fail("store-audits.json", where, "a verified date needs a quote");
    }
  }
  return raw as AuditSeed[];
}

/**
 * What may be published (ADR-0011): a finding against a store ("not met") stands only on words our own
 * reader found on the store's page. Unverified, it becomes "unchecked" and loses its quote. A finding in
 * the store's favour may keep an unverified quote; the site says it was not re-checked.
 */
export function publishable(check: CheckSeed): CheckSeed {
  if (check.result === "not_met" && !check.quote_verified_on) {
    return { result: "unchecked", value: null, source_url: null, quote: null, quote_verified_on: null };
  }
  return check;
}

// ── SQL ────────────────────────────────────────────────────────────────────
// Postgres text cannot hold NUL; drop it before quoting.
export const lit = (v: string | null | undefined): string => (v === null || v === undefined ? "null" : `'${v.split(String.fromCharCode(0)).join("").replace(/'/g, "''")}'`);
export const day = (v: string | null): string => (v === null ? "null" : `${lit(v)}::date`);
export const arr = (v: string[]): string => (v.length === 0 ? "'{}'::text[]" : `array[${v.map(lit).join(", ")}]::text[]`);
export const bool = (v: boolean): string => (v ? "true" : "false");

/**
 * A migration that loads the three files. Idempotent: a store already listed keeps what an admin or the
 * price pipeline set and only gains what it lacks; a lab is refreshed; an audit already loaded is skipped.
 */
export function directorySql(stores: StoreSeed[], labs: LabSeed[], audits: AuditSeed[], header: string): string {
  const out: string[] = [header.trimEnd(), ""];
  if (stores.length) {
    out.push(
      "insert into prices.vendors (slug, name, website_url, canonical_domain, kind, origin_country, origin_source, ships_to, ships_worldwide, native_currency) values",
      stores.map((s) => `  (${[lit(s.slug), lit(s.name), lit(s.website_url), lit(s.canonical_domain), lit(s.kind), lit(s.origin_country),
        lit(s.origin_source), arr(s.ships_to), bool(s.ships_worldwide), lit(s.native_currency)].join(", ")})`).join(",\n"),
      "on conflict (slug) do update set",
      "  kind = excluded.kind,",
      "  origin_country = coalesce(prices.vendors.origin_country, excluded.origin_country),",
      "  origin_source = coalesce(prices.vendors.origin_source, excluded.origin_source),",
      "  ships_to = case when cardinality(prices.vendors.ships_to) = 0 then excluded.ships_to else prices.vendors.ships_to end,",
      "  ships_worldwide = prices.vendors.ships_worldwide or excluded.ships_worldwide,",
      "  native_currency = coalesce(prices.vendors.native_currency, excluded.native_currency);",
      "",
    );
  }
  if (labs.length) {
    out.push(
      "insert into prices.labs (slug, name, website_url, country, tier, accreditation_body, accreditation_number, verify_how, evidence_url, evidence_quote, checked_on) values",
      labs.map((l) => `  (${[lit(l.slug), lit(l.name), lit(l.website_url), lit(l.country), lit(l.tier), lit(l.accreditation_body),
        lit(l.accreditation_number), lit(l.verify_how), lit(l.evidence_url), lit(l.evidence_quote), day(l.checked_on)].join(", ")})`).join(",\n"),
      "on conflict (slug) do update set",
      "  name = excluded.name, website_url = excluded.website_url, country = excluded.country, tier = excluded.tier,",
      "  accreditation_body = excluded.accreditation_body, accreditation_number = excluded.accreditation_number,",
      "  verify_how = excluded.verify_how, evidence_url = excluded.evidence_url, evidence_quote = excluded.evidence_quote,",
      "  checked_on = excluded.checked_on;",
      "",
    );
  }
  if (audits.length) {
    const rows: string[] = [];
    for (const a of audits) {
      for (const criterion of STORE_AUDIT_CRITERIA) {
        const c = publishable(a.checks[criterion]);
        rows.push(`  (${[lit(a.slug), day(a.audited_on), lit(criterion), lit(c.result), lit(c.value), lit(c.source_url), lit(c.quote), day(c.quote_verified_on)].join(", ")})`);
      }
    }
    out.push(
      "with audit as (",
      "  insert into prices.store_audits (vendor_id, standard_version, audited_on, reachable, pages_read)",
      "  select v.id, x.standard_version, x.audited_on, x.reachable, x.pages_read",
      "  from (values",
      audits.map((a) => `    (${[lit(a.slug), lit(a.standard_version), day(a.audited_on), bool(a.reachable), arr(a.pages_read)].join(", ")})`).join(",\n"),
      "  ) as x (slug, standard_version, audited_on, reachable, pages_read)",
      "  join prices.vendors v on v.slug = x.slug",
      "  on conflict (vendor_id, standard_version, audited_on) do nothing",
      "  returning id, vendor_id, audited_on)",
      "insert into prices.store_audit_checks (audit_id, criterion, result, value, source_url, quote, quote_verified_on)",
      "select audit.id, c.criterion, c.result, c.value, c.source_url, c.quote, c.quote_verified_on",
      "from audit",
      "join prices.vendors v on v.id = audit.vendor_id",
      "join (values",
      rows.join(",\n"),
      ") as c (slug, audited_on, criterion, result, value, source_url, quote, quote_verified_on)",
      "  on c.slug = v.slug and c.audited_on = audit.audited_on;",
      "",
    );
  }
  return out.join("\n");
}
