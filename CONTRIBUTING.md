# Contributing

## Workflow

1. Branch from `main` (`feat/…`, `fix/…`).
2. Make the change. Database changes follow `.claude/skills/new-migration/SKILL.md`.
3. Run `pnpm check` (lint, typecheck, all tests). CI runs the same steps plus a build, dependency audit and secret scan (plus CodeQL and dependency review when GitHub Code Security is enabled).
4. Open a PR using the template checklist. Changes to `supabase/migrations/`, `apps/worker/src/scoring/` or anything touching auth need a second reviewer.

## Ground rules

- **Never edit an applied migration.** Add a new `supabase/migrations/<UTC timestamp>_<name>.sql`.
- Behaviour changes need tests that act as the real roles (`anon`, members at aal1/aal2, `service`) through `TestDb.as()`.
- Tunable numbers belong in `app_config` and [docs/SELF_MODERATION.md](docs/SELF_MODERATION.md).
- Every UI string needs English **and** French.
- No secrets in code, fixtures or logs. `.env*` files are gitignored, and CI scans for secrets.
- Keep comments for *why*, not *what*.

## Commit messages

Conventional style: `feat(notes): …`, `fix(web): …`, `docs: …`. Explain the reason in the body when it isn't obvious.
