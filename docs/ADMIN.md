# Admin console guide (`/admin`)

The console is where admins look after Pepforums without touching SQL. Everything here is enforced by the database (migrations `…015_admin_console`, `…016_sourcing_shield`, `…018_link_review`, `…019_member_reports_and_owner` and `…020_support_tickets`): the web pages only display what the admin RPCs return and send changes back to them.

## Getting in

1. You need the **admin** role. The site owner gives it from **Team & access** (see "The site owner" below). The very first admin, who becomes the owner, is created with SQL (see [DEPLOYMENT.md](DEPLOYMENT.md), "Bootstrap staff").
2. You need **two-factor sign-in** (an authenticator app, set up in Settings → Security). Without an MFA session the database refuses every admin read and write.
3. Open **Admin** in the header, or go to `/admin`.

## The rules the console can't break

- **Every change needs a reason**, and is written to the append-only moderation log with your name.
- **Nobody edits karma or XP.** To undo a penalty, undo its cause: restore the content, uphold the appeal or remove the strike. The ledger records the reversal.
- **Nobody overrides a community note's rating.** An admin may only *hide* a note that breaks the rules itself (personal information, vendor links, abuse). Hiding an open note closes it as "Needs ratings", which rewards and penalises nobody. See [ADR-0006](adr/0006-admin-limits.md).
- **Only the site owner adds or removes admins.** Nobody changes their own role, and the last admin can't be removed.
- **Emails stay private.** Profiles show a masked address. A real one appears only through an exact-email lookup or the **Reveal** button, and both are logged.
- Admin changes are rate-limited (`rate_limit.admin_action`, 300 an hour), which limits the damage from a stolen session.

## Sections

| Section | Use it to |
|---|---|
| **Home** | See what needs you today, and community health (active members, posts, notes, reports) over 7, 30 or 90 days, with how well moderation is working. Download the numbers as CSV. |
| **Inbox** | Read and answer what members send the team from **Contact the team**: suggestions, reports about a member or a post, problems with the site, account help. See "Inbox" below. |
| **Moderation** | Work the report queue across every zone, including posts held by the shield. Decide appeals, including sanction appeals that only admins can decide. Read the log of who did what (with Undo where possible). See each moderator's speed and how often appeals overturn them. |
| **Links** | Approve or decline every link members post. Approve a whole site once (e.g. `pubmed.ncbi.nlm.nih.gov`) and its future links go straight through; block a vendor site and everything waiting on it is declined. See "Link review" below. |
| **Member reports** | Members reporting another member (harassment, selling, impersonation, a banned member back on a new account…). One card per member with every open report about them. See "Member reports" below. |
| **People** | Find a member by username, or by exact email for privacy and support requests. A member's page shows everything in one place: standing, strikes, sanctions, ledger, content, notes, appeals, risk signals and private staff notes. Actions: warn, freeze, suspend, ban, lift, rename, roles, founding rater, clear a writing lock, remove a mistaken strike. |
| **Content** | Search posts, comments and notes, removed ones included. Remove, restore, pin (two per zone), lock comments, hide or unhide notes. |
| **Clinicians** | Members asking for a "verified" badge (physician, pharmacist, nurse practitioner…). Check the regulator's public register, approve for the configured validity, reject or revoke with a reason. See "Clinicians" below. |
| **Ads** | Approve advertiser accounts, review every campaign before it runs, stop campaigns, record payments and refunds, resolve member reports about an ad. See "Ads" below. |
| **Media** | Images members uploaded (post images and profile pictures), newest first. Remove one with a reason: it disappears at once and the worker deletes the file. A removed profile picture falls back to the member's initials. |
| **SEO** | The sitemaps search engines read, and redirects for moved or mistyped paths (301/302). A redirect never shadows a real page. |
| **Community notes** | Watch the notes pipeline, scoring runs and agreement, and readiness to switch to bridging scoring (with the switch). See raters, writer pauses, and signs of manipulation: notes rated mostly by new accounts, and rater pairs who almost always agree. |
| **Sourcing shield** | Block vendor sites, and watch phrases ("dm me", "telegram") that either hold a post for review or block it. Test any text against the rules. |
| **Rules & settings** | Change any rule of the karma and notes economy in plain words, with its allowed range, history and Revert. Edit categories, zones and city sub-zones. Publish a site-wide announcement. |
| **Team & access** | Admins (the owner adds and removes them), zone moderators, founding raters, who qualifies as a Steward, and which staff lack two-factor sign-in. |
| **System** | Background jobs (scoring, maintenance, deletions), the security self-audit, the privacy deletion queue, sign-in providers, and the busiest accounts. |

The public **[/transparency](../apps/web/src/app/transparency/page.tsx)** page publishes monthly totals (removals by reason, sanctions, appeals, notes, shield holds). It contains no member data.

## A daily routine (10 minutes)

1. **Home:** clear the "Needs you" list from top to bottom. Red first.
2. **Inbox:** answer everything under *Waiting for us*, oldest first.
3. **Links:** approve or decline what's waiting. When several items link to the same site, use **Approve site** in "Sites waiting".
4. **Member reports:** look into each member, act from their page if needed, then close the reports.
5. **Moderation → Queue:** keep or remove each item. Held posts never reopen on their own, so they wait for you.
6. **Moderation → Appeals:** decide the ones you didn't act on yourself.
7. **System:** jobs should all say *Running*, and the self-audit *0 problems*.
8. Weekly: skim **Community notes → Signs of manipulation**, and **Moderation → Moderator performance**.

## Sourcing shield: how rules behave

| Rule | Posts and comments | Notes |
|---|---|---|
| Blocked site | Refused, wherever the site appears (link, bare `site.com`, subdomains) | Refused, including as a source |
| Phrase set to **hold** | Saved as *held*: only the author and moderators see it until a moderator keeps or removes it | Refused (notes can't be held) |
| Phrase set to **block** | Refused | Refused |

Phrases match whole words in any capitalisation. Moderators' own posts are exempt, so a warning that names a scam channel still goes through. Only holds are counted, because a block cancels the whole write and leaves no record. The hit log stores the member and the rule, never the text.

## Link review

Every post or comment that contains a link (anything starting with `http://`, `https://` or `www.`) is saved as *held*: only its author and moderators see it until an admin decides on the **Links** page. Moderators' and admins' own links are exempt. Community-note sources are not reviewed, because only proven Contributors write notes and every note is rated before it shows; blocked sites are still refused there.

| Button | What happens |
|---|---|
| **Approve** | This item is published. Its links stay approved if the author edits it later; a new link in an edit waits again. |
| **Approve all of *site*** / **Approve site** | The site (and its subdomains) is added to Approved sites. Everything waiting that links only to approved sites is published, and future links to it go straight through. |
| **Decline** (reason required) | The item is removed with no karma penalty and no strike. The author sees "Removed by a moderator: link not approved". Restoring it from **Content** sends it back to the Links page. |
| **Block site** (reason required) | The site joins the shield's blocked sites, so new posts linking to it are refused, and everything waiting on it is declined. For vendor spam, also sanction the member from **People**. |

If text is also held by the shield ("dm me"…), approving the link leaves it in the moderator queue, and keeping it in the queue leaves it waiting for the link. It's published only when both are cleared. Turn the whole review off with **Rules & settings → Admins approve every link** (`links.require_approval`).

## The site owner

One admin is the **owner**: the main account, and the only one who can make someone an admin or remove an admin. Other admins can do everything else; on **Team & access** they see who the owner is instead of the Add and Remove buttons.

**Making someone an admin** (owner only):

1. They create an account and confirm their email.
2. **Team & access → Add an admin**: type their username and a short reason, and confirm. Or open their page in **People** and use **Make admin**.
3. They turn on two-factor sign-in under **Settings**. The console stays closed to them until they do.

**Removing an admin:** **Remove admin** on their row in **Team & access**, or on their page in **People**. They lose access straight away.

The owner can't remove their own role, so the site always has an owner. When migration …019 ran, the one existing admin became the owner. To set or move ownership by hand (for example if the owner's account is lost), run this in the Supabase SQL editor; the new owner must already be an admin:

```sql
delete from public.user_roles where role = 'owner';
insert into public.user_roles (user_id, role)
select id, 'owner' from public.profiles where lower(username) = '<username>';
```

## Admins' own standing

Admins pass every karma gate: they can post text and links, rate and write notes, and count as Stewards, from day one. Their posts get the same protection from report collapses as the top tier, and their profiles say "Admin". Their karma number is untouched: it still comes only from the community, because karma is public and members read it as earned. Admins can't edit anyone's karma, their own included ([ADR-0006](adr/0006-admin-limits.md)).

## Member reports

Every profile has a **Report member** button for problems with the person rather than one post: harassment, selling or sourcing, spam, impersonation, a banned member back on a new account, sharing personal information, someone under 18. These reports go to admins only. They never collapse anything, the reported member never sees them or who sent them, and each member can report 5 people a day (`rate_limit.report_member`). Reports about a single post or comment still go to zone moderators through the post's own Report button.

On **Member reports**, each card is one member, with their karma, integrity, active strikes, any current sanction, how many earlier tickets ended with action, and every open report (reason, details, reporter and the reporter's integrity).

| Button | What happens |
|---|---|
| **Open their page to act** | Their page in **People**, where you warn, freeze, suspend or ban them, rename them or add a staff note. |
| **Action taken** (reason required) | Closes every open report about them as handled. It doesn't sanction anyone: do that from their page first. |
| **Dismiss** (reason required) | Closes every open report about them with no action. Nobody is told. |

Both are logged, and "Closed in the last 30 days" shows who decided what. If reports are about you, another admin has to decide them. Once closed, members can report the same person again.

## Inbox

Members write to the team from **Contact the team** (`/contact`, linked in the footer and from the inbox icon in the header). They pick what it's about: a suggestion, reporting a member (they give the username), reporting a post or comment (with an optional link), something broken, help with their account, or something else. Each ticket is a private conversation between that member and the admins; other members never see it.

| Status | Means |
|---|---|
| **Waiting for us** | New, or the member wrote last. The sidebar badge and Home count these. Oldest first. |
| **Waiting for the member** | An admin replied. If the member answers, it comes back to *Waiting for us*. |
| **Closed** | Read-only for the member, who can open a new ticket. You can still reply (which reopens it) or **Reopen** it. |

- **Replying.** Your reply shows to the member as "Pepforums team"; only admins see which admin wrote it. Tick *Close the ticket after sending* for a final answer (e.g. thanking someone for a suggestion). Replies are plain text, can't be edited, and count towards `rate_limit.admin_action`.
- **Telling the member.** Until they open the ticket, the member sees a green notice at the top of every page and a dot on the header's inbox icon. There's no email notification.
- **Reports.** A ticket about a member links to their page in **People**, where you act (warn, freeze, suspend, ban). Replying or closing a ticket never sanctions anyone. Post-and-comment reports from a post's own Report button still go to the moderation queue; tickets are for when someone needs to explain more.
- **Your own tickets.** If an admin writes in, another admin has to answer or close it.
- **Limits.** Members need the basic *report* permission (signed up, email confirmed, not suspended or banned). Each can open 5 tickets a day (`rate_limit.open_ticket`) and reply 30 times an hour (`rate_limit.ticket_reply`).
- **Privacy.** Tickets are in the member's data export (without which admin replied). Deleting the account deletes their tickets.

## Clinicians

A licensed health professional can carry a **verified <profession>** badge on their profile, posts and comments. It is identity, not authority: the badge grants no karma, no note weight, no moderation power, and the member is held to the same rules as everyone (ADR-0006 applies to admins; this applies to clinicians).

- The member submits their profession, province, regulator (CPSO, OCP, OIIQ…), registration number and a credential document (PDF or photo). The number and document are visible only to admins in an MFA session, never published, and deleted with the account.
- **Check the regulator's own public register**, not a link the member sent. Confirm the name on the document, the registration status, and that the profession matches. Approve with what you checked as the reason; reject with why. Both are logged (`clinician_approved` / `clinician_rejected`) and notify the member.
- Approval lasts `clinician.valid_days` (730 by default). The **Expiring** tab lists approvals within 60 days of lapsing; members can renew in that window. Revoke at any time (licence suspended, misrepresentation): the badge goes immediately.
- You can't review your own request.

## Ads

Pepforums sells one reviewed sponsored card per feed. The money and policy rules are in [ADR-0007](adr/0007-advertising.md); the short version:

- **No vendors, no sales.** An advertiser whose website, or a campaign whose landing page or copy, matches a blocked sourcing-shield domain or phrase is refused by the database before you see it. Everything else you check by hand: open the landing page, read both languages, look for prices, before/after imagery, health claims.
- **Accounts first.** An organisation starts *pending*; approve it after checking the business and website. Suspending it stops every campaign.
- **Credit is prepaid and recorded by you.** The team invoices the advertiser; when the money arrives, *Record payment* with the invoice or transaction id (a reference can be recorded once, so a double click can't double-credit). *Refund / adjust* takes a signed amount: negative refunds available (never reserved) credit.
- **Submitting a campaign reserves its whole budget**; approving starts it today for `ads.flight_days`; rejecting releases the reservation. Each finished day the worker charges counted impressions × CPM ÷ 1000, never more than the budget; what's left returns when the flight ends. A member counts once per campaign per hour.
- **Reports.** Any member can report an ad. *Resolve* closes the report; *Stop campaign* closes every report on it, stops serving and releases the unspent reservation. Days already charged stay charged; refund from the advertiser card if warranted.
- **The switch.** `ads.enabled` (Rules & settings → Images, clinicians, notifications & ads) hides every slot without touching campaigns; days off still count towards a flight. Pricing (`ads.cpm.*`, `ads.min_booking_microcad`) applies to campaigns submitted after the change.

## Verified social accounts

Members can verify an X, YouTube, Instagram, TikTok or Reddit account from Settings; badges show on their profile, and a verified audience earns a one-time karma bonus capped at Member (see docs/SELF_MODERATION.md). On a member's public profile, admins see **Remove** next to each badge: use it for vendor or sourcing accounts and for accounts that aren't theirs. It takes the bonus back and is logged as *Verified account removed*. Setup: docs/DEPLOYMENT.md, "Verified social accounts".

## Prices

`/admin/prices` (migrations …031–…032; full guide in [PRICES.md](PRICES.md)). Prices themselves are never edited here: they come only from the pipeline.

- **Vendors.** Add a store (it starts Pending), then set it Active after a clean dry run. Paused keeps its data without reading or showing it; Delisted hides it at once, which is what to do when a vendor asks to be removed. Tick "refuses our reader" for a store that answers 401/403 so it stops holding runs.
- **Certificates of analysis.** Links the pipeline found wait under "To check". Open the document, record exactly what it states, then publish. The site always presents it as the vendor's own document.
- **Clicks.** Clicks to each store over 7 and 30 days. Links are plain: Pepforums earns nothing from them (ADR-0009).
- **Recent runs.** A held run published nothing; the site is still showing the last checked prices.

Every change needs MFA and a reason and is written to the moderation log (`price_vendor_*`, `price_coa_*`, `price_link_*`).

## Where the code lives

| Concern | Location |
|---|---|
| Admin RPCs, guardrails, metrics, transparency | `supabase/migrations/…015_admin_console.sql` |
| Shield, held status, all-zones queue | `supabase/migrations/…016_sourcing_shield.sql` |
| Link review, approved sites | `supabase/migrations/…018_link_review.sql` |
| Member reports, site owner, admins' gates | `supabase/migrations/…019_member_reports_and_owner.sql` |
| Contact the team (tickets, inbox) | `supabase/migrations/…020_support_tickets.sql`, `apps/web/src/app/contact/**`, `apps/web/src/app/admin/inbox/**` |
| Tests | `packages/database/tests/{admin,shield,links,member-reports,owner-and-admins,support-tickets}.test.ts`, `apps/web/tests/admin.test.ts` |
| Pages | `apps/web/src/app/admin/**` |
| Reads / writes | `apps/web/src/server/admin.ts`, `apps/web/src/server/actions/admin.ts` |
| Settings registry (groups, inputs, units) | `packages/database/src/config-fields.ts` |
