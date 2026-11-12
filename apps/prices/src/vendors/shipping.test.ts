import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateOrigin } from "./origin.ts";
import { shipsSource, validateEvidence, type ShippingEvidence } from "./shipping.ts";

const good: ShippingEvidence = { slug: "nextedge-peptides", ships_to: ["CA", "US"], source: "https://nextedgepeptides.com/shipping-policy", quote: "USA: All USA orders are shipped with FEDEX.", checked: "2026-10-06" };

// Owner, 2026-10-05: a Canadian vendor is in the USA view only on evidence from its own pages.
describe("shipping evidence", () => {
  it("keeps an entry that names its countries, its page, its words and its date", () => {
    expect(validateEvidence([good])).toEqual([good]);
  });

  it("refuses anything it could not stand behind", () => {
    for (const bad of [
      { ...good, ships_to: ["CA", "GB"] },
      { ...good, ships_to: [] },
      { ...good, ships_to: ["US", "US"] },
      { ...good, source: "http://nextedgepeptides.com/shipping-policy" },
      { ...good, source: "javascript:alert(1)" },
      { ...good, quote: " " },
      { ...good, checked: "06/10/2026" },
      { ...good, checked: "2026-02-30" },
      { ...good, slug: "Next Edge" },
    ]) expect(() => validateEvidence([bad])).toThrow();
    expect(() => validateEvidence([good, good])).toThrow(/twice/);
    expect(() => validateEvidence([null])).toThrow(/shipping evidence/);
    expect(() => validateEvidence(["nextedge-peptides"])).toThrow(/shipping evidence/);
  });

  it("records where the evidence came from, and when", () => {
    expect(shipsSource(good)).toBe("https://nextedgepeptides.com/shipping-policy (checked 2026-10-06)");
  });

  // Since 2026-10-08 the file also holds US-based vendors' evidence (X posting); the site's USA view
  // still takes in a vendor based in Canada only on this evidence: NextEdge from its own page, and
  // Peptide Confidential from its founder's message to the owner (recorded 2026-10-10, owner's instruction).
  it("the committed file is valid, and of the ten vendors based in Canada NextEdge Peptides and Peptide Confidential ship to the USA", () => {
    const file = validateEvidence(JSON.parse(readFileSync("src/vendors/shipping-evidence.json", "utf8")));
    const canadian = new Set(validateOrigin(JSON.parse(readFileSync("src/vendors/origin-evidence.json", "utf8"))).filter((e) => e.based_in === "CA").map((e) => e.slug));
    const inCanada = file.filter((e) => canadian.has(e.slug));
    expect(inCanada).toHaveLength(10);
    expect(inCanada.filter((e) => e.ships_to.includes("US")).map((e) => e.slug).sort()).toEqual(["nextedge-peptides", "peptide-confidential"]);
    expect(inCanada.every((e) => e.ships_to.includes("CA"))).toBe(true);
  });
});
