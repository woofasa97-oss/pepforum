import { describe, expect, it } from "vitest";
import { missingFragments, pageText, quoteFragments } from "./quote-check.ts";

const html = `<html><head><style>p{color:red}</style><script>var x="Ships to USA"</script></head><body>
<p>We ship   across <b>Canada</b>&nbsp;only.</p><!-- Ships worldwide -->
<p>Researchers in the United States are served by our US&nbsp;store&#8217;s team &amp; partners.</p></body></html>`;

describe("quote check", () => {
  it("reads only the visible text", () => {
    const t = pageText(html);
    expect(t).toContain("we ship across canada only.");
    expect(t).not.toContain("ships to usa");
    expect(t).not.toContain("worldwide");
    expect(t).toContain("our us store's team & partners");
  });

  it("splits a quote on either kind of ellipsis", () => {
    expect(quoteFragments("Where do you ship? Across Canada only … Researchers ... served")).toEqual(["where do you ship? across canada only", "researchers", "served"]);
  });

  it("finds a quote across tags, spaces and curly quotes", () => {
    expect(missingFragments(pageText(html), "We ship across Canada only. … US store’s team")).toEqual([]);
  });

  it("compares words, not the punctuation a reader adds between a heading and its text", () => {
    const page = pageText("<h2>Canadian Shipping Only</h2><p>For now, we ship exclusively within Canada.</p><p>Free shipping over $350</p><p>Flat $20 Ontario – $30 outside Ont. Prices $1.50 each.</p>");
    expect(missingFragments(page, "Canadian Shipping Only. For now, we ship exclusively within Canada.")).toEqual([]);
    expect(missingFragments(page, "Free shipping over $350 | flat $20 Ontario - $30 outside Ont.")).toEqual([]);
    expect(missingFragments(page, "Prices $1.50 each")).toEqual([]);
    expect(missingFragments(page, "Prices $150 each")).toEqual(["prices $150 each"]);
    expect(missingFragments(page, "We ship exclusively within Canada and the USA")).toEqual(["we ship exclusively within canada and the usa"]);
  });

  it("names the fragments that are not on the page", () => {
    expect(missingFragments(pageText(html), "We ship worldwide … across Canada")).toEqual(["we ship worldwide"]);
  });
});
