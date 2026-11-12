import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateOrigin } from "./origin.ts";

const ok = { slug: "peptide-bros", based_in: "CA", basis: "business address", source: "https://peptidebros.ca/contact", quote: "Peptide Bros, Toronto, Ontario", checked: "2026-10-08", read_by: "claude" };

// Spec 2026-10-08 part 1: a vendor is in a post's market only on evidence from its own pages.
describe("origin evidence", () => {
  it("keeps a found base with its kind of statement, page, words, day and reader", () => {
    expect(validateOrigin([ok])).toEqual([ok]);
  });

  it("keeps an unknown base with no quote and no basis", () => {
    expect(validateOrigin([{ ...ok, based_in: "unknown", basis: undefined, quote: "" }])).toHaveLength(1);
  });

  it.each([
    [{ ...ok, slug: "Peptide Bros" }, /slug/],
    [{ ...ok, based_in: "Canada" }, /based_in/],
    [{ ...ok, basis: "domain name" }, /basis/],
    [{ ...ok, based_in: "unknown", quote: "" }, /basis is only/],
    [{ ...ok, source: "http://peptidebros.ca/contact" }, /https/],
    [{ ...ok, quote: " " }, /quote/],
    [{ ...ok, checked: "2026-02-30" }, /real day/],
    [{ ...ok, read_by: "" }, /read_by/],
    [{ ...ok, ships_from: "Mars" }, /ships_from/],
    [{ ...ok, reviewed: "yes" }, /reviewed/],
    [{ ...ok, based_in: "conflict" }, /conflict needs notes/],
    // Review M3: a shipping, return or warehouse address says where parcels go, not where the business is.
    [{ ...ok, quote: "Shipping Address 6549 Mission Gorge Rd. #314 San Diego, CA 92120" }, /not a business address/],
    [{ ...ok, quote: "Returns address: 12 Dock St, Toronto" }, /not a business address/],
  ])("refuses bad entry %#", (entry, why) => {
    expect(() => validateOrigin([entry])).toThrow(why);
  });

  it("refuses a vendor listed twice, and anything that is not a list of entries", () => {
    expect(() => validateOrigin([ok, ok])).toThrow(/twice/);
    expect(() => validateOrigin({})).toThrow(/not a list/);
    expect(() => validateOrigin([null])).toThrow(/not an entry/);
  });

  it("the committed file is valid", () => {
    expect(() => validateOrigin(JSON.parse(readFileSync("src/vendors/origin-evidence.json", "utf8")))).not.toThrow();
  });
});
