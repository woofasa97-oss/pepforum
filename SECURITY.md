# Security policy

## Reporting a vulnerability

Please email **security@pepforum.ca** with steps to reproduce. Don't open a public issue. We acknowledge reports within 3 business days and keep you updated until a fix ships. Good-faith research that respects the rules below won't face legal action from us.

**In scope:**
- authentication and session handling;
- authorisation bypasses, including calling the Supabase API directly;
- manipulating karma, tiers, note status or moderation;
- data exposure;
- XSS, CSRF and open redirects.

**Rules:**
- Use only your own accounts.
- Don't access, modify or delete other members' data.
- Don't run denial-of-service or social-engineering attacks.
- Stop and report as soon as you've confirmed an issue.

## Design overview

Pepforum enforces permissions in Postgres (RLS plus `security definer` RPCs), not in the web app. See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and [docs/adr/0001](docs/adr/0001-database-as-security-boundary.md). Automated checks:
- the catalog self-audit `private.security_audit()`;
- the RLS and grant test suite;
- gitleaks and `pnpm audit` in CI;
- CodeQL and dependency review, once GitHub Code Security is enabled (repository variable `CODE_SECURITY_ENABLED=true`);
- Dependabot, with a release-age cooldown matching pnpm's `minimumReleaseAge`.
