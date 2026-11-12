# Deployment

## 1. Supabase (database and Auth)

1. **Create the project** in region **Canada (Central)** — `ca-central-1`. The Pro plan is recommended, for PITR backups and leaked-password protection.
2. **Apply the migrations** with the Supabase CLI, which `pnpm install` provides (pinned in `package.json`). `<ref>` is the project ID in your dashboard URL, `supabase.com/dashboard/project/<ref>`; `link` asks for the database password.
   ```bash
   pnpm supabase login
   pnpm supabase link --project-ref <ref>
   pnpm supabase db push         # applies supabase/migrations; never runs seed.sql
   ```
   Then run the self-audit in the SQL editor. It must return no rows:
   ```sql
   select * from private.security_audit();
   ```
3. **API → Settings:**
   - Set **Exposed schemas** to `public` only. Never add `private`.
   - Disable GraphQL if it is enabled.
4. **Auth → Providers → Email:**
   - Turn on **Confirm email** and **Secure password change**.
   - Set the minimum password length to **12**.
   - Turn on **leaked password protection** (Pro).
5. **Auth → URL configuration:**
   - Site URL: `https://<your-domain>`.
   - Redirect URLs: `https://<your-domain>/auth/confirm**`. The wildcard matters: sign-in links and social sign-in return to `/auth/confirm?next=…`, and Supabase sends anything that doesn't match to the Site URL, where the sign-in is lost.
6. **Auth → Email templates:** paste `supabase/templates/{confirmation,recovery,email_change,magic_link}.html`. They link to `/auth/confirm?token_hash=…`, which verifies the token on the server.
7. **Auth → Sign In / Providers (social sign-in):** switch on any provider. The sign-in and sign-up pages show a "Continue with …" button for every enabled provider within five minutes; no deploy is needed. For each provider:
   - Create an OAuth app in the provider's developer console and register this **callback URL**: `https://<ref>.supabase.co/auth/v1/callback` (it's shown on the provider's page in Supabase).
   - Paste its client ID and secret into Supabase.
   - Request only the basic scopes (email, profile/openid). Pepforum never reads anything else.

   | Provider | Where to create the app | Notes |
   |---|---|---|
   | Google | Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application) | Configure the OAuth consent screen first: app name, support email, privacy policy URL `https://<your-domain>/legal/privacy`. Publish it, or only test users can sign in. |
   | Apple | Apple Developer → Certificates, IDs & Profiles → Services ID + Sign in with Apple key | Needs a paid Apple Developer account. The secret is a JWT that expires every 6 months: put a renewal reminder in the runbook. |
   | Microsoft (Azure) | Microsoft Entra admin center → App registrations | Supported account types: personal and work accounts. |
   | Facebook | Meta for Developers → Create app → Facebook Login | Switch the app to Live mode. |
   | X | X Developer Portal → Project → User authentication settings (OAuth 2.0, type *Web App*) | Use the **X / Twitter (OAuth 2.0)** provider in Supabase. Turn on **Request email from users** (it needs your terms and privacy URLs): members without a confirmed email can read but not take part. |
   | Discord, GitHub, LinkedIn, Twitch, Spotify, Slack, GitLab, Bitbucket, Notion, Figma, Zoom, Kakao | That platform's developer settings | Same pattern: callback URL in, client ID and secret out. |

   The first time someone signs in with a provider, they choose a pseudonymous username and confirm they're an adult (`/auth/welcome`). Until then they can read but not post, vote, comment or report. If their provider email matches an existing account, Supabase links the two (only for emails the provider has verified).
   **Google showing your brand.** By default Google's screen says "to continue to <ref>.supabase.co", because Google sends people back to Supabase. To show your site instead, let the web app handle Google itself (`apps/web/src/lib/google-oauth.ts`):
   1. In Google Cloud → Google Auth Platform → **Clients** → your Web client: add the redirect URI `https://<your-domain>/auth/oauth/google/callback` (keep the Supabase one).
   2. On the web service in Render, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to that client's ID and secret. From the next deploy, Google's screen names your domain. Remove both to fall back to Supabase's flow.
   3. For your **name and logo** on that screen: Google Auth Platform → **Branding**: app name, a 120×120 logo, home page, privacy policy and terms URLs, and your domain under *Authorized domains*. Prove you own the domain in [Google Search Console](https://search.google.com/search-console) (a DNS TXT record), then **Submit for verification**. Google reviews it in a few business days; until then it shows the domain.
8. **Auth → SMTP:** configure a real provider. The built-in sender is rate-limited and meant for testing only.
9. **Auth → MFA:** turn TOTP on.
10. **Auth → CAPTCHA:** choose Cloudflare Turnstile and add the secret. The site key goes to Render as `TURNSTILE_SITE_KEY`.
11. **API keys:** you'll need the **publishable** key (web) and the **secret** key (worker only).
11b. **Storage (images, …023):** migration `…023_media.sql` creates the private bucket `media` and its policies when it runs on Supabase (`storage.buckets`). Check Storage → `media` exists and is **not** public. Files are served through `/media/<id>` only.
11c. **Web push (…022), optional:** generate a VAPID key pair once — `pnpm --filter @pepforum/worker exec web-push generate-vapid-keys` — and keep both halves. The public key goes to the **web** service, the private key to the **worker**. Without them, notifications are in-app only.
12. **Bootstrap staff:**
    - Make yourself admin and site owner (the owner is the only one who can add or remove admins):
      ```sql
      insert into public.user_roles (user_id, role)
      select id, r from public.profiles, unnest(array['admin', 'owner']) r
      where lower(username) = '<you>'
      on conflict do nothing;
      ```
      Then turn on two-factor sign-in in Settings, sign in again, and run everything else from `/admin` (Team & access adds admins and moderators). See docs/ADMIN.md, "The site owner".
    - `security.require_mfa_for_staff` must stay `true` in production.

### Verified social accounts (optional)

Members verify an X, YouTube, Instagram, TikTok or Reddit account from **Settings → Verified accounts** (migration …028, `apps/web/src/lib/socials.ts`). Verification is off until you set it up, and each network appears only once its app is configured.

1. **The shared key.** Generate a random key (for example `openssl rand -hex 32`). Put it in the Supabase SQL editor:
   ```sql
   insert into private.app_secrets (name, value) values ('social_attestation', '<the key>')
   on conflict (name) do update set value = excluded.value;
   ```
   Then set the same value as `SOCIAL_ATTESTATION_KEY` on the web service in Render. The web server signs every verification with it, and the database rejects anything it didn't sign.
2. **One developer app per network.** In each, register the callback `https://<your-domain>/social/<network>/callback`, then put the app's ID and secret on the web service:

   | Network | Where | Permissions | Render variables | Notes |
   |---|---|---|---|---|
   | X | developer.x.com → Project → App → User authentication settings (OAuth 2.0, *Web App*) | `users.read`, `tweet.read` | `X_CLIENT_ID`, `X_CLIENT_SECRET` | Can be the same app as Sign in with X (add both callbacks). X's free API tier allows only a small number of reads a day. |
   | YouTube | Google Cloud (same client as Google sign-in) → enable **YouTube Data API v3**; add the scope on the consent screen | `youtube.readonly` | uses `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | A sensitive scope: until Google verifies it, members see an "unverified app" warning. |
   | Instagram | developers.facebook.com → app → *Instagram API with Instagram Login* | `instagram_business_basic` | `INSTAGRAM_CLIENT_ID`, `INSTAGRAM_CLIENT_SECRET` | Works for Business and Creator accounts only. Needs Meta app review before the public can use it. |
   | TikTok | developers.tiktok.com → app → Login Kit | `user.info.basic`, `user.info.profile`, `user.info.stats` | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | Needs TikTok app review. |
   | Reddit | reddit.com/prefs/apps → *web app* | `identity` | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | Audience = the profile's followers. |
3. **The bonus** is tuned in Rules & settings (`socials.bonus_*`, docs/SELF_MODERATION.md).

### Price tracking (optional)

Migrations …030–…033 create the `prices` schema and a login for the pipeline, `pepforum_prices`, with no password. To run the pipeline, set one out of band (`alter role pepforum_prices password '…';`), store that login's session-pooler connection string as the GitHub secret `PRICES_DB_URL`, and follow "Going live" in [PRICES.md](PRICES.md). Nothing is shown to visitors until an admin switches on "Show the Prices section". The pipeline runs on GitHub Actions, not Render, and needs no other secret.

## 2. Render (web and worker)

1. **New Blueprint**, pointing at this repo. `render.yaml` creates:
   - `pepforum-web`: a web service in Ohio, with health check `/api/health`;
   - `pepforum-worker`: a cron job running every 10 minutes.
2. **Fill in the `sync: false` variables:**
   - **web:** `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SITE_URL`, `TURNSTILE_SITE_KEY` (optional), `VAPID_PUBLIC_KEY` (optional, push), `AD_VISITOR_SALT` (optional; any random string, salts the ad frequency-cap hash);
     - `SITE_URL` is the full public origin, with the scheme: `https://pepforum.ca`, not `pepforum.ca`. Leave it blank to use Render's `https://<service>.onrender.com` URL (`RENDER_EXTERNAL_URL`), and set it once you add a custom domain. It must match the Site URL in Supabase Auth (step 1).
   - **worker:** `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SITE_URL` (for links in push payloads), `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` (optional, push), `VAPID_SUBJECT` (`mailto:` address the push services can contact).
   - **Never** put the secret key on the web service; the app refuses to start in production if it finds it.
3. **Custom domain and TLS** are set in the Render dashboard. HSTS preload is on, so serve every subdomain over HTTPS.
4. **Deploy gate:** `autoDeployTrigger: checksPass` deploys only after GitHub CI passes.

## 3. Smoke test after deploying

1. Sign up, then confirm the email: you land signed in.
2. The new account can start a text post right away. The Resource (link) option is greyed out and says "Requires Member". A post with a link in its text is held, and appears on `/admin/links`.
3. Vote from a second account older than 7 days; the author's ledger shows `post_votes +1`.
4. As a founding rater, propose a note. Rate it from five graduated or founding accounts. Within 10 minutes the worker marks it Helpful, and the cron log shows `scoring run complete`.
5. Report a post from three accounts older than 14 days: it collapses. A moderator in an MFA session resolves it.
6. Download the data export; delete a test account. Within 10 minutes the auth user is gone.
7. Response headers: `curl -sI https://<domain>/api/health` should show CSP with a nonce, HSTS, `X-Frame-Options: DENY`.
8. `curl -s https://<domain>/sitemap.xml` lists the sitemaps. Submit the index to Google Search Console (robots.txt is static and doesn't name the domain).
9. As a Trusted account, attach an image to a post: it renders from `/media/<id>`; removing it from `/admin/media` makes that URL 404 and the next worker run logs `media purged`.
10. In Settings → Notifications, enable push on a browser (needs the VAPID keys); reply to that account's post from another; a notification arrives within 10 minutes.
11. Create an advertiser account, approve it from `/admin/ads`, record a payment, submit and approve a campaign, switch `ads.enabled` on: the card appears in the matching feed, `/ads/go/<id>` redirects, and the next day's worker run logs `ads settled`.

## Local development

```bash
pnpm install
pnpm supabase start                    # needs Docker; applies migrations + seed.sql
cp .env.example apps/web/.env.local    # fill from `pnpm supabase status`
pnpm dev                               # http://localhost:3000, demo password: pepforum-demo-2026
pnpm worker:dry-run                    # no Supabase needed: PGlite + seed
```

To regenerate types against a linked project and compare them with the hand-maintained file:

```bash
pnpm db:types                          # writes packages/database/src/generated.types.ts
```
