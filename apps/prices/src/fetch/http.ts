/**
 * The one HTTP client the pipeline uses. Honest user-agent naming pepforum.ca, one attempt
 * per URL (no retries — observation is not free when the failure is load), a 20 s timeout,
 * robots.txt honoured before the request, and every result recorded in the raw capture after
 * it. It never throws: a failure is a FetchResult with state "unknown" and an error.
 */
import type { RawCapture } from "./raw-capture.ts";
import { loadRobots, type RobotsPolicy } from "./robots.ts";
import type { FetchOptions, FetchResult, FetchState, FetchText } from "./types.ts";

export const ROBOTS_AGENT = "PepforumBot";
export const PEPFORUM_USER_AGENT = `${ROBOTS_AGENT}/1.0 (+https://pepforum.ca/legal/price-methodology)`;
export const DEFAULT_TIMEOUT_MS = 20_000;

/** The three-state rule at the HTTP layer. See `pipeline/fetch/types.ts`. */
export function classifyStatus(status: number): FetchState {
  if (status === 200) return "hit";
  if (status >= 200 && status < 300) return "unknown"; // a 202 challenge/queue page is not an answer
  if (status === 403 || status === 429 || status >= 500) return "unknown"; // a block or an outage is "could not tell"
  return "miss"; // 404, 410, 401 and the other plain 4xx: the server answered "no"
}

/** A read that carries a vendor's key follows at most this many redirects, all on the same site. */
export const MAX_KEYED_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetcherOptions {
  userAgent?: string;
  timeoutMs?: number;
  capture?: RawCapture;
  /** Honour robots.txt (loaded once per origin through this same fetcher). Default true. */
  robots?: boolean;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * The Authorization header a vendor gave us for its own site (`vendorAuthorizationFromEnv`), or
   * null — the answer for every URL by default. Sent over https only. A read that carries it
   * follows its redirects itself, on the same site only: the key never travels to another host.
   */
  authorization?: (url: URL) => string | null;
}

export function createFetcher(opts: FetcherOptions = {}): FetchText {
  const userAgent = opts.userAgent ?? PEPFORUM_USER_AGENT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const honourRobots = opts.robots ?? true;
  const policies = new Map<string, Promise<RobotsPolicy>>();

  const keyFor = (target: string): string | null => {
    if (!opts.authorization) return null;
    const u = parseUrl(target);
    return u?.protocol === "https:" ? opts.authorization(u) : null;
  };

  const raw = async (url: string, fetchOpts: FetchOptions = {}): Promise<FetchResult> => {
    const fetchedAt = new Date().toISOString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const accept = fetchOpts.accept ?? "application/json, text/html;q=0.9, */*;q=0.5";
    const send = (target: string, key: string | null) =>
      fetchImpl(target, {
        headers: { "user-agent": userAgent, accept, ...(key ? { authorization: key } : {}) },
        redirect: key ? "manual" : "follow",
        signal: controller.signal,
      });
    let result: FetchResult;
    try {
      let target = url;
      let key = keyFor(url);
      let res = await send(target, key);
      let refused: string | null = null;
      for (let hops = 0; key && REDIRECT_STATUSES.has(res.status); hops++) {
        const next = parseUrl(res.headers.get("location") ?? "", target);
        if (!next || next.origin !== new URL(target).origin) refused = "redirect_off_site";
        else if (hops === MAX_KEYED_REDIRECTS) refused = "too_many_redirects";
        if (refused || !next) break;
        await res.body?.cancel().catch(() => undefined);
        target = next.href;
        key = keyFor(target);
        res = await send(target, key);
      }
      if (refused) {
        await res.body?.cancel().catch(() => undefined);
        result = { url, status: res.status, state: "unknown", body: null, fetchedAt, error: refused };
      } else if (fetchOpts.binary) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        result = { url, status: res.status, state: classifyStatus(res.status), body: null, bytes, fetchedAt };
      } else {
        const body = await res.text();
        result = { url, status: res.status, state: classifyStatus(res.status), body, fetchedAt };
      }
    } catch (err) {
      const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
      result = { url, status: null, state: "unknown", body: null, fetchedAt, error: aborted ? "timeout" : errorMessage(err) };
    } finally {
      clearTimeout(timer);
    }
    opts.capture?.record(result);
    return result;
  };

  const policyFor = (origin: string): Promise<RobotsPolicy> => {
    let p = policies.get(origin);
    if (!p) {
      p = loadRobots(origin, raw, ROBOTS_AGENT);
      policies.set(origin, p);
    }
    return p;
  };

  return async (url, fetchOpts) => {
    if (honourRobots) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(url);
      } catch {
        return { url, status: null, state: "unknown", body: null, fetchedAt: new Date().toISOString(), error: "invalid_url" };
      }
      if (parsed.pathname !== "/robots.txt") {
        const policy = await policyFor(parsed.origin);
        if (!policy.allows(parsed.pathname + parsed.search)) {
          const refused: FetchResult = { url, status: null, state: "miss", body: null, fetchedAt: new Date().toISOString(), error: "robots_disallow" };
          opts.capture?.record(refused);
          return refused;
        }
      }
    }
    return raw(url, fetchOpts);
  };
}

function parseUrl(value: string, base?: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
  return String(err);
}
