# ADR-0008 · Price tracking: an editorial section, a closed schema, a separate login

**Status:** accepted · 2026-11-10

## Context

Pepforum's line for members is "no vendors, no sourcing": posts that name stores or prices are removed and the sourcing shield blocks vendor domains. The owner wants the site itself to track what Canadian vendors charge, together with the certificates of analysis they publish, and to earn affiliate commission where a vendor agrees to it. PepSpotter, a working price tracker (pipeline, schema, site), was handed over as source code.

Three questions follow: how prices sit beside the forum's rule, where the pipeline and its data live, and what keeps money from bending the comparison.

## Decision

- **Editorial, not member content.** The Prices section is written by the pipeline and by admins only. The community rule and the shield are unchanged: members still cannot post vendors, prices or affiliate links. The tagline, the privacy policy's "what we never do" and two new public pages (how prices are tracked, affiliate disclosure) say so. `features.prices` (off by default) hides the whole section, including its read functions.
- **Ported, not linked.** PepSpotter's pipeline is copied into `apps/prices` and its tables into this project's database, so Pepforum depends on no other account. The X poster, guides, SEO hubs and PepSpotter's own site are not ported. Only Canadian vendors are seeded.
- **A closed schema.** Price tables live in `prices`, which PostgREST does not expose and in which no API role (anon, authenticated, service_role) holds anything; `private.security_audit()` now checks that. The site reads through `get_price_catalog`, `get_price_history` and `price_link`, which show only published offers of active vendors.
- **A separate login, not the secret key.** The pipeline connects straight to Postgres as `pepforum_prices`, which can write offers and run records and call four functions, and nothing else: no DELETE, no forum table, no publishing of a run the gate did not pass. Invariant 4 stands: the secret key stays in `apps/worker`. Raw captures are kept as private workflow artifacts so the pipeline needs no storage credentials at all.
- **Only checked prices are shown.** A run reaches the site through `publish_offers` after the gate passed it. A held run changes nothing; prices age into "stale" and drop out of ranking by themselves.
- **Certificates are the vendor's claim.** An admin records what a certificate states (lab, method, batch, date, purity) and publishes it; the pipeline can only file a link as a candidate. The site always labels it as published by the vendor and not verified. Pepforum does not test anything and does not rate vendors.
- **Affiliate terms never touch the comparison.** No store address is rendered; links go through `/prices/go/<id>`, where the database picks the address (affiliate when terms are recorded) and counts the click per vendor per day, with no member or visitor identifier. The read API orders by nothing affiliate-related; ranking and "Lowest" are computed from price alone, and tests assert it. Every outbound link is `rel="sponsored nofollow"`, and affiliate vendors are labelled wherever they appear.

## Consequences

- The site now lists stores. That is a change of positioning and of a privacy-policy promise; the owner should take legal advice on comparing prices and earning commission on products sold as research peptides in Canada, and give members notice of the policy change, before switching `features.prices` on.
- A vendor can be removed at once (`delisted`); removal requests go to prices@pepforum.ca.
- Admin time: activating vendors after a dry run, recording certificates, re-reading multipack discounts as they expire, looking at held runs.
- PepSpotter's vendor-specific agreements (a price-feed key, an affiliate code) did not carry over. `VENDOR_KEYS` is empty until a vendor issues Pepforum its own.
- The pipeline's code keeps its original style and is exempt from one compiler check (`noUncheckedIndexedAccess`); see `apps/prices/tsconfig.json`.
