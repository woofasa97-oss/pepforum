export interface PipelineEnv {
  /** Direct Postgres URL: the `pepforum_prices` login (session pooler on the hosted project, the local database in development). */
  dbUrl: string;
}

/** The pipeline's only reader of secrets. Fails loudly by name; never logs a value. */
export function readPipelineEnv(): PipelineEnv {
  const dbUrl = process.env.PRICES_DB_URL;
  if (!dbUrl) throw new Error("PRICES_DB_URL is required");
  return { dbUrl };
}

export interface VendorKey {
  readonly hosts: readonly string[];
  /** The environment variable that holds the key. */
  readonly variable: string;
}

/**
 * Vendors that gave Pepforum a key for prices they show only to signed-in visitors: the hosts it
 * is for and the variable that holds it. Empty today. A key is an agreement with that vendor: add
 * an entry only once the vendor has issued one to Pepforum, and record the terms in docs/PRICES.md.
 */
export const VENDOR_KEYS: readonly VendorKey[] = [];

/** The Authorization header for a URL on a keyed vendor's own site, over https; null for every other URL and while the key is not set. */
export function vendorAuthorizationFromEnv(keys: readonly VendorKey[] = VENDOR_KEYS): (url: URL) => string | null {
  const byHost = new Map<string, string>();
  for (const v of keys) {
    const key = process.env[v.variable]?.trim();
    if (key) for (const host of v.hosts) byHost.set(host, `Bearer ${key}`);
  }
  return (url) => (url.protocol === "https:" ? (byHost.get(url.hostname) ?? null) : null);
}
