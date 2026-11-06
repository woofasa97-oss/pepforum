# ADR-0007 · Advertising: prepaid, reviewed, reserved-then-charged

**Status:** accepted · 2026-11-06

## Context

Pepforum's positioning is "no vendors, no sales, just context". The prototype build (`pepforum-ca`) had a full advertising workspace: a CPM rate card, prepaid credit on an integer microCAD ledger, reservation of a campaign's budget on submission, staff creative review, impression billing and a hosted crypto checkout (NOWPayments). Porting it raises two questions: can ads coexist with the positioning, and how much of the money machinery belongs in the database.

## Decision

- **Ads exist, under the same rule as posts.** An advertiser's website and a campaign's landing page and copy are checked against the sourcing shield by the database and refused outright on a blocked match; an admin then reviews every campaign by hand before it runs, and any member can report one. Cards are labelled "Sponsored" with the advertiser's name, carry no trackers, and link through `/ads/go/<id>` so no landing URL is ever rendered raw. `ads.enabled` hides every slot.
- **Money follows ADR-0002.** `ad_ledger` is append-only and the only source of truth; `advertisers.balance_microcad` is a cached sum kept by trigger and constrained to be non-negative with reservations never exceeding it. Amounts are integer microCAD. Submitting a campaign reserves its budget from available credit; each settled day charges `impressions × CPM ÷ 1000`, capped at the budget, under an idempotent reference (`charge:<campaign>:<day>`); the unspent reservation returns when the flight ends or the campaign is rejected or stopped.
- **No payment provider in the database, and none in v1.** Credit is recorded by an admin against an external invoice or transaction reference (recorded once). The prototype's NOWPayments adapter stays out: it would put a webhook endpoint, provider secrets and currency conversion on the web service. If hosted checkout is wanted later, it belongs in the worker (the only holder of secrets) writing `payment` ledger rows through a service-only RPC.
- **Impressions are counted by the database** when it serves a card (`get_ad`), once per opaque visitor token per campaign per hour. The token is a salted daily hash of network address and user agent, never joined to a member.

## Consequences

- Advertising buys no standing: nothing in the ledger touches karma, notes or moderation.
- The exposure to fake traffic is bounded by a campaign's budget and reversible by refund (THREAT_MODEL.md, residual risks).
- Admin time: approving accounts, reviewing campaigns, recording payments. The console groups these on one page with the moderation log recording every decision.
