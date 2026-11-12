import { describe, expect, it } from "vitest";
import { findCoaLinks, matchCompoundSlug } from "./scan.ts";

describe("findCoaLinks", () => {
  it("finds certificate documents in HTML, absolute and relative", () => {
    const html = `<a href="/wp-content/uploads/2026/09/BPC-157-COA-LOT42.pdf">Lab report</a>
      <img src="https://cdn.shop.ca/files/tb-500_certificate-of-analysis.png">
      <a href="/product/bpc-157">BPC-157</a> <a href="https://shop.ca/about">About</a>`;
    expect(findCoaLinks(html, "https://shop.ca/product/bpc-157").sort()).toEqual([
      "https://cdn.shop.ca/files/tb-500_certificate-of-analysis.png",
      "https://shop.ca/wp-content/uploads/2026/09/BPC-157-COA-LOT42.pdf",
    ]);
  });

  it("reads through the escaping of a JSON product feed", () => {
    const feed = JSON.stringify({ description: `<p>Purity: <a href="https://shop.ca/coa/retatrutide-10mg.pdf?v=2&amp;x=1">COA</a></p>` });
    expect(findCoaLinks(feed)).toEqual(["https://shop.ca/coa/retatrutide-10mg.pdf?v=2&x=1"]);
  });

  it("takes report pages on a known testing lab's site", () => {
    expect(findCoaLinks(`See https://www.janoshik.com/tests/12345-BPC157 and https://janoshik.com/`)).toEqual(["https://www.janoshik.com/tests/12345-BPC157"]);
  });

  it("ignores plain product images, http links, credentials and words that merely contain 'coa'", () => {
    const html = `<img src="https://shop.ca/uploads/bpc-157-vial.png"> <a href="http://shop.ca/coa/x.pdf">x</a>
      <a href="https://user:pw@shop.ca/coa/x.pdf">y</a> <a href="https://shop.ca/products/cocoa-butter.pdf">z</a>
      <a href="https://shop.ca/coach/plan.pdf">w</a>`;
    expect(findCoaLinks(html)).toEqual([]);
  });

  it("returns each link once and at most fifty", () => {
    const many = Array.from({ length: 80 }, (_, i) => `<a href="https://shop.ca/coa/lot-${i}.pdf">c</a><a href="https://shop.ca/coa/lot-${i}.pdf#page=2">c</a>`).join("");
    const links = findCoaLinks(many);
    expect(links).toHaveLength(50);
    expect(new Set(links).size).toBe(50);
  });
});

describe("matchCompoundSlug", () => {
  const slugs = ["bpc-157", "tb-500", "bpc-157-tb-500", "cjc-1295", "cjc-1295-dac", "ghk-cu"];

  it("picks the compound the address names, preferring the most specific", () => {
    expect(matchCompoundSlug("https://shop.ca/coa/BPC_157-LOT42.pdf", slugs)).toBe("bpc-157");
    expect(matchCompoundSlug("https://shop.ca/coa/cjc-1295-dac-5mg.pdf", slugs)).toBe("cjc-1295-dac");
    expect(matchCompoundSlug("https://shop.ca/coa/bpc-157-tb-500-blend.pdf", slugs)).toBe("bpc-157-tb-500");
  });

  it("answers null when nothing fits, or when two compounds fit equally", () => {
    expect(matchCompoundSlug("https://shop.ca/coa/lot-42.pdf", slugs)).toBeNull();
    expect(matchCompoundSlug("https://shop.ca/coa/tb-500-and-ghk-cu.pdf", slugs)).toBeNull();
    expect(matchCompoundSlug("not a url", slugs)).toBeNull();
    expect(matchCompoundSlug("https://shop.ca/coa/abpc-1570.pdf", slugs)).toBeNull();
  });
});
