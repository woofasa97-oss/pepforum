// Reading a file that may not be there, without checking first (no gap between a check and a read).
import { readFileSync } from "node:fs";

/** The file's text, or null when it does not exist. Any other error is thrown. */
export function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** A JSON file's value, or `fallback` when the file does not exist. */
export function readJsonIfPresent<T>(path: string, fallback: T): T {
  const text = readIfPresent(path);
  return text === null ? fallback : (JSON.parse(text) as T);
}
