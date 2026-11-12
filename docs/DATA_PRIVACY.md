# Data privacy (PIPEDA · Québec Loi 25)

## Data inventory

| Data | Where | Why | Retention |
|---|---|---|---|
| Email, password hash, sessions, MFA factors | Supabase Auth (ca-central-1) | Sign-in | Until account deletion (the worker removes the auth user) |
| Social sign-in identity: provider user id, email, and usually the name and photo the provider sends | Supabase Auth (`auth.identities`, user metadata) | Sign-in only. Never copied to `profiles` or shown: members pick a username at onboarding | Until account deletion, with the auth user |
| Username, bio, conflicts of interest, home zone, locale | `profiles` | Public profile | Tombstoned on deletion (username replaced, fields cleared) |
| Posts, revisions, comments | `posts`, `post_revisions`, `comments` | Core service | Kept (attributed to the anonymised account) unless the member chooses "erase my content" |
| Votes, ratings, reports | `post_votes`, `note_ratings`, `reports` | Scoring and moderation | Kept as anonymous records |
| Member reports | `member_reports`: reporter, reported member, reason, the reporter's details | Admins investigating a member | Kept as moderation records. Only admins read them; the reported member never learns who reported them |
| Tickets to the team | `support_tickets`, `support_messages`: kind, subject, the conversation, who it's about (a member or a link) | Answering suggestions, reports and help requests | Until the member deletes their account, when they are deleted outright. Only the member and admins read them; the member doesn't see which admin replied |
| Karma ledger, strikes, sanctions, moderator log | `ledger_events`, `strikes`, `sanctions`, `mod_actions` | Accountability, appeals | Kept; ledger rows point at the anonymised id |
| Rate-limit events | `private.rate_limit_events` | Abuse prevention | 2 days |
| Staff notes on members | `staff_notes` | Moderation context (staff only, append-only) | Kept with the moderation record |
| Clicks from price pages to stores: a count per vendor per day, with no member, address or token | `prices.click_daily_stats` | Measuring the section; affiliate reporting | Kept |
| Sourcing-shield holds (member + rule matched, never the text) | `shield_hits` | Abuse prevention | Kept; reviewed in the admin console |
| Staff access to an email (lookup or reveal) | `mod_actions` (`lookup_email`, `reveal_email`) | Accountability for staff access to personal information | Kept with the moderation record |
| Notifications and preferences | `notifications`, `notification_settings`: what happened (never who wrote a note or which moderator acted), read state, category switches | Telling members about replies, note outcomes, moderation and the team | `notifications.retention_days` (90 by default), and deleted with the account |
| Push subscriptions | `push_subscriptions`: the browser's push endpoint and keys, a user-agent string | Web push, opt-in per browser | Until the member turns it off, the endpoint dies, or the account is deleted. Payloads carry a title and a link, never content |
| Images on posts | `media` row (type, size, dimensions, alt text) + the file in the private Storage bucket `media` | Illustrating posts (Trusted members and above) | Removed by the member or an admin, or with the account; the worker deletes the file. The composer forbids before/after body photos and identifying images |
| Profile picture | `media` row (kind `avatar`) + the file in the `media` bucket; `profiles.avatar_media_id` | Shown on the member's profile and menu | Re-encoded to a 256×256 WebP on upload, which removes EXIF data such as a phone photo's location. Public while current; replaced or removed pictures are deleted by the worker, and the picture goes with the account |
| Follows | `follows`: who follows whom, and since when | Followers and following lists, "friends" when mutual, new-follower notifications | Public lists, like most networks. In the data export. Deleted in both directions with the account |
| Verified social accounts | `social_accounts`: network, account ID, handle, audience, a few public counts, profile link, when verified | Badges on the profile and the capped karma bonus | Read once from the network's API when the member signs in to it; the network token is never stored. Public on the profile. Removed by the member or an admin, and deleted with the account |
| Clinician verification | `clinician_verifications`: profession, regulator, province, **registration number**, a credential document (`media`, kind `credential`), an optional statement, the decision | Verified-clinician badge | Registration number and document are visible only to admins in an MFA session and are **deleted with the account**. Only the profession is public |
| Advertiser account | `advertisers`: organisation name, website, billing email and address, province; `ad_campaigns`; `ad_ledger` | Selling and billing reviewed sponsored cards | Financial records are kept (tax law); the account is suspended, not deleted, when its owner deletes their member account |
| Ad delivery counts | `ad_daily_stats` (per campaign, per day), `ad_deliveries` (campaign + an opaque salted hash of network address, user agent and date, per hour) | Billing advertisers once per visitor per hour | Deliveries 2 days; daily totals kept with the campaign. The hash can't be reversed and is never joined to a member |
| Server logs | Render | Operations | Per Render plan. Logs hold error codes and opaque ids, never content |

**Not collected:** health information, real names, date of birth, location beyond province or zone, advertising or analytics profiles. The composer warns members not to include identifying details. Ads carry no third-party trackers: impressions and clicks are counted on this site only, against an opaque daily hash, and never tied to a member.

## Residency and transfers

- The database and Auth are hosted in **Canada** (Supabase `ca-central-1`, Montréal).
- The web and worker servers run on **Render, Ohio (US)**, because Render has no Canadian region. Personal information transits these servers and is processed in memory there, but is not stored.
- Loi 25 s. 17 requires a privacy impact assessment (PIA) before communicating personal information outside Québec. Complete it before launch, and say so in the privacy policy (`/legal/privacy`, `/legal/loi-25`).
- To move compute to Canada later, a Canadian host (e.g. a container platform in `ca-central-1`) can replace Render. The app is a standard Node server.

## Rights and how they are fulfilled

| Right | Implementation |
|---|---|
| Access and portability | Settings → Download my data → `export_my_data()` returns JSON with the account, profile, content, votes, ratings, reports (including member reports you filed), your tickets to the team, notifications and preferences, push browsers, uploads, clinician verification requests, advertiser account and ledger, ad reports you filed, ledger, strikes, sanctions and moderator actions taken on you. Rate-limited to 3 per day. |
| Correction | Profile fields are editable; anything else via privacy@pepforum.ca |
| Deletion | Settings → Delete account. The member re-enters their password or, for social-only accounts, must have signed in within the last 10 minutes. `request_account_deletion()` tombstones the profile immediately and the worker deletes the auth user within about 10 minutes. Optionally erases authored content. |
| Information about automated decisions (Loi 25 s. 12.1) | Note status, karma and tiers are automated. The rules are published (`/legal/community-notes`), every change is listed in the member's ledger, and human review is available via appeals or the privacy officer. |
| Withdrawal of consent | No optional processing exists in v1. Add toggles here if analytics are ever introduced. |

## Why anonymise instead of hard-delete?

Deleting a member's ledger rows would silently change *other* members' standing. For example, karma they earned from the deleted member's ratings would disappear. The profile row therefore survives as an opaque id with every identifying field cleared. The auth record, which holds the email and credentials, is deleted. A trigger tombstones profiles even when an auth user is deleted from the Supabase dashboard.

## Pre-launch checklist

- [ ] Appoint the person in charge of personal information; publish the contact (Loi 25 s. 3.1)
- [ ] Complete the PIA for US processing (Render)
- [ ] Have counsel review `/legal/*`; it ships as plain-language summaries
- [ ] Set up an incident register and a CAI notification procedure (Loi 25 s. 3.5–3.8)
- [ ] Enable Supabase PITR backups; document the retention period
- [ ] Sign a DPA with Supabase and Render
- [ ] Limit the admin role to people who need it; review **Admin → Moderation → Log** for `reveal_email` / `lookup_email` entries monthly
- [ ] For each social provider you enable, list it in the privacy policy and point its consent screen at `/legal/privacy` (the provider learns that the member uses Pepforum)
