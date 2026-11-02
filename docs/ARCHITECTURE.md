# Architecture

```
Browser ──HTTPS──▶ Render · apps/web (Next.js 16, Node, region ohio)
                      proxy.ts: CSP nonce + session refresh
                      Server Components (reads) · Server Actions (writes)
                      @supabase/ssr cookie session → member's JWT
                          │  PostgREST + RPC, as the member (RLS applies)
                          ▼
                   Supabase · ca-central-1
                      Postgres: public (API surface) · private (logic, state)
                      Auth: email+password, confirmed email, TOTP MFA, CAPTCHA
                          ▲  RPC with the secret key (service_role)
                          │
Render cron · apps/worker (*/10 min)
   scoring_input() → bootstrap + matrix factorisation → apply_note_scores()
   run_maintenance() · process account deletions (Auth admin API)
```

## Repository layout

| Path | What | Notes |
|---|---|---|
| `supabase/migrations/` | Schema, RLS, grants, every business rule | Ordered, append-only. 13 files. |
| `supabase/seed.sql` | Local demo data (dev only) | Creates content through the real RPCs |
| `supabase/config.toml`, `templates/` | Local Supabase + auth email templates | Only `public` exposed via the API |
| `packages/database/` | `Database` types, domain vocabulary, PGlite test harness, schema tests | The database contract |
| `apps/worker/` | Note scoring, maintenance, deletions | Pure algorithms + a storage interface |
| `apps/web/` | Next.js app | Server-rendered, no browser→Supabase traffic |
| `docs/` | Specs, threat model, privacy, ops, ADRs | |
| `.claude/skills/` | Project skills for AI-assisted changes | |

## Invariants

These are enforced by code, tests or both. Break one and a test fails.

1. **The database is the security boundary** ([ADR-0001](adr/0001-database-as-security-boundary.md)).
   - Assume anyone can call PostgREST directly with any member's JWT.
   - Every table has RLS enabled. API roles hold no INSERT/UPDATE/DELETE grants; the one exception is a column grant on four descriptive profile fields.
   - Every write goes through an RPC. Each RPC checks:
     - the caller (`private.require_user`);
     - their capability (`private.require_capability`), read from tables and never from JWT claims or user metadata;
     - rate limits (`private.enforce_rate_limit`).
   - `private.security_audit()` checks all of this, and the tests assert it returns nothing.
2. **Points come only from the ledger** ([ADR-0002](adr/0002-karma-ledger.md)).
   - `ledger_events` is append-only (triggers block UPDATE/DELETE/TRUNCATE).
   - Cached totals change only through the ledger trigger.
   - Writers declare a *desired* total via `private.reconcile()`, which makes every settlement idempotent and every reversal auditable.
3. **Algorithms in TypeScript, side effects in SQL** ([ADR-0003](adr/0003-note-scoring.md)).
   - The worker computes statuses as pure functions.
   - `apply_note_scores()` applies them in one transaction: run-id idempotency, a single-runner advisory lock, stale-snapshot detection, then lock detection and settlement.
4. **The secret key lives only in the worker.** The web app reads `SUPABASE_PUBLISHABLE_KEY` only, and refuses to start in production if `SUPABASE_SECRET_KEY` is present.
5. **Nothing in the browser talks to Supabase.**
   - All data access is server-side, so CSP `connect-src 'self'` holds.
   - User content renders as text (`react/no-danger` is a lint error).
6. **Every user-facing string exists in English and French.** `fr.ts` is typed against `en.ts`, and a test compares placeholders.

## Request flow (a vote)

1. `VoteButtons` (client) calls the `voteAction` Server Action. Next.js rejects cross-origin action POSTs.
2. `voteAction` validates the input with zod, then calls `supabase.rpc('cast_vote')` as the member.
3. `cast_vote` (`security definer`, `search_path = ''`):
   - checks the member's `vote` capability and rate limit, and rejects self-votes;
   - decides `counts_for_karma` once, when the vote is cast;
   - locks the post row, upserts the vote and recomputes the score;
   - calls `private.reconcile('post_votes:<id>', author, 'karma', …, greatest(net, −5))`.
4. A ledger trigger updates `profiles.karma` and the tier, with hysteresis.
5. On failure, the `PF` SQLSTATE is mapped to a localised message (`lib/errors.ts`). Unknown errors become a generic message, and only the code is logged.

## Reading data

Reads use `security definer` *projection* functions (`get_feed`, `get_post`, `get_comments`, `get_post_notes`, `get_note`, `list_notes`, `get_profile`, `mod_queue`) rather than raw tables. They:
- replace note-writer ids with pseudonyms;
- hide rating breakdowns until a note locks;
- mask removed comments;
- attach the caller's own vote or rating.

Each one applies its visibility rule in its `WHERE` clause, and tests assert what anonymous visitors, members and moderators can see. Watch for NULL-unsafe predicates: for anonymous callers `auth.uid()` is NULL, so write `coalesce(author_id = auth.uid(), false)`. The test suite caught exactly this bug once.

## Testing strategy

| Layer | Tool | What it proves |
|---|---|---|
| Schema and security | PGlite (Postgres 18 in WASM) plus a Supabase shim: roles, default grants, `auth.uid()` | Migrations apply from zero; RLS, grants, capability gates, ledger, settlement and moderation behave as specified. Runs as anon, members (aal1/aal2) and service_role. |
| Contract | `packages/database/tests/contract.test.ts` | TypeScript enums match the SQL CHECK constraints |
| Scoring | Vitest with synthetic polarised communities | Bridging shows notes both camps like, and resists a majority camp |
| Worker end-to-end | PGlite + seed + the real jobs | The worker and the SQL agree on the payload contract |
| Web units | Vitest | CSP, open-redirect guard, error mapping, validation, i18n parity |

What isn't covered here: a browser end-to-end run against a real Supabase project. Playwright is listed in the roadmap; [DEPLOYMENT.md](DEPLOYMENT.md) has a manual smoke test.

## Known limitations and next steps

- `packages/database/src/types.ts` is maintained by hand. Once a project is linked, regenerate with `pnpm db:types` and diff.
- Scoring reads up to 180 days of ratings in one payload. Paging is needed at very large scale.
- Not built yet: image uploads, notifications, search, clinician verification, ads, reciprocal-vote-ring detection.
