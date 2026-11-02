---
name: security-audit
description: Use when reviewing a Pepforum change, PR or the whole codebase for security — authorisation bypasses via direct PostgREST calls, karma/notes manipulation, data exposure, secrets, XSS/CSRF/redirects, privacy (PIPEDA/Loi 25). Gives the project-specific checklist to run alongside the built-in /security-review.
---

# Pepforum security review

Start from the assumption in docs/THREAT_MODEL.md: **an attacker holds a valid member JWT and calls Supabase directly**. Nothing the web app does protects data on its own.

## 1. Automated baseline

```bash
pnpm check                                  # includes the RLS/grant suite and the catalog audit
grep -rn "dangerouslySetInnerHTML\|SUPABASE_SECRET_KEY\|service_role" apps/web/src   # expect nothing
```

Then run the built-in `/security-review` on the branch.

## 2. Database (highest risk)

For each changed migration:

- [ ] Every new table has `enable row level security`. Policies cover exactly the intended rows for `anon` and `authenticated`.
- [ ] No `grant insert|update|delete` to API roles (column-level update on profile descriptive fields is the only exception).
- [ ] Every `security definer` function has `set search_path = ''` and schema-qualified references.
- [ ] Every write RPC calls `private.require_user()`, a capability check and a rate limit, and checks ownership.
- [ ] No function trusts a caller-supplied user id. Identity comes from `auth.uid()` only.
- [ ] Privileges are read from tables, never from `auth.jwt()` custom claims or `raw_user_meta_data`. The only JWT field trusted is `aal`.
- [ ] Karma/XP changes use `private.reconcile` and appear in tests.
- [ ] Service-only functions are granted to `service_role` only.
- [ ] Read projections are NULL-safe for anonymous callers, and hide note-writer ids and pre-lock breakdowns.
- [ ] Nothing new is added to the `supabase_realtime` publication.

Try to break it: write a test that calls the RPC as another member, as anon, with someone else's ids, twice concurrently, and with boundary values.

## 3. Trust-system abuse

Check the change against the abuse table in THREAT_MODEL.md:
- Can it be farmed (rewards for volume rather than accuracy)?
- Can it be brigaded (unweighted, unassigned input)?
- Can it be weaponised against authors?
- Does it pay before an outcome is final?

## 4. Web app

- [ ] Server Actions validate with zod, re-check the session, and return mapped errors, never raw DB messages.
- [ ] Redirects use `safeRedirectPath`; external links use `rel="nofollow ugc noopener noreferrer"`.
- [ ] No new script origins. Any change to `src/lib/csp.ts` is justified and tested.
- [ ] Secrets are read only via `src/lib/env.ts`; nothing secret is exported to client components.
- [ ] Logs contain codes and opaque ids, never content, emails or tokens.

## 5. Privacy

- [ ] New personal data is listed in docs/DATA_PRIVACY.md (purpose, retention), included in `export_my_data()`, and handled by `private.tombstone_profile()`.
- [ ] No health information is collected or inferred.

Report findings ranked by severity, with a concrete exploit scenario for each.
