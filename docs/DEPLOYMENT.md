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
   - Redirect URLs: `https://<your-domain>/auth/confirm`.
6. **Auth → Email templates:** paste `supabase/templates/{confirmation,recovery,email_change}.html`. They link to `/auth/confirm?token_hash=…`, which verifies the token on the server.
7. **Auth → SMTP:** configure a real provider. The built-in sender is rate-limited and meant for testing only.
8. **Auth → MFA:** turn TOTP on.
9. **Auth → CAPTCHA:** choose Cloudflare Turnstile and add the secret. The site key goes to Render as `TURNSTILE_SITE_KEY`.
10. **API keys:** you'll need the **publishable** key (web) and the **secret** key (worker only).
11. **Bootstrap staff:**
    - Make yourself admin:
      ```sql
      insert into public.user_roles (user_id, role)
      select id, 'admin' from public.profiles where username = '<you>';
      ```
      Then, from an MFA session, use `set_zone_moderator` and `grant_founding_rater`.
    - `security.require_mfa_for_staff` must stay `true` in production.

## 2. Render (web and worker)

1. **New Blueprint**, pointing at this repo. `render.yaml` creates:
   - `pepforum-web`: a web service in Ohio, with health check `/api/health`;
   - `pepforum-worker`: a cron job running every 10 minutes.
2. **Fill in the `sync: false` variables:**
   - **web:** `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SITE_URL`, `TURNSTILE_SITE_KEY` (optional);
     - `SITE_URL` is the full public origin, with the scheme: `https://pepforum.ca`, not `pepforum.ca`. Leave it blank to use Render's `https://<service>.onrender.com` URL (`RENDER_EXTERNAL_URL`), and set it once you add a custom domain. It must match the Site URL in Supabase Auth (step 1).
   - **worker:** `SUPABASE_URL`, `SUPABASE_SECRET_KEY`.
   - **Never** put the secret key on the web service; the app refuses to start in production if it finds it.
3. **Custom domain and TLS** are set in the Render dashboard. HSTS preload is on, so serve every subdomain over HTTPS.
4. **Deploy gate:** `autoDeployTrigger: checksPass` deploys only after GitHub CI passes.

## 3. Smoke test after deploying

1. Sign up, then confirm the email: you land signed in.
2. A newcomer is blocked from posting, and the page says "Requires Member".
3. With a seeded Member account, post. Vote from a second account older than 7 days; the author's ledger shows `post_votes +1`.
4. As a founding rater, propose a note. Rate it from five graduated or founding accounts. Within 10 minutes the worker marks it Helpful, and the cron log shows `scoring run complete`.
5. Report a post from three accounts older than 14 days: it collapses. A moderator in an MFA session resolves it.
6. Download the data export; delete a test account. Within 10 minutes the auth user is gone.
7. Response headers: `curl -sI https://<domain>/api/health` should show CSP with a nonce, HSTS, `X-Frame-Options: DENY`.

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
