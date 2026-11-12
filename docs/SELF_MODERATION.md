# Self-moderation system

Pepforums' moderation is done mostly by members. Reddit-style karma measures community standing; X-style Community Notes add context to misleading posts; a progression system rewards members who moderate *accurately*. This document is the specification. Every number here is a default in `app_config` (migration `…011_reference_data.sql`) and can be changed in production with `admin_set_config()`, which is logged.

## Design principles

1. **Reward accuracy, never volume.** Moderation rewards are paid only when the outcome is known (a note *settles*, a moderator acts on a report), and only for agreeing with an outcome reached across perspectives.
2. **Correct claims, protect people.** Notes add context. Penalties apply only to an uncorrected misleading *claim* that raters with different track records agree on. First-hand experience reports are never penalised.
3. **Popularity can't buy moderation power.** Karma opens the door to notes, but writing notes and Steward powers require a proven rating record and clean integrity.
4. **Everything is explainable.** Each point is a ledger row with a reason; each capability gate returns the exact unmet requirement; each moderator action is in an append-only log and can be appealed to a different moderator.
5. **The database enforces it.** All of this lives in SQL behind RLS and `security definer` functions, so it holds even if someone calls the API directly.

## Three measures of standing

| Measure | Range | Comes from | Unlocks / gates |
|---|---|---|---|
| **Karma** (community track, public) | unbounded | Votes on your posts and comments | Posting tiers; entry gate for notes |
| **Moderation XP** (moderation track, private) | unbounded | Accurate ratings, helpful notes you wrote, reports a moderator acted on | Steward powers (with karma and integrity) |
| **Integrity** | 0–100 | Starts at 100; minus active strikes (each expires after 90 days) | Can switch privileges off |

Plus two counters used for note privileges: **rater impact** (settled ratings that matched the outcome minus those that didn't) and **writer impact** (Helpful notes minus Not Helpful notes).

**Why the moderation track is private.** Moderation XP, rater impact, writer impact and rater status change when a note settles. If they were public, anyone could compare profiles before and after a scoring run, unmask the pseudonymous writer, and see how each rater voted. They are therefore readable only by their owner (`/karma`, `my_standing()`) and by staff in an MFA session. For the same reason, note writers are paid moderation XP only, never public karma: a karma jump at settlement would reveal them. This is how X keeps Community Notes contributors anonymous.

### Tiers (karma)

| Tier | Karma | Unlocks |
|---|---|---|
| 0 Newcomer | 0 | Text posts (3 a day), comment, vote, report |
| 1 Member | 100 | Link posts; the normal posting limit (10 a day) |
| 2 Trusted | 1,000 | Start rating notes (probation) |
| 3 Contributor | 3,000 | Write notes, once a graduated rater |
| 4 Steward | 10,000 | Steward powers, with mod XP ≥ 150 and integrity ≥ 90 |

**Taking part is never gated.** A new member can post the moment they confirm their email (or finish onboarding after a social sign-up). Karma unlocks what carries more risk: links, then moderating other people. A Newcomer's posts face the same checks as everyone else's: the sourcing shield, collapse on reports, and the integrity gates. On top of the normal limit, a Newcomer can start `rate_limit.post_newcomer` posts a day (default 3); reaching Member lifts it.

**Admins** pass every karma gate in this table (posting, links, rating and writing notes, Steward) and get the top tier's protection from report collapses, but their karma isn't changed: it still comes only from the community (…019, [ADR-0006](adr/0006-admin-limits.md)).

**Hysteresis:** you're promoted the moment you reach a threshold, but demoted only when karma falls below 90% of your current tier's threshold (`tiers.demotion_ratio`), so privileges don't flicker.

**Verified social accounts** (…028): a member who verifies an X, YouTube, Instagram, TikTok or Reddit account (by signing in to it) gets a badge and a one-time bonus for their largest verified audience: `min(max, step × (1 + ⌊log₁₀(audience ÷ min)⌋))`, i.e. 1k → 25, 10k → 50, 100k → 75, 1M+ → 100 karma by default. The bonus is capped at Member on purpose: followers can be bought and large peptide accounts are often vendors, so Trusted and above still have to be earned here. It is one ledger fact (`social_verified`), recalculated when accounts change; removing the account (by the member, or by an admin for a vendor or impersonation) takes it back.

### Capability gates

`private.capability_check(user, capability)` returns `NULL` (allowed) or a reason key (`tier:2`, `account_age:30`, `integrity:70`, `rater_impact:5`, `writing_locked`, `frozen`, `sanctioned`, `email_unconfirmed`, `onboarding`…). The UI renders the reason as a sentence ("Requires Trusted").

| Capability | Requirement |
|---|---|
| `vote`, `comment`, `report` | confirmed email, no suspension/ban |
| `post_text` | integrity ≥ 30 · not frozen (3 posts/day as a Newcomer; one post/day below integrity 50) |
| `post_link` | Member |
| `rate_notes` | Trusted · account ≥ 30 days · integrity ≥ 70 · not frozen (· confirmed phone if `gates.rate_notes.require_phone`) |
| `write_notes` | `rate_notes` + Contributor · **graduated rater** (rater impact ≥ 5) · integrity ≥ 80 · not writing-locked |
| `steward` | karma ≥ 10,000 · mod XP ≥ 150 · integrity ≥ 90 |

**Social sign-ups** (Google, Apple, …) start with a placeholder username and the reason `onboarding` on every capability, until they choose a username and confirm they're an adult with `complete_onboarding()` (rate limit `rate_limit.onboarding`, default 20 per hour; it can succeed only once). After that they are ordinary Newcomers: the same karma, age and integrity gates apply, so a fresh social account is no shortcut to moderation power.

**Founding raters** (granted by an admin, with an expiry, logged) bypass the karma, age and graduation requirements but not integrity. They carry the system at launch.

## Votes → karma

- Self-votes are rejected.
- Whether a vote moves karma is decided once, when it's cast (`post_votes.counts_for_karma`). It doesn't count if:
  - the voter's account is younger than 7 days, or the voter's integrity is below 50;
  - the voter has already given this author 5 counted votes in 30 days (fans, vote rings);
  - the author has already received 100 counted votes today (brigades, viral spikes).
- One item can cost its author at most **5** karma (`karma.vote_floor_per_item`).
- The score shown to readers counts every vote; only the karma effect is filtered.

## Community notes

### Lifecycle

```
proposed → needs_more_ratings ⇄ helpful | not_helpful → locked (settled)
```

- **Writing:** a note has a classification, a body of 20–500 characters, 1–5 sources (specific `https://` pages, not homepages) and a language. A writer can't note their own post, and writes at most one note per post. Publicly the writer appears as a stable pseudonym ("Contributor 3FA2").
- **Rating:** Helpful, Somewhat or Not helpful, plus 1–6 reason tags valid for that value. Nobody can rate their own note or a note on their own post.
- **Rating weight:**
  - Probationary raters weigh **0**: their ratings build impact but don't move status.
  - Graduated and founding raters weigh **1** on notes the queue assigned them (`next_note_to_rate`) and **0.5** on notes they navigated to themselves (`notes.unassigned_weight`). This makes targeted brigades expensive.
  - The queue can't be re-rolled to fish for a target. A rater holds one outstanding assignment at a time: asking again returns the same note until it is rated, closes, or 24 hours pass. New draws are rate-limited (`rate_limit.queue`).
- **Herding:** the helpful/not-helpful breakdown stays hidden until the note locks. A rating cast (or changed) after the note's status became public earns no accuracy credit. That includes a note that showed a status and later fell back to Needs More Ratings.
- **Locking:** a note locks when its status has been stable for 72 hours with at least `min_ratings` full-weight ratings (5 by default; Regulation uses 7), or when it reaches 14 days. Rewards and penalties are paid only at lock, so a flip-flopping status never pays out twice.

### Scoring

The worker (`apps/worker`) computes statuses every 10 minutes and applies them atomically with `apply_note_scores()`.

- **Bootstrap mode** is the default at launch. Weighted helpful share (Helpful = 1, Somewhat = 0.5, Not = 0):
  - **Helpful** when the 90% Wilson lower bound is ≥ 0.60. Five unanimous ratings clear this bound; a single dissent among six does not.
  - **Not Helpful** when the upper bound is ≤ 0.40.
  - Otherwise **Needs More Ratings**.
- **Bridging mode** is matrix factorisation, X's model: `r̂ = μ + i_rater + i_note + f_rater·f_note`, with L2 regularisation of 0.15 on intercepts and 0.03 on factors.
  - **Helpful** when `i_note ≥ 0.40` and `|f_note| < 0.5`.
  - **Not Helpful** when `i_note ≤ −0.05 − 0.8·|f_note|`.
  - The factor absorbs agreement that is explained by viewpoint. A note therefore needs support from both sides.
- **Shadow runs:** both scorers run on every pass; the inactive one is stored in `scoring_runs.shadow` along with the agreement rate.
- **Switching:** set `scoring.mode` to `bridging` once at least 150 raters have 10 or more ratings and shadow agreement is ≥ 85%. A guard keeps applying bootstrap if the rater pool is too small.

The test suite contains the motivating case. When one camp outnumbers the other 85:15, the bootstrap scorer marks that camp's partisan notes Helpful. The bridging scorer does not.

### Settlement (at lock)

| Who | Note settles Helpful | Note settles Not Helpful | Locks as Needs More Ratings |
|---|---|---|---|
| Writer (private moderation track) | +15 mod XP, +1 per helpful rating (max +10) | −10 mod XP | nothing |
| Rater (definite rating cast before the result was public) | `xp = 2 × (match − π)` | same formula | nothing |
| Post author | strike + karma loss, only under the conditions below | nothing | nothing |

**Base rate π:** π is the recent probability (90 days) that a rating of that value matched the final outcome. It defaults to 0.5 until there are 20 samples. Paying `2 × (match − π)` makes always voting with the majority, or guessing, worth zero on average. "Somewhat" ratings are neutral.

**Rater impact** is recomputed for every rater of the note:
- reaching **+5** graduates a probationary rater, so their ratings start carrying weight;
- falling to **−5** sends an active rater back to probation.

**Writer lock:** if 5 or more of a writer's last 10 settled notes are Not Helpful, and fewer than 30% of them are Helpful, note writing pauses for 30 days.

**Author strike:** the post author gets a strike only when **all** of these hold:
- the note's classification is in `notes.strike_classifications` (default: `misleading` only);
- it settled **Helpful**;
- the post is **not** an Experience post;
- the author did **not** correct the post within 72 hours of the note first being shown. A correction prevents the strike. It must actually change the post compared with the revision the note was written against; no-op edits are rejected, and every revision is public.

The strike costs 15 integrity for 90 days and −10 karma, capped at −30 note-related karma per rolling 30 days. Deleting the post afterwards doesn't undo it.

## Reports and moderators

- **Reports:** weight is 0.5–1.5 depending on the reporter's integrity. Each member can file 10 per day, once per item.
- **Member reports** (…019): a report about a person rather than one post goes to admins only, from the **Report member** button on their profile. It never collapses anything or changes anyone's karma; admins close it as *action taken* or *dismissed* after acting (or not) from the member's page. Each member can report 5 people a day (`rate_limit.report_member`), with one open report per person. See [ADMIN.md](ADMIN.md#member-reports).
- **Contact the team** (…020): members can also open a private ticket to the admins (a suggestion, a report about a member or a post, a problem, account help) and talk it through. Tickets never act on anyone: admins act from the member's page. Each member can open 5 a day (`rate_limit.open_ticket`) and reply 30 times an hour (`rate_limit.ticket_reply`). See [ADMIN.md](ADMIN.md#inbox).
- **Auto-collapse:** content collapses (it is never deleted) when the open reports reach total weight ≥ 3 from at least 3 distinct reporters whose accounts are at least 14 days old.
  - Content by a Trusted+ author collapses only if a Steward is among the reporters.
  - If no moderator reviews it within 48 hours, the collapse reverts.
- **Moderator decisions:** a moderator (site-wide, ADR-0010), in an MFA (aal2) session, removes or keeps the content.
  - **Removal** costs the author 25 karma (100 for sourcing), a strike, and a 7-day freeze. Every reporter earns +3 mod XP.
  - **Keep** dismisses the reports at no cost, except reports the moderator explicitly marks *abusive*, which cost −2 mod XP.
- **Reporter XP:** a moderator earns nothing for resolving their own report. Reporter XP is reversed if the removal is later overturned on appeal.
- **Sanctions:**
  - Moderators can warn or freeze. Only admins can suspend or ban.
  - Nobody can lift their own sanction. A moderator can only undo a warning or freeze they issued; everything else goes through an admin or an appeal.
  - Frozen members can't post or edit posts.
- **Staff reads need MFA too.** Note authorship, other members' ledgers, sanctions, reports and pre-lock breakdowns require an aal2 session, just like staff actions.
- **Moderator identity:** members see what was done to them and why, but not which moderator did it (anti-retaliation). Moderators see it in the mod tools.
- **Appeals:** one appeal per action, within 30 days, decided by a *different* moderator. An upheld appeal reverses the karma, strike and freeze. The reversal is itself a ledger row.

## Admin controls and the sourcing shield

Admins run the community from `/admin` ([ADMIN.md](ADMIN.md)). They can sanction, restore content, pin up to two posts for the whole site (`posts.pinned_at`), lock comments on a post, and hide a note that breaks the rules itself. They **can't** edit karma, XP or tiers, or set a note's status ([ADR-0006](adr/0006-admin-limits.md)): hiding an open note closes it as Needs More Ratings, which settles with no rewards and no strike.

The **sourcing shield** checks every post, comment, edit and note:
- **Blocked domains** are refused wherever they appear.
- **Watched phrases** either `block` the text, or `hold` it with status `held`. Held content is visible only to its author and the moderators until a moderator keeps or removes it from the queue, and it never reopens on its own.
- Moderators' own content is exempt. Notes can't be held, so any matching rule refuses them.
- Seeded hold-phrases: dm me, telegram, whatsapp, signal me, wickr, discount code, promo code, coupon code.

**Link review** (…018): a post or comment with a link (`http://`, `https://` or `www.`) is held until an admin approves the link, or its whole site, on `/admin/links`. Approved sites (and their subdomains) pass from then on; a declined item is removed with **no** karma penalty or strike, because posting a link isn't a violation in itself. Blocking a site adds it to the shield's blocked domains. Moderators and admins are exempt, and note sources aren't reviewed (only proven Contributors write notes). Shield holds (`held_reason`) and link holds (`links_pending`) are cleared separately, and content goes live only when both are. See [ADMIN.md](ADMIN.md#link-review).

New settings:

| Key | Default | Meaning |
|---|---|---|
| `rate_limit.admin_action` | 300 / hour | Admin console writes per admin |
| `features.prices` | false | Show the Prices section (…030). Off: the pages, the header link and the price read functions return nothing; the pipeline may keep running |
| `features.stores` | false | Show the Stores directory (…035, ADR-0011). Off: only admins see it, as a preview; the read functions return nothing to anyone else |
| `prices.stale_hours` | 48 | A published price not rechecked within this many hours is marked and no longer ranked (12–720) |
| `prices.lead_vials` | 10 | The order size a price comparison opens on: 1, 3, 5 or 10 |
| `links.require_approval` | true | Posts and comments with a link wait for an admin (…018) |
| `rate_limit.post_newcomer` | 3 / day | Posts a Newcomer can start, on top of `rate_limit.post` (…017) |
| `rate_limit.report_member` | 5 / day | Members one person can report to the admins (…019) |
| `socials.bonus_min_audience` | 1000 | Verified audience needed for a karma bonus (…028) |
| `socials.bonus_step_karma` | 25 | Bonus karma at the minimum and per tenfold audience |
| `socials.bonus_max_karma` | 100 | Cap on the one-time bonus (100 = exactly Member) |
| `rate_limit.social_link` | 10 / day | Social accounts verified or removed per member |
| `rate_limit.follow` | 60 / hour | Follows and unfollows per member (…027) |
| `rate_limit.avatar` | 10 / day | Profile picture changes per member (…027) |
| `rate_limit.open_ticket` | 5 / day | Tickets one member can open to the team (…020) |
| `rate_limit.ticket_reply` | 30 / hour | Replies one member can add to their own tickets (…020) |
| `site.announcement` | empty | Site-wide banner `{en, fr, tone: info\|warn, until}` |

Numeric settings now carry `app_config.bounds` (min/max), which `admin_set_config` checks along with the shape of `tiers.thresholds` and the `rate_limit.*` objects.

## Ported features: what they don't change

Images, clinician badges, notifications and ads (migrations …021–…025) sit beside the economy and never touch it:

- A **verified clinician** badge is identity, not authority: no karma, no note weight, no moderation power. Settings: `clinician.valid_days`.
- **Images** are a capability (`upload_image`: tier ≥ `gates.upload.min_tier`, default Trusted; integrity ≥ `gates.posting.min_integrity`), with `uploads.max_bytes` and `uploads.max_per_post`. Removing an image is a logged admin action with no karma effect.
- **Notifications** are private and purged after `notifications.retention_days`.
- **Ads** are prepaid and reviewed; `ads.enabled` is the switch, `ads.cpm.{category,national}` and `ads.min_booking_microcad` the price list (microCAD), `ads.flight_days` the run length. Members' standing is irrelevant to advertising, and advertising buys no standing.
- New rate limits: `rate_limit.{push_subscribe,notification_settings,upload,clinician_submit,ad_write,ad_report}`.

## Launch playbook (cold start)

1. Grant **founding rater** status, with a 90–180 day expiry, to 20–50 people you trust: verified clinicians and known community members.
2. Keep `scoring.mode = bootstrap`. Watch `scoring_runs.shadow.agreement`.
3. Consider lowering `gates.rate_notes.min_tier` to 1 for the first months, so probationary raters start building impact early. Their ratings carry no weight until they graduate, so this is safe.
4. Turn on `gates.rate_notes.require_phone` (needs an SMS provider in Supabase Auth) the moment sock-puppet ratings appear.
5. Switch to `bridging` when the guard conditions are met. Raise `notes.min_ratings` as volume grows.

## Where the code lives

| Concern | Location |
|---|---|
| Capabilities, integrity, tiers | `supabase/migrations/…003_identity.sql` |
| Ledger and reconcile | `…004_ledger.sql` |
| Votes and vote karma | `…005_content.sql` |
| Notes, rating, settlement | `…006_notes.sql` |
| Reports, moderation, appeals | `…007_moderation.sql` |
| Scoring algorithms | `apps/worker/src/scoring/` |
| Behavioural tests | `packages/database/tests/{content,notes,moderation}.test.ts`, `apps/worker/tests/` |
