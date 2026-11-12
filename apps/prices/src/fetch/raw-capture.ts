/**
 * RAW CAPTURE — every fetch is stored before it is parsed, so a parser bug costs a re-parse
 * and never a re-crawl. One gzipped NDJSON file per vendor per run turns "was this a parser
 * bug or did the vendor change?" from an argument into a diff.
 *
 * The FIRST line is a routing header (platform, known product URLs, …): the ladder routes on
 * those, so a capture without them would replay down whichever path the defaults choose.
 * `parseCapture` refuses a file whose first line is not one.
 *
 * A failed fetch is a RECORD, not an omission: it replays as UNKNOWN, never as MISS.
 */
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { FetchResult, FetchState, FetchText } from "./types.ts";

/** The private bucket created by migration 20261001000004. */
export const RAW_CAPTURE_BUCKET = "offer-raw";
/** The bucket's own file_size_limit, asserted here rather than discovered as an opaque rejection. */
export const MAX_CAPTURE_BYTES = 52_428_800;
export const CAPTURE_HEADER_MARK = "pepforum-raw-capture/1";

export interface CaptureHeader {
  capture: string;
  run_label: string;
  vendor_slug: string;
  started_at: string;
  [key: string]: unknown;
}

export interface CaptureRecord {
  url: string;
  status: number | null;
  state: FetchState;
  fetched_at: string;
  body: string | null;
  error?: string;
}

export interface SerializedCapture {
  buffer: Buffer;
  sha256: string;
  bytes: number;
  overCap: boolean;
}

export interface RawCapture {
  readonly header: CaptureHeader;
  readonly records: CaptureRecord[];
  readonly count: number;
  record(result: FetchResult): void;
  /** gzip + its digest and size, computed over the SAME bytes that get stored. */
  serialize(): SerializedCapture;
}

export function createRawCapture(args: {
  runLabel: string;
  vendorSlug: string;
  header?: Record<string, unknown>;
  startedAt?: Date;
}): RawCapture {
  const header: CaptureHeader = {
    capture: CAPTURE_HEADER_MARK,
    run_label: args.runLabel,
    vendor_slug: args.vendorSlug,
    ...(args.header ?? {}),
    started_at: (args.startedAt ?? new Date()).toISOString(),
  };
  const records: CaptureRecord[] = [];
  return {
    header,
    records,
    get count() {
      return records.length;
    },
    record(result) {
      records.push({
        url: result.url,
        status: result.status,
        state: result.state,
        fetched_at: result.fetchedAt,
        body: result.body,
        ...(result.error !== undefined ? { error: result.error } : {}),
      });
    },
    serialize() {
      const buffer = gzipSync(Buffer.from(serializeCapture(header, records), "utf8"));
      return { buffer, sha256: createHash("sha256").update(buffer).digest("hex"), bytes: buffer.length, overCap: buffer.length > MAX_CAPTURE_BYTES };
    },
  };
}

/** header + records → NDJSON text. The header is always line 1. */
export function serializeCapture(header: CaptureHeader, records: CaptureRecord[]): string {
  return [JSON.stringify(header), ...records.map((r) => JSON.stringify(r))].join("\n") + "\n";
}

/** NDJSON text → `{ header, records }`. Refuses a file with no routing header or a broken line. */
export function parseCapture(text: string): { header: CaptureHeader; records: CaptureRecord[] } {
  const lines = String(text ?? "").split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) throw new Error("capture is empty — no header line, nothing to replay");
  let header: unknown;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    throw new Error("capture line 1 is not JSON — a capture must open with its routing header");
  }
  const h = header as Partial<CaptureHeader> | null;
  if (!h || h.capture !== CAPTURE_HEADER_MARK) {
    throw new Error(`capture line 1 is not a ${CAPTURE_HEADER_MARK} header — refusing to replay with default routing`);
  }
  const records: CaptureRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]) as CaptureRecord);
    } catch {
      throw new Error(`capture line ${i + 1} is not JSON — refusing a partial replay`);
    }
  }
  return { header: h as CaptureHeader, records };
}

export function gunzipCapture(buffer: Buffer): string {
  return gunzipSync(buffer).toString("utf8");
}

/** The object key inside the bucket: `<run_label>/<vendor_slug>.ndjson.gz`. */
export function captureObjectKey(runLabel: string, vendorSlug: string): string {
  return `${runLabel}/${vendorSlug}.ndjson.gz`;
}

export function captureStorageUri(key: string): string {
  return `storage://${RAW_CAPTURE_BUCKET}/${key}`;
}

/**
 * A `FetchText` that answers from a capture and NOTHING ELSE. An uncaptured URL THROWS — a
 * replay that quietly fetched it would be re-crawling under the name of re-parsing. A recorded
 * failure replays as the failure it was. First-seen wins on a duplicate URL.
 */
export function replayFetchText(records: CaptureRecord[], opts: { onUncaptured?: (url: string) => void } = {}): FetchText {
  const byUrl = new Map<string, CaptureRecord>();
  for (const r of records ?? []) if (r?.url && !byUrl.has(r.url)) byUrl.set(r.url, r);
  return async (url) => {
    const rec = byUrl.get(url);
    if (!rec) {
      opts.onUncaptured?.(url);
      throw new Error(`uncaptured: ${url} is not in this capture — a replay never fetches`);
    }
    return { url: rec.url, status: rec.status, state: rec.state, body: rec.body, fetchedAt: rec.fetched_at, ...(rec.error !== undefined ? { error: rec.error } : {}) };
  };
}
