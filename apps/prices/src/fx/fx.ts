/**
 * EXCHANGE RATES — dated USD/CAD reference rates, both directions, from frankfurter.dev (ECB).
 *
 * Offers are stored in the vendor's own currency and never converted by the pipeline; the site
 * converts at read time with one of these rows, so a shown conversion always names its provider
 * and date. The rate is stored as the provider gave it — never rounded to 2 dp — and a payload
 * that is not exactly the rate asked for is refused rather than interpreted.
 */
import type { FxRate, Repo } from "../ingest/repo.ts";

export const FX_PROVIDER = "frankfurter.dev (ECB)";
const ENDPOINT = "https://api.frankfurter.dev/v1";
/** USD→CAD has sat between 0.9 and 1.6 for fifty years; outside this a payload is wrong, not news. */
const USD_CAD_RANGE = { min: 0.5, max: 2 } as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type FetchJson = (url: string) => Promise<unknown>;

export async function fetchFxRates(fetchJson: FetchJson, date?: string): Promise<FxRate[]> {
  if (date !== undefined && !ISO_DATE.test(date)) throw new Error(`fx: date must be YYYY-MM-DD, received ${JSON.stringify(date)}`);
  const url = `${ENDPOINT}/${date ?? "latest"}?base=USD&symbols=CAD`;
  const body = await fetchJson(url);
  const o = (body !== null && typeof body === "object" ? body : {}) as { base?: unknown; date?: unknown; rates?: { CAD?: unknown } };
  const rate = o.rates?.CAD;
  if (o.base !== "USD" || typeof o.date !== "string" || !ISO_DATE.test(o.date) || typeof rate !== "number" || !Number.isFinite(rate)) {
    throw new Error(`fx: unexpected response from ${url}: ${JSON.stringify(body)?.slice(0, 200)}`);
  }
  if (rate < USD_CAD_RANGE.min || rate > USD_CAD_RANGE.max) throw new Error(`fx: implausible USD/CAD rate ${rate} (expected ${USD_CAD_RANGE.min}–${USD_CAD_RANGE.max}); nothing stored`);
  return [
    { base_currency: "USD", quote_currency: "CAD", rate, provider: FX_PROVIDER, rate_date: o.date },
    { base_currency: "CAD", quote_currency: "USD", rate: 1 / rate, provider: FX_PROVIDER, rate_date: o.date },
  ];
}

export async function upsertFxRates(repo: Repo, rates: FxRate[]): Promise<number> {
  return repo.upsertFxRates(rates);
}
