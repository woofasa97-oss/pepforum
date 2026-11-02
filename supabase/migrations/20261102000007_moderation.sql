-- ============================================================================
-- 0007 · Reports, moderation, sanctions, appeals, admin
--
-- Community layer: weighted reports can *collapse* content (never delete it)
-- once enough established, trustworthy members agree. Un-reviewed collapses
-- revert after `reports.collapse_review_hours`.
--
-- Moderator layer: zone moderators (MFA required) remove/restore content,
-- sanction members and decide appeals; every action lands in the append-only
-- mod_actions log. Penalties that bypass community consensus (removal,
-- sourcing) exist only here, and an appeal is decided by a *different*
-- moderator. An upheld appeal reverses karma, strike and freeze through the
-- same reconcile mechanism, so a reversal leaves a complete audit trail.
-- ============================================================================

create table public.reports (
  id                     uuid primary key default gen_random_uuid(),
  reporter_id            uuid         not null references public.profiles (id),
  post_id                uuid references public.posts (id),
  comment_id             uuid references public.comments (id),
  zone_id                text         not null references public.zones (id),  -- denormalised for mod RLS
  reason                 text         not null check (reason in
                           ('sourcing', 'medical_advice', 'harassment', 'misinformation', 'spam', 'before_after', 'wrong_place', 'other')),
  details                text         not null default '' check (char_length(details) <= 500),
  weight                 numeric(3,2) not null check (weight between 0 and 2),
  counts_toward_collapse boolean      not null,
  status                 text         not null default 'open' check (status in ('open', 'actioned', 'dismissed', 'abusive')),
  resolved_by            uuid references public.profiles (id),
  resolved_at            timestamptz,
  created_at             timestamptz  not null default now(),
  check (num_nonnulls(post_id, comment_id) = 1)
);
create unique index reports_unique_post    on public.reports (reporter_id, post_id)    where post_id is not null;
create unique index reports_unique_comment on public.reports (reporter_id, comment_id) where comment_id is not null;
create index reports_open_zone on public.reports (zone_id, created_at) where status = 'open';

create table public.mod_actions (
  id             uuid primary key default gen_random_uuid(),
  actor_id       uuid references public.profiles (id),   -- null = automatic (system)
  action         text not null check (action in (
                   'remove', 'restore', 'auto_collapse', 'auto_uncollapse', 'dismiss_reports',
                   'sanction', 'revoke_sanction', 'grant_founding_rater', 'appoint_moderator',
                   'remove_moderator', 'appeal_upheld', 'appeal_denied', 'config_change')),
  target_kind    text check (target_kind in ('post', 'comment', 'user', 'config', 'appeal', 'sanction')),
  target_id      uuid,
  target_user_id uuid references public.profiles (id),
  zone_id        text references public.zones (id),
  reason         text  not null default '',
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index mod_actions_zone   on public.mod_actions (zone_id, created_at desc);
create index mod_actions_target on public.mod_actions (target_user_id, created_at desc);

create trigger mod_actions_append_only
  before update or delete on public.mod_actions
  for each row execute function private.forbid_mutation();

alter table public.sanctions add column mod_action_id uuid references public.mod_actions (id);

create table public.appeals (
  id            uuid primary key default gen_random_uuid(),
  mod_action_id uuid not null unique references public.mod_actions (id),
  appellant_id  uuid not null references public.profiles (id),
  body          text not null check (char_length(body) between 10 and 2000),
  status        text not null default 'open' check (status in ('open', 'upheld', 'denied')),
  decided_by    uuid references public.profiles (id),
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function private.log_mod_action(
  p_actor uuid, p_action text, p_target_kind text, p_target_id uuid,
  p_target_user uuid, p_zone text, p_reason text, p_metadata jsonb default '{}'::jsonb
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  insert into public.mod_actions (actor_id, action, target_kind, target_id, target_user_id, zone_id, reason, metadata)
  values (p_actor, p_action, p_target_kind, p_target_id, p_target_user, p_zone, coalesce(p_reason, ''), coalesce(p_metadata, '{}'::jsonb))
  returning id;
$$;

-- Resolves (kind, id) → author, zone, status for posts and comments.
create function private.content_target(p_kind text, p_id uuid, out author_id uuid, out zone_id text, out status text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_kind = 'post' then
    select p.author_id, p.zone_id, p.status into author_id, zone_id, status from public.posts p where p.id = p_id;
  elsif p_kind = 'comment' then
    select c.author_id, p.zone_id, c.status into author_id, zone_id, status
    from public.comments c join public.posts p on p.id = c.post_id where c.id = p_id;
  else
    perform private.raise_error('PF422', 'invalid_target');
  end if;
  if author_id is null then
    perform private.raise_error('PF404', 'not_found', p_kind);
  end if;
end;
$$;

create function private.set_content_status(p_kind text, p_id uuid, p_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind = 'post' then
    update public.posts set status = p_status, status_changed_at = now(),
           removal_reason = case when p_status = 'removed' then p_reason end
     where id = p_id;
  else
    update public.comments set status = p_status, status_changed_at = now(),
           removal_reason = case when p_status = 'removed' then p_reason end
     where id = p_id;
  end if;
end;
$$;

create function private.require_zone_mod(p_user uuid, p_zone text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  perform private.require_aal2();
  if not private.is_zone_mod(p_user, p_zone) then
    perform private.raise_error('PF403', 'not_moderator', p_zone);
  end if;
end;
$$;

create function private.require_admin(p_user uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  perform private.require_aal2();
  if not private.is_admin(p_user) then
    perform private.raise_error('PF403', 'not_admin');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Community reports
-- ---------------------------------------------------------------------------
create function public.file_report(p_target_kind text, p_target_id uuid, p_reason text, p_details text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := private.require_user();
  v_target     record;
  v_created    timestamptz;
  v_weight     numeric;
  v_counts     boolean;
  v_sum        numeric;
  v_reporters  integer;
  v_author_tier smallint;
  v_collapsed  boolean := false;
begin
  perform private.require_capability(v_uid, 'report');
  perform private.enforce_rate_limit(v_uid, 'report');

  select * into v_target from private.content_target(p_target_kind, p_target_id);
  if v_target.status not in ('visible', 'collapsed') then
    perform private.raise_error('PF404', 'not_found', p_target_kind);
  end if;
  if v_target.author_id = v_uid then
    perform private.raise_error('PF403', 'own_content');
  end if;
  if p_reason is null or p_reason not in ('sourcing', 'medical_advice', 'harassment', 'misinformation', 'spam', 'before_after', 'wrong_place', 'other') then
    perform private.raise_error('PF422', 'invalid_reason');
  end if;
  if char_length(coalesce(p_details, '')) > 500 then
    perform private.raise_error('PF422', 'invalid_details');
  end if;

  select u.created_at into v_created from auth.users u where u.id = v_uid;
  -- Weight 0.5–1.5 by integrity: members with a clean record count for more.
  v_weight := round(0.5 + private.integrity(v_uid) / 100.0, 2);
  v_counts := v_created <= now() - make_interval(days => private.cfg_int('reports.min_account_days'));

  begin
    insert into public.reports (reporter_id, post_id, comment_id, zone_id, reason, details, weight, counts_toward_collapse)
    values (v_uid,
            case when p_target_kind = 'post' then p_target_id end,
            case when p_target_kind = 'comment' then p_target_id end,
            v_target.zone_id, p_reason, coalesce(p_details, ''), v_weight, v_counts);
  exception when unique_violation then
    perform private.raise_error('PF409', 'already_reported');
  end;

  if v_target.status = 'visible' then
    select coalesce(sum(r.weight), 0), count(distinct r.reporter_id)
      into v_sum, v_reporters
    from public.reports r
    where r.status = 'open' and r.counts_toward_collapse
      and (r.post_id = p_target_id or r.comment_id = p_target_id);

    select p.tier into v_author_tier from public.profiles p where p.id = v_target.author_id;

    if v_sum >= private.cfg_num('reports.collapse_weight')
       and v_reporters >= private.cfg_int('reports.collapse_min_reporters')
       and (
         v_author_tier < private.cfg_int('reports.steward_required_tier')
         or exists (
           select 1 from public.reports r
           where r.status = 'open' and (r.post_id = p_target_id or r.comment_id = p_target_id)
             and private.has_capability(r.reporter_id, 'steward')
         )
       ) then
      perform private.set_content_status(p_target_kind, p_target_id, 'collapsed');
      perform private.log_mod_action(null, 'auto_collapse', p_target_kind, p_target_id, v_target.author_id,
                                     v_target.zone_id, 'community reports',
                                     jsonb_build_object('weight', v_sum, 'reporters', v_reporters));
      v_collapsed := true;
    end if;
  end if;

  return jsonb_build_object('collapsed', v_collapsed);
end;
$$;

-- Reverts collapses no moderator reviewed in time (service_role, worker).
create function public.expire_stale_collapses()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row   record;
  v_count integer := 0;
  v_cutoff timestamptz := now() - make_interval(hours => private.cfg_int('reports.collapse_review_hours'));
begin
  for v_row in
    select 'post' as kind, p.id, p.author_id, p.zone_id from public.posts p
     where p.status = 'collapsed' and p.status_changed_at < v_cutoff
    union all
    select 'comment', c.id, c.author_id, p.zone_id from public.comments c join public.posts p on p.id = c.post_id
     where c.status = 'collapsed' and c.status_changed_at < v_cutoff
  loop
    perform private.set_content_status(v_row.kind, v_row.id, 'visible');
    perform private.log_mod_action(null, 'auto_uncollapse', v_row.kind, v_row.id, v_row.author_id, v_row.zone_id,
                                   'collapse expired without moderator review');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Moderator actions
-- ---------------------------------------------------------------------------

-- p_violation drives the penalty: 'sourcing' is the harshest (vendors and
-- supply are the platform's hard line); everything else is a standard removal.
create function private.remove_content(p_actor uuid, p_kind text, p_id uuid, p_violation text, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target record;
  v_action uuid;
  v_karma  integer;
begin
  select * into v_target from private.content_target(p_kind, p_id);
  if v_target.status = 'removed' then
    perform private.raise_error('PF409', 'already_removed');
  end if;

  perform private.set_content_status(p_kind, p_id, 'removed', p_violation);
  v_action := private.log_mod_action(p_actor, 'remove', p_kind, p_id, v_target.author_id, v_target.zone_id,
                                     p_reason, jsonb_build_object('violation', p_violation));

  v_karma := case when p_violation = 'sourcing'
                  then private.cfg_int('moderation.sourcing_penalty_karma')
                  else private.cfg_int('moderation.removal_penalty_karma') end;
  perform private.reconcile('removal:' || p_id, v_target.author_id, 'karma', 'mod_removal', p_kind, p_id, v_karma);

  insert into public.strikes (user_id, reason, points, source_kind, source_id, expires_at)
  values (v_target.author_id,
          case when p_violation = 'sourcing' then 'sourcing' else 'mod_removal' end,
          case when p_violation = 'sourcing' then private.cfg_int('strikes.sourcing_points')
               else private.cfg_int('strikes.mod_removal_points') end,
          p_kind, p_id, now() + make_interval(days => private.cfg_int('strikes.duration_days')))
  on conflict (user_id, reason, source_kind, source_id) do nothing;

  insert into public.sanctions (user_id, kind, reason, issued_by, ends_at, mod_action_id)
  values (v_target.author_id, 'freeze', 'Automatic freeze after content removal: ' || p_violation, p_actor,
          now() + make_interval(days => private.cfg_int('moderation.removal_freeze_days')), v_action);

  return v_action;
end;
$$;

-- Decide every open report on one piece of content at once.
--   p_decision 'remove': content removed (penalties apply); reports actioned (+XP to reporters)
--   p_decision 'keep':   content stays/uncollapses; reports dismissed (no penalty) —
--                         except ids in p_abusive_report_ids, which cost the reporter XP.
create function public.resolve_reports(
  p_target_kind        text,
  p_target_id          uuid,
  p_decision           text,
  p_violation          text default null,
  p_reason             text default '',
  p_abusive_report_ids uuid[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_user();
  v_target record;
  v_action uuid;
  v_report record;
begin
  select * into v_target from private.content_target(p_target_kind, p_target_id);
  perform private.require_zone_mod(v_uid, v_target.zone_id);
  if v_target.author_id = v_uid then
    perform private.raise_error('PF403', 'conflict_of_interest');
  end if;

  if p_decision = 'remove' then
    if p_violation is null or p_violation not in ('sourcing', 'medical_advice', 'harassment', 'misinformation', 'spam', 'before_after', 'other') then
      perform private.raise_error('PF422', 'invalid_violation');
    end if;
    v_action := private.remove_content(v_uid, p_target_kind, p_target_id, p_violation, p_reason);
  elsif p_decision = 'keep' then
    if v_target.status = 'collapsed' then
      perform private.set_content_status(p_target_kind, p_target_id, 'visible');
    end if;
    v_action := private.log_mod_action(v_uid, 'dismiss_reports', p_target_kind, p_target_id, v_target.author_id,
                                       v_target.zone_id, p_reason);
  else
    perform private.raise_error('PF422', 'invalid_decision');
  end if;

  for v_report in
    select r.id, r.reporter_id from public.reports r
    where r.status = 'open' and (r.post_id = p_target_id or r.comment_id = p_target_id)
    for update
  loop
    if p_decision = 'remove' then
      update public.reports set status = 'actioned', resolved_by = v_uid, resolved_at = now() where id = v_report.id;
      -- A moderator acting on their own report earns nothing for it.
      perform private.reconcile('report:' || v_report.id, v_report.reporter_id, 'mod_xp', 'report_upheld',
                                'report', v_report.id,
                                case when v_report.reporter_id = v_uid then 0 else private.cfg_num('reports.upheld_xp') end);
    elsif v_report.id = any (p_abusive_report_ids) then
      update public.reports set status = 'abusive', resolved_by = v_uid, resolved_at = now() where id = v_report.id;
      perform private.reconcile('report:' || v_report.id, v_report.reporter_id, 'mod_xp', 'report_abusive',
                                'report', v_report.id, private.cfg_num('reports.abusive_xp'));
    else
      update public.reports set status = 'dismissed', resolved_by = v_uid, resolved_at = now() where id = v_report.id;
    end if;
  end loop;

  return v_action;
end;
$$;

-- Removal without a report (e.g. a moderator spots sourcing while browsing).
create function public.moderate_remove(p_target_kind text, p_target_id uuid, p_violation text, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.resolve_reports(p_target_kind, p_target_id, 'remove', p_violation, p_reason, '{}');
end;
$$;

create function public.apply_sanction(p_user uuid, p_kind text, p_reason text, p_days integer default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := private.require_user();
  v_action   uuid;
  v_sanction uuid;
begin
  perform private.require_aal2();
  if not private.is_moderator(v_uid) then
    perform private.raise_error('PF403', 'not_moderator');
  end if;
  if p_kind in ('suspension', 'ban') and not private.is_admin(v_uid) then
    perform private.raise_error('PF403', 'not_admin');
  end if;
  if p_kind is null or p_kind not in ('warning', 'freeze', 'suspension', 'ban') then
    perform private.raise_error('PF422', 'invalid_sanction');
  end if;
  if p_user = v_uid or private.is_admin(p_user) then
    perform private.raise_error('PF403', 'conflict_of_interest');
  end if;
  if char_length(coalesce(p_reason, '')) not between 3 and 500 then
    perform private.raise_error('PF422', 'reason_required');
  end if;
  if p_kind in ('freeze', 'suspension') and (p_days is null or p_days not between 1 and 365) then
    perform private.raise_error('PF422', 'duration_required');
  end if;

  v_action := private.log_mod_action(v_uid, 'sanction', 'user', p_user, p_user, null, p_reason,
                                     jsonb_build_object('kind', p_kind, 'days', p_days));

  insert into public.sanctions (user_id, kind, reason, issued_by, ends_at, mod_action_id)
  values (p_user, p_kind, p_reason, v_uid,
          case when p_days is not null then now() + make_interval(days => p_days) end, v_action)
  returning id into v_sanction;

  if p_kind <> 'warning' then
    insert into public.strikes (user_id, reason, points, source_kind, source_id, expires_at)
    values (p_user, 'sanction', private.cfg_int('strikes.sanction_points'), 'sanction', v_sanction,
            now() + make_interval(days => private.cfg_int('strikes.duration_days')))
    on conflict do nothing;
  end if;

  return v_sanction;
end;
$$;

create function public.revoke_sanction(p_sanction_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  s     public.sanctions;
begin
  perform private.require_aal2();
  select * into s from public.sanctions where id = p_sanction_id for update;
  if not found or s.revoked_at is not null then
    perform private.raise_error('PF404', 'not_found', 'sanction');
  end if;
  -- Nobody lifts their own sanction (that's what appeals are for). Admins may
  -- revoke anything else; a moderator may only undo a warning or freeze they
  -- issued themselves.
  if s.user_id = v_uid then
    perform private.raise_error('PF403', 'conflict_of_interest');
  end if;
  if not (private.is_admin(v_uid)
          or (private.is_moderator(v_uid) and s.kind in ('warning', 'freeze') and s.issued_by = v_uid)) then
    perform private.raise_error('PF403', 'not_allowed');
  end if;

  update public.sanctions set revoked_at = now(), revoked_by = v_uid where id = p_sanction_id;
  update public.strikes set revoked_at = now()
   where source_kind = 'sanction' and source_id = p_sanction_id and revoked_at is null;
  perform private.log_mod_action(v_uid, 'revoke_sanction', 'sanction', p_sanction_id, s.user_id, null, p_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Appeals — decided by a different moderator than the one who acted
-- ---------------------------------------------------------------------------
create function public.submit_appeal(p_mod_action_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  a     public.mod_actions;
  v_id  uuid;
begin
  perform private.enforce_rate_limit(v_uid, 'appeal');
  select * into a from public.mod_actions where id = p_mod_action_id;
  if not found or a.target_user_id is distinct from v_uid or a.action not in ('remove', 'sanction') then
    perform private.raise_error('PF404', 'not_found', 'mod_action');
  end if;
  if a.created_at < now() - make_interval(days => private.cfg_int('moderation.appeal_window_days')) then
    perform private.raise_error('PF409', 'appeal_window_closed');
  end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 10 and 2000 then
    perform private.raise_error('PF422', 'invalid_body');
  end if;

  begin
    insert into public.appeals (mod_action_id, appellant_id, body)
    values (p_mod_action_id, v_uid, btrim(p_body)) returning id into v_id;
  exception when unique_violation then
    perform private.raise_error('PF409', 'already_appealed');
  end;
  return v_id;
end;
$$;

create function public.decide_appeal(p_appeal_id uuid, p_uphold boolean, p_note text)
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
      perform private.set_content_status(a.target_kind, a.target_id, 'visible');
      perform private.reconcile('removal:' || a.target_id, a.target_user_id, 'karma', 'appeal_reversal',
                                a.target_kind, a.target_id, 0);
      update public.strikes set revoked_at = now()
       where user_id = a.target_user_id and source_id = a.target_id and revoked_at is null;
      update public.sanctions set revoked_at = now(), revoked_by = v_uid
       where mod_action_id = a.id and revoked_at is null;
      -- Reporters were paid for a removal that turned out wrong: take it back.
      perform private.reconcile('report:' || r.id, r.reporter_id, 'mod_xp', 'appeal_reversal', 'report', r.id, 0)
      from public.reports r
      where r.status = 'actioned' and (r.post_id = a.target_id or r.comment_id = a.target_id);
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

-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------

-- Founding raters carry the notes system at launch, before anyone has earned
-- rater impact. The grant expires and is logged.
create function public.grant_founding_rater(p_user uuid, p_until timestamptz, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.require_admin(v_uid);
  if p_until is null or p_until <= now() or p_until > now() + interval '366 days' then
    perform private.raise_error('PF422', 'invalid_expiry');
  end if;
  update public.profiles set rater_status = 'founding', founding_until = p_until
   where id = p_user and deleted_at is null;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'profile');
  end if;
  perform private.log_mod_action(v_uid, 'grant_founding_rater', 'user', p_user, p_user, null, p_reason,
                                 jsonb_build_object('until', p_until));
end;
$$;

create function public.set_zone_moderator(p_user uuid, p_zone text, p_appoint boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.require_admin(v_uid);
  if p_appoint then
    insert into public.zone_moderators (zone_id, user_id, appointed_by) values (p_zone, p_user, v_uid)
    on conflict do nothing;
  else
    delete from public.zone_moderators where zone_id = p_zone and user_id = p_user;
  end if;
  perform private.log_mod_action(v_uid, case when p_appoint then 'appoint_moderator' else 'remove_moderator' end,
                                 'user', p_user, p_user, p_zone, p_reason);
end;
$$;

create function public.admin_set_config(p_key text, p_value jsonb, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_old jsonb;
begin
  perform private.require_admin(v_uid);
  select value into v_old from public.app_config where key = p_key for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', p_key);
  end if;
  if p_value is null or jsonb_typeof(v_old) <> jsonb_typeof(p_value) then
    perform private.raise_error('PF422', 'config_type_mismatch', p_key);
  end if;
  if char_length(coalesce(p_reason, '')) < 3 then
    perform private.raise_error('PF422', 'reason_required');
  end if;
  update public.app_config set value = p_value where key = p_key;
  perform private.log_mod_action(v_uid, 'config_change', 'config', null, null, null, p_reason,
                                 jsonb_build_object('key', p_key, 'old', v_old, 'new', p_value));
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS & grants
-- ---------------------------------------------------------------------------
alter table public.reports     enable row level security;
alter table public.mod_actions enable row level security;
alter table public.appeals     enable row level security;

-- Staff reads require an MFA session (private.staff_session), like staff writes.
create policy reports_self_or_zone_mod_read on public.reports
  for select to authenticated
  using (reporter_id = auth.uid() or (private.is_zone_mod(auth.uid(), zone_id) and private.staff_session()));

-- Moderators see the whole log; members see actions taken on them.
create policy mod_actions_mod_or_target_read on public.mod_actions
  for select to authenticated
  using ((private.is_moderator(auth.uid()) and private.staff_session()) or target_user_id = auth.uid());

create policy appeals_self_or_mod_read on public.appeals
  for select to authenticated
  using (appellant_id = auth.uid() or (private.is_moderator(auth.uid()) and private.staff_session()));

create policy app_config_history_admin_read on public.app_config_history
  for select to authenticated using (private.is_admin(auth.uid()) and private.staff_session());

grant select on public.reports, public.app_config_history to authenticated;
-- Which moderator acted is withheld from direct reads (anti-retaliation);
-- moderators see it through mod_queue()/open_appeals().
grant select (id, action, target_kind, target_id, target_user_id, zone_id, reason, metadata, created_at)
  on public.mod_actions to authenticated;
grant select (id, mod_action_id, appellant_id, body, status, decided_at, decision_note, created_at)
  on public.appeals to authenticated;

grant execute on function public.file_report(text, uuid, text, text)                        to authenticated;
grant execute on function public.resolve_reports(text, uuid, text, text, text, uuid[])      to authenticated;
grant execute on function public.moderate_remove(text, uuid, text, text)                    to authenticated;
grant execute on function public.apply_sanction(uuid, text, text, integer)                  to authenticated;
grant execute on function public.revoke_sanction(uuid, text)                                to authenticated;
grant execute on function public.submit_appeal(uuid, text)                                  to authenticated;
grant execute on function public.decide_appeal(uuid, boolean, text)                         to authenticated;
grant execute on function public.grant_founding_rater(uuid, timestamptz, text)              to authenticated;
grant execute on function public.set_zone_moderator(uuid, text, boolean, text)              to authenticated;
grant execute on function public.admin_set_config(text, jsonb, text)                        to authenticated;
grant execute on function public.expire_stale_collapses()                                   to service_role;
