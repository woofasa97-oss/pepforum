# ADR-0004 · Supabase in Canada, compute on Render (US)

**Status:** accepted · 2026-11-02

## Context

The founder chose Supabase and Render. Canadian members expect their data to stay in Canada, and Québec's Loi 25 requires a privacy impact assessment for transfers outside Québec. Supabase offers `ca-central-1`. Render offers only Oregon, Ohio, Virginia, Frankfurt and Singapore.

## Decision

- Database and Auth in Supabase `ca-central-1` (Montréal).
- Web service and cron in Render **Ohio**, the closest region to Toronto and Montréal.
- Personal data is *stored* only in Canada. It *transits* and is processed in memory in the US, and this is disclosed (privacy policy, Loi 25 notice, PIA).

## Consequences

- An extra round trip of about 20–30 ms between Ohio and Montréal on each query. Acceptable for a forum.
- The app is a plain Node server plus a cron script, so it can move to a Canadian host without code changes if a residency requirement demands it.
