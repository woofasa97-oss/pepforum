import { readFileSync } from "node:fs";
import { STORE_AUDIT_CRITERIA, type StoreAuditCriterion } from "@pepforum/database";
import { TestDb, anon } from "@pepforum/database/testing";
import { afterAll, describe, expect, it } from "vitest";
import { type AuditSeed, type CheckSeed, type LabSeed, type StoreSeed, directorySql, domainOf, publishable, slugify, validateAudits, validateLabs, validateStores } from "./directory.ts";

const store = (over: Partial<StoreSeed> = {}): StoreSeed => ({
  slug: "bangkok-peptides", name: "Bangkok Peptides", website_url: "https://www.bangkokpeptides.example", canonical_domain: "bangkokpeptides.example",
  kind: "store", origin_country: "TH", origin_source: "https://www.bangkokpeptides.example/contact", ships_to: ["TH", "SG"], ships_worldwide: false,
  native_currency: "THB", ...over,
});
const none: CheckSeed = { result: "not_found", value: null, source_url: null, quote: null, quote_verified_on: null };
const audit = (over: Partial<Record<StoreAuditCriterion, CheckSeed>> = {}, slug = "bangkok-peptides"): AuditSeed => ({
  slug, standard_version: "0.9", audited_on: "2026-11-12", reachable: true, pages_read: ["https://www.bangkokpeptides.example/"],
  checks: { ...(Object.fromEntries(STORE_AUDIT_CRITERIA.map((c) => [c, none])) as Record<StoreAuditCriterion, CheckSeed>), ...over },
});
const lab: LabSeed = {
  slug: "o-brien-analytical", name: "O'Brien Analytical", website_url: "https://obrien.example", country: "IE", tier: "accredited",
  accreditation_body: "INAB", accreditation_number: "123T", verify_how: null, evidence_url: "https://inab.example/123T",
  evidence_quote: "ISO/IEC 17025:2017", checked_on: "2026-11-12",
};

describe("store files", () => {
  it("slugs and domains", () => {
    expect(slugify("Péptidos México S.A. de C.V.")).toBe("peptidos-mexico-s-a-de-c-v");
    expect(domainOf("https://WWW.Example.co.uk/shop?x=1")).toBe("example.co.uk");
  });

  it("accepts a well-formed store and rejects what the database would", () => {
    expect(validateStores([store()])).toHaveLength(1);
    expect(validateStores([store({ origin_country: null, origin_source: null })])).toHaveLength(1);
    for (const bad of [
      { origin_country: "EU" }, { origin_country: "CA", origin_source: null }, { ships_to: ["Canada"] }, { native_currency: "US$" },
      { website_url: "http://bangkokpeptides.example" }, { canonical_domain: "other.example" }, { kind: "pharmacy" },
    ] as Partial<StoreSeed>[]) {
      expect(() => validateStores([store(bad)]), JSON.stringify(bad)).toThrow();
    }
    expect(() => validateStores([store(), store({ slug: "again" })])).toThrow(/duplicate domain/);
  });

  it("needs all fourteen checks, and quotes tied to a page", () => {
    expect(validateAudits([audit()], [store()])).toHaveLength(1);
    const { coa_current: _gone, ...thirteen } = audit().checks;
    expect(() => validateAudits([{ ...audit(), checks: thirteen }], [store()])).toThrow(/missing checks: coa_current/);
    expect(() => validateAudits([audit({ coa_published: { ...none, result: "met", quote: "COA for every batch" } })], [store()])).toThrow(/needs its page/);
    expect(() => validateAudits([{ ...audit(), reachable: false }], [store()])).toThrow(/unreachable/);
    expect(() => validateAudits([audit({}, "nobody")], [store()])).toThrow(/no such store/);
  });

  it("an accredited lab names its body and certificate", () => {
    expect(validateLabs([lab])).toHaveLength(1);
    expect(() => validateLabs([{ ...lab, accreditation_number: null }])).toThrow(/accredited needs/);
  });

  it("publishes a finding against a store only on words our reader found", () => {
    const against: CheckSeed = { result: "not_met", value: null, source_url: "https://x.example/dosing", quote: "Dosage chart", quote_verified_on: null };
    expect(publishable(against)).toEqual({ ...none, result: "unchecked" });
    expect(publishable({ ...against, quote_verified_on: "2026-11-12" })).toEqual({ ...against, quote_verified_on: "2026-11-12" });
    const inFavour: CheckSeed = { result: "met", value: null, source_url: "https://x.example/about", quote: "Based in Bangkok", quote_verified_on: null };
    expect(publishable(inFavour)).toBe(inFavour);
  });
});

describe("the generated migration", () => {
  let db: TestDb;
  afterAll(async () => {
    await db?.close();
  });

  it("loads into the database, idempotently, and the site reads it back", async () => {
    db = await TestDb.create();
    await db.sql(`insert into prices.vendors (slug, name, website_url, canonical_domain, origin_country, origin_source, ships_to)
                  values ('bangkok-peptides', 'Bangkok Peptides', 'https://www.bangkokpeptides.example', 'bangkokpeptides.example', 'TH', 'https://admin.example/note', array['TH'])`);
    const audits = [audit({
      identity_country: { result: "met", value: null, source_url: "https://www.bangkokpeptides.example/contact", quote: "We're based in Bangkok", quote_verified_on: "2026-11-12" },
      no_human_use_claims: { result: "not_met", value: null, source_url: "https://www.bangkokpeptides.example/dosing", quote: "Dosing guide", quote_verified_on: null },
      coa_lab_named: { result: "met", value: "O'Brien Analytical", source_url: "https://www.bangkokpeptides.example/coa", quote: "Tested by O'Brien", quote_verified_on: null },
    })];
    const sql = directorySql([store(), store({ slug: "kiwi", name: "Kiwi", website_url: "https://kiwi.example", canonical_domain: "kiwi.example", origin_country: null, origin_source: null, ships_to: [], ships_worldwide: true, native_currency: null })], [lab], audits, "-- test");
    await db.exec(sql);
    await db.exec(sql);

    // An existing store keeps what was set; it only gains what it lacked.
    expect(await db.sqlOne(`select origin_source, ships_to, native_currency, kind from prices.vendors where slug = 'bangkok-peptides'`))
      .toEqual({ origin_source: "https://admin.example/note", ships_to: ["TH"], native_currency: "THB", kind: "store" });
    expect(await db.sqlOne(`select count(*)::int as n from prices.store_audit_checks c join prices.store_audits a on a.id = c.audit_id
                            join prices.vendors v on v.id = a.vendor_id where v.slug = 'bangkok-peptides'`)).toEqual({ n: 14 });

    await db.setConfig("features.stores", true);
    const { s } = await db.asOne<{ s: { audit: { checks: Array<{ criterion: string; result: string; quote: string | null; quote_verified_on: string | null }> } } }>(
      anon, `select public.get_store('bangkok-peptides') as s`);
    const by = new Map(s.audit.checks.map((c) => [c.criterion, c]));
    expect(by.get("identity_country")).toMatchObject({ result: "met", quote: "We're based in Bangkok", quote_verified_on: "2026-11-12" });
    expect(by.get("no_human_use_claims")).toMatchObject({ result: "unchecked", quote: null });
    expect(by.get("coa_lab_named")).toMatchObject({ result: "met", quote: "Tested by O'Brien", quote_verified_on: null });
    const { d } = await db.asOne<{ d: { labs: Array<{ slug: string; name: string }> } }>(anon, `select public.get_store_directory() as d`);
    expect(d.labs.find((l) => l.slug === "o-brien-analytical")?.name).toBe("O'Brien Analytical");
  });
});

describe("the files in seed/", () => {
  it("are valid", () => {
    const stores = validateStores(JSON.parse(readFileSync("seed/stores.json", "utf8")));
    validateLabs(JSON.parse(readFileSync("seed/labs.json", "utf8")));
    validateAudits(JSON.parse(readFileSync("seed/store-audits.json", "utf8")), stores);
  });
});
