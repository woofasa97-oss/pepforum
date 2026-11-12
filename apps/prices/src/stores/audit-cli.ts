// pnpm --filter @pepforum/prices stores:audit --cache <dir> [--stores a,b] [--verdicts <file>] [--refresh]
//
// The public-information audit (docs/QUALITY_ASSURANCE.md §9.1). For each store in seed/stores.json: reads
// its home page and up to eight of its own pages that a person would read for these checks (about,
// contact, shipping, FAQ, terms, privacy, certificates), as PepforumsBot with robots.txt honoured and one
// page a second per site; applies the rules in audit.ts; and writes one audit per store to
// seed/store-audits.json (today's, replacing an earlier one of the same day). Pages are cached in <dir>,
// so a re-run reads nothing again unless --refresh.
//
// Human-use claims are judged by a person: candidates go to <dir>/human-use-candidates.json, and a file of
// verdicts ([{ slug, quote, claim }]) passed with --verdicts decides them.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { STORE_AUDIT_CRITERIA } from "@pepforum/database";
import { createFetcher } from "../fetch/http.ts";
import { realSleep } from "../fetch/pacing.ts";
import { visibleText } from "../vendors/quote-check.ts";
import { type Page, auditPages, pickLinks, reviewHumanUse } from "./audit.ts";
import { type AuditSeed, type StoreSeed, validateAudits, validateLabs, validateStores } from "./directory.ts";

const say = (line: string) => process.stdout.write(`${line}\n`);
const STANDARD = "0.9";

type Cached = { url: string; ok: boolean; text: string; links: Array<{ href: string; label: string }>; error?: string };
type Hints = Record<string, { country?: { code: string; quote: string }; independent?: string }>;

const LAB_HOSTS = ["janoshik.com", "freedomdiagnosticstesting.com", "trustpointeanalytics.com", "vanguardlaboratory.com", "mzbiolabs.com", "chromate.org", "btlabtesting.com", "krauselabs.com", "pharmlabs.com", "harrenslab.com"];

function linksOf(html: string, base: string): Array<{ href: string; label: string }> {
  const host = new URL(base).hostname.replace(/^www\./, "");
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const href = new URL(m[1], base);
      if (href.protocol !== "https:") continue;
      const sameSite = href.hostname.replace(/^www\./, "") === host;
      // Keep same-site links, and links to a known lab's own site (exact host), for "reports can be checked".
      const target = href.hostname.toLowerCase();
      if (!sameSite && !LAB_HOSTS.some((h) => target === h || target.endsWith(`.${h}`))) continue;
      if (!out.has(href.href)) out.set(href.href, visibleText(m[2]).slice(0, 100));
    } catch {
      // not an address
    }
  }
  return [...out].map(([href, label]) => ({ href, label }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const cacheDir = opt("cache");
  if (!cacheDir) throw new Error("usage: stores:audit --cache <dir> [--stores a,b] [--verdicts <file>] [--refresh]");
  mkdirSync(cacheDir, { recursive: true });
  const only = opt("stores")?.split(",");
  const refresh = args.includes("--refresh");
  const today = new Date();
  const day = today.toISOString().slice(0, 10);

  const stores = validateStores(JSON.parse(readFileSync("seed/stores.json", "utf8")));
  const labs = validateLabs(JSON.parse(readFileSync("seed/labs.json", "utf8")));
  const labAliases = existsSync("seed/lab-aliases.json") ? (JSON.parse(readFileSync("seed/lab-aliases.json", "utf8")) as Record<string, string[]>) : {};
  const hints: Hints = existsSync("seed/store-hints.json") ? JSON.parse(readFileSync("seed/store-hints.json", "utf8")) : {};
  const audits = validateAudits(JSON.parse(readFileSync("seed/store-audits.json", "utf8")), stores);
  const verdicts: Array<{ slug: string; quote: string; claim: boolean }> = opt("verdicts") ? JSON.parse(readFileSync(opt("verdicts") as string, "utf8")) : [];

  const fetchText = createFetcher();
  const fileOf = (url: string) => path.join(cacheDir, `${createHash("sha1").update(url).digest("hex")}.json`);
  const read = async (url: string): Promise<Cached> => {
    const file = fileOf(url);
    if (!refresh && existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Cached;
    const r = await fetchText(url, { accept: "text/html, application/xhtml+xml;q=0.9, */*;q=0.5" });
    const page: Cached = r.state === "hit" && r.body !== null
      ? { url, ok: true, text: visibleText(r.body), links: linksOf(r.body, url) }
      : { url, ok: false, text: "", links: [], error: r.error ?? `status ${r.status ?? "none"}` };
    writeFileSync(file, JSON.stringify(page));
    await realSleep(1000);
    return page;
  };

  const todo = stores.filter((s) => !only || only.includes(s.slug));
  const candidates: Array<{ slug: string; url: string; quote: string; term: string }> = [];
  const results = new Map<string, { audit: AuditSeed; store: Partial<StoreSeed> }>();
  let done = 0;
  const queue = [...todo];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const home = await read(s.website_url);
      const pages: Page[] = [];
      if (home.ok) {
        pages.push(home);
        for (const href of pickLinks(s.website_url, home.links)) {
          const p = await read(href);
          if (p.ok) pages.push(p);
        }
      }
      const hint = hints[s.slug] ?? {};
      const independent = hint.independent ? await read(hint.independent) : null;
      const f = auditPages({ store: { name: s.name, domain: s.canonical_domain }, pages, labs, labAliases, discoveryCountry: hint.country ?? null, independent: independent?.ok ? independent : null, today });
      if (!home.ok) {
        for (const c of STORE_AUDIT_CRITERIA) f.checks[c] = { result: "unchecked", value: null, source_url: null, quote: null, quote_verified_on: null };
      } else {
        const mine = verdicts.filter((v) => v.slug === s.slug);
        if (f.human_use_candidates.length) f.checks.no_human_use_claims = reviewHumanUse(f, mine);
        for (const c of f.human_use_candidates) candidates.push({ slug: s.slug, ...c });
      }
      // A quote cut from a page our reader read today was on that page today.
      const byUrl = new Map([...pages, ...(independent?.ok ? [independent] : [])].map((p) => [p.url, p.text]));
      for (const c of Object.values(f.checks)) {
        if (c.quote && c.source_url && byUrl.get(c.source_url)?.includes(c.quote)) c.quote_verified_on = day;
      }
      results.set(s.slug, {
        audit: { slug: s.slug, standard_version: STANDARD, audited_on: day, reachable: home.ok, pages_read: pages.map((p) => p.url), checks: f.checks },
        store: f.country ? { origin_country: f.country, origin_source: f.checks.identity_country.source_url, ships_to: f.ships_to, ships_worldwide: f.ships_worldwide } : { ships_to: f.ships_to, ships_worldwide: f.ships_worldwide },
      });
      done++;
      if (done % 25 === 0) say(`${done}/${todo.length} stores read`);
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));

  // Today's audit replaces an earlier one of the same day; other days are kept (each is a record).
  const kept = audits.filter((a) => !(results.has(a.slug) && a.audited_on === day));
  const next = [...kept, ...[...results.values()].map((r) => r.audit)].sort((a, b) => a.slug.localeCompare(b.slug) || a.audited_on.localeCompare(b.audited_on));
  const updated = stores.map((s) => {
    const r = results.get(s.slug);
    if (!r) return s;
    return {
      ...s,
      origin_country: r.store.origin_country ?? s.origin_country,
      origin_source: r.store.origin_country ? (r.store.origin_source ?? s.origin_source) : s.origin_source,
      ships_to: r.store.ships_to?.length ? r.store.ships_to : s.ships_to,
      ships_worldwide: r.store.ships_worldwide || s.ships_worldwide,
    };
  });
  validateStores(updated);
  validateAudits(next, updated);
  writeFileSync("seed/stores.json", `${JSON.stringify(updated, null, 2)}\n`);
  writeFileSync("seed/store-audits.json", `${JSON.stringify(next, null, 2)}\n`);
  writeFileSync(path.join(cacheDir, "human-use-candidates.json"), `${JSON.stringify(candidates, null, 2)}\n`);

  const unread = [...results.values()].filter((r) => !r.audit.reachable).length;
  const tally = Object.fromEntries(STORE_AUDIT_CRITERIA.map((c) => [c, [...results.values()].filter((r) => r.audit.checks[c].result === "met" || r.audit.checks[c].result === "partly").length]));
  say(`${results.size} stores audited, ${unread} could not be read; ${candidates.length} human-use candidates to judge`);
  say(`met or partly, per check: ${JSON.stringify(tally)}`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exitCode = 1;
});
