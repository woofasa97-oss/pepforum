## What & why

<!-- One or two sentences. Link the issue. -->

## Checklist

- [ ] `pnpm check` passes (lint, typecheck, tests)
- [ ] New/changed tables: RLS enabled, explicit grants, covered by `private.security_audit()` (see `.claude/skills/new-migration`)
- [ ] New RPCs: `security definer` + `set search_path = ''`, `private.require_user()`, capability check, rate limit, granted only to the roles that need it
- [ ] Karma/XP changes go through `private.reconcile()`, never direct updates; `app_config` defaults + docs/SELF_MODERATION.md updated
- [ ] No secrets, PII or health data in code, logs or fixtures
- [ ] User-facing strings added to **both** `en.ts` and `fr.ts`
- [ ] Migrations are new files (never edit an applied migration)
