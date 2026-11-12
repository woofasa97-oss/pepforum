import { describe, expect, it } from "vitest";
import { InMemoryRepo } from "../ingest/repo.ts";
import { FX_PROVIDER, fetchFxRates, upsertFxRates } from "./fx.ts";

const payload = (cad: unknown, over: Record<string, unknown> = {}) => ({ base: "USD", date: "2026-10-01", rates: { CAD: cad }, ...over });

describe("fetchFxRates", () => {
  it("stores both directions with the provider's date and never a rounded 2-dp rate", async () => {
    const rates = await fetchFxRates(async () => ({ base: "USD", date: "2026-10-01", rates: { CAD: 1.36712 } }));
    expect(rates).toEqual([
      { base_currency: "USD", quote_currency: "CAD", rate: 1.36712, provider: "frankfurter.dev (ECB)", rate_date: "2026-10-01" },
      { base_currency: "CAD", quote_currency: "USD", rate: 1 / 1.36712, provider: "frankfurter.dev (ECB)", rate_date: "2026-10-01" },
    ]);
  });

  it("refuses a rate outside [0.5, 2] for USD/CAD", async () => {
    await expect(fetchFxRates(async () => payload(13.6712))).rejects.toThrow(/implausible/);
    await expect(fetchFxRates(async () => payload(0.136712))).rejects.toThrow(/implausible/);
  });

  it("asks for the latest rate by default and for a dated one when given a date", async () => {
    const urls: string[] = [];
    const fetchJson = async (url: string) => {
      urls.push(url);
      return payload(1.37, { date: "2026-09-30" });
    };
    await fetchFxRates(fetchJson);
    const dated = await fetchFxRates(fetchJson, "2026-09-30");
    expect(urls).toEqual(["https://api.frankfurter.dev/v1/latest?base=USD&symbols=CAD", "https://api.frankfurter.dev/v1/2026-09-30?base=USD&symbols=CAD"]);
    // The stored date is the PROVIDER's reference date, which on a weekend is not the day asked for.
    expect(dated.every((r) => r.rate_date === "2026-09-30")).toBe(true);
    await expect(fetchFxRates(fetchJson, "30/09/2026")).rejects.toThrow(/date/);
  });

  it("refuses a payload that is not the rate it asked for, rather than guessing", async () => {
    await expect(fetchFxRates(async () => null)).rejects.toThrow(/unexpected/);
    await expect(fetchFxRates(async () => payload("1.37"))).rejects.toThrow(/unexpected/);
    await expect(fetchFxRates(async () => payload(1.37, { base: "EUR" }))).rejects.toThrow(/unexpected/);
    await expect(fetchFxRates(async () => payload(1.37, { date: "yesterday" }))).rejects.toThrow(/unexpected/);
    await expect(fetchFxRates(async () => ({ base: "USD", date: "2026-10-01", rates: {} }))).rejects.toThrow(/unexpected/);
  });
});

describe("upsertFxRates", () => {
  it("writes one row per direction and date; a re-run on the same date replaces, never duplicates", async () => {
    const repo = new InMemoryRepo();
    const first = await fetchFxRates(async () => payload(1.36712));
    expect(await upsertFxRates(repo, first)).toBe(2);
    await upsertFxRates(repo, await fetchFxRates(async () => payload(1.37)));
    await upsertFxRates(repo, await fetchFxRates(async () => payload(1.38, { date: "2026-10-02" })));
    expect(repo.fxRates.map((r) => [r.base_currency, r.quote_currency, r.rate_date, r.rate])).toEqual([
      ["USD", "CAD", "2026-10-01", 1.37],
      ["CAD", "USD", "2026-10-01", 1 / 1.37],
      ["USD", "CAD", "2026-10-02", 1.38],
      ["CAD", "USD", "2026-10-02", 1 / 1.38],
    ]);
    expect(repo.fxRates.every((r) => r.provider === FX_PROVIDER)).toBe(true);
  });
});
