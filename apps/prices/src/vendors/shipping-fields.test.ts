import { describe, expect, it } from "vitest";
import { isRealDay, isReview, validateEvidence } from "./shipping.ts";

const good = { slug: "nextedge-peptides", ships_to: ["CA", "US"], source: "https://nextedgepeptides.com/shipping-policy", quote: "USA: All USA orders are shipped with FEDEX.", checked: "2026-10-06" };

// Spec 2026-10-08 part 1: restrictions, the reader and the owner's review travel with the evidence.
describe("shipping evidence — X posting fields", () => {
  it("keeps restrictions, reader and review", () => {
    const e = { ...good, restrictions: "We do not ship to Hawaii.", read_by: "claude", reviewed: "owner 2026-10-09" };
    expect(validateEvidence([e])).toEqual([e]);
  });

  it.each([
    [{ ...good, restrictions: "" }, /restrictions/],
    [{ ...good, read_by: 3 }, /read_by/],
    [{ ...good, reviewed: "owner yesterday" }, /reviewed/],
    [{ ...good, reviewed: "owner 2026-02-30" }, /reviewed/],
  ])("refuses bad field %#", (entry, why) => {
    expect(() => validateEvidence([entry])).toThrow(why);
  });

  it("knows a real day and a review", () => {
    expect(isRealDay("2026-10-08")).toBe(true);
    expect(isRealDay("2026-02-30")).toBe(false);
    expect(isRealDay("8 Oct")).toBe(false);
    expect(isReview(undefined)).toBe(true);
    expect(isReview("owner 2026-10-09")).toBe(true);
    expect(isReview("claude 2026-10-09")).toBe(false);
  });
});
