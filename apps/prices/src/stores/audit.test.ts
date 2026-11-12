import { describe, expect, it } from "vitest";
import { type Page, auditPages, countriesIn, pickLinks, reviewHumanUse, windowAround } from "./audit.ts";
import type { LabSeed } from "./directory.ts";

const lab = (slug: string, name: string, tier: LabSeed["tier"]): LabSeed => ({
  slug, name, tier, website_url: null, country: null, accreditation_body: tier === "accredited" ? "A2LA" : null,
  accreditation_number: tier === "accredited" ? "1234.01" : null, verify_how: null, evidence_url: null, evidence_quote: null, checked_on: "2026-11-12",
});
const LABS = [lab("janoshik", "Janoshik Analytical", "recognised"), lab("acme", "Acme Laboratories", "accredited"), lab("house", "Inhouse Lab", "not_accepted")];
const page = (url: string, text: string, links: Page["links"] = []): Page => ({ url, text, links });
const today = new Date("2026-11-12T12:00:00Z");
const labAliases = { janoshik: ["Janoshik"] };
const STORE = { name: "Maple Peptides", domain: "maple.example" };

const shop: Page[] = [
  page("https://maple.example/", "Maple Peptides Research peptides shipped across Canada and the United States. Every batch is third-party tested by Janoshik. Research Calculator Shop now.", [
    { href: "https://maple.example/coa/bpc-157-lot-2611.pdf", label: "BPC-157 COA" },
    { href: "https://janoshik.com/tests/12345-bpc157", label: "Verify on Janoshik" },
  ]),
  page("https://maple.example/contact", "Contact us. Maple Peptides Ltd., 120 King Street West, Suite 400, Toronto, ON M5H 1J9. We are based in Canada and ship from Ontario."),
  page("https://maple.example/lab-results", "Lab results. Certificates of analysis for every lot are listed below. BPC-157 lot 2611 tested 2026-09-14: HPLC purity 99.2%, identity confirmed by LC-MS, endotoxin < 5 EU/mg. Enter the verification key on the lab's site to verify each report."),
  page("https://maple.example/faq", "Is this for human use? No. Our products are not for human consumption. If a lot fails a retest we notify all customers who bought it and stop selling it."),
];

describe("the audit rules", () => {
  it("quotes a window of the page's own words", () => {
    const text = "one two three four five six seven eight nine ten eleven twelve";
    const w = windowAround(text, text.indexOf("six"), 3, 10);
    expect(text).toContain(w);
    expect(w).toMatch(/^\S.*six.*\S$/);
  });

  it("names countries, including short forms", () => {
    expect(countriesIn("We ship to the USA, the UK and Australia").sort()).toEqual(["AU", "GB", "US"]);
    expect(countriesIn("Papua New Guinea")).toEqual(["PG"]);
    expect(countriesIn("research use only")).toEqual([]);
  });

  it("finds identity, certificates, labs and conduct on a well-documented store", () => {
    const f = auditPages({ store: STORE, pages: shop, labs: LABS, labAliases, today });
    const c = f.checks;
    expect(c.identity_name).toMatchObject({ result: "met", value: "Maple Peptides Ltd.", source_url: "https://maple.example/contact" });
    expect(c.identity_address.result).toBe("met");
    expect(c.identity_address.quote).toContain("M5H 1J9");
    expect(c.identity_country).toMatchObject({ result: "met", value: "CA" });
    expect(f.country).toBe("CA");
    expect(c.ships_to.result).toBe("met");
    expect(f.ships_to.sort()).toEqual(["CA", "US"]);
    expect(f.ships_worldwide).toBe(false);
    expect(c.coa_published.result).toBe("met"); // a certificates page, per lot
    expect(c.coa_lab_named).toMatchObject({ result: "met", value: "Janoshik Analytical" });
    expect(c.coa_lab_tier).toMatchObject({ result: "partly", value: "Janoshik Analytical" });
    expect(c.coa_verifiable.result).toBe("met");
    expect(c.coa_identity_ms.result).toBe("met");
    expect(c.coa_endotoxin.result).toBe("met");
    expect(c.coa_current.result).toBe("met");
    expect(c.lot_notice_process.result).toBe("met");
    // "not for human consumption" is negated; "Research Calculator" is a candidate for a person to judge.
    expect(f.human_use_candidates.map((h) => h.term)).toEqual(["Research Calculator"]);
    expect(c.no_human_use_claims.result).toBe("unchecked");
    // Every quote is the page's own words.
    for (const check of Object.values(c)) {
      if (check.quote) expect(shop.find((p) => p.url === check.source_url)?.text).toContain(check.quote);
    }
  });

  it("finds nothing where a store publishes nothing, and says so", () => {
    const f = auditPages({ store: STORE, pages: [page("https://bare.example/", "Bare Peptides. Buy BPC-157 10mg. Research use only.")], labs: LABS, today });
    for (const [name, check] of Object.entries(f.checks)) {
      expect(check.result, name).toBe(name === "no_human_use_claims" ? "met" : "not_found");
    }
  });

  it("an old certificate is not recent; an unknown or in-house lab is not a pass", () => {
    const old = [page("https://old.example/coa", "Certificates of analysis: BPC-157 batch 7, tested March 2024 by Inhouse Lab.")];
    const f = auditPages({ store: STORE, pages: old, labs: LABS, today });
    expect(f.checks.coa_current.result).toBe("not_found");
    expect(f.checks.coa_lab_tier.result).toBe("not_met");
  });

  it("takes a researcher's country only when its words are on our pages", () => {
    const pages = [page("https://x.example/", "Proudly operated from Bogotá, Colombia since 2021.")];
    expect(auditPages({ store: STORE, pages, labs: [], today, discoveryCountry: { code: "CO", quote: "operated from Bogotá, Colombia" } }).country).toBe("CO");
    expect(auditPages({ store: STORE, pages, labs: [], today, discoveryCountry: { code: "MX", quote: "based in Mexico City" } }).country).toBeNull();
  });

  it("worldwide shipping, unless the words deny it", () => {
    expect(auditPages({ store: STORE, pages: [page("https://w.example/", "We ship worldwide with tracking.")], labs: [], today }).ships_worldwide).toBe(true);
    expect(auditPages({ store: STORE, pages: [page("https://w.example/", "We ship to Canada only. We do not ship internationally.")], labs: [], today }).ships_worldwide).toBe(false);
  });

  it("a person's verdict decides human-use claims", () => {
    const f = auditPages({ store: STORE, pages: [page("https://d.example/", "Dosage chart: 250 mcg twice daily, subcutaneous injection. Not for human use.")], labs: [], today });
    expect(f.human_use_candidates.length).toBeGreaterThan(0);
    const first = f.human_use_candidates[0];
    expect(reviewHumanUse(f, [])).toMatchObject({ result: "unchecked" });
    expect(reviewHumanUse(f, f.human_use_candidates.map((c) => ({ quote: c.quote, claim: false })))).toMatchObject({ result: "met" });
    expect(reviewHumanUse(f, [{ quote: first.quote, claim: true }])).toMatchObject({ result: "not_met", source_url: "https://d.example/", quote: first.quote });
  });

  it("reads the pages a person would, never the shop or the cart", () => {
    const picked = pickLinks("https://s.example/", [
      { href: "https://s.example/product/bpc-157/", label: "BPC-157" },
      { href: "https://s.example/cart/", label: "Cart" },
      { href: "https://s.example/lab-results/", label: "Lab Results" },
      { href: "https://s.example/about-us/", label: "About" },
      { href: "https://s.example/shipping-policy/", label: "Shipping" },
      { href: "https://s.example/lab-results/#top", label: "Lab results" },
      { href: "https://s.example/coa/x.pdf", label: "COA" },
      { href: "https://janoshik.attacker.example/lab-results/", label: "Lab results" },
      { href: "https://other-store.example/about/", label: "About" },
    ]);
    expect(picked).toEqual(["https://s.example/lab-results", "https://s.example/about-us", "https://s.example/shipping-policy"]);
  });

  it("does not mistake a supplier, a host or an explainer for the store", () => {
    const pages = [
      page("https://maple.example/privacy", "We use Brevo (Sendinblue GmbH) for email. Hosting: Hetzner Online GmbH, Industriestr. 25, 91710 Gunzenhausen."),
      page("https://maple.example/learn", "Every product is 99% pure, verified with COA. A purity figure is silent on endotoxin. Once shipped we can't recall or redirect a parcel."),
      page("https://maple.example/coa", "Tested at Vanguard Laboratory · Eagle Analytical Services Inc. Reports released."),
    ];
    const f = auditPages({ store: STORE, pages, labs: [], today });
    for (const c of ["identity_name", "identity_address", "coa_verifiable", "coa_endotoxin", "lot_notice_process"] as const) {
      expect(f.checks[c].result, c).toBe("not_found");
    }
  });

  it("counts a tester's results, quoting the count and date only", () => {
    const tester = page("https://www.finnrick.com/vendors/maple", "Maple Safety Rating & Test Results · Finnrick ← Vendors Maple 6 tests · 1 peptide · latest 12 Oct 2026 Visit website 79 % Finnrick rating");
    const f = auditPages({ store: STORE, pages: shop, labs: [], today, independent: tester });
    expect(f.checks.independent_results).toMatchObject({ result: "met", value: "finnrick.com", source_url: tester.url });
    expect(f.checks.independent_results.quote).toBe("6 tests · 1 peptide · latest 12 Oct 2026");
    const none = page("https://www.finnrick.com/vendors/x", "X Safety Rating & Test Results · Finnrick 0 tests");
    expect(auditPages({ store: STORE, pages: shop, labs: [], today, independent: none }).checks.independent_results.result).toBe("not_found");
  });
});
