# Pepforum

Canada's bilingual peptide-discussion forum: no vendors, no sales, just context. Moderation is done mostly by the community. **Karma** measures standing, **community notes** add context that raters across perspectives agree on, and a **progression system** rewards members who moderate accurately.

- **Stack:** Supabase (Postgres, Auth · `ca-central-1`) · Render (Next.js 16 web service + Node cron worker) · TypeScript · pnpm workspaces
- **Status:** foundation plus the features ported from the prototype build (SEO, notifications and web push, images, clinician verification, advertising). See [roadmap](#roadmap).

## How self-moderation works (60 seconds)

| You do | You get |
|---|---|
| Post and comment; others upvote | **Karma**, which unlocks tiers: Member (posts) → Trusted (links, rating notes) → Contributor (writing notes) → Steward |
| Rate community notes, in line with the eventual cross-perspective outcome | **Moderation XP** and **rater impact**: graduation from probation, note-writing rights, Steward powers |
| Write notes that settle Helpful | Moderation XP and writer impact (private, so pseudonymous writers can't be unmasked) |
| Post a misleading claim that raters across perspectives correct, and don't fix it | A **strike** (integrity −15 for 90 days) and a capped karma loss. Experience posts and corrected posts are protected. |

Rewards are paid only when outcomes are final, adjusted so that guessing earns nothing. Full spec: **[docs/SELF_MODERATION.md](docs/SELF_MODERATION.md)**.

## Quick start

```bash
nvm use                       # Node 22.18+
corepack enable && pnpm install
pnpm check                    # lint + typecheck + all tests (no Docker needed)
pnpm worker:dry-run           # score the demo seed in an in-process Postgres
```

To run the web app against a local Supabase (needs Docker; `pnpm install` provides the Supabase CLI):

```bash
pnpm supabase start           # applies migrations + seed.sql
cp .env.example apps/web/.env.local   # fill SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY from `pnpm supabase status`
pnpm dev                      # http://localhost:3000 · demo accounts use password pepforum-demo-2026
```

Demo accounts include `maple_you` (Trusted), `peptide_analyst` (founding rater), `nurse_nova` (Ontario moderator), `newbie_sask` (newcomer) and `ops_lead` (admin).

## Repository

```
apps/web            Next.js app: server-rendered, Server Actions, CSP nonce, EN/FR
apps/worker         Render cron: note scoring (Wilson bootstrap + matrix factorisation), maintenance, account deletions, web push, media purge, ad settlement
packages/database   Supabase types, domain vocabulary, PGlite harness + schema/security tests
supabase/           Migrations (all business rules + RLS), config, auth email templates, local seed
docs/               Architecture, self-moderation spec, threat model, privacy, deployment, runbook, ADRs
.claude/skills/     Project skills for safe AI-assisted changes
```

## Documentation

| Read this | For |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Invariants, request flow, testing strategy |
| [docs/SELF_MODERATION.md](docs/SELF_MODERATION.md) | Karma, tiers, notes, scoring, settlement, reports, appeals; every tunable |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) | STRIDE table, abuse cases, residual risks |
| [docs/DATA_PRIVACY.md](docs/DATA_PRIVACY.md) | PIPEDA / Loi 25: inventory, residency, rights, pre-launch checklist |
| [docs/ADMIN.md](docs/ADMIN.md) | The `/admin` console: what each section does, the rules admins can't break, a daily routine |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · [docs/RUNBOOK.md](docs/RUNBOOK.md) | Supabase + Render setup, smoke test, operations |
| [docs/adr/](docs/adr) | Why things are the way they are |
| [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) | Workflow; reporting vulnerabilities |

## Roadmap

- Search (pg_trgm), email digests
- Server-side image re-encoding (strip EXIF) and malware scanning on uploads
- A payment-provider adapter for ad credit (today an admin records payments against an invoice)
- Reciprocal vote-ring detection
- Playwright end-to-end tests against a Supabase branch
- Porting the remaining prototype pages (explore map, admin analytics)
