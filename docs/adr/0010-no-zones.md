# ADR-0010 · No zones; site-wide moderators

**Status:** accepted · 2026-11-12 · migration `20261112000034_remove_zones.sql`

## Context

Pepforum began as a Canadian forum organised by "zones": a national zone, seven regions and 27 cities. Each post belonged to a zone, moderators were appointed per zone, and members had a home zone. The regions were hidden from members in …026.

The site is now global (pepforums.com, ADR-0009), and the owner asked for zones to be removed completely. They chose to keep moderators, as site-wide moderators.

## Decision

- **No zones, cities or home zones.** The tables, the columns on posts, reports, the moderation log and profiles, the regions switch, and every function argument and output that carried a zone are removed. Old `/zone/...` addresses redirect permanently to the community feed.
- **Moderators are site-wide.**
  - `public.moderators(user_id, appointed_by, created_at)` replaces `zone_moderators`; every zone moderator was carried over once.
  - `private.is_moderator()` kept its signature, so the policies and functions built on it are unchanged.
  - `private.require_moderator()` replaces `require_zone_mod()`.
  - Admins appoint or remove a moderator with `public.set_moderator()`, which needs MFA and a reason, is logged, and can't be used on yourself.
- **Appeals.** Appeals on removed posts and comments go to any moderator other than the one who acted. Appeals on sanctions stay with admins.
- **Pins.** Two pinned posts for the whole site; older regional pins were unpinned.
- **Countries instead of provinces.** Clinician verification and advertiser billing take an ISO 3166-1 alpha-2 country. Existing rows became `CA`.
- **Ads.** The "zone" package is gone; its campaigns became site-wide. French copy is now required for every campaign.
- **The log stays readable.** `log_mod_action()` kept its eight arguments so its callers are unchanged; the zone argument is ignored. The action names `appoint_moderator`, `remove_moderator` and `taxonomy_change` stay valid because past log rows use them.

## Consequences

- One moderation queue. As the team grows, routing will be by category or language, not by place.
- A guard test (`packages/database/tests/zones-removed.test.ts`) fails if any function still mentions a zone, city, home zone or province. It also checks the migration of existing data, by building the database up to …033, loading zone data, then applying …034.
- The web app and migration …034 must go live together: the app calls the new function signatures.
