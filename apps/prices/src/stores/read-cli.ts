// pnpm --filter @pepforum/prices stores:read <https url> — prints a page's visible text and its same-site
// links, read exactly as the quote checker reads it (PepforumsBot, robots.txt honoured). An audit's quotes
// are copied from this output, so stores:check finds them on the page. Reads only.
import { createFetcher } from "../fetch/http.ts";
import { visibleText } from "../vendors/quote-check.ts";

const MAX_TEXT = 24_000;
const MAX_LINKS = 150;

async function main(): Promise<void> {
  const url = process.argv[2] ?? "";
  if (!/^https:\/\/\S+$/.test(url)) throw new Error("usage: read-cli.ts <https url>");
  const r = await createFetcher()(url);
  if (r.state !== "hit" || r.body === null) {
    process.stdout.write(`NOT READ ${url}: ${r.error ?? `status ${r.status ?? "none"}`}\n`);
    process.exitCode = 3;
    return;
  }
  const base = new URL(url);
  const links = new Map<string, string>();
  for (const m of r.body.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const href = new URL(m[1], base);
      if (href.protocol !== "https:" || href.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) continue;
      const label = visibleText(m[2]).slice(0, 80);
      if (!links.has(href.href)) links.set(href.href, label);
    } catch {
      // not an address
    }
    if (links.size >= MAX_LINKS) break;
  }
  const text = visibleText(r.body);
  process.stdout.write(`READ ${base.href}\n\nTEXT (${text.length} characters${text.length > MAX_TEXT ? `, first ${MAX_TEXT}` : ""}):\n${text.slice(0, MAX_TEXT)}\n\nLINKS:\n`);
  for (const [href, label] of links) process.stdout.write(`${href}  ${label}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
