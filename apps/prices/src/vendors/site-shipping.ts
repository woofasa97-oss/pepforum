// What `pnpm vendors:shipping` records for the site (owner, 2026-10-05: a vendor based in Canada is in
// the USA view only on evidence). Since 2026-10-08 the evidence file also holds US-based vendors' lines
// for X posts, not yet reviewed by the owner; the site's record keeps to vendors based in Canada.
import type { OriginEvidence } from "./origin.ts";
import type { ShippingEvidence } from "./shipping.ts";

export function forSite(shipping: readonly ShippingEvidence[], origin: readonly OriginEvidence[]): { record: ShippingEvidence[]; skipped: string[] } {
  const inCanada = new Set(origin.filter((e) => e.based_in === "CA").map((e) => e.slug));
  return {
    record: shipping.filter((e) => inCanada.has(e.slug)),
    skipped: shipping.filter((e) => !inCanada.has(e.slug)).map((e) => e.slug),
  };
}
