# Runbook

## Routine

| When | Check |
|---|---|
| After every migration | **Admin → System → Security self-audit** says *0 problems* (or `select * from private.security_audit();` returns no rows) |
| Daily | **Admin → Home**: clear "Needs you". **Admin → System**: every job says *Running*. |
| Weekly | **Admin → Community notes**: scoring agreement and established raters; signs of manipulation |
| Weekly | **Admin → Moderation → Moderator performance**: time to decide, appeals overturned |

The full console guide is [ADMIN.md](ADMIN.md).

## Tuning the economy

Use **Admin → Rules & settings**. Each setting shows its allowed range, its last change and a history with Revert. Under the hood this calls `admin_set_config` (admin + MFA), which checks the range and shape and logs the change with its reason in `mod_actions`. Keys are documented in [SELF_MODERATION.md](SELF_MODERATION.md).

## Switching scoring to bridging mode

1. **Admin → Community notes → Ready for bridging?** Both checks should pass for about a week: established raters ≥ `scoring.bridging.switch_min_raters`, and agreement ≥ 85%.
2. Press **Switch to bridging** and give a reason (or `select public.admin_set_config('scoring.mode', '"bridging"', '…');`).
3. If the pool shrinks, the worker logs `bridging mode configured but rater pool too small` and applies bootstrap until it recovers.

## Incidents

| Symptom | Likely cause | Action |
|---|---|---|
| `scoring_busy` errors | Two cron runs overlapped | Harmless; the next run proceeds |
| `apply_note_scores failed: PF500 config_missing` | A config key was deleted | Re-insert the default from the `…011_reference_data` migration |
| Brigade suspected on a note | Many ratings from new graduates | **Admin → Community notes → Signs of manipulation** lists notes rated mostly by new accounts and raters in lockstep. Open the members, then freeze them from their page. If accuracy suffers, raise `notes.graduation_impact`. |
| Member disputes their karma | | **Admin → People → member → Standing** shows the ledger; every row has a reason and source |
| Vendor spam wave | | **Admin → Sourcing shield**: block the site, add the phrase as *hold*, then clear held posts from the queue |
| Worker stalled | **Admin → System** shows *Stalled* | Check the `pepforum-worker` cron on Render. Notes stop settling, collapses stop reopening and deletions stop until it runs. |
| Suspected leak of the secret key | | Rotate it in Supabase (API keys) **and** in Render (worker only). Review `mod_actions` and `app_config_history` for unexpected writes. |
| Confidentiality incident (Loi 25) | | Record it in the incident register. If there's a risk of serious injury, notify the CAI and the affected people promptly. See [DATA_PRIVACY.md](DATA_PRIVACY.md). |

## Restoring a removed post

Prefer the appeal: the author appeals and a different moderator decides. If an admin needs to act directly, use **Admin → Content → Restore** (or the Restore button in the log). It reverses the karma penalty, strike, freeze and reporter XP exactly like an upheld appeal, closes any open appeal, and logs `restore`. Never edit rows by hand: it bypasses the audit trail.
