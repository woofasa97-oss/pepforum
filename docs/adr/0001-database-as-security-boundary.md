# ADR-0001 · The database is the security boundary

**Status:** accepted · 2026-11-02

## Context

Supabase exposes Postgres through PostgREST. Anyone holding a member's JWT, including that member, can call any exposed table or function directly, bypassing the Next.js app. Pepforum's value is a trust system (karma, notes, moderation), so it can't depend on the app behaving.

## Decision

- Every rule that protects data or the trust system is enforced in Postgres:
  - RLS on every table;
  - no direct write grants for API roles;
  - business logic in `security definer` functions with `search_path = ''`;
  - capabilities computed from tables, not from JWT claims or user metadata (both of which members can influence or which go stale);
  - rate limits in SQL.
- Internal functions and state live in a `private` schema that PostgREST doesn't expose. EXECUTE is revoked from PUBLIC globally and granted function by function.
- The app layer validates input for usability (zod) and maps errors, but grants nothing.
- `private.security_audit()` encodes these rules as catalog checks, and the test suite asserts it returns no rows.

## Consequences

- More SQL, but tested end to end against an in-process Postgres (PGlite) with real roles.
- Adding a feature means adding an RPC plus tests. See `.claude/skills/new-migration`.
- Reads go through projection functions where identities or aggregates must be hidden.
