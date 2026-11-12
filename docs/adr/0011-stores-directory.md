# ADR-0011 · The Stores directory and its public-information audit

**Status:** accepted · 2026-11-12 · migration `20261112000035_stores_directory.sql`

## Context

ADR-0009 set out a global catalogue: aggregate every peptide store, then let stores claim their listing and become Verified under the Quality Assurance Policy (`docs/QUALITY_ASSURANCE.md`). The owner asked for a Stores page in the header listing stores worldwide, each audited against that policy.

Two constraints shape it:
- The Standard is a draft (0.9). It says no grade is published before v1.0, after expert and legal review.
- Grading rests on laboratory results that Pepforums does not yet hold. What can be checked today is what each store publishes about itself.

## Decision

- **A directory of every store found.** Stores are rows of `prices.vendors`, any country (ISO 3166-1) or unknown, any currency (ISO 4217), "store" or "manufacturer". Every store but a delisted one is listed. Prices remain a separate, stricter surface: only active stores with published offers.
- **A public-information audit, not a grade.** Each store gets a dated audit of fourteen checks taken from the Standard (§9.1): who the store is, its certificates of analysis, independent testing, and conduct. A check is *met*, *partly met*, *not met*, *not found* (we read its pages and found nothing) or *could not check*.
- **Every finding quotes the store.** A finding names the page and the store's own words. The audit is a program (`pnpm prices stores:audit`), not a person's impression:
  - it reads each store's own pages as PepforumsBot, honouring robots.txt;
  - it applies written rules (`apps/prices/src/stores/audit.ts`, unit-tested);
  - every quote is a span of the text it read, so `stores:check` finds it again.
- **A finding against a store needs confirmed words.** "Not met" is published only when our reader has found the quoted words on the page (`publishable()`); otherwise it becomes "could not check". Human-use claims, the one check where a rule can misread a page ("not for human use"), are judged by a reviewer against a written rubric before they count. In the first audit (2026-11-12) the reviewer was an AI model; staff confirm each "not met" before the directory is switched on.
- **Append-only.** Audits and their checks are never changed; a new audit supersedes the last. The directory shows the latest.
- **Laboratories.** A public list of the labs named on certificates, with their tier under §3. A tier is "accredited" only with the accreditation body and certificate number; until established it is "not yet established".
- **Off until counsel signs off.** `features.stores` gates every read. While it is off, admins see the directory as a preview, with a banner saying so. Store, evidence and lab addresses are never rendered; links go through `/prices/go/<s|e|l>-<id>`, as for prices.

### What each store sells, its logo and its certificates (…037, …038)

- **Listings.**
  - `stores:catalogue` reads each store's own product feed (WooCommerce Store API, Shopify `products.json`). If that is shut, it reads the store's product pages found through its sitemap.
  - It uses the price pipeline's ladder and offer rules: the price must appear in the store's raw text, the currency must be stated, and the product address must be on the store's own brand.
  - Each read is dated and append-only, and the latest is shown, in the store's own currency.
  - Listings are **never compared or ranked**. Comparisons ("lowest", per-mg across stores) remain the Prices section's, from gate-passed runs only (ADR-0008, docs/PRICES.md).
- **Logos.**
  - `stores:brand` takes the store's own header logo or site icon, never a social banner (`og:image`), which can carry marketing claims.
  - Each image is decoded and re-encoded as WebP by sharp, so no store file is served as-is and an SVG becomes pixels.
  - The logos are served from our own origin (`/brands/<slug>.webp`, `img-src 'self'`).
  - A store without a usable logo gets its initials.
- **Certificate documents.**
  - These are the PDFs and images a store links as certificates on the pages the audit read.
  - They are shown as the store's own documents, not checked by Pepforums, and linked through `/prices/go/d-<id>`.
- **Generated data migrations** are named `<timestamp>_stores_<name>_data.sql`. The test harness skips them, except one test that loads them all and checks the security audit (`stores.test.ts`).

### Rubric for human-use claims

A candidate phrase is a claim when the store's own page:
- gives or offers doses, dosing schedules or dosage charts;
- offers protocols, cycles or stacks for using compounds on a person;
- offers a peptide, reconstitution or dosing calculator;
- markets products for an outcome in people (weight loss, fat loss, muscle growth, healing, anti-aging), including shop categories so named;
- says the products are for human use, consumption or injection, or tells the buyer how to take them;
- shows a customer describing their own use or results.

It is not a claim when it is a denial or disclaimer, an explanation of the law, a summary of research that does not tell the reader to use the store's products, or the word used in another sense ("testing protocol", "Water for Injection"). When in doubt, it is not a claim.

## Consequences

- The directory is only as complete as the sweep that found the stores, and as accurate as the rules. Both are re-runnable: `stores:audit` reads the sites again, and each run is a new dated record.
- Stores that refuse automated readers are listed with "could not check". Their audit can't be completed until they claim their listing (ADR-0009) or allow the reader.
- A store's own wording is quoted in public. Quotes are short (≤ 220 characters) and link to their source, and a store can ask for a re-audit.
- Grades (§8.3) still wait for v1.0 of the Standard and for laboratory results. This audit does not replace them.
