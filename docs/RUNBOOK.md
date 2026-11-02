# Runbook

## Routine

| When | Check |
|---|---|
| After every migration | `select * from private.security_audit();` returns no rows |
| Daily | The Render cron for `pepforum-worker` is green. Log line `scoring run complete` shows `skipped_stale` near 0. |
| Weekly | `select mode, created_at, shadow from public.scoring_runs order by created_at desc limit 20;`: watch `shadow.agreement` and `established_raters` |
| Weekly | Mod queue age: `select zone_id, count(*), min(created_at) from public.reports where status = 'open' group by 1;` |

## Tuning the economy

Change thresholds through the logged admin RPC, from an MFA session:

```sql
select public.admin_set_config('notes.min_ratings', '7', 'Rater pool passed 300; raise the bar');
```

History lives in `app_config_history`; each change is also recorded in `mod_actions` (action `config_change`). Keys are documented in [SELF_MODERATION.md](SELF_MODERATION.md).

## Switching scoring to bridging mode

1. Check that `scoring_runs.shadow.established_raters` ≥ `scoring.bridging.switch_min_raters` and `shadow.agreement` ≥ 0.85 over a week.
2. Switch:
   ```sql
   select public.admin_set_config('scoring.mode', '"bridging"', 'Shadow agreement 0.9 for 7 days');
   ```
3. If the pool shrinks, the worker logs `bridging mode configured but rater pool too small` and applies bootstrap until it recovers.

## Incidents

| Symptom | Likely cause | Action |
|---|---|---|
| `scoring_busy` errors | Two cron runs overlapped | Harmless; the next run proceeds |
| `apply_note_scores failed: PF500 config_missing` | A config key was deleted | Re-insert the default from the `…011_reference_data` migration |
| Brigade suspected on a note | Many ratings from new graduates | Inspect `note_ratings` (weight, cast_while_public) and ratings per rater. Freeze accounts via `apply_sanction`. If accuracy suffers, raise `notes.graduation_impact`. |
| Member disputes their karma | | `select * from ledger_events where user_id = … order by id;` — every row has a reason and source |
| Suspected leak of the secret key | | Rotate it in Supabase (API keys) **and** in Render (worker only). Review `mod_actions` and `app_config_history` for unexpected writes. |
| Confidentiality incident (Loi 25) | | Record it in the incident register. If there's a risk of serious injury, notify the CAI and the affected people promptly. See [DATA_PRIVACY.md](DATA_PRIVACY.md). |

## Restoring a removed post

Ask the author to appeal, so the reversal is recorded and decided by a different moderator. Direct SQL edits bypass the audit trail. If one is unavoidable, log it with `private.log_mod_action` in the same transaction.
