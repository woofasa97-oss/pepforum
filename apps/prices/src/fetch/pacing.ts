/**
 * How hard the pipeline leans on one vendor. Two requests at a time, a short pause between one
 * worker's requests, and a full stop the moment the vendor says "too many requests": after a 429
 * nothing further is asked of that vendor in this run, and whatever was not asked about is
 * UNKNOWN — never gone. (First live run, 2026-10-01: one store answered 429 to dozens of
 * variation requests sent four at a time with no pause.)
 */
export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const VENDOR_CONCURRENCY = 2;
export const REQUEST_PAUSE_MS = 250;
export const RATE_LIMITED_STATUS = 429;
export const NOT_ASKED_REASON = "not asked: the vendor answered 429 earlier in this run";

export interface PacingOptions {
  concurrency?: number;
  pauseMs?: number;
  /** Injectable for tests. */
  sleep?: Sleep;
}

/**
 * Run `task(i)` for i in [0, count), paced. Stops handing out work once `stopped()` is true and
 * returns the indexes that were never started, in order.
 */
export async function runPaced(count: number, task: (index: number) => Promise<void>, opts: PacingOptions & { stopped?: () => boolean } = {}): Promise<number[]> {
  const concurrency = opts.concurrency ?? VENDOR_CONCURRENCY;
  const pauseMs = opts.pauseMs ?? REQUEST_PAUSE_MS;
  const sleep = opts.sleep ?? realSleep;
  const stopped = opts.stopped ?? (() => false);
  const started = new Array<boolean>(count).fill(false);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, count) }, async () => {
      while (next < count && !stopped()) {
        const index = next++;
        started[index] = true;
        await task(index);
        if (next < count && !stopped()) await sleep(pauseMs);
      }
    }),
  );
  return started.flatMap((wasStarted, index) => (wasStarted ? [] : [index]));
}
