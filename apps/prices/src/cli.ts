// `pnpm prices <command>` — the entry point. It only assembles the real dependencies; every
// decision lives in commands.ts, where it is tested. One JSON summary on stdout, logs on stderr.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import compounds from "../seed/compounds.json" with { type: "json" };
import vendors from "../seed/vendors.json" with { type: "json" };
import { runCommand, EXIT } from "./commands.ts";
import { readPipelineEnv, vendorAuthorizationFromEnv } from "./env.ts";
import { createFetcher, PEPFORUM_USER_AGENT } from "./fetch/http.ts";
import { PostgresRepo } from "./ingest/repo.ts";
import { log } from "./log.ts";
import type { CompoundSeed, VendorSeed } from "./seed/types.ts";

/** Raw captures of every fetch, kept locally (git-ignored); the scheduled workflow keeps them as a private artifact. */
const CAPTURE_DIR = ".raw-capture";
const CAPTURE_SUFFIX = ".ndjson.gz";

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "user-agent": PEPFORUM_USER_AGENT, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (res.status !== 200) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json();
}

runCommand(process.argv.slice(2), {
  openRepo: () => new PostgresRepo(readPipelineEnv().dbUrl),
  // Only the probe takes this fetcher; a refresh builds one capturing fetcher per vendor itself.
  fetchText: process.argv[2] === "probe" ? () => createFetcher() : undefined,
  authorization: vendorAuthorizationFromEnv(),
  fetchJson,
  isTTY: Boolean(process.stdout.isTTY && process.stdin.isTTY),
  env: process.env,
  out: (summary) => process.stdout.write(JSON.stringify(summary) + "\n"),
  log,
  seeds: { compounds: compounds as CompoundSeed[], vendors: vendors as VendorSeed[] },
  captureDir: CAPTURE_DIR,
  readCaptures: (runLabel) => {
    const dir = join(CAPTURE_DIR, runLabel);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(CAPTURE_SUFFIX))
      .sort()
      .map((f) => ({ slug: f.slice(0, -CAPTURE_SUFFIX.length), bytes: readFileSync(join(dir, f)) }));
  },
}).then(
  (code) => process.exit(code),
  (err: unknown) => {
    log("fatal", { error: err instanceof Error ? err.message : String(err) });
    process.exit(EXIT.error);
  },
);
