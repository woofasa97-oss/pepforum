/**
 * One more try for a statement whose CONNECTION failed — and only for that. A read timeout or a
 * reset on the way to the hosted pooler says nothing about the statement; an error the database
 * itself answered with (a constraint, a permission) is final and is never repeated.
 *
 * The caller decides which statements are safe to repeat: a timeout on a write is ambiguous (it
 * may have landed), so only reads and writes that land on the same row whatever came before go
 * through here. (First live run, 2026-10-01: two `read ETIMEDOUT`s; one cost a vendor's rows.)
 */
import { realSleep, type Sleep } from "../fetch/pacing.ts";

const TRANSIENT_CODES: ReadonlySet<string> = new Set(["ETIMEDOUT", "ECONNRESET", "EPIPE", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT"]);
export const RETRY_WAIT_MS = 500;

export function isTransientDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
  return /\b(ETIMEDOUT|ECONNRESET|EPIPE)\b/.test(err.message);
}

export async function withRetry<T>(statement: () => Promise<T>, opts: { sleep?: Sleep; waitMs?: number } = {}): Promise<T> {
  try {
    return await statement();
  } catch (err) {
    if (!isTransientDbError(err)) throw err;
    await (opts.sleep ?? realSleep)(opts.waitMs ?? RETRY_WAIT_MS);
    return statement();
  }
}
