/**
 * The fetch contract every rung, capture and replay shares.
 *
 * THE THREE-STATE RULE: a fetch answers HIT (200 with a body), MISS (the server answered "no":
 * 404, 410, 401 and the other plain 4xx) or UNKNOWN (network error, timeout, 5xx, 429, 403, or
 * any 2xx that is not 200 — a challenge/queue page is not the endpoint's answer). UNKNOWN IS NOT
 * MISS: "we could not tell" and "there is nothing there" are different facts, and only the
 * second licenses removing a vendor's offers. A fetcher NEVER throws; a failure is a result.
 */
export type FetchState = "hit" | "miss" | "unknown";

export interface FetchResult {
  url: string;
  status: number | null;
  state: FetchState;
  body: string | null;
  /** ISO timestamp of the request. */
  fetchedAt: string;
  /** Present on a network failure, timeout or a refusal (`robots_disallow`). */
  error?: string;
  /** A binary read's body (`binary: true`); `body` is then null. */
  bytes?: Uint8Array;
}

export interface FetchOptions {
  accept?: string;
  /** Read the body as bytes (an image), not text. */
  binary?: boolean;
}

export type FetchText = (url: string, opts?: FetchOptions) => Promise<FetchResult>;
