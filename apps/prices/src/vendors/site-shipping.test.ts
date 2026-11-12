import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateOrigin } from "./origin.ts";
import { validateEvidence } from "./shipping.ts";
import { forSite } from "./site-shipping.ts";

// Review I6: the shipping file also holds US vendors' evidence for X posts (not yet reviewed by the
// owner); `pnpm vendors:shipping --apply` records for the site only vendors based in Canada, as before.
describe("what the site's shipping record takes from the evidence", () => {
  const ca = { slug: "north", based_in: "CA" as const, basis: "business address" as const, source: "https://north.example/c", quote: "Toronto", checked: "2026-10-08", read_by: "t" };
  const us = { ...ca, slug: "eagle", based_in: "US" as const };
  const ship = (slug: string, ships_to: ("CA" | "US")[]) => ({ slug, ships_to, source: `https://${slug}.example/s`, quote: "we ship", checked: "2026-10-08" });

  it("records vendors based in Canada and leaves the others out, by name", () => {
    expect(forSite([ship("north", ["CA", "US"]), ship("eagle", ["US"]), ship("nowhere", ["US"])], [ca, us])).toEqual({ record: [ship("north", ["CA", "US"])], skipped: ["eagle", "nowhere"] });
  });

  it("the committed files: exactly the ten Canadian vendors are recorded", () => {
    const shipping = validateEvidence(JSON.parse(readFileSync("src/vendors/shipping-evidence.json", "utf8")));
    const origin = validateOrigin(JSON.parse(readFileSync("src/vendors/origin-evidence.json", "utf8")));
    expect(forSite(shipping, origin).record).toHaveLength(10);
  });
});
