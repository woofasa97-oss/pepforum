# Admin console guide (`/admin`)

The console is where admins look after Pepforum without touching SQL. Everything here is enforced by the database (migrations `…015_admin_console` and `…016_sourcing_shield`): the web pages only display what the admin RPCs return and send changes back to them.

## Getting in

1. You need the **admin** role. The first admin is created with SQL (see [DEPLOYMENT.md](DEPLOYMENT.md), "Bootstrap staff"); after that, admins add each other from **Team & access**.
2. You need **two-factor sign-in** (an authenticator app, set up in Settings → Security). Without an MFA session the database refuses every admin read and write.
3. Open **Admin** in the header, or go to `/admin`.

## The rules the console can't break

- **Every change needs a reason**, and is written to the append-only moderation log with your name.
- **Nobody edits karma or XP.** To undo a penalty, undo its cause: restore the content, uphold the appeal or remove the strike. The ledger records the reversal.
- **Nobody overrides a community note's rating.** An admin may only *hide* a note that breaks the rules itself (personal information, vendor links, abuse). Hiding an open note closes it as "Needs ratings", which rewards and penalises nobody. See [ADR-0006](adr/0006-admin-limits.md).
- **Nobody changes their own role**, and the last admin can't be removed.
- **Emails stay private.** Profiles show a masked address. A real one appears only through an exact-email lookup or the **Reveal** button, and both are logged.
- Admin changes are rate-limited (`rate_limit.admin_action`, 300 an hour), which limits the damage from a stolen session.

## Sections

| Section | Use it to |
|---|---|
| **Home** | See what needs you today, and community health (active members, posts, notes, reports) over 7, 30 or 90 days, with how well moderation is working. Download the numbers as CSV. |
| **Moderation** | Work the report queue across every zone, including posts held by the shield. Decide appeals, including sanction appeals that only admins can decide. Read the log of who did what (with Undo where possible). See each moderator's speed and how often appeals overturn them. |
| **People** | Find a member by username, or by exact email for privacy and support requests. A member's page shows everything in one place: standing, strikes, sanctions, ledger, content, notes, appeals, risk signals and private staff notes. Actions: warn, freeze, suspend, ban, lift, rename, roles, founding rater, clear a writing lock, remove a mistaken strike. |
| **Content** | Search posts, comments and notes, removed ones included. Remove, restore, pin (two per zone), lock comments, hide or unhide notes. |
| **Community notes** | Watch the notes pipeline, scoring runs and agreement, and readiness to switch to bridging scoring (with the switch). See raters, writer pauses, and signs of manipulation: notes rated mostly by new accounts, and rater pairs who almost always agree. |
| **Sourcing shield** | Block vendor sites, and watch phrases ("dm me", "telegram") that either hold a post for review or block it. Test any text against the rules. |
| **Rules & settings** | Change any rule of the karma and notes economy in plain words, with its allowed range, history and Revert. Edit categories, zones and city sub-zones. Publish a site-wide announcement. |
| **Team & access** | Admins, zone moderators, founding raters, who qualifies as a Steward, and which staff lack two-factor sign-in. |
| **System** | Background jobs (scoring, maintenance, deletions), the security self-audit, the privacy deletion queue, sign-in providers, and the busiest accounts. |

The public **[/transparency](../apps/web/src/app/transparency/page.tsx)** page publishes monthly totals (removals by reason, sanctions, appeals, notes, shield holds). It contains no member data.

## A daily routine (10 minutes)

1. **Home:** clear the "Needs you" list from top to bottom. Red first.
2. **Moderation → Queue:** keep or remove each item. Held posts never reopen on their own, so they wait for you.
3. **Moderation → Appeals:** decide the ones you didn't act on yourself.
4. **System:** jobs should all say *Running*, and the self-audit *0 problems*.
5. Weekly: skim **Community notes → Signs of manipulation**, and **Moderation → Moderator performance**.

## Sourcing shield: how rules behave

| Rule | Posts and comments | Notes |
|---|---|---|
| Blocked site | Refused, wherever the site appears (link, bare `site.com`, subdomains) | Refused, including as a source |
| Phrase set to **hold** | Saved as *held*: only the author and moderators see it until a moderator keeps or removes it | Refused (notes can't be held) |
| Phrase set to **block** | Refused | Refused |

Phrases match whole words in any capitalisation. Moderators' own posts are exempt, so a warning that names a scam channel still goes through. Only holds are counted, because a block cancels the whole write and leaves no record. The hit log stores the member and the rule, never the text.

## Where the code lives

| Concern | Location |
|---|---|
| Admin RPCs, guardrails, metrics, transparency | `supabase/migrations/…015_admin_console.sql` |
| Shield, held status, all-zones queue | `supabase/migrations/…016_sourcing_shield.sql` |
| Tests | `packages/database/tests/{admin,shield}.test.ts`, `apps/web/tests/admin.test.ts` |
| Pages | `apps/web/src/app/admin/**` |
| Reads / writes | `apps/web/src/server/admin.ts`, `apps/web/src/server/actions/admin.ts` |
| Settings registry (groups, inputs, units) | `packages/database/src/config-fields.ts` |
