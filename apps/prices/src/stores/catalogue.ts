// What a store lists (catalogue-cli.ts) and the certificate documents it links (audit-cli.ts): types,
// validation and the pure helpers. Nothing here touches the network or a database.
import type { CompoundSeed } from "../seed/types.ts";
import { arr, bool, day, lit, type StoreSeed } from "./directory.ts";

export const LISTING_FORMS = ["vial", "capsule", "tablet", "nasal", "pen", "topical", "solution", "bulk", "unknown"] as const;
export const LISTING_AVAILABILITY = ["in_stock", "out_of_stock", "backorder", "preorder", "discontinued", "unknown"] as const;
export const LISTING_SOURCES = ["woo_store_api", "woo_embedded_variations", "shopify_products_json", "shopify_product_js", "jsonld"] as const;

export interface ListingSeed {
  compound: string;
  product_name: string;
  variant_label: string | null;
  form: string;
  mg_per_vial: number | null;
  vials_per_pack: number | null;
  total_mg: number | null;
  is_blend: boolean;
  currency: string;
  price_minor: number;
  list_price_minor: number | null;
  on_sale: boolean;
  per_mg_minor_e4: number | null;
  availability: string;
  product_url: string | null;
  /** The store's own figure the price was checked against. */
  raw_price_text: string;
}

export interface ListingRead {
  slug: string;
  observed_on: string;
  /** The feed that answered, or null when none did. */
  source: string | null;
  /** The read reached the end of the catalogue. */
  complete: boolean;
  products_seen: number;
  listings: ListingSeed[];
}

export interface DocumentSeed {
  slug: string;
  url: string;
  label: string;
  compound: string | null;
  found_on: string;
}

const fail = (file: string, key: unknown, why: string): never => {
  throw new Error(`${file} ${JSON.stringify(key)}: ${why}`);
};
const oneOf = (list: readonly string[], v: unknown) => typeof v === "string" && list.includes(v);
const num = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v > 0);

export function validateListings(raw: unknown, stores: StoreSeed[], compounds: Set<string>): ListingRead[] {
  if (!Array.isArray(raw)) fail("store-listings.json", null, "is not an array");
  const known = new Set(stores.map((s) => s.slug));
  const seen = new Set<string>();
  for (const r of raw as ListingRead[]) {
    const key = `${r.slug} ${r.observed_on}`;
    if (!known.has(r.slug)) fail("store-listings.json", key, "no such store");
    if (seen.has(key)) fail("store-listings.json", key, "two reads of one store on one day");
    seen.add(key);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.observed_on)) fail("store-listings.json", key, "bad observed_on");
    if (!oneOf(LISTING_SOURCES, r.source)) fail("store-listings.json", key, "bad source");
    for (const l of r.listings) {
      if (!compounds.has(l.compound)) fail("store-listings.json", key, `unknown compound ${l.compound}`);
      if (!l.product_name || l.product_name.length > 300) fail("store-listings.json", key, "bad product_name");
      if (!/^[A-Z]{3}$/.test(l.currency)) fail("store-listings.json", key, "bad currency");
      if (!(Number.isInteger(l.price_minor) && l.price_minor > 0)) fail("store-listings.json", key, "bad price");
      if (l.list_price_minor !== null && !(Number.isInteger(l.list_price_minor) && l.list_price_minor >= l.price_minor)) fail("store-listings.json", key, "bad list price");
      if (!num(l.mg_per_vial) || !num(l.total_mg) || !(l.vials_per_pack === null || (Number.isInteger(l.vials_per_pack) && l.vials_per_pack >= 1))) fail("store-listings.json", key, "bad quantity");
      if (!oneOf(LISTING_FORMS, l.form) || !oneOf(LISTING_AVAILABILITY, l.availability)) fail("store-listings.json", key, "bad form or availability");
      if (l.product_url !== null && !/^https:\/\/\S+$/.test(l.product_url)) fail("store-listings.json", key, "product_url must be https");
      if (!l.raw_price_text) fail("store-listings.json", key, "no raw price text");
    }
  }
  return raw as ListingRead[];
}

export function validateDocuments(raw: unknown, stores: StoreSeed[], compounds: Set<string>): DocumentSeed[] {
  if (!Array.isArray(raw)) fail("store-documents.json", null, "is not an array");
  const known = new Set(stores.map((s) => s.slug));
  const seen = new Set<string>();
  for (const d of raw as DocumentSeed[]) {
    const key = `${d.slug} ${d.url}`;
    if (!known.has(d.slug)) fail("store-documents.json", key, "no such store");
    if (seen.has(key)) fail("store-documents.json", key, "duplicate");
    seen.add(key);
    if (!/^https:\/\/\S+$/.test(d.url) || d.url.length > 600) fail("store-documents.json", key, "url must be https");
    if (!d.label || d.label.length > 160) fail("store-documents.json", key, "bad label");
    if (d.compound !== null && !compounds.has(d.compound)) fail("store-documents.json", key, "unknown compound");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.found_on)) fail("store-documents.json", key, "bad found_on");
  }
  return raw as DocumentSeed[];
}

/** A readable label for a certificate link: its own text, or its file name made legible. */
export function documentLabel(href: string, label: string): string {
  const own = label.replace(/\s+/g, " ").trim();
  if (own.length >= 4 && !/^(?:view|open|download|click here|here|pdf|coa|link|see)$/i.test(own)) return own.slice(0, 160);
  const file = decodeURIComponent(new URL(href).pathname.split("/").pop() ?? "")
    .replace(/\.(?:pdf|png|jpe?g|webp)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (file || own || "Certificate").slice(0, 160);
}

// ── SQL ────────────────────────────────────────────────────────────────────
const n = (v: number | null): string => (v === null ? "null" : String(v));

/**
 * The compounds (as `pnpm prices seed` upserts them), the catalogue reads with their listings, and the
 * certificate documents. Idempotent: a read already loaded (same store, same day) is skipped with its
 * listings; a document already known is skipped.
 */
export function catalogueSql(compounds: CompoundSeed[], reads: ListingRead[], documents: DocumentSeed[]): string {
  const out: string[] = [];
  if (compounds.length) {
    out.push(
      "insert into prices.compounds (slug, name, type, aliases, known_sizes_mg, blend_components) values",
      compounds.map((c) => `  (${[lit(c.slug), lit(c.name), lit(c.type), arr(c.aliases), c.known_sizes_mg.length ? `array[${c.known_sizes_mg.join(", ")}]::numeric[]` : "'{}'::numeric[]",
        c.blend_components ? `${lit(JSON.stringify(c.blend_components))}::jsonb` : "null"].join(", ")})`).join(",\n"),
      "on conflict (slug) do update set",
      "  name = excluded.name, type = excluded.type, aliases = excluded.aliases,",
      "  known_sizes_mg = excluded.known_sizes_mg, blend_components = excluded.blend_components;",
      "",
    );
  }
  const withRows = reads.filter((r) => r.source);
  if (withRows.length) {
    const rows = withRows.flatMap((r) => r.listings.map((l) => `  (${[lit(r.slug), day(r.observed_on), lit(l.compound), lit(l.product_name), lit(l.variant_label), lit(l.form),
      n(l.mg_per_vial), n(l.vials_per_pack), n(l.total_mg), bool(l.is_blend), lit(l.currency), n(l.price_minor), n(l.list_price_minor), bool(l.on_sale),
      n(l.per_mg_minor_e4), lit(l.availability), lit(l.product_url), lit(l.raw_price_text)].join(", ")})`));
    out.push(
      "with read as (",
      "  insert into prices.store_catalogue_reads (vendor_id, observed_on, source, complete, products_seen)",
      "  select v.id, x.observed_on, x.source, x.complete, x.products_seen",
      "  from (values",
      withRows.map((r) => `    (${[lit(r.slug), day(r.observed_on), lit(r.source), bool(r.complete), n(r.products_seen)].join(", ")})`).join(",\n"),
      "  ) as x (slug, observed_on, source, complete, products_seen)",
      "  join prices.vendors v on v.slug = x.slug",
      "  on conflict (vendor_id, observed_on) do nothing",
      "  returning id, vendor_id, observed_on)",
    );
    if (rows.length) {
      out.push(
        "insert into prices.store_listings (read_id, compound_id, product_name, variant_label, form, mg_per_vial, vials_per_pack, total_mg, is_blend,",
        "                                   currency, price_minor, list_price_minor, on_sale, per_mg_minor_e4, availability, product_url, raw_price_text)",
        "select read.id, c.id, l.product_name, l.variant_label, l.form, l.mg_per_vial::numeric, l.vials_per_pack::integer, l.total_mg::numeric, l.is_blend,",
        "       l.currency, l.price_minor::bigint, l.list_price_minor::bigint, l.on_sale, l.per_mg_minor_e4::bigint, l.availability, l.product_url, l.raw_price_text",
        "from read",
        "join prices.vendors v on v.id = read.vendor_id",
        "join (values",
        rows.join(",\n"),
        ") as l (slug, observed_on, compound, product_name, variant_label, form, mg_per_vial, vials_per_pack, total_mg, is_blend,",
        "        currency, price_minor, list_price_minor, on_sale, per_mg_minor_e4, availability, product_url, raw_price_text)",
        "  on l.slug = v.slug and l.observed_on = read.observed_on",
        "join prices.compounds c on c.slug = l.compound;",
        "",
      );
    } else {
      out.push("select 1 from read;", "");
    }
  }
  if (documents.length) {
    out.push(
      "insert into prices.store_documents (vendor_id, url, label, compound_id, found_on)",
      "select v.id, d.url, d.label, c.id, d.found_on",
      "from (values",
      documents.map((d) => `  (${[lit(d.slug), lit(d.url), lit(d.label), lit(d.compound), day(d.found_on)].join(", ")})`).join(",\n"),
      ") as d (slug, url, label, compound, found_on)",
      "join prices.vendors v on v.slug = d.slug",
      "left join prices.compounds c on c.slug = d.compound",
      "on conflict (vendor_id, url) do nothing;",
      "",
    );
  }
  return out.join("\n");
}
