// pnpm vendors:discounts            show what the evidence file would record (changes nothing)
// pnpm vendors:discounts --apply    record it: each listed vendor's vendor-wide vial tiers in
//                                   quantity_tiers are replaced by the file's, all or nothing
//
// Acts on the database PRICES_DB_URL names: the local one by default (.env.local); the hosted
// one only after `set -a; source .env.hosted; set +a`, and only with the owner's permission.
// Exit 0 done, 1 error (nothing written).
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { readPipelineEnv } from "../env.ts";
import { tierRows, validateDiscounts } from "./discounts.ts";

const FILE = "src/vendors/discount-evidence.json";
const say = (line: string) => process.stdout.write(`${line}\n`);
const tiersText = (tiers: { vials: number; percent: number }[]) => (tiers.length === 0 ? "none" : tiers.map((t) => `${t.percent}%@${t.vials}`).join(" "));

// Not top-level await: the project compiles scripts as CommonJS (as pipeline/cli.ts).
async function main(): Promise<void> {
  const evidence = validateDiscounts(JSON.parse(readFileSync(FILE, "utf8")));
  const apply = process.argv.includes("--apply");
  const { dbUrl } = readPipelineEnv();
  // Which database, before anything is read or written (the hosted one needs the owner's permission).
  say(`database: ${new URL(dbUrl).hostname}${apply ? "  (recording)" : ""}`);
  const sql = postgres(dbUrl, { max: 1, connection: { search_path: "prices, pg_catalog" } });
  try {
    const vendors = await sql<{ id: string; slug: string }[]>`select id, slug from vendors where slug in ${sql(evidence.map((e) => e.slug))}`;
    const idOf = new Map(vendors.map((v) => [v.slug, v.id]));
    const missing = evidence.filter((e) => !idOf.has(e.slug)).map((e) => e.slug);
    if (missing.length > 0) throw new Error(`not in the vendors table: ${missing.join(", ")}`);
    const current = await sql<{ slug: string; threshold: number; discount_pct: string }[]>`
      select v.slug, t.threshold, t.discount_pct from quantity_tiers t join vendors v on v.id = t.vendor_id
      where t.compound_id is null and t.basis = 'vials' and v.slug in ${sql(evidence.map((e) => e.slug))} order by t.threshold`;
    const now = (slug: string) => current.filter((r) => r.slug === slug).map((r) => ({ vials: r.threshold, percent: Number(r.discount_pct) }));
    for (const e of evidence) if (e.tiers.length > 0 || now(e.slug).length > 0) say(`${e.slug.padEnd(28)} ${tiersText(now(e.slug)).padEnd(24)} → ${tiersText(e.tiers)}`);
    say(`${evidence.filter((e) => e.tiers.length > 0).length} vendors with a discount, ${evidence.length} checked`);
    if (!apply) {
      say("(dry run — add --apply to record)");
      return;
    }
    await sql.begin(async (tx) => {
      for (const e of evidence) {
        const id = idOf.get(e.slug) ?? "";
        await tx`delete from quantity_tiers where vendor_id = ${id} and compound_id is null and basis = 'vials'`;
        const rows = tierRows(e, id);
        if (rows.length > 0) await tx`insert into quantity_tiers ${tx(rows)}`;
      }
    });
    say(`recorded multipack discounts for ${evidence.length} vendors`);
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`vendors:discounts: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
