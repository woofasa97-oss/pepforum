# Data privacy (PIPEDA · Québec Loi 25)

## Data inventory

| Data | Where | Why | Retention |
|---|---|---|---|
| Email, password hash, sessions, MFA factors | Supabase Auth (ca-central-1) | Sign-in | Until account deletion (the worker removes the auth user) |
| Social sign-in identity: provider user id, email, and usually the name and photo the provider sends | Supabase Auth (`auth.identities`, user metadata) | Sign-in only. Never copied to `profiles` or shown: members pick a username at onboarding | Until account deletion, with the auth user |
| Username, bio, conflicts of interest, home zone, locale | `profiles` | Public profile | Tombstoned on deletion (username replaced, fields cleared) |
| Posts, revisions, comments | `posts`, `post_revisions`, `comments` | Core service | Kept (attributed to the anonymised account) unless the member chooses "erase my content" |
| Votes, ratings, reports | `post_votes`, `note_ratings`, `reports` | Scoring and moderation | Kept as anonymous records |
| Karma ledger, strikes, sanctions, moderator log | `ledger_events`, `strikes`, `sanctions`, `mod_actions` | Accountability, appeals | Kept; ledger rows point at the anonymised id |
| Rate-limit events | `private.rate_limit_events` | Abuse prevention | 2 days |
| Server logs | Render | Operations | Per Render plan. Logs hold error codes and opaque ids, never content |

**Not collected:** health information, real names, date of birth, location beyond province or zone, advertising or analytics profiles. The composer warns members not to include identifying details.

## Residency and transfers

- The database and Auth are hosted in **Canada** (Supabase `ca-central-1`, Montréal).
- The web and worker servers run on **Render, Ohio (US)**, because Render has no Canadian region. Personal information transits these servers and is processed in memory there, but is not stored.
- Loi 25 s. 17 requires a privacy impact assessment (PIA) before communicating personal information outside Québec. Complete it before launch, and say so in the privacy policy (`/legal/privacy`, `/legal/loi-25`).
- To move compute to Canada later, a Canadian host (e.g. a container platform in `ca-central-1`) can replace Render. The app is a standard Node server.

## Rights and how they are fulfilled

| Right | Implementation |
|---|---|
| Access and portability | Settings → Download my data → `export_my_data()` returns JSON with the account, profile, content, votes, ratings, reports, ledger, strikes, sanctions and moderator actions taken on you. Rate-limited to 3 per day. |
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
- [ ] For each social provider you enable, list it in the privacy policy and point its consent screen at `/legal/privacy` (the provider learns that the member uses Pepforum)
