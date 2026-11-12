// pnpm vendors:quote-check — reads each evidence page once (robots.txt honoured, as PepforumsBot,
// one page a second) and says whether every quote in origin-evidence.json and shipping-evidence.json
// is still on its page. Reads only. Exit 1 when a quote is missing; a page it could not read is
// reported, not counted as missing.
import { readFileSync } from "node:fs";
import { createFetcher } from "../fetch/http.ts";
import { realSleep } from "../fetch/pacing.ts";
import { validateOrigin } from "./origin.ts";
import { missingFragments, pageText } from "./quote-check.ts";
import { validateEvidence } from "./shipping.ts";

const say = (line: string) => process.stdout.write(`${line}\n`);

// Not top-level await: the project compiles scripts as CommonJS (as pipeline/cli.ts).
async function main(): Promise<void> {
  const origin = validateOrigin(JSON.parse(readFileSync("src/vendors/origin-evidence.json", "utf8")));
  const shipping = validateEvidence(JSON.parse(readFileSync("src/vendors/shipping-evidence.json", "utf8")));
  const checks = [
    ...origin.filter((e) => e.quote.trim() !== "").map((e) => ({ file: "origin", slug: e.slug, source: e.source, quote: e.quote })),
    ...shipping.map((e) => ({ file: "shipping", slug: e.slug, source: e.source, quote: e.quote })),
  ];
  const fetchText = createFetcher();
  const pages = new Map<string, { text: string } | { error: string }>();
  let missing = 0;
  let unread = 0;
  for (const c of checks) {
    if (!pages.has(c.source)) {
      const r = await fetchText(c.source);
      pages.set(c.source, r.state === "hit" && r.body !== null ? { text: pageText(r.body) } : { error: r.error ?? `status ${r.status ?? "none"}` });
      await realSleep(1000);
    }
    const page = pages.get(c.source);
    if (!page || "error" in page) {
      unread++;
      say(`${c.file.padEnd(8)} ${c.slug.padEnd(32)} not read: ${page && "error" in page ? page.error : "unknown"}`);
      continue;
    }
    const gone = missingFragments(page.text, c.quote);
    if (gone.length > 0) missing++;
    say(`${c.file.padEnd(8)} ${c.slug.padEnd(32)} ${gone.length === 0 ? "ok" : `MISSING ${gone.map((g) => JSON.stringify(g)).join(" | ")}`}`);
  }
  say(`${checks.length} quotes on ${pages.size} pages: ${missing} missing, ${unread} not read`);
  if (missing > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
