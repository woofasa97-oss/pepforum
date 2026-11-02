-- ============================================================================
-- 0015 · Admin console
--
-- Everything /admin needs, enforced here like the rest of the platform:
--   * reads are SECURITY DEFINER projections gated by private.require_admin
--     (admin + MFA/aal2); no new table grants;
--   * every write requires a reason, is rate-limited (`rate_limit.admin_action`)
--     and is written to the append-only mod_actions log;
--   * guardrails: nobody changes their own role, the last admin stays, karma
--     and XP are never edited (penalties are undone by reversing their cause),
--     and community-note statuses are never overridden — an admin can only
--     hide a note that itself breaks the rules (docs/adr/0006).
-- Emails are never listed: a masked form is shown, and the real address comes
-- only from admin_find_by_email / admin_reveal_email, both logged.
-- See docs/ADMIN.md.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Vocabulary
-- ---------------------------------------------------------------------------
alter table public.mod_actions drop constraint mod_actions_action_check;
alter table public.mod_actions add constraint mod_actions_action_check check (action in (
  'remove', 'restore', 'auto_collapse', 'auto_uncollapse', 'dismiss_reports',
  'sanction', 'revoke_sanction', 'grant_founding_rater', 'appoint_moderator',
  'remove_moderator', 'appeal_upheld', 'appeal_denied', 'config_change',
  'grant_admin', 'revoke_admin', 'end_founding_rater', 'rename_user', 'revoke_strike', 'clear_writing_lock',
  'hide_note', 'unhide_note', 'pin', 'unpin', 'lock_comments', 'unlock_comments',
  'shield_rule_added', 'shield_rule_removed', 'shield_hold', 'taxonomy_change',
  'lookup_email', 'reveal_email'));

alter table public.mod_actions drop constraint mod_actions_target_kind_check;
alter table public.mod_actions add constraint mod_actions_target_kind_check check (target_kind in (
  'post', 'comment', 'user', 'config', 'appeal', 'sanction', 'note', 'strike', 'shield', 'taxonomy'));

-- ---------------------------------------------------------------------------
-- New columns
-- ---------------------------------------------------------------------------
-- Pinned posts lead their zone's feed (at most two per zone); locked posts
-- accept no new comments.
alter table public.posts add column pinned_at          timestamptz;
alter table public.posts add column comments_locked_at timestamptz;
create index posts_pinned on public.posts (zone_id) where pinned_at is not null;

-- A hidden note is gone from every public read. Hiding an open note locks it
-- as Needs More Ratings, which settles with no rewards and no strike.
alter table public.notes add column hidden_at     timestamptz;
alter table public.notes add column hidden_reason text check (hidden_reason is null or char_length(hidden_reason) <= 500);

-- Allowed range for numeric settings: {"min": n, "max": n}. Checked by
-- admin_set_config; the console uses it for its inputs.
alter table public.app_config add column bounds jsonb
  check (bounds is null or (jsonb_typeof(bounds -> 'min') = 'number' and jsonb_typeof(bounds -> 'max') = 'number'));

-- Metrics count by creation time.
create index comments_created      on public.comments (created_at);
create index reports_created       on public.reports (created_at);
create index mod_actions_created   on public.mod_actions (created_at desc);
create index mod_actions_action    on public.mod_actions (action, created_at desc);
create index notes_created         on public.notes (created_at);
create index note_ratings_created  on public.note_ratings (created_at);
create index post_votes_created    on public.post_votes (created_at);
create index comment_votes_created on public.comment_votes (created_at);

-- ---------------------------------------------------------------------------
-- Staff notes (Reddit's "mod notes"): private, append-only context on a member
-- ---------------------------------------------------------------------------
create table public.staff_notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null references public.profiles (id),
  author_id  uuid        not null references public.profiles (id),
  label      text        not null check (label in ('note', 'watch', 'warned', 'good_contributor')),
  body       text        not null check (char_length(body) between 3 and 1000),
  created_at timestamptz not null default now()
);
create index staff_notes_user on public.staff_notes (user_id, created_at desc);

create trigger staff_notes_append_only
  before update or delete on public.staff_notes
  for each row execute function private.forbid_mutation();

alter table public.staff_notes enable row level security;
-- Read through admin_member(); no API grant.

-- ---------------------------------------------------------------------------
-- Background job heartbeat (written by the worker, read by /admin/system)
-- ---------------------------------------------------------------------------
create table public.job_runs (
  id          bigint generated always as identity primary key,
  job         text        not null check (job in ('score_notes', 'maintenance', 'process_deletions')),
  started_at  timestamptz not null,
  finished_at timestamptz not null default now(),
  ok          boolean     not null,
  summary     jsonb       not null default '{}'::jsonb
);
create index job_runs_job on public.job_runs (job, finished_at desc);

alter table public.job_runs enable row level security;

create function public.record_job_run(p_job text, p_started_at timestamptz, p_ok boolean, p_summary jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.job_runs (job, started_at, ok, summary)
  values (p_job, coalesce(p_started_at, now()), coalesce(p_ok, false), coalesce(p_summary, '{}'::jsonb));
  -- A month of history is plenty for a heartbeat.
  delete from public.job_runs where finished_at < now() - interval '30 days';
end;
$$;

-- ---------------------------------------------------------------------------
-- Settings: new keys and bounds
-- ---------------------------------------------------------------------------
insert into public.app_config (key, value, is_public, description) values
  ('site.announcement', '{"en": "", "fr": "", "tone": "info", "until": null}', true,
   'Site-wide banner. Empty text hides it; "until" (ISO date) ends it automatically.'),
  ('rate_limit.admin_action', '{"limit": 300, "window_seconds": 3600}', false, 'Admin console changes per admin per hour.');

update public.app_config c
   set bounds = jsonb_build_object('min', b.min, 'max', b.max)
  from (values
    ('tiers.demotion_ratio', 0.5, 1),
    ('gates.post_text.min_tier', 0, 4), ('gates.post_link.min_tier', 0, 4),
    ('gates.posting.min_integrity', 0, 100), ('gates.posting.cooldown_integrity', 0, 100),
    ('gates.rate_notes.min_tier', 0, 4), ('gates.rate_notes.min_account_days', 0, 365),
    ('gates.rate_notes.min_integrity', 0, 100),
    ('gates.write_notes.min_tier', 0, 4), ('gates.write_notes.min_integrity', 0, 100),
    ('gates.steward.min_karma', 0, 1000000), ('gates.steward.min_mod_xp', 0, 100000), ('gates.steward.min_integrity', 0, 100),
    ('gates.vote_counts.min_account_days', 0, 365), ('gates.vote_counts.min_integrity', 0, 100),
    ('karma.vote_floor_per_item', -1000, 0),
    ('karma.max_counted_votes_per_voter_author_30d', 1, 1000), ('karma.max_counted_votes_per_author_day', 1, 100000),
    ('notes.min_ratings', 3, 200), ('notes.graduation_impact', 1, 100), ('notes.demotion_impact', -100, -1),
    ('notes.unassigned_weight', 0, 1), ('notes.lock_stable_hours', 1, 720), ('notes.max_age_days', 1, 365),
    ('notes.correction_window_hours', 1, 720),
    ('notes.writer_helpful_xp', 0, 1000), ('notes.writer_helpful_bonus_cap', 0, 1000), ('notes.writer_not_helpful_xp', -1000, 0),
    ('notes.rater_xp_scale', 0, 100), ('notes.base_rate_window_days', 7, 365), ('notes.base_rate_min_samples', 1, 10000),
    ('notes.writer_lock_window', 1, 100), ('notes.writer_lock_min_not_helpful', 1, 100),
    ('notes.writer_lock_helpful_ratio', 0, 1), ('notes.writer_lock_days', 1, 365),
    ('notes.author_penalty_karma', 0, 1000), ('notes.author_penalty_cap_30d', 0, 10000),
    ('scoring.bootstrap.helpful_lower_bound', 0, 1), ('scoring.bootstrap.not_helpful_upper_bound', 0, 1),
    ('scoring.bootstrap.z', 0.5, 5),
    ('scoring.bridging.lambda_intercept', 0, 10), ('scoring.bridging.lambda_factor', 0, 10),
    ('scoring.bridging.helpful_intercept', -1, 2), ('scoring.bridging.max_factor', 0, 5),
    ('scoring.bridging.not_helpful_intercept', -2, 1), ('scoring.bridging.not_helpful_factor_slope', 0, 5),
    ('scoring.bridging.switch_min_raters', 1, 100000),
    ('strikes.duration_days', 1, 3650), ('strikes.note_misleading_points', 1, 100), ('strikes.mod_removal_points', 1, 100),
    ('strikes.sourcing_points', 1, 100), ('strikes.sanction_points', 1, 100),
    ('reports.min_account_days', 0, 365), ('reports.collapse_weight', 0.5, 100), ('reports.collapse_min_reporters', 1, 100),
    ('reports.steward_required_tier', 0, 5), ('reports.collapse_review_hours', 1, 720),
    ('reports.upheld_xp', 0, 1000), ('reports.abusive_xp', -1000, 0),
    ('moderation.removal_penalty_karma', -10000, 0), ('moderation.sourcing_penalty_karma', -10000, 0),
    ('moderation.removal_freeze_days', 0, 365), ('moderation.appeal_window_days', 1, 365)
  ) as b (key, min, max)
 where c.key = b.key;

-- Shape and range checks beyond the JSON type (which admin_set_config already
-- compares with the old value).
create function private.validate_config(p_key text, p_value jsonb, p_bounds jsonb)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_prev numeric := null;
  v_item jsonb;
  v_n    numeric;
begin
  if p_bounds is not null and jsonb_typeof(p_value) = 'number'
     and (p_value::numeric < (p_bounds ->> 'min')::numeric or p_value::numeric > (p_bounds ->> 'max')::numeric) then
    perform private.raise_error('PF422', 'config_out_of_range', p_key);
  end if;

  if p_key = 'tiers.thresholds' then
    if jsonb_array_length(p_value) <> 5 or (p_value ->> 0)::numeric <> 0 then
      perform private.raise_error('PF422', 'config_out_of_range', p_key);
    end if;
    for v_item in select * from jsonb_array_elements(p_value) loop
      if jsonb_typeof(v_item) <> 'number' or v_item::numeric <> trunc(v_item::numeric)
         or (v_prev is not null and v_item::numeric <= v_prev) then
        perform private.raise_error('PF422', 'config_out_of_range', p_key);
      end if;
      v_prev := v_item::numeric;
    end loop;
  elsif p_key like 'rate_limit.%' then
    if (select count(*) from jsonb_object_keys(p_value)) <> 2
       or jsonb_typeof(p_value -> 'limit') <> 'number' or jsonb_typeof(p_value -> 'window_seconds') <> 'number' then
      perform private.raise_error('PF422', 'config_out_of_range', p_key);
    end if;
    v_n := (p_value ->> 'limit')::numeric;
    if v_n <> trunc(v_n) or v_n not between 0 and 100000 then
      perform private.raise_error('PF422', 'config_out_of_range', p_key);
    end if;
    v_n := (p_value ->> 'window_seconds')::numeric;
    if v_n <> trunc(v_n) or v_n not between 60 and 604800 then
      perform private.raise_error('PF422', 'config_out_of_range', p_key);
    end if;
  elsif p_key = 'scoring.mode' then
    if p_value #>> '{}' not in ('bootstrap', 'bridging') then
      perform private.raise_error('PF422', 'config_out_of_range', p_key);
    end if;
  elsif p_key = 'notes.strike_classifications' then
    if exists (select 1 from jsonb_array_elements(p_value) e
               where jsonb_typeof(e) <> 'string'
                  or e #>> '{}' not in ('misleading', 'missing_context', 'outdated', 'unverifiable', 'opinion_as_fact', 'satire')) then
      perform private.raise_error('PF422', 'config_out_of_range', p_key);
    end if;
  elsif p_key = 'site.announcement' then
    if jsonb_typeof(p_value -> 'en') <> 'string' or jsonb_typeof(p_value -> 'fr') <> 'string'
       or char_length(p_value ->> 'en') > 280 or char_length(p_value ->> 'fr') > 280
       or coalesce(p_value ->> 'tone', '') not in ('info', 'warn')
       or (p_value ->> 'until' is not null and p_value ->> 'until' !~ '^\d{4}-\d{2}-\d{2}') then
      perform private.raise_error('PF422', 'config_out_of_range', p_key);
    end if;
  end if;
end;
$$;

create or replace function public.admin_set_config(p_key text, p_value jsonb, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_user();
  v_old    jsonb;
  v_bounds jsonb;
begin
  perform private.require_admin(v_uid);
  perform private.enforce_rate_limit(v_uid, 'admin_action');
  select value, bounds into v_old, v_bounds from public.app_config where key = p_key for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', p_key);
  end if;
  if p_value is null or jsonb_typeof(v_old) <> jsonb_typeof(p_value) then
    perform private.raise_error('PF422', 'config_type_mismatch', p_key);
  end if;
  if char_length(coalesce(p_reason, '')) < 3 then
    perform private.raise_error('PF422', 'reason_required');
  end if;
  perform private.validate_config(p_key, p_value, v_bounds);
  update public.app_config set value = p_value where key = p_key;
  perform private.log_mod_action(v_uid, 'config_change', 'config', null, null, null, p_reason,
                                 jsonb_build_object('key', p_key, 'old', v_old, 'new', p_value));
end;
$$;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------
create function private.require_reason(p_reason text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500 then
    perform private.raise_error('PF422', 'reason_required');
  end if;
end;
$$;

-- Admin entry check for writes: admin + MFA, a reason, and the rate limit.
create function private.require_admin_write(p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.require_admin(v_uid);
  perform private.require_reason(p_reason);
  perform private.enforce_rate_limit(v_uid, 'admin_action');
  return v_uid;
end;
$$;

-- j•••@example.com — enough to recognise an address, not to collect it.
create function private.mask_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_email is null or position('@' in p_email) = 0 then null
              else left(p_email, 1) || '•••@' || split_part(p_email, '@', 2) end;
$$;

-- ---------------------------------------------------------------------------
-- Undoing a removal (shared by appeals and admin restore)
-- ---------------------------------------------------------------------------
create function private.reverse_removal(p_action_id uuid, p_actor uuid, p_ledger_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.mod_actions;
begin
  select * into a from public.mod_actions where id = p_action_id;
  perform private.set_content_status(a.target_kind, a.target_id, 'visible');
  perform private.reconcile('removal:' || a.target_id, a.target_user_id, 'karma', p_ledger_reason,
                            a.target_kind, a.target_id, 0);
  update public.strikes set revoked_at = now()
   where user_id = a.target_user_id and source_id = a.target_id and revoked_at is null;
  update public.sanctions set revoked_at = now(), revoked_by = p_actor
   where mod_action_id = a.id and revoked_at is null;
  -- Reporters were paid for a removal that turned out wrong: take it back.
  perform private.reconcile('report:' || r.id, r.reporter_id, 'mod_xp', p_ledger_reason, 'report', r.id, 0)
  from public.reports r
  where r.status = 'actioned' and (r.post_id = a.target_id or r.comment_id = a.target_id);
end;
$$;

create or replace function public.decide_appeal(p_appeal_id uuid, p_uphold boolean, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  ap    public.appeals;
  a     public.mod_actions;
  v_sanction uuid;
begin
  select * into ap from public.appeals where id = p_appeal_id for update;
  if not found or ap.status <> 'open' then
    perform private.raise_error('PF404', 'not_found', 'appeal');
  end if;
  select * into a from public.mod_actions where id = ap.mod_action_id;

  if a.zone_id is not null then
    perform private.require_zone_mod(v_uid, a.zone_id);
  else
    perform private.require_admin(v_uid);
  end if;
  if a.actor_id = v_uid or ap.appellant_id = v_uid then
    perform private.raise_error('PF403', 'conflict_of_interest');
  end if;

  update public.appeals
     set status = case when p_uphold then 'upheld' else 'denied' end,
         decided_by = v_uid, decided_at = now(), decision_note = p_note
   where id = p_appeal_id;

  if p_uphold then
    if a.action = 'remove' then
      perform private.reverse_removal(a.id, v_uid, 'appeal_reversal');
    elsif a.action = 'sanction' then
      select s.id into v_sanction from public.sanctions s where s.mod_action_id = a.id;
      update public.sanctions set revoked_at = now(), revoked_by = v_uid where id = v_sanction and revoked_at is null;
      update public.strikes set revoked_at = now()
       where source_kind = 'sanction' and source_id = v_sanction and revoked_at is null;
    end if;
  end if;

  perform private.log_mod_action(v_uid, case when p_uphold then 'appeal_upheld' else 'appeal_denied' end,
                                 'appeal', p_appeal_id, ap.appellant_id, a.zone_id, p_note,
                                 jsonb_build_object('mod_action_id', a.id));
end;
$$;

-- Put removed content back without waiting for an appeal: reverses the karma
-- penalty, strike, freeze and reporter XP exactly like an upheld appeal, and
-- closes any open appeal on the removal.
create function public.admin_restore_content(p_kind text, p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_admin_write(p_reason);
  v_target record;
  v_action uuid;
begin
  select * into v_target from private.content_target(p_kind, p_id);
  if v_target.status <> 'removed' then
    perform private.raise_error('PF409', 'not_removed');
  end if;
  select m.id into v_action from public.mod_actions m
   where m.action = 'remove' and m.target_id = p_id
   order by m.created_at desc limit 1;

  if v_action is null then
    perform private.set_content_status(p_kind, p_id, 'visible');
  else
    perform private.reverse_removal(v_action, v_uid, 'admin_reversal');
    update public.appeals
       set status = 'upheld', decided_by = v_uid, decided_at = now(), decision_note = btrim(p_reason)
     where mod_action_id = v_action and status = 'open';
  end if;
  perform private.log_mod_action(v_uid, 'restore', p_kind, p_id, v_target.author_id, v_target.zone_id, btrim(p_reason),
                                 jsonb_build_object('mod_action_id', v_action));
end;
$$;

-- ---------------------------------------------------------------------------
-- People and roles
-- ---------------------------------------------------------------------------
create function public.admin_set_role(p_user uuid, p_admin boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
begin
  if p_user = v_uid then
    perform private.raise_error('PF403', 'conflict_of_interest');
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_user and p.deleted_at is null) then
    perform private.raise_error('PF404', 'not_found', 'profile');
  end if;

  if p_admin then
    insert into public.user_roles (user_id, role, granted_by) values (p_user, 'admin', v_uid)
    on conflict do nothing;
  else
    if (select count(*) from public.user_roles r where r.role = 'admin') <= 1 then
      perform private.raise_error('PF409', 'last_admin');
    end if;
    delete from public.user_roles where user_id = p_user and role = 'admin';
  end if;
  perform private.log_mod_action(v_uid, case when p_admin then 'grant_admin' else 'revoke_admin' end,
                                 'user', p_user, p_user, null, btrim(p_reason));
end;
$$;

create function public.admin_end_founding(p_user uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
begin
  -- effective_rater_status() then falls back to active or probation by impact.
  update public.profiles set founding_until = now()
   where id = p_user and rater_status = 'founding' and founding_until > now();
  if not found then
    perform private.raise_error('PF404', 'not_found', 'founding_rater');
  end if;
  perform private.log_mod_action(v_uid, 'end_founding_rater', 'user', p_user, p_user, null, btrim(p_reason));
end;
$$;

-- For usernames that break the rules (slurs, impersonation, vendor names).
create function public.admin_rename_user(p_user uuid, p_username text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
  v_old text;
begin
  select username into v_old from public.profiles where id = p_user and deleted_at is null for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'profile');
  end if;
  if p_username is null or p_username !~ '^[A-Za-z0-9_]{3,20}$' then
    perform private.raise_error('PF422', 'invalid_username');
  end if;
  if lower(p_username) ~ '^(deleted_|admin|mod_|moderator|pepforum|system|support|staff)' then
    perform private.raise_error('PF422', 'reserved_username');
  end if;
  if exists (select 1 from public.profiles p where lower(p.username) = lower(p_username) and p.id <> p_user) then
    perform private.raise_error('PF409', 'username_taken');
  end if;
  update public.profiles set username = p_username where id = p_user;
  perform private.log_mod_action(v_uid, 'rename_user', 'user', p_user, p_user, null, btrim(p_reason),
                                 jsonb_build_object('from', v_old, 'to', p_username));
end;
$$;

-- For a strike given by mistake. Integrity is derived from active strikes, so
-- this restores it; karma penalties are undone by restoring content instead.
create function public.admin_revoke_strike(p_strike uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
  s     public.strikes;
begin
  select * into s from public.strikes where id = p_strike and revoked_at is null for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'strike');
  end if;
  if s.user_id = v_uid then
    perform private.raise_error('PF403', 'conflict_of_interest');
  end if;
  update public.strikes set revoked_at = now() where id = p_strike;
  perform private.log_mod_action(v_uid, 'revoke_strike', 'strike', p_strike, s.user_id, null, btrim(p_reason),
                                 jsonb_build_object('reason', s.reason, 'points', s.points));
end;
$$;

create function public.admin_clear_writing_lock(p_user uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
begin
  update public.profiles set writing_locked_until = null
   where id = p_user and writing_locked_until > now();
  if not found then
    perform private.raise_error('PF404', 'not_found', 'writing_lock');
  end if;
  perform private.log_mod_action(v_uid, 'clear_writing_lock', 'user', p_user, p_user, null, btrim(p_reason));
end;
$$;

-- Moderators and admins can leave private context on a member.
create function public.add_staff_note(p_user uuid, p_label text, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_id  uuid;
begin
  perform private.require_aal2();
  if not private.is_moderator(v_uid) then
    perform private.raise_error('PF403', 'not_moderator');
  end if;
  perform private.enforce_rate_limit(v_uid, 'admin_action');
  if p_label is null or p_label not in ('note', 'watch', 'warned', 'good_contributor') then
    perform private.raise_error('PF422', 'invalid_label');
  end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 3 and 1000 then
    perform private.raise_error('PF422', 'invalid_body');
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_user) then
    perform private.raise_error('PF404', 'not_found', 'profile');
  end if;
  insert into public.staff_notes (user_id, author_id, label, body)
  values (p_user, v_uid, p_label, btrim(p_body)) returning id into v_id;
  return v_id;
end;
$$;

-- Exact-match lookup for support and privacy requests. The searched address is
-- not stored; the log records who looked and whether it matched.
create function public.admin_find_by_email(p_email text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_admin_write('email lookup');
  v_user uuid;
  v_name text;
begin
  select u.id, p.username into v_user, v_name
  from auth.users u join public.profiles p on p.id = u.id
  where lower(u.email) = lower(btrim(coalesce(p_email, ''))) and p.deleted_at is null;
  perform private.log_mod_action(v_uid, 'lookup_email', 'user', v_user, v_user, null, 'email lookup',
                                 jsonb_build_object('matched', v_user is not null));
  return v_name;
end;
$$;

create function public.admin_reveal_email(p_user uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := private.require_admin_write(p_reason);
  v_email text;
begin
  select u.email into v_email from auth.users u where u.id = p_user;
  if v_email is null then
    perform private.raise_error('PF404', 'not_found', 'email');
  end if;
  perform private.log_mod_action(v_uid, 'reveal_email', 'user', p_user, p_user, null, btrim(p_reason));
  return v_email;
end;
$$;

-- ---------------------------------------------------------------------------
-- Content: notes, pins, comment locks
-- ---------------------------------------------------------------------------
create function public.admin_set_note_hidden(p_note uuid, p_hidden boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_admin_write(p_reason);
  n      public.notes;
  v_zone text;
begin
  select * into n from public.notes where id = p_note for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'note');
  end if;
  select p.zone_id into v_zone from public.posts p where p.id = n.post_id;

  if p_hidden then
    if n.hidden_at is not null then
      perform private.raise_error('PF409', 'already_hidden');
    end if;
    -- Never a status override: an open note is closed as Needs More Ratings,
    -- which pays nobody and strikes nobody.
    if n.locked_at is null then
      update public.notes
         set status = 'needs_more_ratings', status_since = now(),
             locked_at = now(), locked_status = 'needs_more_ratings'
       where id = p_note;
      insert into public.note_status_history (note_id, event, from_status, to_status)
      values (p_note, 'locked', n.status, 'needs_more_ratings');
      perform private.settle_note(p_note);
    end if;
    update public.notes set hidden_at = now(), hidden_reason = btrim(p_reason) where id = p_note;
  else
    if n.hidden_at is null then
      perform private.raise_error('PF409', 'not_hidden');
    end if;
    update public.notes set hidden_at = null, hidden_reason = null where id = p_note;
  end if;
  perform private.log_mod_action(v_uid, case when p_hidden then 'hide_note' else 'unhide_note' end,
                                 'note', p_note, n.author_id, v_zone, btrim(p_reason));
end;
$$;

create function public.admin_set_pinned(p_post uuid, p_pinned boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
  v     public.posts;
begin
  select * into v from public.posts where id = p_post for update;
  if not found or v.status not in ('visible', 'collapsed') then
    perform private.raise_error('PF404', 'not_found', 'post');
  end if;
  if p_pinned then
    if v.pinned_at is not null then
      perform private.raise_error('PF409', 'already_pinned');
    end if;
    if (select count(*) from public.posts p where p.zone_id = v.zone_id and p.pinned_at is not null) >= 2 then
      perform private.raise_error('PF409', 'pin_limit');
    end if;
    update public.posts set pinned_at = now() where id = p_post;
  else
    update public.posts set pinned_at = null where id = p_post;
  end if;
  perform private.log_mod_action(v_uid, case when p_pinned then 'pin' else 'unpin' end,
                                 'post', p_post, v.author_id, v.zone_id, btrim(p_reason));
end;
$$;

create function public.admin_set_comments_locked(p_post uuid, p_locked boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
  v     public.posts;
begin
  select * into v from public.posts where id = p_post for update;
  if not found or v.status = 'deleted' then
    perform private.raise_error('PF404', 'not_found', 'post');
  end if;
  update public.posts set comments_locked_at = case when p_locked then now() end where id = p_post;
  perform private.log_mod_action(v_uid, case when p_locked then 'lock_comments' else 'unlock_comments' end,
                                 'post', p_post, v.author_id, v.zone_id, btrim(p_reason));
end;
$$;

create function private.enforce_comment_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.posts p where p.id = new.post_id and p.comments_locked_at is not null) then
    perform private.raise_error('PF403', 'comments_locked');
  end if;
  return new;
end;
$$;

create trigger comments_respect_lock
  before insert on public.comments
  for each row execute function private.enforce_comment_lock();

-- ---------------------------------------------------------------------------
-- Taxonomy (categories, cities, zone texts). Zone ids stay migration-only.
-- ---------------------------------------------------------------------------
create function public.admin_upsert_category(
  p_id text, p_name_en text, p_name_fr text, p_icon text,
  p_description_en text, p_description_fr text, p_rules_en text[], p_rules_fr text[],
  p_min_note_ratings smallint, p_sort_order smallint, p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := private.require_admin_write(p_reason);
  v_created boolean;
begin
  if p_id is null or p_id !~ '^[a-z0-9-]{2,40}$' then
    perform private.raise_error('PF422', 'invalid_id');
  end if;
  if char_length(btrim(coalesce(p_name_en, ''))) not between 2 and 60
     or char_length(btrim(coalesce(p_name_fr, ''))) not between 2 and 60 then
    perform private.raise_error('PF422', 'invalid_name');
  end if;
  if p_icon is null or p_icon !~ '^[a-z]{2,20}$' then
    perform private.raise_error('PF422', 'invalid_icon');
  end if;
  if char_length(coalesce(p_description_en, '')) > 500 or char_length(coalesce(p_description_fr, '')) > 500
     or cardinality(coalesce(p_rules_en, '{}')) > 10 or cardinality(coalesce(p_rules_fr, '{}')) > 10 then
    perform private.raise_error('PF422', 'invalid_body');
  end if;
  if p_min_note_ratings is not null and p_min_note_ratings not between 3 and 200 then
    perform private.raise_error('PF422', 'config_out_of_range');
  end if;

  v_created := not exists (select 1 from public.categories c where c.id = p_id);
  insert into public.categories (id, name_en, name_fr, icon, description_en, description_fr, rules_en, rules_fr,
                                 min_note_ratings, sort_order)
  values (p_id, btrim(p_name_en), btrim(p_name_fr), p_icon, coalesce(p_description_en, ''), coalesce(p_description_fr, ''),
          coalesce(p_rules_en, '{}'), coalesce(p_rules_fr, '{}'), p_min_note_ratings, coalesce(p_sort_order, 0))
  on conflict (id) do update
     set name_en = excluded.name_en, name_fr = excluded.name_fr, icon = excluded.icon,
         description_en = excluded.description_en, description_fr = excluded.description_fr,
         rules_en = excluded.rules_en, rules_fr = excluded.rules_fr,
         min_note_ratings = excluded.min_note_ratings, sort_order = excluded.sort_order;
  perform private.log_mod_action(v_uid, 'taxonomy_change', 'taxonomy', null, null, null, btrim(p_reason),
                                 jsonb_build_object('kind', 'category', 'id', p_id, 'created', v_created));
end;
$$;

create function public.admin_archive_category(p_id text, p_archived boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
begin
  update public.categories set archived_at = case when p_archived then coalesce(archived_at, now()) end where id = p_id;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'category');
  end if;
  perform private.log_mod_action(v_uid, 'taxonomy_change', 'taxonomy', null, null, null, btrim(p_reason),
                                 jsonb_build_object('kind', 'category', 'id', p_id, 'archived', p_archived));
end;
$$;

create function public.admin_upsert_city(p_id text, p_zone_id text, p_name text, p_sort_order smallint, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
begin
  if p_id is null or p_id !~ '^[a-z0-9-]{2,40}$' then
    perform private.raise_error('PF422', 'invalid_id');
  end if;
  if not exists (select 1 from public.zones z where z.id = p_zone_id and z.id <> 'national') then
    perform private.raise_error('PF422', 'invalid_zone');
  end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 2 and 60 then
    perform private.raise_error('PF422', 'invalid_name');
  end if;
  insert into public.cities (id, zone_id, name, sort_order)
  values (p_id, p_zone_id, btrim(p_name), coalesce(p_sort_order, 0))
  on conflict (id) do update set zone_id = excluded.zone_id, name = excluded.name, sort_order = excluded.sort_order;
  perform private.log_mod_action(v_uid, 'taxonomy_change', 'taxonomy', null, null, p_zone_id, btrim(p_reason),
                                 jsonb_build_object('kind', 'city', 'id', p_id));
end;
$$;

create function public.admin_update_zone(
  p_id text, p_name_en text, p_name_fr text, p_short_name text, p_description_en text, p_description_fr text, p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
begin
  if char_length(btrim(coalesce(p_name_en, ''))) not between 2 and 60
     or char_length(btrim(coalesce(p_name_fr, ''))) not between 2 and 60
     or char_length(btrim(coalesce(p_short_name, ''))) not between 2 and 20 then
    perform private.raise_error('PF422', 'invalid_name');
  end if;
  if char_length(coalesce(p_description_en, '')) > 500 or char_length(coalesce(p_description_fr, '')) > 500 then
    perform private.raise_error('PF422', 'invalid_body');
  end if;
  update public.zones
     set name_en = btrim(p_name_en), name_fr = btrim(p_name_fr), short_name = btrim(p_short_name),
         description_en = coalesce(p_description_en, ''), description_fr = coalesce(p_description_fr, '')
   where id = p_id;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'zone');
  end if;
  perform private.log_mod_action(v_uid, 'taxonomy_change', 'taxonomy', null, null, p_id, btrim(p_reason),
                                 jsonb_build_object('kind', 'zone', 'id', p_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Reads for the console (admin + MFA)
-- ---------------------------------------------------------------------------

-- Staff (admins and moderators) without a verified second factor.
create function private.staff_without_mfa()
returns table (user_id uuid, username text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.username
  from public.profiles p
  where p.deleted_at is null
    and (exists (select 1 from public.user_roles r where r.user_id = p.id)
         or exists (select 1 from public.zone_moderators m where m.user_id = p.id))
    and not exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified');
$$;

-- "Needs you" and status lights for the console home.
create function public.admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_last_run public.scoring_runs;
begin
  perform private.require_admin(v_uid);
  select * into v_last_run from public.scoring_runs order by created_at desc limit 1;

  return jsonb_build_object(
    'reports_open', (select count(distinct coalesce(r.post_id, r.comment_id)) from public.reports r where r.status = 'open'),
    'reports_oldest', (select min(r.created_at) from public.reports r where r.status = 'open'),
    'appeals_open', (select count(*) from public.appeals a where a.status = 'open'),
    'appeals_admin_only', (select count(*) from public.appeals a join public.mod_actions m on m.id = a.mod_action_id
                           where a.status = 'open' and m.zone_id is null),
    'collapsed', (select count(*) from public.posts p where p.status = 'collapsed')
               + (select count(*) from public.comments c where c.status = 'collapsed'),
    'collapsed_next_reopen', (
      select min(x.at) + make_interval(hours => private.cfg_int('reports.collapse_review_hours')) from (
        select p.status_changed_at as at from public.posts p where p.status = 'collapsed'
        union all select c.status_changed_at from public.comments c where c.status = 'collapsed') x),
    'held', (select count(*) from public.posts p where p.status = 'held')
          + (select count(*) from public.comments c where c.status = 'held'),
    'jobs', coalesce((
      select jsonb_object_agg(j.job, jsonb_build_object('at', j.finished_at, 'ok', j.ok))
      from (select distinct on (r.job) r.job, r.finished_at, r.ok from public.job_runs r
            order by r.job, r.finished_at desc) j), '{}'::jsonb),
    'last_scoring_run', v_last_run.created_at,
    'security_problems', (select count(*) from private.security_audit()),
    'staff_without_mfa', (select count(*) from private.staff_without_mfa()),
    'founding_expiring', (select count(*) from public.profiles p
                          where p.rater_status = 'founding' and p.founding_until between now() and now() + interval '14 days'),
    'deletions_pending', (select count(*) from public.account_deletions d where d.processed_at is null),
    'deletions_oldest', (select min(d.requested_at) from public.account_deletions d where d.processed_at is null),
    'scoring_mode', private.cfg('scoring.mode') #>> '{}',
    'bridging_ready', private.cfg('scoring.mode') #>> '{}' = 'bootstrap'
                      and coalesce((v_last_run.shadow ->> 'established_raters')::integer, 0)
                          >= private.cfg_int('scoring.bridging.switch_min_raters')
                      and coalesce((v_last_run.shadow ->> 'agreement')::numeric, 0) >= 0.85
  );
end;
$$;

-- Daily series and period totals for the health dashboard. Days are in
-- Eastern time. "Active" = posted, commented, voted, rated or reported; page
-- views are not tracked.
create function public.admin_metrics(p_days integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := private.require_user();
  v_tz    constant text := 'America/Toronto';
  v_today date;
  v_start timestamptz;
  v_prev  timestamptz;
begin
  perform private.require_admin(v_uid);
  if p_days is null or p_days not in (7, 30, 90) then
    perform private.raise_error('PF422', 'invalid_range');
  end if;
  v_today := (now() at time zone v_tz)::date;
  v_start := ((v_today - (p_days - 1)) :: timestamp) at time zone v_tz;
  v_prev  := v_start - make_interval(days => p_days);

  return (
    with events as (
      select 'signups' as metric, u.created_at as at, u.id as who from auth.users u where u.created_at >= v_prev
      union all select 'signups_social', u.created_at, u.id from auth.users u
        where u.created_at >= v_prev and coalesce(u.raw_app_meta_data ->> 'provider', 'email') not in ('email', 'phone')
      union all select 'posts', p.created_at, p.author_id from public.posts p where p.created_at >= v_prev
      union all select 'comments', c.created_at, c.author_id from public.comments c where c.created_at >= v_prev
      union all select 'notes', n.created_at, n.author_id from public.notes n where n.created_at >= v_prev
      union all select 'notes_shown', n.first_shown_at, n.author_id from public.notes n
        where n.first_shown_at >= v_prev and n.hidden_at is null
      union all select 'ratings', r.created_at, r.rater_id from public.note_ratings r where r.created_at >= v_prev
      union all select 'reports', r.created_at, r.reporter_id from public.reports r where r.created_at >= v_prev
      union all select 'removals', m.created_at, m.target_user_id from public.mod_actions m
        where m.action = 'remove' and m.created_at >= v_prev
      union all select 'votes', v.created_at, v.voter_id from public.post_votes v where v.created_at >= v_prev
      union all select 'votes', v.created_at, v.voter_id from public.comment_votes v where v.created_at >= v_prev
    ),
    activity as (
      select at, who from events where metric in ('posts', 'comments', 'ratings', 'reports', 'votes')
    ),
    days as (
      select generate_series((v_today - (p_days - 1))::timestamp, v_today::timestamp, interval '1 day')::date as d
    ),
    metrics as (
      select unnest(array['signups', 'signups_social', 'posts', 'comments', 'notes', 'notes_shown',
                          'ratings', 'reports', 'removals']) as metric
    )
    select jsonb_build_object(
      'days', (select jsonb_agg(d order by d) from days),
      'series', (
        select jsonb_object_agg(m.metric, (
          select jsonb_agg((select count(*) from events e
                            where e.metric = m.metric and (e.at at time zone v_tz)::date = days.d) order by days.d)
          from days))
        from metrics m
      ) || jsonb_build_object('active', (
          select jsonb_agg((select count(distinct a.who) from activity a where (a.at at time zone v_tz)::date = days.d)
                           order by days.d)
          from days)),
      'totals', (
        select jsonb_object_agg(m.metric, jsonb_build_object(
                 'current',  (select count(*) from events e where e.metric = m.metric and e.at >= v_start),
                 'previous', (select count(*) from events e where e.metric = m.metric and e.at >= v_prev and e.at < v_start)))
        from metrics m
      ) || jsonb_build_object('active', jsonb_build_object(
                 'current',  (select count(distinct a.who) from activity a where a.at >= v_start),
                 'previous', (select count(distinct a.who) from activity a where a.at >= v_prev and a.at < v_start))),
      'quality', jsonb_build_object(
        'reports_actioned_pct', (
          select round(100.0 * count(*) filter (where r.status = 'actioned') / nullif(count(*), 0))
          from public.reports r where r.resolved_at >= v_start),
        'median_review_hours', (
          select round((percentile_cont(0.5) within group (order by extract(epoch from (t.resolved - t.reported)) / 3600))::numeric, 1)
          from (select min(r.created_at) as reported, min(r.resolved_at) as resolved
                from public.reports r where r.resolved_at >= v_start
                group by coalesce(r.post_id, r.comment_id)) t),
        'appeals_overturned_pct', (
          select round(100.0 * count(*) filter (where a.status = 'upheld') / nullif(count(*), 0))
          from public.appeals a where a.decided_at >= v_start),
        'posts_with_helpful_note_pct', (
          select round(100.0 * count(*) filter (where exists (
                   select 1 from public.notes n where n.post_id = p.id and n.status = 'helpful' and n.hidden_at is null))
                 / nullif(count(*), 0))
          from public.posts p where p.created_at >= v_start and p.status in ('visible', 'collapsed')),
        'collapses_reopened_unreviewed', (
          select count(*) from public.mod_actions m where m.action = 'auto_uncollapse' and m.created_at >= v_start)
      )
    )
  );
end;
$$;

-- Member list. p_filter: all | new | onboarding | restricted | low_integrity |
-- staff | founding. p_sort: newest | karma | reported. 50 per page.
create function public.admin_people(p_query text, p_filter text, p_sort text, p_page integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := private.require_user();
  v_q     text := lower(btrim(coalesce(p_query, '')));
  v_page  integer := least(greatest(coalesce(p_page, 0), 0), 200);
  v_rows  jsonb;
begin
  perform private.require_admin(v_uid);
  -- Prefix match; escape LIKE wildcards in what the admin typed.
  v_q := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');

  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.ord), '[]'::jsonb) into v_rows
  from (
    select p.username, p.tier, p.karma, private.integrity(p.id) as integrity, p.created_at,
           coalesce(u.raw_app_meta_data ->> 'provider', 'email') as provider,
           p.needs_onboarding, p.deleted_at is not null as deleted,
           private.is_admin(p.id) as is_admin,
           exists (select 1 from public.zone_moderators m where m.user_id = p.id) as is_moderator,
           private.effective_rater_status(p) = 'founding' as founding,
           (select s.kind from public.sanctions s
             where s.user_id = p.id and s.revoked_at is null and s.starts_at <= now()
               and (s.ends_at is null or s.ends_at > now()) and s.kind <> 'warning'
             order by case s.kind when 'ban' then 0 when 'suspension' then 1 else 2 end limit 1) as restriction,
           (select count(*) from public.reports r
              left join public.posts rp on rp.id = r.post_id
              left join public.comments rc on rc.id = r.comment_id
             where coalesce(rp.author_id, rc.author_id) = p.id and r.created_at > now() - interval '30 days') as reports_30d,
           row_number() over (order by
             case when p_sort = 'karma' then p.karma end desc nulls last,
             case when p_sort = 'reported' then (
               select count(*) from public.reports r
                 left join public.posts rp on rp.id = r.post_id
                 left join public.comments rc on rc.id = r.comment_id
                where coalesce(rp.author_id, rc.author_id) = p.id and r.created_at > now() - interval '30 days') end desc nulls last,
             p.created_at desc) as ord
    from public.profiles p
    left join auth.users u on u.id = p.id
    where (v_q = '' or lower(p.username) like v_q || '%')
      and case coalesce(p_filter, 'all')
            when 'new'           then p.created_at > now() - interval '7 days' and p.deleted_at is null
            when 'onboarding'    then p.needs_onboarding and p.deleted_at is null
            when 'restricted'    then private.has_active_sanction(p.id, array['freeze', 'suspension', 'ban'])
            when 'low_integrity' then p.deleted_at is null and private.integrity(p.id) < 50
            when 'staff'         then private.is_moderator(p.id)
            when 'founding'      then private.effective_rater_status(p) = 'founding'
            else p.deleted_at is null
          end
    order by ord
    limit 51 offset v_page * 50
  ) x;

  return jsonb_build_object(
    'rows', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_rows) e limit 50) t),
    'has_more', jsonb_array_length(v_rows) > 50
  );
end;
$$;

-- Everything about one member, for staff eyes only.
create function public.admin_member(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  p     public.profiles;
  u     record;
begin
  perform private.require_admin(v_uid);
  select * into p from public.profiles where lower(username) = lower(btrim(coalesce(p_username, '')));
  if not found then
    perform private.raise_error('PF404', 'not_found', 'profile');
  end if;
  select au.email, au.email_confirmed_at, au.created_at, au.last_sign_in_at,
         coalesce(au.raw_app_meta_data ->> 'provider', 'email') as provider
    into u from auth.users au where au.id = p.id;

  return jsonb_build_object(
    'id', p.id, 'username', p.username, 'locale', p.locale, 'home_zone_id', p.home_zone_id,
    'bio', p.bio, 'coi', p.coi, 'karma', p.karma, 'mod_xp', p.mod_xp, 'tier', p.tier,
    'integrity', private.integrity(p.id), 'rater_status', private.effective_rater_status(p),
    'rater_impact', p.rater_impact, 'writer_impact', p.writer_impact,
    'founding_until', p.founding_until, 'writing_locked_until', p.writing_locked_until,
    'needs_onboarding', p.needs_onboarding, 'created_at', p.created_at, 'deleted_at', p.deleted_at,
    'is_admin', private.is_admin(p.id), 'is_self', p.id = v_uid,
    'moderates', coalesce((select jsonb_agg(m.zone_id order by m.zone_id) from public.zone_moderators m where m.user_id = p.id), '[]'::jsonb),
    'account', jsonb_build_object(
      'email_masked', private.mask_email(u.email), 'email_confirmed', u.email_confirmed_at is not null,
      'provider', u.provider,
      'providers', coalesce((select jsonb_agg(distinct i.provider) from auth.identities i where i.user_id = p.id), '[]'::jsonb),
      'last_sign_in_at', u.last_sign_in_at,
      'mfa', exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified')),
    'counts', jsonb_build_object(
      'posts', (select count(*) from public.posts x where x.author_id = p.id),
      'posts_removed', (select count(*) from public.posts x where x.author_id = p.id and x.status = 'removed'),
      'comments', (select count(*) from public.comments x where x.author_id = p.id),
      'comments_removed', (select count(*) from public.comments x where x.author_id = p.id and x.status = 'removed'),
      'notes', (select count(*) from public.notes x where x.author_id = p.id),
      'notes_helpful', (select count(*) from public.notes x where x.author_id = p.id and x.locked_status = 'helpful'),
      'ratings', (select count(*) from public.note_ratings x where x.rater_id = p.id),
      'reports_filed', (select count(*) from public.reports x where x.reporter_id = p.id),
      'reports_actioned', (select count(*) from public.reports x where x.reporter_id = p.id and x.status = 'actioned'),
      'reports_abusive', (select count(*) from public.reports x where x.reporter_id = p.id and x.status = 'abusive'),
      'reports_received_30d', (select count(*) from public.reports r
                                 left join public.posts rp on rp.id = r.post_id
                                 left join public.comments rc on rc.id = r.comment_id
                                where coalesce(rp.author_id, rc.author_id) = p.id and r.created_at > now() - interval '30 days')),
    'signals', (
      select coalesce(jsonb_agg(s), '[]'::jsonb) from (
        select 'new_account_busy' as s
         where p.created_at > now() - interval '7 days'
           and (select count(*) from public.posts x where x.author_id = p.id and x.created_at > now() - interval '24 hours')
             + (select count(*) from public.comments x where x.author_id = p.id and x.created_at > now() - interval '24 hours') >= 10
        union all select 'low_integrity' where private.integrity(p.id) < 50
        union all select 'often_reported' where (
          select count(*) from public.reports r
            left join public.posts rp on rp.id = r.post_id
            left join public.comments rc on rc.id = r.comment_id
           where coalesce(rp.author_id, rc.author_id) = p.id and r.created_at > now() - interval '30 days') >= 3
        union all select 'vote_caps' where (
          select count(*) from public.post_votes v
           where v.voter_id = p.id and not v.counts_for_karma and v.created_at > now() - interval '30 days') >= 10
      ) t),
    'sanctions', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'kind', s.kind, 'reason', s.reason, 'starts_at', s.starts_at,
                                          'ends_at', s.ends_at, 'revoked_at', s.revoked_at,
                                          'issued_by', i.username, 'revoked_by', r.username) order by s.created_at desc)
      from public.sanctions s
      left join public.profiles i on i.id = s.issued_by
      left join public.profiles r on r.id = s.revoked_by
      where s.user_id = p.id), '[]'::jsonb),
    'strikes', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'reason', s.reason, 'points', s.points, 'created_at', s.created_at,
                                          'expires_at', s.expires_at, 'revoked_at', s.revoked_at,
                                          'active', s.revoked_at is null and s.expires_at > now()) order by s.created_at desc)
      from public.strikes s where s.user_id = p.id), '[]'::jsonb),
    'ledger', coalesce((
      select jsonb_agg(jsonb_build_object('track', l.track, 'delta', l.delta, 'reason', l.reason, 'created_at', l.created_at)
                       order by l.created_at desc)
      from (select * from public.ledger_events l where l.user_id = p.id order by l.created_at desc limit 50) l), '[]'::jsonb),
    'actions', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'action', m.action, 'target_kind', m.target_kind, 'target_id', m.target_id,
                                          'reason', m.reason, 'metadata', m.metadata, 'actor', a.username,
                                          'created_at', m.created_at) order by m.created_at desc)
      from (select * from public.mod_actions m where m.target_user_id = p.id order by m.created_at desc limit 50) m
      left join public.profiles a on a.id = m.actor_id), '[]'::jsonb),
    'appeals', coalesce((
      select jsonb_agg(jsonb_build_object('id', ap.id, 'status', ap.status, 'body', ap.body, 'created_at', ap.created_at,
                                          'decision_note', ap.decision_note, 'decided_by', d.username) order by ap.created_at desc)
      from public.appeals ap left join public.profiles d on d.id = ap.decided_by
      where ap.appellant_id = p.id), '[]'::jsonb),
    'staff_notes', coalesce((
      select jsonb_agg(jsonb_build_object('id', n.id, 'label', n.label, 'body', n.body, 'author', a.username,
                                          'created_at', n.created_at) order by n.created_at desc)
      from public.staff_notes n join public.profiles a on a.id = n.author_id
      where n.user_id = p.id), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(t.c order by t.at desc) from (
        select x.created_at as at,
               jsonb_build_object('kind', 'post', 'id', x.id, 'post_id', x.id, 'text', x.title, 'status', x.status,
                                  'zone_id', x.zone_id, 'created_at', x.created_at) as c
          from public.posts x where x.author_id = p.id
        union all
        select x.created_at,
               jsonb_build_object('kind', 'comment', 'id', x.id, 'post_id', x.post_id, 'text', left(x.body, 160),
                                  'status', x.status, 'zone_id', null, 'created_at', x.created_at)
          from public.comments x where x.author_id = p.id
        order by 1 desc
        limit 20) t), '[]'::jsonb),
    'notes_written', coalesce((
      select jsonb_agg(jsonb_build_object('id', n.id, 'post_id', n.post_id, 'post_title', x.title, 'status', n.status,
                                          'locked_status', n.locked_status, 'hidden', n.hidden_at is not null,
                                          'created_at', n.created_at) order by n.created_at desc)
      from (select * from public.notes n where n.author_id = p.id order by n.created_at desc limit 20) n
      join public.posts x on x.id = n.post_id), '[]'::jsonb)
  );
end;
$$;

-- Content search across posts, comments and notes, including removed items.
create function public.admin_content(p_kind text, p_query text, p_status text, p_zone text, p_page integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_user();
  v_q    text := btrim(coalesce(p_query, ''));
  v_page integer := least(greatest(coalesce(p_page, 0), 0), 200);
  v_rows jsonb;
begin
  perform private.require_admin(v_uid);
  v_q := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  if coalesce(p_kind, 'post') = 'post' then
    select coalesce(jsonb_agg(r order by r ->> 'created_at' desc), '[]'::jsonb) into v_rows from (
      select jsonb_build_object(
               'kind', 'post', 'id', p.id, 'post_id', p.id, 'title', p.title, 'excerpt', left(p.body, 200),
               'status', p.status, 'zone_id', p.zone_id, 'category_id', p.category_id, 'author', a.username,
               'created_at', p.created_at, 'pinned', p.pinned_at is not null, 'locked', p.comments_locked_at is not null,
               'removal_reason', p.removal_reason,
               'open_reports', (select count(*) from public.reports r where r.post_id = p.id and r.status = 'open')) as r
      from public.posts p join public.profiles a on a.id = p.author_id
      where (p.title ilike v_q or p.body ilike v_q or a.username ilike v_q)
        and (p_status is null or p.status = p_status)
        and (p_zone is null or p.zone_id = p_zone)
      order by p.created_at desc
      limit 51 offset v_page * 50) t;
  elsif p_kind = 'comment' then
    select coalesce(jsonb_agg(r order by r ->> 'created_at' desc), '[]'::jsonb) into v_rows from (
      select jsonb_build_object(
               'kind', 'comment', 'id', c.id, 'post_id', c.post_id, 'title', p.title, 'excerpt', left(c.body, 200),
               'status', c.status, 'zone_id', p.zone_id, 'author', a.username, 'created_at', c.created_at,
               'removal_reason', c.removal_reason,
               'open_reports', (select count(*) from public.reports r where r.comment_id = c.id and r.status = 'open')) as r
      from public.comments c
      join public.posts p on p.id = c.post_id
      join public.profiles a on a.id = c.author_id
      where (c.body ilike v_q or a.username ilike v_q)
        and (p_status is null or c.status = p_status)
        and (p_zone is null or p.zone_id = p_zone)
      order by c.created_at desc
      limit 51 offset v_page * 50) t;
  elsif p_kind = 'note' then
    select coalesce(jsonb_agg(r order by r ->> 'created_at' desc), '[]'::jsonb) into v_rows from (
      select jsonb_build_object(
               'kind', 'note', 'id', n.id, 'post_id', n.post_id, 'title', p.title, 'excerpt', left(n.body, 200),
               'status', coalesce(n.locked_status, n.status), 'locked', n.locked_at is not null,
               'hidden', n.hidden_at is not null, 'hidden_reason', n.hidden_reason,
               'classification', n.classification, 'zone_id', p.zone_id, 'author', a.username,
               'created_at', n.created_at) as r
      from public.notes n
      join public.posts p on p.id = n.post_id
      join public.profiles a on a.id = n.author_id
      where (n.body ilike v_q or a.username ilike v_q or p.title ilike v_q)
        and (p_status is null or (p_status = 'hidden' and n.hidden_at is not null) or coalesce(n.locked_status, n.status) = p_status)
        and (p_zone is null or p.zone_id = p_zone)
      order by n.created_at desc
      limit 51 offset v_page * 50) t;
  else
    perform private.raise_error('PF422', 'invalid_kind');
  end if;

  return jsonb_build_object(
    'rows', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_rows) e limit 50) t),
    'has_more', jsonb_array_length(v_rows) > 50
  );
end;
$$;

-- The moderation log with who acted (admins only; members never see actors).
create function public.admin_mod_log(p_action text, p_actor text, p_zone text, p_target text, p_before timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.require_admin(v_uid);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', m.id, 'action', m.action, 'target_kind', m.target_kind, 'target_id', m.target_id,
             'target_user', t.username, 'zone_id', m.zone_id, 'reason', m.reason, 'metadata', m.metadata,
             'actor', a.username, 'created_at', m.created_at,
             'appealed', exists (select 1 from public.appeals ap where ap.mod_action_id = m.id),
             'post_id', case m.target_kind when 'post' then m.target_id
                                           when 'comment' then (select c.post_id from public.comments c where c.id = m.target_id)
                                           when 'note' then (select n.post_id from public.notes n where n.id = m.target_id) end)
           order by m.created_at desc)
    from (
      select * from public.mod_actions m
      where (p_action is null or m.action = p_action)
        and (p_zone is null or m.zone_id = p_zone)
        and (p_before is null or m.created_at < p_before)
        and (p_actor is null or m.actor_id = (select x.id from public.profiles x where lower(x.username) = lower(p_actor)))
        and (p_target is null or m.target_user_id = (select x.id from public.profiles x where lower(x.username) = lower(p_target)))
      order by m.created_at desc
      limit 100
    ) m
    left join public.profiles a on a.id = m.actor_id
    left join public.profiles t on t.id = m.target_user_id
  ), '[]'::jsonb);
end;
$$;

-- Admins, moderators (with 30-day performance), founding raters, stewards.
create function public.admin_team()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.require_admin(v_uid);
  return jsonb_build_object(
    'admins', coalesce((
      select jsonb_agg(jsonb_build_object(
               'username', p.username, 'since', r.created_at, 'granted_by', g.username, 'is_self', p.id = v_uid,
               'mfa', exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified'),
               'last_sign_in_at', u.last_sign_in_at,
               'actions_30d', (select count(*) from public.mod_actions m where m.actor_id = p.id and m.created_at > now() - interval '30 days'))
             order by r.created_at)
      from public.user_roles r
      join public.profiles p on p.id = r.user_id
      left join public.profiles g on g.id = r.granted_by
      left join auth.users u on u.id = p.id
      where r.role = 'admin'), '[]'::jsonb),
    'moderators', coalesce((
      select jsonb_agg(jsonb_build_object(
               'zone_id', zm.zone_id, 'username', p.username, 'since', zm.created_at,
               'mfa', exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified'),
               'actions_30d', (select count(*) from public.mod_actions m
                               where m.actor_id = p.id and m.created_at > now() - interval '30 days'),
               'last_action_at', (select max(m.created_at) from public.mod_actions m where m.actor_id = p.id),
               'median_hours', (select round((percentile_cont(0.5) within group (
                                         order by extract(epoch from (r.resolved_at - r.created_at)) / 3600))::numeric, 1)
                                from public.reports r
                                where r.resolved_by = p.id and r.resolved_at > now() - interval '30 days'),
               'decisions_appealed', (select count(*) from public.appeals ap join public.mod_actions m on m.id = ap.mod_action_id
                                      where m.actor_id = p.id and ap.status <> 'open'),
               'decisions_overturned', (select count(*) from public.appeals ap join public.mod_actions m on m.id = ap.mod_action_id
                                        where m.actor_id = p.id and ap.status = 'upheld'))
             order by zm.zone_id, p.username)
      from public.zone_moderators zm join public.profiles p on p.id = zm.user_id), '[]'::jsonb),
    'founding', coalesce((
      select jsonb_agg(jsonb_build_object('username', p.username, 'until', p.founding_until,
                                          'rater_impact', p.rater_impact) order by p.founding_until)
      from public.profiles p
      where p.rater_status = 'founding' and p.founding_until > now() and p.deleted_at is null), '[]'::jsonb),
    'stewards', coalesce((
      select jsonb_agg(jsonb_build_object('username', s.username, 'karma', s.karma, 'mod_xp', s.mod_xp) order by s.karma desc)
      from (select p.username, p.karma, p.mod_xp from public.profiles p
            where p.deleted_at is null and p.karma >= private.cfg_int('gates.steward.min_karma')
              and private.capability_check(p.id, 'steward') is null
            order by p.karma desc limit 50) s), '[]'::jsonb),
    'reports_by_reason_30d', coalesce((
      select jsonb_object_agg(x.reason, x.n) from (
        select r.reason, count(*) as n from public.reports r where r.created_at > now() - interval '30 days' group by r.reason) x),
      '{}'::jsonb),
    'abusive_reports_30d', (select count(*) from public.reports r where r.status = 'abusive' and r.resolved_at > now() - interval '30 days'),
    'resolved_reports_30d', (select count(*) from public.reports r where r.status <> 'open' and r.resolved_at > now() - interval '30 days')
  );
end;
$$;

-- Community-notes pipeline, scoring health and integrity signals.
create function public.admin_notes_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.require_admin(v_uid);
  return jsonb_build_object(
    'open', jsonb_build_object(
      'needs_more_ratings', (select count(*) from public.notes n where n.locked_at is null and n.status = 'needs_more_ratings'),
      'helpful',            (select count(*) from public.notes n where n.locked_at is null and n.status = 'helpful'),
      'not_helpful',        (select count(*) from public.notes n where n.locked_at is null and n.status = 'not_helpful')),
    'locked', jsonb_build_object(
      'helpful',            (select count(*) from public.notes n where n.locked_status = 'helpful'),
      'not_helpful',        (select count(*) from public.notes n where n.locked_status = 'not_helpful'),
      'needs_more_ratings', (select count(*) from public.notes n where n.locked_status = 'needs_more_ratings')),
    'hidden', (select count(*) from public.notes n where n.hidden_at is not null),
    'waiting', coalesce((
      select jsonb_agg(w order by w ->> 'created_at') from (
        select jsonb_build_object('id', n.id, 'post_id', n.post_id, 'post_title', p.title, 'created_at', n.created_at,
                                  'ratings', (select count(*) from public.note_ratings r where r.note_id = n.id and r.weight > 0),
                                  'min_ratings', private.note_min_ratings(n.id)) as w
        from public.notes n join public.posts p on p.id = n.post_id
        where n.locked_at is null and n.status = 'needs_more_ratings'
        order by n.created_at limit 8) t), '[]'::jsonb),
    'recently_locked', coalesce((
      select jsonb_agg(w order by w ->> 'locked_at' desc) from (
        select jsonb_build_object('id', n.id, 'post_id', n.post_id, 'post_title', p.title,
                                  'locked_status', n.locked_status, 'locked_at', n.locked_at, 'hidden', n.hidden_at is not null) as w
        from public.notes n join public.posts p on p.id = n.post_id
        where n.locked_at is not null order by n.locked_at desc limit 8) t), '[]'::jsonb),
    'scoring', jsonb_build_object(
      'mode', private.cfg('scoring.mode') #>> '{}',
      'switch_min_raters', private.cfg_int('scoring.bridging.switch_min_raters'),
      'runs', coalesce((
        select jsonb_agg(jsonb_build_object('at', s.created_at, 'mode', s.mode, 'scored', s.notes_scored,
                                            'transitions', s.transitions, 'locked', s.locked,
                                            'agreement', s.shadow -> 'agreement',
                                            'established_raters', s.shadow -> 'established_raters') order by s.created_at)
        from (select * from public.scoring_runs order by created_at desc limit 30) s), '[]'::jsonb)),
    'raters', jsonb_build_object(
      'probation', (select count(*) from public.profiles p where p.deleted_at is null and private.effective_rater_status(p) = 'probation'),
      'active',    (select count(*) from public.profiles p where p.deleted_at is null and private.effective_rater_status(p) = 'active'),
      'founding',  (select count(*) from public.profiles p where p.deleted_at is null and private.effective_rater_status(p) = 'founding')),
    'writer_locks', coalesce((
      select jsonb_agg(jsonb_build_object('username', p.username, 'until', p.writing_locked_until) order by p.writing_locked_until)
      from public.profiles p where p.writing_locked_until > now()), '[]'::jsonb),
    'strikes_30d', (select count(*) from public.strikes s where s.reason = 'note_misleading' and s.created_at > now() - interval '30 days'),
    'corrections_30d', (select count(*) from public.notes n where n.post_corrected_at > now() - interval '30 days'),
    -- Open notes where at least half the rating weight came from accounts younger than 60 days.
    'young_rater_notes', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'post_id', x.post_id, 'post_title', x.title, 'young_share', x.share))
      from (
        select n.id, n.post_id, p.title,
               round(sum(r.weight) filter (where u.created_at > now() - interval '60 days') / sum(r.weight), 2) as share
        from public.notes n
        join public.posts p on p.id = n.post_id
        join public.note_ratings r on r.note_id = n.id and r.weight > 0
        join auth.users u on u.id = r.rater_id
        where n.locked_at is null
        group by n.id, n.post_id, p.title
        having sum(r.weight) >= 2
           and sum(r.weight) filter (where u.created_at > now() - interval '60 days') >= 0.5 * sum(r.weight)
        limit 20) x), '[]'::jsonb),
    -- Rater pairs who agree almost always over many shared notes (possible sock puppets).
    'lockstep_pairs', coalesce((
      select jsonb_agg(jsonb_build_object('a', pa.username, 'b', pb.username, 'shared', x.shared, 'agreement', x.agreement))
      from (
        select r1.rater_id as a, r2.rater_id as b, count(*) as shared,
               round(avg((r1.value = r2.value)::int)::numeric, 2) as agreement
        from public.note_ratings r1
        join public.note_ratings r2 on r2.note_id = r1.note_id and r2.rater_id > r1.rater_id
        where r1.created_at > now() - interval '90 days'
        group by r1.rater_id, r2.rater_id
        having count(*) >= 15 and avg((r1.value = r2.value)::int) >= 0.95
        order by count(*) desc
        limit 20) x
      join public.profiles pa on pa.id = x.a
      join public.profiles pb on pb.id = x.b), '[]'::jsonb)
  );
end;
$$;

-- Every setting with its range and last change (who, when, why).
create function public.admin_config()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.require_admin(v_uid);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'key', c.key, 'value', c.value, 'description', c.description, 'is_public', c.is_public,
             'bounds', c.bounds, 'updated_at', c.updated_at,
             'last_change', (select jsonb_build_object('by', a.username, 'at', m.created_at, 'reason', m.reason)
                             from public.mod_actions m left join public.profiles a on a.id = m.actor_id
                             where m.action = 'config_change' and m.metadata ->> 'key' = c.key
                             order by m.created_at desc limit 1))
           order by c.key)
    from public.app_config c), '[]'::jsonb);
end;
$$;

create function public.admin_config_history(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.require_admin(v_uid);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'old', m.metadata -> 'old', 'new', m.metadata -> 'new',
                                        'reason', m.reason, 'by', a.username, 'at', m.created_at) order by m.created_at desc)
    from (select * from public.mod_actions m
          where m.action = 'config_change' and m.metadata ->> 'key' = p_key
          order by m.created_at desc limit 50) m
    left join public.profiles a on a.id = m.actor_id), '[]'::jsonb);
end;
$$;

-- Jobs, self-audit, privacy queue, sign-ups by method, busiest accounts.
create function public.admin_system_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.require_admin(v_uid);
  return jsonb_build_object(
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'job', j.job, 'last_at', j.finished_at, 'ok', j.ok, 'summary', j.summary,
               'last_failure_at', (select max(f.finished_at) from public.job_runs f where f.job = j.job and not f.ok),
               'runs_24h', (select count(*) from public.job_runs f where f.job = j.job and f.finished_at > now() - interval '24 hours'),
               'failures_24h', (select count(*) from public.job_runs f where f.job = j.job and not f.ok
                                                                       and f.finished_at > now() - interval '24 hours')))
      from (select distinct on (r.job) r.job, r.finished_at, r.ok, r.summary from public.job_runs r
            order by r.job, r.finished_at desc) j), '[]'::jsonb),
    'last_scoring_run', (select jsonb_build_object('at', s.created_at, 'mode', s.mode, 'scored', s.notes_scored,
                                                   'transitions', s.transitions, 'locked', s.locked)
                         from public.scoring_runs s order by s.created_at desc limit 1),
    'security_audit', coalesce((
      select jsonb_agg(jsonb_build_object('check', a.check_name, 'object', a.object_name, 'detail', a.detail))
      from private.security_audit() a), '[]'::jsonb),
    'staff_without_mfa', coalesce((select jsonb_agg(s.username) from private.staff_without_mfa() s), '[]'::jsonb),
    'deletions', jsonb_build_object(
      'pending', (select count(*) from public.account_deletions d where d.processed_at is null),
      'oldest', (select min(d.requested_at) from public.account_deletions d where d.processed_at is null),
      'processed_30d', (select count(*) from public.account_deletions d where d.processed_at > now() - interval '30 days')),
    'signups_by_provider_30d', coalesce((
      select jsonb_object_agg(x.provider, x.n) from (
        select coalesce(u.raw_app_meta_data ->> 'provider', 'email') as provider, count(*) as n
        from auth.users u where u.created_at > now() - interval '30 days' group by 1) x), '{}'::jsonb),
    'busiest_24h', coalesce((
      select jsonb_agg(jsonb_build_object('username', p.username, 'action', x.action, 'count', x.n) order by x.n desc)
      from (
        select e.user_id, e.action, count(*) as n
        from private.rate_limit_events e where e.created_at > now() - interval '24 hours'
        group by e.user_id, e.action order by count(*) desc limit 15) x
      join public.profiles p on p.id = x.user_id), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Public transparency report (aggregates only; no member data)
-- ---------------------------------------------------------------------------
create function public.transparency_stats(p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_first date := (select date_trunc('month', min(p.created_at))::date from public.posts p);
  v_month date := date_trunc('month', coalesce(p_month, now()::date))::date;
  v_from  timestamptz;
  v_to    timestamptz;
begin
  v_from := v_month::timestamptz;
  v_to   := (v_month + interval '1 month')::timestamptz;
  return jsonb_build_object(
    'month', v_month,
    'months', coalesce((
      select jsonb_agg(m::date order by m desc)
      from generate_series(coalesce(v_first, date_trunc('month', now())::date)::timestamp,
                           date_trunc('month', now())::date::timestamp, interval '1 month') m),
      '[]'::jsonb),
    'removals', coalesce((
      select jsonb_object_agg(x.violation, x.n) from (
        select coalesce(m.metadata ->> 'violation', 'other') as violation, count(*) as n
        from public.mod_actions m where m.action = 'remove' and m.created_at >= v_from and m.created_at < v_to
        group by 1) x), '{}'::jsonb),
    'restored', (select count(*) from public.mod_actions m
                 where m.action in ('restore', 'appeal_upheld') and m.created_at >= v_from and m.created_at < v_to),
    'sanctions', coalesce((
      select jsonb_object_agg(x.kind, x.n) from (
        select s.kind, count(*) as n from public.sanctions s
        where s.created_at >= v_from and s.created_at < v_to and s.issued_by is not null group by s.kind) x), '{}'::jsonb),
    'appeals', jsonb_build_object(
      'filed',  (select count(*) from public.appeals a where a.created_at >= v_from and a.created_at < v_to),
      'upheld', (select count(*) from public.appeals a where a.status = 'upheld' and a.decided_at >= v_from and a.decided_at < v_to),
      'denied', (select count(*) from public.appeals a where a.status = 'denied' and a.decided_at >= v_from and a.decided_at < v_to)),
    'reports', jsonb_build_object(
      'filed',    (select count(*) from public.reports r where r.created_at >= v_from and r.created_at < v_to),
      'actioned', (select count(*) from public.reports r where r.status = 'actioned' and r.resolved_at >= v_from and r.resolved_at < v_to),
      'dismissed', (select count(*) from public.reports r where r.status in ('dismissed', 'abusive')
                                                             and r.resolved_at >= v_from and r.resolved_at < v_to)),
    'collapses', jsonb_build_object(
      'collapsed', (select count(*) from public.mod_actions m where m.action = 'auto_collapse' and m.created_at >= v_from and m.created_at < v_to),
      'reopened',  (select count(*) from public.mod_actions m where m.action = 'auto_uncollapse' and m.created_at >= v_from and m.created_at < v_to)),
    'notes', jsonb_build_object(
      'written', (select count(*) from public.notes n where n.created_at >= v_from and n.created_at < v_to),
      'shown',   (select count(*) from public.notes n where n.first_shown_at >= v_from and n.first_shown_at < v_to),
      'locked_helpful', (select count(*) from public.notes n where n.locked_status = 'helpful' and n.locked_at >= v_from and n.locked_at < v_to),
      'locked_not_helpful', (select count(*) from public.notes n where n.locked_status = 'not_helpful' and n.locked_at >= v_from and n.locked_at < v_to),
      'hidden', (select count(*) from public.notes n where n.hidden_at >= v_from and n.hidden_at < v_to)),
    'held_by_shield', (select count(*) from public.mod_actions m where m.action = 'shield_hold' and m.created_at >= v_from and m.created_at < v_to)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Public reads: pinned posts, locked comments, hidden notes
-- ---------------------------------------------------------------------------
create or replace function private.note_visible(p_note public.notes)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_note.hidden_at is null
     and exists (
       select 1 from public.posts p
       where p.id = p_note.post_id and p.status in ('visible', 'collapsed')
     )
     and (p_note.status = 'helpful' or auth.uid() is not null);
$$;

drop function public.get_feed(text, text, text, text, text, integer, integer);
create function public.get_feed(
  p_zone            text    default null,
  p_category        text    default null,
  p_city            text    default null,
  p_author_username text    default null,
  p_sort            text    default 'hot',
  p_limit           integer default 25,
  p_offset          integer default 0
)
returns table (
  id              uuid,
  title           text,
  excerpt         text,
  post_type       text,
  link_url        text,
  language        text,
  status          text,
  zone_id         text,
  city_id         text,
  category_id     text,
  author_username text,
  author_tier     smallint,
  author_karma    integer,
  score           integer,
  comment_count   integer,
  created_at      timestamptz,
  edited_at       timestamptz,
  my_vote         smallint,
  has_helpful_note boolean,
  has_open_note   boolean,
  pinned          boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.title, left(p.body, 400), p.post_type, p.link_url, p.language, p.status,
         p.zone_id, p.city_id, p.category_id,
         a.username, a.tier, a.karma,
         p.score, p.comment_count, p.created_at, p.edited_at,
         (select v.value from public.post_votes v where v.post_id = p.id and v.voter_id = auth.uid()),
         exists (select 1 from public.notes n where n.post_id = p.id and n.status = 'helpful' and n.hidden_at is null),
         exists (select 1 from public.notes n where n.post_id = p.id and n.status = 'needs_more_ratings'
                                                and n.locked_at is null and n.hidden_at is null),
         -- Pins lead the feed of their own zone (national pins lead the national feed).
         p.pinned_at is not null and p_author_username is null and p_category is null and p_city is null
           and coalesce(nullif(p_zone, ''), 'national') = p.zone_id
  from public.posts p
  join public.profiles a on a.id = p.author_id
  where p.status in ('visible', 'collapsed')
    and (p_zone is null or p_zone = 'national' or p.zone_id = p_zone)
    and (p_category is null or p.category_id = p_category)
    and (p_city is null or p.city_id = p_city)
    and (p_author_username is null or lower(a.username) = lower(p_author_username))
  order by
    (p.pinned_at is not null and p_author_username is null and p_category is null and p_city is null
       and coalesce(nullif(p_zone, ''), 'national') = p.zone_id) desc,
    case p_sort
      when 'new' then extract(epoch from p.created_at)
      when 'top' then p.score::numeric
      else p.score / power(extract(epoch from (now() - p.created_at)) / 3600 + 2, 1.5)
    end desc,
    p.created_at desc
  limit least(greatest(coalesce(p_limit, 25), 1), 50)
  offset least(greatest(coalesce(p_offset, 0), 0), 1000);
$$;

drop function public.get_post(uuid);
create function public.get_post(p_post_id uuid)
returns table (
  id              uuid,
  title           text,
  body            text,
  post_type       text,
  link_url        text,
  language        text,
  status          text,
  removal_reason  text,
  zone_id         text,
  city_id         text,
  category_id     text,
  author_username text,
  author_tier     smallint,
  author_karma    integer,
  is_mine         boolean,
  score           integer,
  comment_count   integer,
  revision        integer,
  created_at      timestamptz,
  edited_at       timestamptz,
  my_vote         smallint,
  can_moderate    boolean,
  pinned          boolean,
  comments_locked boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id,
         case when p.status = 'deleted' then '[deleted post]' else p.title end,
         case when p.status = 'deleted' then '' else p.body end,
         p.post_type, p.link_url, p.language, p.status, p.removal_reason,
         p.zone_id, p.city_id, p.category_id,
         a.username, a.tier, a.karma,
         coalesce(p.author_id = auth.uid(), false),
         p.score, p.comment_count, p.revision, p.created_at, p.edited_at,
         (select v.value from public.post_votes v where v.post_id = p.id and v.voter_id = auth.uid()),
         coalesce(private.is_zone_mod(auth.uid(), p.zone_id) and private.staff_session(), false),
         p.pinned_at is not null,
         p.comments_locked_at is not null
  from public.posts p
  join public.profiles a on a.id = p.author_id
  where p.id = p_post_id
    and (p.status in ('visible', 'collapsed')
         or p.author_id = auth.uid()
         or (private.is_zone_mod(auth.uid(), p.zone_id) and private.staff_session()));
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant execute on function public.get_feed(text, text, text, text, text, integer, integer) to anon, authenticated;
grant execute on function public.get_post(uuid)                                          to anon, authenticated;
grant execute on function public.transparency_stats(date)                                to anon, authenticated;
grant execute on function public.record_job_run(text, timestamptz, boolean, jsonb)       to service_role;

grant execute on function public.admin_restore_content(text, uuid, text)                 to authenticated;
grant execute on function public.admin_set_role(uuid, boolean, text)                     to authenticated;
grant execute on function public.admin_end_founding(uuid, text)                          to authenticated;
grant execute on function public.admin_rename_user(uuid, text, text)                     to authenticated;
grant execute on function public.admin_revoke_strike(uuid, text)                         to authenticated;
grant execute on function public.admin_clear_writing_lock(uuid, text)                    to authenticated;
grant execute on function public.add_staff_note(uuid, text, text)                        to authenticated;
grant execute on function public.admin_find_by_email(text)                               to authenticated;
grant execute on function public.admin_reveal_email(uuid, text)                          to authenticated;
grant execute on function public.admin_set_note_hidden(uuid, boolean, text)              to authenticated;
grant execute on function public.admin_set_pinned(uuid, boolean, text)                   to authenticated;
grant execute on function public.admin_set_comments_locked(uuid, boolean, text)          to authenticated;
grant execute on function public.admin_upsert_category(text, text, text, text, text, text, text[], text[], smallint, smallint, text) to authenticated;
grant execute on function public.admin_archive_category(text, boolean, text)             to authenticated;
grant execute on function public.admin_upsert_city(text, text, text, smallint, text)     to authenticated;
grant execute on function public.admin_update_zone(text, text, text, text, text, text, text) to authenticated;
grant execute on function public.admin_overview()                                        to authenticated;
grant execute on function public.admin_metrics(integer)                                  to authenticated;
grant execute on function public.admin_people(text, text, text, integer)                 to authenticated;
grant execute on function public.admin_member(text)                                      to authenticated;
grant execute on function public.admin_content(text, text, text, text, integer)          to authenticated;
grant execute on function public.admin_mod_log(text, text, text, text, timestamptz)      to authenticated;
grant execute on function public.admin_team()                                            to authenticated;
grant execute on function public.admin_notes_health()                                    to authenticated;
grant execute on function public.admin_config()                                          to authenticated;
grant execute on function public.admin_config_history(text)                              to authenticated;
grant execute on function public.admin_system_status()                                   to authenticated;
