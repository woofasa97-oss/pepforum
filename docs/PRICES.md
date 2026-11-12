# Price tracking

How the Prices section gets its numbers, what an admin does, and how to run it. Decision record: [ADR-0008](adr/0008-price-tracking.md). Code: `apps/prices` (the pipeline, ported from PepSpotter), migrations `…030`–`…033`, `apps/web/src/app/prices`, `/admin/prices`.

## At a glance

```
Vendors' own stores (WooCommerce Store API · Shopify products.json · product pages)
      │  twice a day, as PepforumsBot, robots.txt obeyed
      ▼
apps/prices   read → match to one compound → build rows → reconcile → GATE → publish
      │  direct Postgres login `pepforum_prices` (never the secret key)
      ▼
schema `prices`   offers (working) → published_offers          (closed to every API role)
      │  get_price_catalog · get_price_history · price_link    (anon-safe, only when features.prices is on)
      ▼
apps/web   /prices · /prices/<compound> · /prices/vendors · /prices/vendor/<slug> · /prices/go/<id>
```

## Rules built into the code

| Rule | Where |
|---|---|
| A price comes from the vendor's own data and must appear in the raw text captured beside it | `src/ingest/build-offer.ts`, `src/fetch/raw-capture.ts` |
| A read is a HIT, a MISS or UNKNOWN; UNKNOWN never changes or removes a stored price | `src/ladder`, `src/ingest/reconcile.ts` |
| A vendor yielding under 70% of its last complete read is held, untouched, until it recovers or a person accepts the drop | `src/ingest/ingest-vendor.ts` |
| Removal is a move to `offer_quarantine` with a reason, restorable per run; the price log is append-only | `prices.quarantine_offers`, `prices.offer_observations` |
| A run is shown only after the gate passed it | `src/gate/gate.ts`, `prices.publish_offers` |
| Prices stay in the vendor's currency; the site converts for display at one dated ECB rate and names it | `src/fx/fx.ts`, `apps/web/src/lib/prices/model.ts` |
| N vials = N singles less the vendor's own multipack discount, or a real N-vial kit when cheaper | `model.ts` `vendorQuote` |
| Stale (default 48 h) and out-of-stock prices are listed last and never "Lowest"; "Lowest" needs two current vendors | `model.ts` `compare`, `lowestOf` |
| Blends are compared per vial within one exact mix; an unstated mix is listed, never ranked | `src/units/blend-*.ts`, `model.ts` |
| Shipping never changes a price or an order | `model.ts`; tests in `apps/web/tests/prices.test.ts` |

### The gate

| Check | Holds the run when |
|---|---|
| `partial_failure` | it has under 70% of the baseline's rows |
| `vendor_zero` | over 20% of the baseline's vendors wrote nothing. Vendors an admin marked "refuses our reader" are left out of both sides |
| `outliers` | over 5% of priced rows are outside ×10 / ÷10 of the compound's per-mg median (outliers are set aside either way) |
| `structural` | impossible rows (implausible mg per vial, a non-product URL); set aside |
| `low_confidence` | over 40% of rows are low-confidence |
| `driver_errors` | over 5% of vendors ended in an error |

The first run has no baseline: it holds (exit 11) until someone accepts it with `gate --accept-baseline --approver … --reason …` and then runs `publish --live` by hand.

## Commands

Run from the repository root; each prints one JSON summary on stdout and logs on stderr. `apps/prices/.env.local` is read if present.

```sh
pnpm prices seed                                   # upsert compounds + the Canadian vendors (owner connection)
pnpm prices probe [--vendors a,b] [--apply]        # detect each store's platform
pnpm prices refresh --mode feeds|pages [--vendors a,b] [--label L] [--live] [--accept-drop]
pnpm prices gate --run L [--accept-baseline --approver "Name" --reason "why"]
pnpm prices prune --run L [--live]
pnpm prices publish --run L [--live]
pnpm prices fx [--date YYYY-MM-DD]
pnpm prices coa-scan --run L [--live]              # file certificate-looking links as candidates
pnpm --filter @pepforum/prices vendors:shipping    # record shipping-evidence.json in vendors.ships_to
pnpm --filter @pepforum/prices vendors:discounts   # record discount-evidence.json in quantity_tiers
pnpm --filter @pepforum/prices vendors:quote-check # re-read every evidence page and check each quote
```

`refresh`, `prune`, `publish` and `coa-scan` only report what they would do unless `--live`; a live run from a non-interactive shell also needs `PIPELINE_ALLOW_LIVE=1`. Exit codes: 0 done or pass · 10 gate hold · 11 hold with no baseline · 2 refused · 1 error.

| Variable | Where | For |
|---|---|---|
| `PRICES_DB_URL` | `apps/prices/.env.local`, GitHub secret | The pipeline's Postgres connection. Hosted: the `pepforum_prices` login through the session pooler. Seeding uses the owner connection. |
| `PIPELINE_ALLOW_LIVE` | workflow | permits `--live` without a terminal |

## Schedule

`.github/workflows/refresh-prices.yml` runs at 06:10 and 18:10 UTC: exchange rates → refresh feeds → gate → prune → publish → the same for product-page shops → certificate-link scan. It is a dry run until the repository variable `LIVE_REFRESH` is `true`, and does nothing until the `PRICES_DB_URL` secret exists. A hold shows as a failed run. Run summaries and the raw captures are kept as private artifacts.

## Going live

1. Apply migrations `…030`–`…033` (`supabase db push`), then `select * from private.security_audit();` must return nothing.
2. Give the pipeline's login a password, out of band: `alter role pepforum_prices password '…';`. Put its session-pooler connection string in the GitHub secret `PRICES_DB_URL`.
3. With the owner connection: `pnpm prices seed`, then `pnpm prices probe --apply`.
4. Dry run: `pnpm prices refresh --mode feeds`. Check the summary and ten rows against the vendors' own pages.
5. In `/admin/prices`, set the vendors that read cleanly to Active.
6. First live run: `refresh --live --label first`, `gate --run first --accept-baseline …`, `publish --run first --live`, and `fx`.
7. Set the repository variable `LIVE_REFRESH=true`.
8. When you are ready for visitors: Admin → Rules & settings → "Show the Prices section".

## Vendors

- All 16 seeded vendors are Canadian and start `pending`. Ten have recorded evidence of where they are based (`src/vendors/origin-evidence.json`); the other six carry the seed's country only and should get evidence before activation.
- Add more in `/admin/prices` (name, https address, country, how we know). A new vendor is `pending`: never read live, never shown.
- **Peptide Confidential** shows prices only to signed-in visitors. PepSpotter read it with a key that vendor issued to PepSpotter; Pepforums has none, so it stays pending unless the vendor issues one (then add it to `VENDOR_KEYS` in `src/env.ts`).
- **vialcrest** was paused by PepSpotter after a data audit; read its dry run carefully.
- A store that refuses the reader (401/403/406) is never worked around: no other address, user agent or cart. Tick "refuses our reader" so it stops counting against the gate; its last prices age out.
- Removal on request: set the vendor to Delisted. The site hides it at once.

## Certificates of analysis

`coa-scan` files links that look like certificates (a document whose address names a COA, or a page on a known testing lab's site) as candidates. In `/admin/prices` a person opens each one and records what it states: lab, accreditation as printed, method, batch, test date, purity, and optionally the line that states it. Publishing needs the lab and the purity. The site shows the certificate beside that vendor's prices as "published by the vendor, not verified by Pepforums", with the day it was read, and links to the document through `/prices/go/c-<id>`.

Never record a figure the document does not state, never round a purity up, and withdraw a certificate the vendor has replaced or removed.

## Links to stores

Plain links only ([ADR-0009](adr/0009-global-catalogue.md)): Pepforums earns nothing from a store, and there are no affiliate addresses, referral tags or discount codes anywhere. A price links to `/prices/go/<id>`, which redirects with no referrer; clicks are counted per store per day only.

## Stores directory

Every store found, worldwide, with a public-information audit under the Standard §9.1 ([ADR-0011](adr/0011-stores-directory.md)). The data lives in `apps/prices/seed/`:

| File | Holds |
|---|---|
| `stores.json` | every store: name, address, kind, and where it is based and ships to once its own pages say so |
| `store-hints.json` | what the researchers read: a country and its words (used only if our reader finds the same words), and a tester's page for the store |
| `store-audits.json` | the audits, one per store per day |
| `labs.json`, `lab-aliases.json` | the laboratories, their tier, and the distinctive names a page uses for them |

```sh
pnpm --filter @pepforum/prices stores:audit --cache <dir> [--stores a,b] [--verdicts <file>]   # read the stores' pages and audit them
pnpm --filter @pepforum/prices stores:read <https url>      # a page's text and links, as the audit reads it
pnpm --filter @pepforum/prices stores:check                 # find every quote again on its page
pnpm --filter @pepforum/prices stores:catalogue --cache <dir>       # what each store lists, and its listed prices (seed/store-listings.json)
pnpm --filter @pepforum/prices stores:brand --cache <dir>           # each store's logo → apps/web/public/brands, apps/web/src/lib/stores/brands.json
pnpm --filter @pepforum/prices stores:sql ../../supabase/migrations/<timestamp>_stores_<name>_data.sql [--parts stores,labs,audits,compounds,listings,documents]
```

The audit also writes `seed/store-documents.json`: the certificate documents each store links. The listings are a dated read, shown on the store's page in its own currency and never compared or ranked. Comparisons stay with the gate-passed price runs below.

The audit reads at most nine pages per store, as PepforumsBot, honouring robots.txt, one page a second per site. Possible human-use claims are written to `<dir>/human-use-candidates.json`. A reviewer judges them against the rubric in ADR-0011 (in the first audit, an AI model, with staff to confirm), and the verdicts (`[{ slug, quote, claim }]`) are passed back with `--verdicts`. A finding against a store whose words were not found again is published as "could not check".

To update production, run the audit and the check, then generate a new data migration (never edit one already applied). It loads idempotently: a store keeps what an admin set, and an audit already loaded is skipped.

## Known limitations

- Ported from PepSpotter and run here only against fixtures and a local database: the first live reads of real stores are still to be done (step 4 above).
- Six of the eleven vendors PepSpotter could not read were refusing its reader; expect the same for some Canadian stores.
- Multipack discounts in `discount-evidence.json` expire 60 days after their check date and need re-reading.
- No lock between runs beyond unique labels and the workflow's queue: do not start a live refresh by hand while the workflow is running.
- A probe needs a known-open Shopify store as a control; none of the seeded vendors is confirmed Shopify, so that control is off by default (`--control-shopify <slug>`).
- Kits described as a total ("10 mg vials", "quantity 100 mg") are stored as one large vial: right per mg, wrong vial description.
