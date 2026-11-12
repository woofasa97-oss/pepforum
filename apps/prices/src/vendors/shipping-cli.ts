// pnpm vendors:shipping            show what the evidence file would record (changes nothing)
// pnpm vendors:shipping --apply    record it: vendors.ships_to and ships_to_source, all or nothing
//
// Acts on the database PRICES_DB_URL names: the local one by default (.env.local); the hosted
// one only after `set -a; source .env.hosted; set +a`, and only with the owner's permission.
// Exit 0 done, 1 error (nothing written).
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { readPipelineEnv } from "../env.ts";
import { validateOrigin } from "./origin.ts";
import { shipsSource, validateEvidence } from "./shipping.ts";
import { forSite } from "./site-shipping.ts";

const FILE = "src/vendors/shipping-evidence.json";
const say = (line: string) => process.stdout.write(`${line}\n`);

// Not top-level await: the project compiles scripts as CommonJS (as pipeline/cli.ts).
async function main(): Promise<void> {
  const { record: evidence, skipped } = forSite(
    validateEvidence(JSON.parse(readFileSync(FILE, "utf8"))),
    validateOrigin(JSON.parse(readFileSync("src/vendors/origin-evidence.json", "utf8"))),
  );
  if (skipped.length > 0) say(`not recorded for the site (not based in Canada; X-posting evidence only): ${skipped.length}`);
  const apply = process.argv.includes("--apply");
  const { dbUrl } = readPipelineEnv();
  // Which database, before anything is read or written (the hosted one needs the owner's permission).
  say(`database: ${new URL(dbUrl).hostname}${apply ? "  (recording)" : ""}`);
  const sql = postgres(dbUrl, { max: 1, connection: { search_path: "prices, pg_catalog" } });
  try {
    const current = await sql<{ slug: string; origin_country: string; ships_to: string[] }[]>`select slug, origin_country, ships_to from vendors where slug in ${sql(evidence.map((e) => e.slug))}`;
    const bySlug = new Map(current.map((r) => [r.slug, r]));
    const missing = evidence.filter((e) => !bySlug.has(e.slug)).map((e) => e.slug);
    if (missing.length > 0) throw new Error(`not in the vendors table: ${missing.join(", ")}`);
    for (const e of evidence) say(`${e.slug.padEnd(30)} ${bySlug.get(e.slug)?.origin_country}  {${bySlug.get(e.slug)?.ships_to.join(",")}} → {${e.ships_to.join(",")}}`);
    if (!apply) {
      say("(dry run — add --apply to record)");
      return;
    }
    await sql.begin(async (tx) => {
      for (const e of evidence) {
        const done = await tx`update vendors set ships_to = ${e.ships_to}, ships_to_source = ${shipsSource(e)} where slug = ${e.slug} returning slug`;
        if (done.length !== 1) throw new Error(`${e.slug}: not updated`);
      }
    });
    say(`recorded shipping for ${evidence.length} vendors`);
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`vendors:shipping: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
