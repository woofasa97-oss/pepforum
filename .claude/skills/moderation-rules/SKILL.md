---
name: moderation-rules
description: Use when changing Pepforum's self-moderation economy — karma rewards/penalties, tiers, capability gates, community-note rating/settlement/scoring, reports, strikes, sanctions or appeals. Explains which knob to turn (config vs code), the anti-gaming properties that must be preserved, and the tests that prove them.
---

# Changing the self-moderation rules

The spec is docs/SELF_MODERATION.md. Read the "Design principles" section first: every change must keep those properties.

## Decide: config or code?

| Want to change | How |
|---|---|
| A threshold, reward, penalty, window or rate limit | **Config only.** In production: `select public.admin_set_config('<key>', '<json>', '<reason>');` (admin + MFA, logged). To change the default for new environments, add a new migration that updates `app_config`. Update the table in SELF_MODERATION.md. |
| Who may do something (a new condition) | `private.capability_check()` in a **new** migration (`create or replace`), plus a reason key, plus `describeRequirement()` in `apps/web/src/lib/errors.ts`, plus i18n `req.*` strings |
| What settlement pays | `private.settle_note()` in a new migration. Always pay via `private.reconcile` with a stable event key. |
| How notes are scored | `apps/worker/src/scoring/*` (pure) plus `scoring.*` config keys |

## Properties that must survive every change

1. **Accuracy over volume.** No reward at rating, reporting or posting time. Rewards come only at settlement or a moderator decision, and are base-rate adjusted for ratings.
2. **Bridging.** Nothing lets one coordinated group decide a note alone. Keep probation weight 0, assignment weighting, the 72-hour lock and the bridging guard.
3. **Protected honesty.** Experience posts and corrected posts never get strikes. Author penalties stay capped per 30 days.
4. **Idempotency.** Re-running settlement or scoring changes nothing. Status flips never double-pay.
5. **Reversibility.** Every moderator penalty can be reversed by an appeal through reconcile (desired = 0), decided by a different moderator.
6. **Explainability.** New ledger reasons get an `ledger.reason.*` string in both locales; new gates return a reason key.

## Tests to add or update

- `packages/database/tests/notes.test.ts`: gates, weights, settlement amounts, strike conditions.
- `packages/database/tests/content.test.ts`: vote-karma eligibility, floors, tiers.
- `packages/database/tests/moderation.test.ts`: collapse thresholds, removal penalties, appeals.
- `apps/worker/tests/scoring.test.ts`: any algorithm change must still pass "not fooled by a majority camp".

For a game-theory change, add a test that shows the exploit failing. Example: "always rating Helpful earns ~0 XP once the base rate is high".
