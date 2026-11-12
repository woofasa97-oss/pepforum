/**
 * The vendor platform probe: which extraction door a vendor's storefront opens. Three steps at
 * most — the Woo Store API at page size 1, Shopify /products.json at limit 1, then the homepage
 * for a fingerprint — each with ONE transport retry (a request the vendor never saw costs no
 * etiquette). The verdict is a PURE function of the three observed responses, so re-running
 * `classifyPlatform` on the same signals gives the same answer.
 *
 * NETWORK HEALTH: `unreachable` is a per-vendor label for a per-vendor fact. When the CONNECTION
 * fails, every vendor probed while it is down earns the same label; PeptideBase wrote a network
 * outage into 105 vendor rows that way on 2026-09-28. Two refusals close it, both before any
 * write: the unreachable SHARE may not exceed the guard, and the positive controls must still
 * classify AFTER the sweep. `blocked`/`unreachable` never overwrite a known platform.
 * Ported from PeptideBase's probe-vendor-platforms.mjs with the honest user-agent.
 */
import type { FetchText } from "../fetch/types.ts";
import type { Platform } from "../ladder/types.ts";

export const PLATFORMS: readonly Platform[] = [
  "woocommerce",
  "shopify",
  "woocommerce_closed_api",
  "shopify_closed_api",
  "bigcommerce",
  "squarespace",
  "wix",
  "custom",
  "blocked",
  "unreachable",
];

/** Labels that mean "no measurement", never "no platform". */
export const UNMEASURED_PLATFORMS: readonly Platform[] = ["blocked", "unreachable"];

export const PROBE_ENDPOINTS = { woo: "/wp-json/wc/store/v1/products?per_page=1", shop: "/products.json?limit=1" } as const;
export const NEGATIVE_CONTROL_ORIGIN = "https://control-does-not-exist.invalid";
export const TRANSPORT_RETRY_DELAY_MS = 1_500;
/** Six times a healthy baseline (4%), a quarter of the incident (91%); a tenth of the directory going dark at once is news, not a probe result. */
export const UNREACHABLE_SHARE_GUARD = 0.25;

const BLOCKING_STATUSES: readonly number[] = [403, 429, 503];
const MAX_JSON_BYTES = 1_000_000;
const MAX_HTML_BYTES = 200_000;

/** Homepage fingerprints, in decision order. */
const HOME_FINGERPRINTS: readonly { platform: Platform; label: string; re: RegExp }[] = [
  { platform: "woocommerce_closed_api", label: "wp-content/plugins/woocommerce", re: /wp-content\/plugins\/woocommerce/ },
  { platform: "shopify_closed_api", label: "cdn.shopify.com|Shopify.theme", re: /cdn\.shopify\.com|Shopify\.theme/ },
  { platform: "bigcommerce", label: "bigcommerce", re: /bigcommerce/i },
  { platform: "squarespace", label: "squarespace", re: /squarespace/i },
  { platform: "wix", label: "wix.com", re: /wix\.com/i },
];

/** One observed response. `status: 0` means transport failure — never a server answer. */
export interface Signal {
  status: number;
  body: string;
}
export interface Signals {
  woo: Signal;
  shop: Signal;
  home: Signal;
}
const EMPTY_SIGNAL: Signal = { status: 0, body: "" };

export function originOf(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string" || !url.trim()) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    if (!u.hostname || !u.hostname.includes(".")) return null;
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return null;
  }
}

function parseJsonOrUndefined(body: string): unknown {
  if (typeof body !== "string" || body.length === 0) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Statuses that mean "something refused us"; any 2xx that is not 200 is a challenge/queue page. */
function isBlockingStatus(status: number): boolean {
  if (BLOCKING_STATUSES.includes(status)) return true;
  return status >= 200 && status < 300 && status !== 200;
}

/** The whole platform decision, as a pure function of three observed responses. */
export function classifyPlatform(signals: Partial<Signals>): { platform: Platform; reason: string } {
  const woo = signals.woo ?? EMPTY_SIGNAL;
  const shop = signals.shop ?? EMPTY_SIGNAL;
  const home = signals.home ?? EMPTY_SIGNAL;
  const statuses = `woo:${woo.status} shop:${shop.status} home:${home.status}`;

  if (woo.status === 200 && Array.isArray(parseJsonOrUndefined(woo.body))) {
    return { platform: "woocommerce", reason: `${statuses} match=wc/store/v1/products[]` };
  }
  const shopJson = shop.status === 200 ? parseJsonOrUndefined(shop.body) : undefined;
  if (typeof shopJson === "object" && shopJson !== null && Array.isArray((shopJson as { products?: unknown }).products)) {
    return { platform: "shopify", reason: `${statuses} match=products.json{products:[]}` };
  }
  // Homepage fingerprints, read whatever the status was.
  const html = typeof home.body === "string" ? home.body : "";
  for (const fp of HOME_FINGERPRINTS) {
    if (fp.re.test(html)) return { platform: fp.platform, reason: `${statuses} match=${fp.label}` };
  }
  // `custom` requires a 200 homepage WITH a body: an empty 200 is a body we did not get.
  if (home.status === 200 && html.length > 0) return { platform: "custom", reason: `${statuses} no-signal homepage_read` };
  const emptyNote = home.status === 200 ? " empty_body" : "";
  const blocking = [woo.status, shop.status, home.status].filter(isBlockingStatus);
  if (blocking.length > 0) return { platform: "blocked", reason: `${statuses} no-signal${emptyNote} blocked_status=${blocking.join(",")}` };
  return { platform: "unreachable", reason: `${statuses} no-signal${emptyNote} homepage_never_read` };
}

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One step of the probe through the pipeline's fetcher, with exactly one transport retry. */
async function step(url: string, fetchText: FetchText, accept: string, maxBytes: number, sleep: Sleep): Promise<Signal> {
  const attempt = async (): Promise<Signal> => {
    const res = await fetchText(url, { accept });
    // A refusal by robots.txt is a served answer for our purposes: the origin exists and spoke.
    if (res.status === null) return res.error === "robots_disallow" ? { status: 403, body: "" } : { status: 0, body: "" };
    return { status: res.status, body: (res.body ?? "").slice(0, maxBytes) };
  };
  const first = await attempt();
  if (first.status !== 0) return first;
  await sleep(TRANSPORT_RETRY_DELAY_MS);
  return attempt();
}

export interface ProbeVerdict {
  platform: Platform;
  reason: string;
  statuses: { woo: number; shop: number; home: number };
  signals: Signals;
}

/** Build `signals` for one origin and hand them to the classifier. Later steps are skipped once a
 *  positive API match is in hand: at most three steps, six requests worst case, usually one. */
export async function probeOrigin(origin: string, fetchText: FetchText, opts: { sleep?: Sleep } = {}): Promise<ProbeVerdict> {
  const sleep = opts.sleep ?? realSleep;
  const base = origin.replace(/\/$/, "");
  const signals: Signals = { woo: EMPTY_SIGNAL, shop: EMPTY_SIGNAL, home: EMPTY_SIGNAL };
  const json = "application/json, text/plain;q=0.5";
  signals.woo = await step(`${base}${PROBE_ENDPOINTS.woo}`, fetchText, json, MAX_JSON_BYTES, sleep);
  if (classifyPlatform(signals).platform !== "woocommerce") {
    signals.shop = await step(`${base}${PROBE_ENDPOINTS.shop}`, fetchText, json, MAX_JSON_BYTES, sleep);
    if (classifyPlatform(signals).platform !== "shopify") {
      signals.home = await step(`${base}/`, fetchText, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", MAX_HTML_BYTES, sleep);
    }
  }
  const verdict = classifyPlatform(signals);
  return { ...verdict, statuses: { woo: signals.woo.status, shop: signals.shop.status, home: signals.home.status }, signals };
}

export interface ProbeVendor {
  id: string;
  slug: string;
  website: string | null;
  detectedPlatform: Platform | null;
}

export interface ProbeRow {
  vendorId: string;
  slug: string;
  origin: string | null;
  platform: Platform | "no_origin";
  reason: string;
  previousPlatform: Platform | null;
  statuses: { woo: number; shop: number; home: number } | null;
}

/** Probe every vendor with an origin, `concurrency` at a time, results in input order. */
export async function probeVendors(vendors: ProbeVendor[], fetchText: FetchText, opts: { concurrency?: number; sleep?: Sleep } = {}): Promise<ProbeRow[]> {
  const concurrency = opts.concurrency ?? 4;
  const out: ProbeRow[] = new Array(vendors.length);
  let next = 0;
  const runOne = async (i: number) => {
    const v = vendors[i];
    const origin = originOf(v.website);
    if (!origin) {
      out[i] = { vendorId: v.id, slug: v.slug, origin: null, platform: "no_origin", reason: "vendor has no usable website", previousPlatform: v.detectedPlatform, statuses: null };
      return;
    }
    const verdict = await probeOrigin(origin, fetchText, { sleep: opts.sleep });
    out[i] = { vendorId: v.id, slug: v.slug, origin, platform: verdict.platform, reason: verdict.reason, previousPlatform: v.detectedPlatform, statuses: verdict.statuses };
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, vendors.length) }, async () => {
      while (next < vendors.length) await runOne(next++);
    }),
  );
  return out;
}

export interface ControlResult {
  kind: "woo" | "shopify" | "negative";
  origin: string;
  expect: Platform;
  got: Platform;
}

/** The instrument check: a known Woo origin, a known Shopify origin and an origin that cannot
 *  exist must classify as woocommerce, shopify and unreachable. Run before AND after a sweep. */
export async function runControls(fetchText: FetchText, opts: { wooOrigin: string; shopifyOrigin: string | null; sleep?: Sleep }): Promise<ControlResult[]> {
  const plan: { kind: ControlResult["kind"]; origin: string; expect: Platform }[] = [
    { kind: "woo", origin: opts.wooOrigin, expect: "woocommerce" },
    // null = no Shopify control configured: the instrument is then checked on WooCommerce and the negative control alone.
    ...(opts.shopifyOrigin === null ? [] : [{ kind: "shopify" as const, origin: opts.shopifyOrigin, expect: "shopify" as const }]),
    { kind: "negative", origin: NEGATIVE_CONTROL_ORIGIN, expect: "unreachable" },
  ];
  const out: ControlResult[] = [];
  for (const c of plan) {
    const verdict = await probeOrigin(c.origin, fetchText, { sleep: opts.sleep });
    out.push({ ...c, got: verdict.platform });
  }
  return out;
}

/** The network-health verdict for a finished sweep. A share above the guard, or an end-of-run
 *  control that no longer classifies, is an instrument failure — never a finding about vendors. */
export function assessNetworkHealth(
  rows: { platform: Platform | "no_origin" }[],
  endControls: { kind: string; expect: Platform; got: Platform }[],
  guard = UNREACHABLE_SHARE_GUARD,
): { ok: boolean; unreachableShare: number; unreachable: number; probed: number; reason?: string } {
  const probed = rows.filter((r) => r.platform !== "no_origin");
  const unreachable = probed.filter((r) => r.platform === "unreachable").length;
  const share = probed.length ? unreachable / probed.length : 0;
  const reasons: string[] = [];
  if (probed.length > 0 && share > guard) {
    reasons.push(`unreachable share ${(100 * share).toFixed(1)}% (${unreachable}/${probed.length}) exceeds the guard ${(100 * guard).toFixed(0)}% — a network failure during the run, not ${unreachable} vendors going dark at once`);
  }
  for (const c of endControls) {
    if (c.got !== c.expect) reasons.push(`end-of-run control ${c.kind} → ${c.got} (expected ${c.expect}) — the network changed during the run`);
  }
  return { ok: reasons.length === 0, unreachableShare: share, unreachable, probed: probed.length, ...(reasons.length ? { reason: reasons.join("; ") } : {}) };
}

/** Vendors whose stored label was a POSITIVE platform and are `unreachable` in this sweep — the
 *  per-vendor residual the share guard cannot bound, listed for a human read. */
export function listRegressions(rows: ProbeRow[]): { slug: string; previous: Platform }[] {
  return rows
    .filter((r): r is ProbeRow & { previousPlatform: Platform } => r.platform === "unreachable" && r.previousPlatform !== null && !UNMEASURED_PLATFORMS.includes(r.previousPlatform))
    .map((r) => ({ slug: r.slug, previous: r.previousPlatform }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** "Not measured is not a finding": an unmeasured label never overwrites a measured one. */
export function shouldWritePlatform(previous: Platform | null, next: Platform | "no_origin"): boolean {
  if (next === "no_origin") return false;
  if (!UNMEASURED_PLATFORMS.includes(next)) return true;
  return previous === null || UNMEASURED_PLATFORMS.includes(previous);
}
