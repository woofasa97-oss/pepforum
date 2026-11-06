# Pepforum — guidance for AI coding agents

A Canadian, bilingual (EN/FR) peptide-discussion forum whose core product is **self-moderation**: karma, community notes, a progression system. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SELF_MODERATION.md](docs/SELF_MODERATION.md) before changing behaviour.

## Commands

```bash
pnpm check                 # lint + typecheck + every test suite — run before declaring work done
pnpm db:test               # schema/RLS/settlement tests only (PGlite, no Docker)
pnpm --filter @pepforum/web build   # needs SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SITE_URL (placeholders OK)
pnpm worker:dry-run        # score the demo seed locally
```

## Non-negotiable invariants

1. **The database is the security boundary.**
   - Assume PostgREST is called directly with any member's JWT.
   - New tables: `enable row level security` and explicit grants only. API roles never get INSERT/UPDATE/DELETE.
   - New writes: a `security definer` RPC with `set search_path = ''`, fully qualified names, and `private.require_user()` → `private.require_capability()` → `private.enforce_rate_limit()`.
   - After any migration change, `select * from private.security_audit()` must return nothing (`packages/database/tests/security.test.ts` asserts it).
2. **Never modify karma/XP/tier/status directly.**
   - Use `private.reconcile(event_key, user, track, reason, source_kind, source_id, desired)`. It is idempotent and auditable.
   - Ledger, mod log, note history and config history are append-only.
3. **Capabilities come from tables**, never from JWT claims or `raw_user_meta_data`, which members can edit.
4. **The secret key belongs to `apps/worker` only.** The web app uses the publishable key, server-side; the browser never calls Supabase.
5. **No raw HTML from users** (`react/no-danger` is an error). Links: https only, `rel="nofollow ugc noopener noreferrer"`. Redirects: `safeRedirectPath`.
6. **Tunable numbers live in `app_config`**, not in code. Document new keys in docs/SELF_MODERATION.md.
7. **Every UI string goes in `apps/web/src/lib/i18n/en.ts` and `fr.ts`.** The French file is typed against the English one, so a missing key fails typecheck.
8. **Never edit an applied migration.** Add a new timestamped file in `supabase/migrations/`.
9. **Read-API functions must be NULL-safe for anonymous callers.** For example, `coalesce(author_id = auth.uid(), false)`.

## Where things live

| Change | Files |
|---|---|
| Schema / RLS / RPC | `supabase/migrations/*.sql` + tests in `packages/database/tests/` + types in `packages/database/src/types.ts` |
| Enum-like vocabulary | `packages/database/src/domain.ts` (contract test compares it with the SQL CHECK constraints) |
| Scoring algorithm | `apps/worker/src/scoring/` (pure, unit-tested) |
| Server reads / writes | `apps/web/src/server/queries.ts` / `apps/web/src/server/actions/*.ts` |
| Validation | `apps/web/src/lib/validation.ts` (mirrors SQL constraints) |
| Error → message mapping | `apps/web/src/lib/errors.ts` (SQLSTATE `PFxxx` codes from `…001_foundation.sql`) |
| Admin console | `admin_*` RPCs in `…015`/`…016`/`…018`, `apps/web/src/app/admin/**`, `server/admin.ts`, `server/actions/admin.ts`; see docs/ADMIN.md. Admins never edit karma or note status (ADR-0006). |
| A new `app_config` key | Migration insert (+ `bounds` if numeric), `packages/database/src/config-fields.ts`, `admin.cfg.*`/`admin.cfgHelp.*` strings; the DB test fails until all three exist |

## Project skills

- `.claude/skills/new-migration`: checklist for any SQL change.
- `.claude/skills/security-audit`: how to review a change against the threat model.
- `.claude/skills/moderation-rules`: changing karma, notes, reports or gates safely.

Use the built-in `/security-review` and `/code-review` before opening a PR.

## Conventions

- TypeScript is strict, ESM, with `.ts` import extensions and `erasableSyntaxOnly` (the worker runs on Node's native type stripping). No enums, namespaces or parameter properties.
- Server Actions return `ActionState`, validate with zod and map DB errors with `messageForDbError`. Log codes only, never content or PII.
- Tests are behavioural: they act as `anon`, `user(id, 'aal1' | 'aal2')` or `service` through `TestDb.as()`.
