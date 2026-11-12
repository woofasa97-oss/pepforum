# Threat model

**Assets:**
- member accounts and sessions;
- the integrity of karma, tiers and note status (the trust layer itself);
- personal information (email, posting history);
- moderator powers;
- the secret key.

**Adversaries:**
- vendors and sourcing spammers;
- brigades and vote rings;
- sock-puppet farms;
- a malicious insider holding a moderator account;
- an attacker who obtains a member's JWT and calls PostgREST directly;
- generic web attackers (XSS, CSRF, open redirect).

## STRIDE

| Threat | Example | Mitigation | Where |
|---|---|---|---|
| **Spoofing** | Credential stuffing; fake sign-ups | Confirmed email; 12+ character passwords plus leaked-password check (Pro); Turnstile CAPTCHA; Supabase Auth rate limits; generic login and reset messages (no enumeration) | `supabase/config.toml`, `server/actions/auth.ts` |
| | Stolen session used to erase the account | Deleting an account re-checks the password | `deleteAccountAction` |
| | Hijacked moderator account | TOTP MFA required; checked in SQL via `aal = 'aal2'` from the verified JWT | `private.require_aal2()` |
| **Tampering** | Member sets their own karma or tier through the REST API | No write grants; column grant limited to bio/coi/locale/zone; values derived from the ledger | `…003_identity.sql`, `security.test.ts` |
| | Forged scoring results | `apply_note_scores` executable by service_role only; idempotent per run; stale-snapshot check | `…006_notes.sql` |
| | Editing the audit trail | Triggers make `ledger_events`, `mod_actions`, `note_status_history` and `app_config_history` append-only, even for the owner | `private.forbid_mutation` |
| | Privileges smuggled through user metadata | Sign-up trigger reads only username, locale and zone, and validates them; privileges come from tables | `handle_new_auth_user` |
| | Social sign-up skipping the sign-up form (username, age, terms) or importing a provider display name | Social sign-ups get a placeholder username and `needs_onboarding`; every capability is denied (`onboarding`) until `complete_onboarding()` validates a username and the adult acknowledgement. Nothing from the provider's profile is used | `…014_social_sign_in.sql` |
| | OAuth code injection / login CSRF | PKCE: the code only exchanges in the browser holding the verifier cookie set when the flow started; `redirectTo` is our own `/auth/confirm` and `next` goes through `safeRedirectPath` | `auth/oauth/[provider]`, `auth/confirm` |
| | Account takeover by linking a provider identity to an existing account | Supabase links identities automatically only when the provider has verified the email; manual linking is off (`enable_manual_linking = false`) | `supabase/config.toml` |
| | Stolen session used to erase a social-only account (no password to re-check) | Deletion requires a sign-in within the last 10 minutes (JWT `amr` timestamp) plus an explicit confirmation | `deleteAccountAction` |
| **Repudiation** | "I never removed that post" | Every moderator and admin action is in `mod_actions` with actor, reason and metadata; config changes are logged with old and new values | `…007_moderation.sql` |
| **Information disclosure** | Who rated what; who wrote a note | `note_ratings` readable only by the rater; writers shown as pseudonyms; moderation-track counters private (column grants); writers paid moderation XP, not public karma; votes private | RLS, column grants, read API |
| | Removed content shown to the public | Masked in `get_comments` (NULL-safe; regression test) | `…009_read_api.sql` |
| | Secret key leaked through the web app | Key lives only on the worker; the web app refuses to boot in production if it sees it | `lib/env.ts` |
| | Error details reach the client | Errors mapped to localised text; unknown errors become generic; logs carry codes only | `lib/errors.ts` |
| **Denial of service** | Spamming votes, comments, reports or notes | Sliding-window limits in SQL per action (stricter for Newcomers' posts and below integrity 50); Supabase Auth limits | `private.enforce_rate_limit` |
| | Overlapping scoring runs | `pg_try_advisory_xact_lock` | `apply_note_scores` |
| **Elevation of privilege** | Calling internal functions | `private` schema not exposed by PostgREST; EXECUTE revoked from PUBLIC globally; audit check | `…001_foundation.sql`, `…010_security_audit.sql` |
| | `search_path` hijack of definer functions | Every definer function pins `search_path = ''` and uses fully qualified names; audit check | `security_audit()` |
| | Moderator deciding their own appeal or acting on their own content | `conflict_of_interest` checks in SQL | `decide_appeal`, `resolve_reports` |
| | Stolen or rogue admin session | Every admin RPC requires aal2 (MFA); every write needs a reason, is rate-limited (`rate_limit.admin_action`) and logged with the actor; only the site owner can add or remove admins, so a rogue admin can't appoint accomplices or remove the others; no self-role changes; the last admin can't be removed | `…015_admin_console.sql`, `…019` |
| | Admin "fixing" karma or forcing a note's status | No RPC exists for either. Penalties are undone by reversing their cause; notes can only be hidden, which closes them with no payout ([ADR-0006](adr/0006-admin-limits.md)) | `admin_restore_content`, `admin_set_note_hidden` |
| **Information disclosure** | Staff browsing members' emails | Emails are never listed: profiles show a masked address; exact-email lookup and Reveal are logged (`lookup_email`, `reveal_email`) and the looked-up address is not stored | `admin_find_by_email`, `admin_reveal_email` |
| | Formula injection through CSV exports | Cells starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`; no email is exported | `apps/web/src/lib/csv.ts` |

## Web-layer threats

- **XSS:**
  - React escapes all output, and `dangerouslySetInnerHTML` is a lint error.
  - The CSP allows only nonce-carrying scripts (`'strict-dynamic'`); there are no inline event handlers.
  - Styles allow `'unsafe-inline'`, needed for React style attributes. This is accepted because CSS injection without script execution is low impact.
- **CSRF:**
  - Server Actions are POST-only, and Next.js checks the Origin header.
  - Cookies are `SameSite=Lax`.
  - The data export rejects cross-site `Sec-Fetch-Site`.
- **Clickjacking:** `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
- **Open redirect:** every `next=` parameter goes through `safeRedirectPath`, which is unit-tested against `//host`, `/\host`, schemes and control characters.
- **Malicious links:** links must be https; they render with `rel="nofollow ugc noopener noreferrer"` and a "not reviewed" label. Note sources must be specific pages.
- **Caching sessions:** the proxy forwards @supabase/ssr's `no-store` headers whenever auth cookies change, and the export route sets `private, no-store`.

## Abuse of the trust system

These are covered in depth in [SELF_MODERATION.md](SELF_MODERATION.md).

| Abuse | Defence |
|---|---|
| Farming moderation XP by guessing | Base-rate-adjusted rewards (expected value 0); paid only at settlement; no credit after the status is public |
| Brigading a note | Bridging scoring (both sides must agree); probation weighs new raters at 0; queue assignment (self-picked notes weigh 0.5); 72-hour stability before lock |
| Using notes as a weapon | Strikes only for *misleading* notes that settle Helpful, on non-experience posts the author didn't correct; capped karma loss |
| Vote rings and sock puppets | Votes from new or low-integrity accounts don't count; 5 counted votes per voter per author every 30 days; 100 per day per author; optional phone gate for raters |
| Report-based censorship | Collapse (never delete) needs weight from 3 established reporters; Trusted+ authors need a Steward reporter; reverts after 48 hours without review; abusive reports cost XP |
| Rogue moderator | MFA; full audit log (admins see who acted); moderator performance shows overturned decisions; appeals to a different moderator; suspensions and bans are admin-only |
| Vendor spam and sourcing | Sourcing shield: blocked domains are refused everywhere (posts, comments, note sources, bare mentions); watched phrases hold content out of view until reviewed. Held content never reopens on its own. Link review: every `http(s)://` or `www.` link in a post or comment waits for an admin unless its site is approved, and nothing that publishes content (a queue keep, a restore, an appeal) can bypass a pending link. Enforced by triggers, so every write path is covered |
| Price data tampered with, or a vendor buying rank | Price tables sit in a schema no API role can reach; the pipeline's own login cannot delete, publish an unpassed run or touch forum tables; a quality gate holds runs that lost ground or carry improbable prices; ranking is computed from price alone and tested against affiliate status; vendor and certificate changes are admin-only (MFA, reason, moderation log). Residual: a vendor's own feed can state a wrong price or a certificate can be false; both are shown as the vendor's claims. |
| Google sign-in on our domain (`GOOGLE_CLIENT_SECRET` on the web service) | The secret only lets someone act as our Google OAuth *client*; it gives no access to Google accounts. The flow binds each sign-in to the browser that started it (httpOnly state cookie, PKCE), and Supabase accepts the ID token only for our client ID and with the matching nonce. The Supabase secret key still never reaches the web service |
| Inflated or borrowed social accounts | The database accepts a verification only with an HMAC signature from the web server (key in `private.app_secrets`, never readable by API roles), bound to the caller, under 15 minutes old; one network account backs one Pepforum account; the bonus is capped at Member (bought followers can't buy Trusted) and an admin can remove a vendor's badge, which takes the bonus back and is logged |
| Abusive profile pictures, follow spam | Pictures are re-encoded server-side (no EXIF, no smuggled payloads), served from this origin with `nosniff`, and appear on the admin Media page, where one click takes them down. Follows need the basic *vote* permission and are limited to 60 an hour; a member is told about each follower only once, however often they re-follow |
| Spamming or harassing the team through tickets | Tickets need the basic *report* permission (no suspended or banned accounts), 5 a day and 30 replies an hour per member; closed tickets are read-only for the member; replies are plain text (no HTML, links rendered `nofollow ugc noopener noreferrer`, https only). Admins' names are never shown to members |
| Brigading a member with reports | Member reports never act on their own: they're tickets an admin decides. One open report per reporter and member, 5 a day per reporter (`rate_limit.report_member`), and each report shows the reporter's integrity. An admin can't decide reports about themselves |

## Security review log

### 2026-11-02 · Independent adversarial review (before first deploy)

A separate reviewer with no access to the design rationale attacked the working tree under this threat model. It confirmed there is no way to mint karma, write the ledger directly, call private functions or escalate to moderator/admin. It found 12 issues, proved 11 of them with exploit tests, and all 12 are now fixed. Each fix has a test in `packages/database/tests/review-regressions.test.ts` or `apps/web/tests/security.test.ts`.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | Public profile counters (`writer_impact`, `mod_xp`, …) and writer karma payouts let anyone unmask note writers and raters by diffing profiles | Column-level SELECT grants on `profiles`; moderation-track fields private in `get_profile`; writers paid moderation XP only |
| 2 | Medium | Open redirect: `/.//evil.com` normalised to `//evil.com` | `safeRedirectPath` re-checks the normalised path |
| 3 | Medium | Moderator *reads* didn't require MFA | `private.staff_session()` added to every staff read policy and projection |
| 4 | Medium | Rating queue could be re-rolled to pick a brigade target | One outstanding assignment per rater, plus a rate limit on new draws |
| 5 | Medium | A no-op edit counted as a correction and cancelled a strike | Identical edits rejected; a correction must differ from the noted revision |
| 6 | Medium | A moderator could revoke their own freeze, or anyone's | No self-revocation; moderators may revoke only what they issued; otherwise admin |
| 7 | Low | `NULL` sources created a note without sources | Explicit NULL check |
| 8 | Low | Herding credit after a Helpful → Needs More Ratings flip | Any past status change marks later ratings as public |
| 9 | Low | Moderators could pay themselves report XP; XP kept after an upheld appeal | No XP for the resolver's own reports; reversal on upheld appeal |
| 10 | Low | Frozen members could still edit posts | `edit_post` requires `post_text` |
| 11 | Low | Comments under removed posts were readable directly | `comments_read` requires a visible parent post |
| 12 | Low | Sanctioned members could see which moderator acted | Column grants withhold `actor_id`, `issued_by`, `decided_by` |

## Residual risks and follow-ups

- **Ad impression inflation.** `get_ad()` is callable anonymously (it has to be: anonymous visitors see ads), so a script can register deliveries with made-up visitor tokens. Mitigations: one count per token per campaign per hour, a charge never exceeds the budget, settlement is daily and reversible by an admin refund, and the daily volume is visible per campaign. Exposure is bounded by the campaign budget — the same exposure any CPM network has to bot traffic. A per-IP limit at the edge (Render/Cloudflare) is the next step if it is abused.
- **Uploaded images** are stored as sent (no re-encoding) and served with `Content-Type` from the registered row and `nosniff`; the browser never evaluates them. A later step is server-side re-encoding to strip metadata (EXIF location) before the file is stored.
- **Push payloads** are encrypted to the browser's keys by `web-push`; they carry a title and a link, never content, so a leaked endpoint reveals nothing.

- **Bootstrap mode** can be carried by a coordinated majority. Mitigated by founding raters and probation; removed by switching to bridging.
- **Reciprocal vote rings** across many accounts aren't detected yet (roadmap).
- **Cross-border transit:** Render has no Canadian region (see [DATA_PRIVACY.md](DATA_PRIVACY.md)).
- **Hand-maintained types** can drift from the schema; the contract test covers the enums, and `pnpm db:types` covers the rest.
- **Supabase plan features:** PITR backups and leaked-password protection need the Pro plan.
