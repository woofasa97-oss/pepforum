# ADR-0009 · A global catalogue: plain links, graded evidence, stores and experts

**Status:** accepted · 2026-11-12 · supersedes parts of [ADR-0008](0008-price-tracking.md)

## Context

The site is moving from pepforum.ca to **pepforums.com**, and from a Canadian forum to a global one. The owner wants it to:
- aggregate every peptide store into one database: prices, lab results, research and regulation;
- publish a quality standard ([QUALITY_ASSURANCE.md](../QUALITY_ASSURANCE.md)) that stores must meet;
- let stores claim or add their listing;
- let members discuss stores with the karma and notes system;
- let vetted professionals assess stores.

ADR-0008 brought in the price tracker as an editorial section with affiliate commission, and kept members from naming vendors.

Research for this decision found that the laws against advertising unapproved drugs apply to *anyone*, not only to sellers:
- Canada, Food and Drug Regulations C.08.002: "sell or advertise";
- Health Canada's 2026 injunction against Canlab, which covers websites reachable from Canada and "assisting others";
- UK, Human Medicines Regulations reg. 279;
- EU, Directive 2001/83 Art. 87;
- Australia, where the TGA names affiliates.

The FDA also cites peptide calculators and buy links as evidence of intended human use.

## Decision

- **Plain links, no commission.** Links to stores go through `/prices/go/<id>` with `nofollow noopener noreferrer`. There are no affiliate addresses, referral tags or discount codes in the database, the pages or the policy. ADR-0008's affiliate clauses are withdrawn, as is the affiliate disclosure page. Clicks are still counted per store per day and nothing else.
- **Grade the evidence, don't test.** Pepforums does not buy or test products. It grades lab results under a published, versioned standard:
  - a sample the store did not choose, verified on the lab's own portal, ranks highest;
  - a certificate the store published itself ranks lowest.
  
  Grades are words ("Meets the Standard", "Partial evidence", "Failed a recent test", "No evidence"), never a "best store" ranking. No payment changes a grade.
- **Stores: aggregated, then claimed, then verified.** The pipeline lists stores from their own public pages. A store can prove it controls its domain (DNS TXT or a `.well-known` file) to claim its listing, and becomes **Verified** only by meeting the Quality Assurance Policy.
- **Members may discuss a store on its own pages.** In a post attached to a store or a peptide page, members can name and link that store. Elsewhere the no-sourcing rule stands. Referral and discount codes, "DM me" and group buys stay banned everywhere. This replaces ADR-0008's "members cannot post vendors" for those pages.
- **Experts are vetted, not empowered.** Professionals are verified on CV, credentials and conflicts of interest. Their structured assessments are shown under their own heading, don't change the grade, and can themselves receive community notes.
- **No dosing, anywhere.** No doses, protocols, calculators, or "for human use" wording. A store's listing must carry none either.
- **Off until counsel signs off.** Every catalogue section is behind a `features.*` switch (`features.prices` today; `catalog`, `lab_results`, `store_claims` and `experts` as they land), and stays off until counsel has reviewed it for each market where the site is visible.

## Consequences

- The privacy policy states that the Prices section, when on, lists stores and counts clicks, and that Pepforums earns nothing from those links.
- A Canadian operator remains subject to Canadian law whatever the domain. Counsel may require per-country display rules, which would need a CDN country header (Cloudflare in front of Render).
- Without affiliate income, the catalogue has no revenue of its own. Ads (ADR-0007) remain the only revenue, and they still exclude vendors.
- The Standard needs maintaining: versions, a changelog, 30 days' notice of changes, and expert review of the numbers before v1.0.
