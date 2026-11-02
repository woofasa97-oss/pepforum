# ADR-0005 · RLS enabled, not forced

**Status:** accepted · 2026-11-02

## Context

`FORCE ROW LEVEL SECURITY` applies policies to the table owner as well. Our `security definer` functions run as the owner (`postgres`), and they are the trusted path that enforces business rules. Supabase doesn't document whether `postgres` has `BYPASSRLS`. If it doesn't, FORCE would silently filter every definer function's reads and writes. If it does, FORCE has no effect on `postgres`.

## Decision

Enable RLS on every table, without forcing it. API roles (`anon`, `authenticated`) are always subject to RLS. `service_role` bypasses RLS by design and receives only the grants the worker needs.

## Consequences

- Definer functions behave the same on Supabase and in PGlite.
- `private.security_audit()` checks that RLS is enabled; the tests check API-role behaviour directly.
