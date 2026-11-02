# ADR-0002 · Append-only ledger with reconcile

**Status:** accepted · 2026-11-02

## Context

Karma and moderation XP change for many reasons: votes, note settlement, strikes, moderator removals, appeals. Settlement can be retried, notes can change status before they lock, and appeals reverse penalties. Updating a balance in place makes all of this lossy and impossible to audit.

## Decision

- `ledger_events` is append-only. Triggers block UPDATE, DELETE and TRUNCATE, even for the table owner.
- Callers never insert raw deltas. They call `private.reconcile(event_key, user, track, reason, source, desired)`, which inserts `desired − current` for that (event_key, user, track), under an advisory lock.
- Retrying a settlement inserts nothing. A reversal is "desired = 0". Every change ever made stays visible.
- An insert trigger maintains `profiles.karma`, `mod_xp` and `tier` (with demotion hysteresis).

## Consequences

- Any balance can be explained row by row (the member-facing ledger on `/karma`).
- Account deletion anonymises profiles instead of removing them, so ledger history stays consistent (see DATA_PRIVACY.md).
