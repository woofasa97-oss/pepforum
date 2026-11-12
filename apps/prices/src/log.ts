/** One JSON object per line on stderr; stdout stays free for machine-readable results. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + "\n");
}
