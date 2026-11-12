// pnpm --filter @pepforum/prices stores:catalogue --cache <dir> [--stores a,b] [--refresh]
//
// What each listed store sells, and at what listed price, read from its own product feed (WooCommerce
// Store API or Shopify products.json) with the price pipeline's own ladder, compound matching and offer
// rules (a price must appear in the store's raw text; the currency must be stated; the product address
// must be on the store's own brand). Writes seed/store-listings.json: one dated read per store.
//
// This is the Stores directory's listing (ADR-0011): dated, in the store's currency, never compared or
// ranked. The Prices section's comparisons still come only from gate-passed runs (docs/PRICES.md).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readIfPresent } from "./files.ts";
import path from "node:path";
import { createFetcher } from "../fetch/http.ts";
import { realSleep } from "../fetch/pacing.ts";
import type { CompoundRow, VendorRow } from "../ingest/repo.ts";
import { buildOfferRow } from "../ingest/build-offer.ts";
import { attemptFeeds, withCanonicalQuantity } from "../ladder/ladder.ts";
import type { CompoundSeed } from "../seed/types.ts";
import { buildProductIndex, resolveProduct } from "../units/blend-match.ts";
import { type ListingRead, type ListingSeed, validateListings } from "./catalogue.ts";
import { validateStores } from "./directory.ts";

const say = (line: string) => process.stdout.write(`${line}\n`);
const MAX_LISTINGS = 400;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const cacheDir = opt("cache");
  if (!cacheDir) throw new Error("usage: stores:catalogue --cache <dir> [--stores a,b] [--refresh]");
  const dir = path.join(cacheDir, "catalogue");
  mkdirSync(dir, { recursive: true });
  const only = opt("stores")?.split(",");
  const refresh = args.includes("--refresh");
  const now = new Date();
  const day = now.toISOString().slice(0, 10);

  const stores = validateStores(JSON.parse(readFileSync("seed/stores.json", "utf8")));
  const seeds = JSON.parse(readFileSync("seed/compounds.json", "utf8")) as CompoundSeed[];
  const rows = seeds.map((c) => ({ id: c.slug, slug: c.slug, name: c.name, aliases: c.aliases, type: c.type, blend_components: c.blend_components ?? null }));
  const index = buildProductIndex(rows);
  const compoundsBySlug = new Map(seeds.map((c) => [c.slug, { ...c, id: c.slug, blend_components: c.blend_components ?? null } as unknown as CompoundRow]));
  const unreadable = new Set(
    (JSON.parse(readFileSync("seed/store-audits.json", "utf8")) as Array<{ slug: string; reachable: boolean }>).filter((a) => !a.reachable).map((a) => a.slug),
  );

  const fetchText = createFetcher();
  const reads: ListingRead[] = [];
  const queue = stores.filter((s) => (!only || only.includes(s.slug)) && !unreadable.has(s.slug));
  let done = 0;
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const file = path.join(dir, `${s.slug}.json`);
      let read: ListingRead;
      const cached = refresh ? null : readIfPresent(file);
      if (cached !== null) {
        read = JSON.parse(cached) as ListingRead;
      } else {
        const vendor = { id: s.slug, slug: s.slug, name: s.name, website_url: s.website_url, canonical_domain: s.canonical_domain } as unknown as VendorRow;
        // The feed first; a shop whose feed is shut or absent is read from its product pages, found through its sitemap.
        let ladder = await attemptFeeds(s.website_url, fetchText, { platform: null, sleep: realSleep });
        if (ladder.state !== "hit") ladder = await attemptFeeds(s.website_url, fetchText, { platform: "jsonld", sleep: realSleep });
        const listings: ListingSeed[] = [];
        const seen = new Set<string>();
        for (const p of withCanonicalQuantity(ladder.products)) {
          const compoundSlug = resolveProduct(p, index);
          const compound = compoundSlug ? compoundsBySlug.get(compoundSlug) : undefined;
          if (!compound) continue;
          const built = buildOfferRow(p, { vendor, compound, runId: null, now, previous: null, blends: index.blends });
          if (!built.ok) continue;
          const r = built.row;
          const key = `${compound.slug}|${r.product_name}|${r.variant_label ?? ""}|${r.price_minor}`;
          if (seen.has(key)) continue;
          seen.add(key);
          listings.push({
            compound: compound.slug, product_name: r.product_name.slice(0, 300), variant_label: r.variant_label?.slice(0, 200) ?? null,
            form: r.form ?? "unknown", mg_per_vial: r.mg_per_vial ?? null, vials_per_pack: r.vials_per_pack ?? null, total_mg: r.total_mg ?? null,
            is_blend: Boolean(r.is_blend), currency: r.native_currency, price_minor: r.price_minor, list_price_minor: r.list_price_minor ?? null,
            on_sale: Boolean(r.on_sale), per_mg_minor_e4: r.per_mg_minor_e4 ?? null, availability: r.availability ?? "unknown",
            product_url: r.product_url && /^https:\/\//.test(r.product_url) ? r.product_url.slice(0, 600) : null,
            raw_price_text: r.raw_price_text.slice(0, 200),
          });
          if (listings.length >= MAX_LISTINGS) break;
        }
        read = { slug: s.slug, observed_on: day, source: ladder.rung, complete: ladder.complete, products_seen: ladder.products.length, listings };
        writeFileSync(file, JSON.stringify(read));
      }
      if (read.source) reads.push(read);
      done++;
      if (done % 25 === 0) say(`${done} stores read`);
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));

  const out = validateListings(reads.sort((a, b) => a.slug.localeCompare(b.slug)), stores, new Set(seeds.map((c) => c.slug)));
  writeFileSync("seed/store-listings.json", `${JSON.stringify(out, null, 1)}\n`);
  const withRows = out.filter((r) => r.listings.length > 0);
  say(`${out.length} stores answered a product feed; ${withRows.length} list matched peptides; ${withRows.reduce((n, r) => n + r.listings.length, 0)} listings`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exitCode = 1;
});
