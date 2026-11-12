import { describe, expect, it } from "vitest";
import abbreviations from "../../seed/blend-abbreviations.json" with { type: "json" };
import compounds from "../../seed/compounds.json" with { type: "json" };
import vendors from "../../seed/vendors.json" with { type: "json" };
import { InMemoryRepo } from "../ingest/repo.ts";
import { buildCompoundIndex, matchCompound } from "../units/compound-match.ts";
import { applySeeds } from "./apply-seeds.ts";
import type { CompoundSeed, VendorSeed } from "./types.ts";

const compoundSeeds = compounds as CompoundSeed[];
const vendorSeeds = vendors as VendorSeed[];

describe("seeds", () => {
  it("cover the nine handoff compounds with their fixture strengths", () => {
    const bySlug = new Map(compoundSeeds.map((c) => [c.slug, c]));
    const expected: [string, number[]][] = [
      ["bpc-157", [5, 10, 20]], ["mots-c", [10, 20, 40]], ["ghk-cu", [50, 100]], ["tb-500", [5, 10]],
      // A blend has mixes, not strengths.
      ["ipamorelin", [5, 10]], ["epithalon", [10, 50]], ["selank", [5, 10]], ["ss-31", [10, 50]], ["bpc-157-tb-500", []],
    ];
    for (const [slug, sizes] of expected) expect(bySlug.get(slug)?.known_sizes_mg, slug).toEqual(sizes);
    expect(bySlug.get("bpc-157-tb-500")?.type).toBe("Blend");
    expect(bySlug.get("bpc-157-tb-500")?.blend_components).toEqual([{ slug: "bpc-157" }, { slug: "tb-500" }]);
  });
  it("every blend names its ingredients, and each ingredient is a single compound we track", () => {
    const blends = compoundSeeds.filter((c) => c.type === "Blend");
    const singles = new Set(compoundSeeds.filter((c) => c.type !== "Blend").map((c) => c.slug));
    expect(blends).toHaveLength(20);
    for (const b of blends) {
      const parts = (b.blend_components ?? []).map((p) => p.slug);
      expect(parts.length, b.slug).toBeGreaterThanOrEqual(2);
      expect(new Set(parts).size, b.slug).toBe(parts.length);
      for (const p of parts) expect(singles.has(p), `${b.slug} → ${p}`).toBe(true);
      expect(b.slug).toBe(parts.join("-"));
    }
    // One blend per ingredient set.
    expect(new Set(blends.map((b) => [...(b.blend_components ?? []).map((p) => p.slug)].sort().join("+"))).size).toBe(20);
  });
  it("blend abbreviations point at single compounds and never shadow a real name", () => {
    const singles = new Map(compoundSeeds.filter((c) => c.type !== "Blend").map((c) => [c.slug, c]));
    const names = new Set(compoundSeeds.flatMap((c) => [c.name, ...c.aliases]).map((n) => n.toLowerCase()));
    for (const [abbr, slug] of Object.entries(abbreviations as Record<string, string>)) {
      expect(singles.has(slug), `${abbr} → ${slug}`).toBe(true);
      expect(abbr).toBe(abbr.toLowerCase());
      expect(names.has(abbr), abbr).toBe(false);
    }
  });
  it("has unique slugs and no alias that collides with another compound's name or alias", () => {
    const names = new Map(compoundSeeds.map((c) => [c.name.toLowerCase(), c.slug]));
    const seen = new Map<string, string>();
    for (const c of compoundSeeds) {
      for (const a of c.aliases) {
        const key = a.toLowerCase();
        expect(seen.get(key) ?? c.slug, `alias "${a}" on ${c.slug} and ${seen.get(key)}`).toBe(c.slug);
        seen.set(key, c.slug);
        expect(names.get(key) ?? c.slug, `alias "${a}" is ${names.get(key)}'s name`).toBe(c.slug);
      }
    }
    expect(new Set(compoundSeeds.map((c) => c.slug)).size).toBe(compoundSeeds.length);
  });
  it("AOD-9604 does not claim hGH Fragment 176-191: vendors sell the two as separate products at separate prices", () => {
    const aod = compounds.find((c) => c.slug === "aod-9604");
    expect(aod?.aliases.filter((a) => /frag/i.test(a))).toEqual([]);
    expect(aod?.aliases).toContain("AOD 9604");
  });

  it("no alias files a different product under a compound: a combination, a sibling copper peptide, another cosmetic peptide", () => {
    const index = buildCompoundIndex(compoundSeeds.map((c) => ({ id: c.slug, name: c.name, slug: c.slug, aliases: c.aliases }))).index;
    expect(matchCompound("CagriSema 10mg", index)).toBeNull(); // cagrilintide + semaglutide
    expect(matchCompound("AHK-Cu Copper Peptide 50mg", index)).toBeNull(); // not GHK-Cu
    expect(matchCompound("Leuphasyl 10mg", index)).toBeNull(); // pentapeptide-18, not SNAP-8
    // Controls: the compounds themselves still match.
    expect(matchCompound("Cagrilintide 10mg", index)).toBe("cagrilintide");
    expect(matchCompound("GHK-Cu Copper Peptide (100MG)", index)).toBe("ghk-cu");
    expect(matchCompound("SNAP-8 Peptide (10MG)", index)).toBe("snap-8");
  });

  it("vendors are Canadian, https, pending, with a known platform label or null", () => {
    expect(vendorSeeds.length).toBe(16);
    for (const v of vendorSeeds) {
      expect(v.origin_country).toBe("CA");
      expect(v.website_url).toMatch(/^https:\/\//);
      expect(v.canonical_domain).not.toBe("");
      expect(v.status).toBe("pending");
      expect([null, "woocommerce", "shopify", "custom", "blocked"]).toContain(v.detected_platform);
    }
    expect(new Set(vendorSeeds.map((v) => v.slug)).size).toBe(vendorSeeds.length);
  });
  it("applies idempotently", async () => {
    const repo = new InMemoryRepo();
    const first = await applySeeds(repo, { compounds: compoundSeeds, vendors: vendorSeeds });
    const second = await applySeeds(repo, { compounds: compoundSeeds, vendors: vendorSeeds });
    expect(first).toEqual({ compounds: compoundSeeds.length, vendors: vendorSeeds.length });
    expect(second).toEqual(first);
    expect(repo.compounds.size).toBe(compoundSeeds.length);
    expect(repo.vendors.size).toBe(vendorSeeds.length);
  });
});
