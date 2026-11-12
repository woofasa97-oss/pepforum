/**
 * The per-vendor ledger vocabulary (`refresh_attempts`). `held` wins over everything: it is a
 * statement about the APPLY (we read the vendor fine and refused to write). `run_complete` is
 * the ONE thing that licenses a removal next run: a hit whose apply threw partway is not
 * complete. Ported from PeptideBase's price-attempts.mjs.
 */
import type { FetchState } from "../fetch/types.ts";
import type { Attempt } from "../ladder/types.ts";
import type { AttemptRow } from "./repo.ts";

export type Outcome = "hit" | "miss" | "unknown" | "held" | "blocked";

const BLOCKING_STATUSES: readonly number[] = [403, 429];
export const MAX_DEAD_URLS = 500;

const isBlocking = (status: number | null | undefined): boolean =>
  typeof status === "number" && (BLOCKING_STATUSES.includes(status) || (status >= 200 && status < 300 && status !== 200));

export function classifyOutcome(args: { ladderState: FetchState; attempts?: Attempt[]; held?: boolean }): Outcome {
  if (args.held) return "held";
  if (args.ladderState === "hit") return "hit";
  if (args.ladderState === "miss") return "miss";
  return (args.attempts ?? []).some((a) => isBlocking(a.status)) ? "blocked" : "unknown";
}

/** The status worth remembering: the winning rung's on a hit (or a held hit), the blocking one on
 *  a block, else the last one seen — never an earlier rung's bare 200 when a later one was refused. */
export function pickHttpStatus(attempts: Attempt[], outcome: Outcome): number | null {
  if (outcome === "hit" || outcome === "held") {
    const won = attempts.find((a) => a.state === "hit" && a.status !== null);
    if (won) return won.status;
  }
  if (outcome === "blocked") {
    const blocked = attempts.find((a) => isBlocking(a.status));
    if (blocked) return blocked.status;
  }
  return attempts.findLast((a) => a.status !== null)?.status ?? null;
}

/** Page-rung URLs that 404/410'd this run, sorted and bounded. */
export function deadUrlsFromAttempts(attempts: Attempt[]): string[] {
  return [...new Set(attempts.filter((a) => a.dead === true && a.url).map((a) => a.url))].sort().slice(0, MAX_DEAD_URLS);
}

export function buildAttemptPatch(args: {
  ladderState: FetchState;
  attempts: Attempt[];
  held?: boolean;
  applied: boolean;
  rung: string | null;
  productsSeen: number;
  matched: number;
  rowsWritten: number;
  counts: Record<string, unknown>;
  capture?: { uri: string | null; sha256: string | null; bytes: number | null } | null;
  error?: string | null;
  finishedAt: Date;
}): Partial<AttemptRow> {
  const outcome = classifyOutcome(args);
  return {
    outcome,
    rung: args.rung,
    http_status: pickHttpStatus(args.attempts, outcome),
    products_seen: args.productsSeen,
    matched: args.matched,
    rows_written: args.rowsWritten,
    counts: args.counts as AttemptRow["counts"],
    run_complete: outcome === "hit" && args.applied,
    raw_capture_uri: args.capture?.uri ?? null,
    raw_capture_sha256: args.capture?.sha256 ?? null,
    raw_capture_bytes: args.capture?.bytes ?? null,
    error: args.error ?? null,
    finished_at: args.finishedAt.toISOString(),
  };
}

/** The lists a previous attempt row carries, read back defensively — `counts` is jsonb. */
export function carriedLists(attempt: AttemptRow | null): { missingProductKeys: string[]; deadUrls: string[] } {
  const counts = (attempt?.counts ?? {}) as Record<string, unknown>;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { missingProductKeys: list(counts.missing_product_keys), deadUrls: list(counts.dead_urls) };
}
