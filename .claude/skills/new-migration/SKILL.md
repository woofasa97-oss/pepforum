---
name: new-migration
description: Use for ANY change to the Pepforum database — new table, column, RPC, policy, grant, trigger or config default in supabase/migrations. Walks through the security checklist (RLS, grants, definer functions, rate limits, ledger rules), the tests to add, and the TypeScript types to update.
---

# Adding or changing a Supabase migration

Pepforum enforces every permission in Postgres (docs/adr/0001). A migration that skips a step below can expose data or let members mint karma. Follow the steps in order.

## 1. Create the file

- Name it `supabase/migrations/<YYYYMMDDHHMMSS>_<snake_name>.sql`, with a UTC timestamp later than the newest file.
- **Never edit a migration that has been applied anywhere.** Fix forward with a new file.
- Start with a header comment: what the change is, why, and which doc section it implements.

## 2. Tables

```sql
create table public.thing (...);
alter table public.thing enable row level security;      -- always; not forced (ADR-0005)
create policy thing_read on public.thing for select to authenticated using (...);
grant select on public.thing to authenticated;             -- reads only
```

- **No INSERT/UPDATE/DELETE grants** to `anon` or `authenticated`. Writes go through an RPC.
- Grant `service_role` only what the worker needs.
- Mirror app validation in CHECK constraints (lengths, enums, `^https://` URLs).
- Internal state belongs in `private.` (not exposed via PostgREST).
- Audit-like tables get `before update or delete … execute function private.forbid_mutation()`.

## 3. Functions (RPCs)

```sql
create function public.do_thing(p_id uuid, ...)
returns ...
language plpgsql
security definer
set search_path = ''                       -- mandatory; use schema-qualified names everywhere
as $$
declare
  v_uid uuid := private.require_user();    -- PF401 if anonymous
begin
  perform private.require_capability(v_uid, 'capability_name');
  perform private.enforce_rate_limit(v_uid, 'action_name');   -- add rate_limit.<action> to app_config
  -- validate inputs explicitly → private.raise_error('PF422', 'specific_key')
  -- ownership checks → PF404 (don't reveal existence) or PF403
  ...
end;
$$;
grant execute on function public.do_thing(uuid, ...) to authenticated;
```

- Karma or XP changes **only** via `private.reconcile(event_key, user, track, reason, source_kind, source_id, desired)`.
- Moderator or admin functions call `private.require_zone_mod()` / `private.require_admin()`. These enforce MFA (aal2). Log the action with `private.log_mod_action()`.
- Read-projection functions: make every `auth.uid()` comparison NULL-safe (`coalesce(x = auth.uid(), false)`).
- A function used inside an RLS policy needs `grant execute … to anon, authenticated`. Keep such helpers read-only.
- New thresholds become `app_config` rows (with a description) plus a section in docs/SELF_MODERATION.md.

## 4. Tests (packages/database/tests)

Act as the real roles with `TestDb.as(anon | user(id, 'aal1'|'aal2') | service, sql)`. At minimum:

- [ ] the happy path as an allowed member;
- [ ] a denied capability returns `PF403` with the expected detail;
- [ ] anon and other members can't read or write what they shouldn't;
- [ ] any rate limit triggers `PF429`;
- [ ] ledger effects are asserted with `ledgerTotal()`;
- [ ] `security.test.ts` still passes (the audit is clean).

## 5. Types and vocabulary

- Update `packages/database/src/types.ts`: the `Functions` entry and any row types.
- New enum-like values go in `packages/database/src/domain.ts`, and the contract test will check them.
- Add any new `PF` error message keys to `apps/web/src/lib/errors.ts` and both i18n files.

## 6. Verify

```bash
pnpm db:test && pnpm check
```

After deploying: `select * from private.security_audit();` must return zero rows.
