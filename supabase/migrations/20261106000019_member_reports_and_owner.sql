-- Member reports, the site owner, and admins at the top of the progression.
--
-- 1. Members can report another member (harassment, selling, impersonation,
--    ban evasion, …), not only a post or comment. These reports are tickets
--    for admins: private, never collapse anything, and resolved once per
--    reported member from Admin → Member reports.
-- 2. The site owner: one admin who alone adds and removes admins. If exactly
--    one admin exists when this runs, they become the owner; otherwise see
--    docs/DEPLOYMENT.md, "Bootstrap staff".
-- 3. Admins pass every karma gate (posting, links, rating and writing notes,
--    Steward) and their content gets the top tier's report protection. Their
--    karma stays what the community gave them: nothing touches the ledger
--    (ADR-0006).
-- See docs/ADMIN.md and docs/SELF_MODERATION.md.

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
  'lookup_email', 'reveal_email',
  'link_hold', 'link_approved', 'link_declined', 'site_approved', 'site_unapproved',
  'member_reports_actioned', 'member_reports_dismissed'));

-- ---------------------------------------------------------------------------
-- The site owner
-- ---------------------------------------------------------------------------
alter table public.user_roles drop constraint user_roles_role_check;
alter table public.user_roles add constraint user_roles_role_check check (role in ('admin', 'owner'));
create unique index user_roles_one_owner on public.user_roles (role) where role = 'owner';

-- The owner is also an admin; an 'owner' row on its own grants nothing.
create function private.is_owner(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null
     and exists (select 1 from public.user_roles r where r.user_id = p_user and r.role = 'owner')
     and private.is_admin(p_user);
$$;

-- The one admin there is today becomes the owner.
insert into public.user_roles (user_id, role)
select r.user_id, 'owner' from public.user_roles r
 where r.role = 'admin'
   and (select count(*) from public.user_roles x where x.role = 'admin') = 1
   and not exists (select 1 from public.user_roles x where x.role = 'owner');

create or replace function public.admin_set_role(p_user uuid, p_admin boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
begin
  -- Only the site owner hands out or takes away admin.
  if not private.is_owner(v_uid) then
    perform private.raise_error('PF403', 'owner_only');
  end if;
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

-- ---------------------------------------------------------------------------
-- Admins at the top of the progression
-- ---------------------------------------------------------------------------
create or replace function private.capability_check(p_user uuid, p_capability text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p           public.profiles;
  v_auth      record;
  v_integrity integer;
  v_status    text;
  v_frozen    boolean;
begin
  if p_user is null then
    return 'not_authenticated';
  end if;

  select * into p from public.profiles where id = p_user;
  if not found or p.deleted_at is not null then
    return 'no_profile';
  end if;

  -- Social sign-ups must pick a username and confirm their age first.
  if p.needs_onboarding then
    return 'onboarding';
  end if;

  select u.email_confirmed_at, u.phone_confirmed_at, u.created_at
    into v_auth
  from auth.users u where u.id = p_user;

  if v_auth.email_confirmed_at is null then
    return 'email_unconfirmed';
  end if;

  if private.has_active_sanction(p_user, array['suspension', 'ban']) then
    return 'sanctioned';
  end if;

  if p_capability in ('vote', 'comment', 'report') then
    return null;
  end if;

  -- Admins run the forum: every karma, integrity and account-age gate is open
  -- to them. Their karma itself is untouched (ADR-0006).
  if private.is_admin(p_user)
     and p_capability in ('post_text', 'post_link', 'rate_notes', 'write_notes', 'steward') then
    return null;
  end if;

  v_integrity := private.integrity(p_user);
  v_frozen    := private.has_active_sanction(p_user, array['freeze']);
  v_status    := private.effective_rater_status(p);

  case p_capability
    when 'post_text', 'post_link' then
      if v_frozen then return 'frozen'; end if;
      if v_integrity < private.cfg_int('gates.posting.min_integrity') then
        return 'integrity:' || private.cfg_int('gates.posting.min_integrity');
      end if;
      if p.tier < private.cfg_int('gates.post_text.min_tier') then
        return 'tier:' || private.cfg_int('gates.post_text.min_tier');
      end if;
      if p_capability = 'post_link' and p.tier < private.cfg_int('gates.post_link.min_tier') then
        return 'tier:' || private.cfg_int('gates.post_link.min_tier');
      end if;
      return null;

    when 'rate_notes', 'write_notes' then
      if v_frozen then return 'frozen'; end if;
      if v_integrity < private.cfg_int('gates.rate_notes.min_integrity') then
        return 'integrity:' || private.cfg_int('gates.rate_notes.min_integrity');
      end if;
      if v_status <> 'founding' then
        if p.tier < private.cfg_int('gates.rate_notes.min_tier') then
          return 'tier:' || private.cfg_int('gates.rate_notes.min_tier');
        end if;
        if v_auth.created_at > now() - make_interval(days => private.cfg_int('gates.rate_notes.min_account_days')) then
          return 'account_age:' || private.cfg_int('gates.rate_notes.min_account_days');
        end if;
        if private.cfg_bool('gates.rate_notes.require_phone') and v_auth.phone_confirmed_at is null then
          return 'phone_unconfirmed';
        end if;
      end if;
      if p_capability = 'rate_notes' then
        return null;
      end if;

      -- Writing: proven rating accuracy (graduated from probation) on top of karma.
      if p.writing_locked_until is not null and p.writing_locked_until > now() then
        return 'writing_locked';
      end if;
      if v_integrity < private.cfg_int('gates.write_notes.min_integrity') then
        return 'integrity:' || private.cfg_int('gates.write_notes.min_integrity');
      end if;
      if v_status <> 'founding' then
        if p.tier < private.cfg_int('gates.write_notes.min_tier') then
          return 'tier:' || private.cfg_int('gates.write_notes.min_tier');
        end if;
        if v_status <> 'active' then
          return 'rater_impact:' || private.cfg_int('notes.graduation_impact');
        end if;
      end if;
      return null;

    when 'steward' then
      if p.karma < private.cfg_int('gates.steward.min_karma') then
        return 'karma:' || private.cfg_int('gates.steward.min_karma');
      end if;
      if p.mod_xp < private.cfg_num('gates.steward.min_mod_xp') then
        return 'mod_xp:' || private.cfg_num('gates.steward.min_mod_xp');
      end if;
      if v_integrity < private.cfg_int('gates.steward.min_integrity') then
        return 'integrity:' || private.cfg_int('gates.steward.min_integrity');
      end if;
      return null;

    else
      return 'unknown_capability';
  end case;
end;
$$;

create or replace function public.create_post(
  p_zone_id     text,
  p_category_id text,
  p_post_type   text,
  p_title       text,
  p_body        text,
  p_link_url    text default null,
  p_city_id     text default null,
  p_language    text default 'en'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := private.require_user();
  v_title text := btrim(coalesce(p_title, ''));
  v_body  text := btrim(coalesce(p_body, ''));
  v_link  text := nullif(btrim(coalesce(p_link_url, '')), '');
  v_id    uuid;
begin
  perform private.require_capability(v_uid, case when v_link is null then 'post_text' else 'post_link' end);
  perform private.enforce_rate_limit(v_uid, 'post');
  if (select p.tier from public.profiles p where p.id = v_uid) = 0 and not private.is_admin(v_uid) then
    perform private.enforce_rate_limit(v_uid, 'post_newcomer');
  end if;
  if private.integrity(v_uid) < private.cfg_int('gates.posting.cooldown_integrity') then
    perform private.enforce_rate_limit(v_uid, 'post_low_integrity');
  end if;

  if not exists (select 1 from public.zones z where z.id = p_zone_id) then
    perform private.raise_error('PF422', 'invalid_zone');
  end if;
  if not exists (select 1 from public.categories c where c.id = p_category_id and c.archived_at is null) then
    perform private.raise_error('PF422', 'invalid_category');
  end if;
  if p_city_id is not null and not exists (
    select 1 from public.cities c where c.id = p_city_id and c.zone_id = p_zone_id
  ) then
    perform private.raise_error('PF422', 'invalid_city');
  end if;
  if p_post_type is null or p_post_type not in ('experience', 'claim', 'question', 'resource') then
    perform private.raise_error('PF422', 'invalid_post_type');
  end if;
  if char_length(v_title) not between 8 and 140 then
    perform private.raise_error('PF422', 'invalid_title');
  end if;
  if char_length(v_body) > 10000 or (p_post_type <> 'resource' and char_length(v_body) < 1) then
    perform private.raise_error('PF422', 'invalid_body');
  end if;
  if p_post_type = 'resource' and v_link is null then
    perform private.raise_error('PF422', 'link_required');
  end if;
  if p_language is null or p_language not in ('en', 'fr') then
    perform private.raise_error('PF422', 'invalid_language');
  end if;

  insert into public.posts (author_id, zone_id, city_id, category_id, post_type, title, body, link_url, language)
  values (v_uid, p_zone_id, p_city_id, p_category_id, p_post_type, v_title, v_body, v_link, p_language)
  returning id into v_id;

  insert into public.post_revisions (post_id, revision, title, body, link_url)
  values (v_id, 1, v_title, v_body, v_link);

  return v_id;
end;
$$;

create or replace function public.file_report(p_target_kind text, p_target_id uuid, p_reason text, p_details text default '')
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

    -- Admins' content gets the top tier's protection.
    select case when private.is_admin(p.id) then 4 else p.tier end into v_author_tier
      from public.profiles p where p.id = v_target.author_id;

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

-- Profiles say who the admins are, as they already say who moderates a zone.
create or replace function public.get_profile(p_username text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'username',      p.username,
    'bio',           p.bio,
    'coi',           p.coi,
    'home_zone_id',  p.home_zone_id,
    'karma',         p.karma,
    'tier',          p.tier,
    -- Moderation-track numbers move when notes settle; publishing them would
    -- unmask pseudonymous writers and reveal how raters voted. Owner only.
    'mod_xp',        case when p.id = auth.uid() then p.mod_xp end,
    'rater_status',  case when p.id = auth.uid() then private.effective_rater_status(p) end,
    'rater_impact',  case when p.id = auth.uid() then p.rater_impact end,
    'writer_impact', case when p.id = auth.uid() then p.writer_impact end,
    'joined_at',     p.created_at,
    'deleted',       p.deleted_at is not null,
    'is_me',         coalesce(p.id = auth.uid(), false),
    'is_admin',      private.is_admin(p.id),
    'moderates',     coalesce((select jsonb_agg(m.zone_id) from public.zone_moderators m where m.user_id = p.id), '[]'::jsonb),
    'post_count',    (select count(*) from public.posts x where x.author_id = p.id and x.status in ('visible', 'collapsed')),
    'comment_count', (select count(*) from public.comments x where x.author_id = p.id and x.status in ('visible', 'collapsed'))
  )
  from public.profiles p
  where lower(p.username) = lower(p_username);
$$;

-- ---------------------------------------------------------------------------
-- Member reports
-- ---------------------------------------------------------------------------
create table public.member_reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (id),
  reported_id uuid not null references public.profiles (id),
  reason      text not null check (reason in ('harassment', 'sourcing', 'spam', 'impersonation', 'ban_evasion', 'privacy', 'underage', 'other')),
  details     text not null default '' check (char_length(details) <= 1000),
  status      text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  resolved_by uuid references public.profiles (id),
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  check (reporter_id <> reported_id),
  check ((status = 'open') = (resolved_at is null))
);
-- One open report per reporter and member; they can report again once it's resolved.
create unique index member_reports_one_open on public.member_reports (reporter_id, reported_id) where status = 'open';
create index member_reports_open on public.member_reports (reported_id, created_at) where status = 'open';

-- Admins read it through admin_member_reports(); nobody gets table access.
alter table public.member_reports enable row level security;

insert into public.app_config (key, value, is_public, description) values
  ('rate_limit.report_member', '{"limit": 5, "window_seconds": 86400}', false,
   'Members one person can report per day.');

create function public.report_member(p_username text, p_reason text, p_details text default '')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_user();
  v_target uuid;
begin
  perform private.require_capability(v_uid, 'report');
  perform private.enforce_rate_limit(v_uid, 'report_member');

  select p.id into v_target from public.profiles p
   where lower(p.username) = lower(btrim(coalesce(p_username, ''))) and p.deleted_at is null;
  if v_target is null then
    perform private.raise_error('PF404', 'not_found', 'profile');
  end if;
  if v_target = v_uid then
    perform private.raise_error('PF422', 'report_self');
  end if;
  if p_reason is null or p_reason not in ('harassment', 'sourcing', 'spam', 'impersonation', 'ban_evasion', 'privacy', 'underage', 'other') then
    perform private.raise_error('PF422', 'invalid_reason');
  end if;
  if char_length(btrim(coalesce(p_details, ''))) > 1000 then
    perform private.raise_error('PF422', 'invalid_details');
  end if;

  begin
    insert into public.member_reports (reporter_id, reported_id, reason, details)
    values (v_uid, v_target, p_reason, btrim(coalesce(p_details, '')));
  exception when unique_violation then
    perform private.raise_error('PF409', 'already_reported');
  end;
end;
$$;

-- Open reports grouped per reported member, oldest first, plus recent decisions.
create function public.admin_member_reports()
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
    'open', coalesce((
      select jsonb_agg(g.item order by g.oldest)
      from (
        select min(r.created_at) as oldest,
               jsonb_build_object(
                 'username',        p.username,
                 'tier',            p.tier,
                 'karma',           p.karma,
                 'integrity',       private.integrity(p.id),
                 'joined',          p.created_at,
                 'is_admin',        private.is_admin(p.id),
                 'is_self',         p.id = v_uid,
                 'sanction',        case when private.has_active_sanction(p.id, array['ban']) then 'ban'
                                         when private.has_active_sanction(p.id, array['suspension']) then 'suspension'
                                         when private.has_active_sanction(p.id, array['freeze']) then 'freeze' end,
                 'strikes',         (select count(*) from public.strikes s
                                      where s.user_id = p.id and s.revoked_at is null and s.expires_at > now()),
                 'actioned_before', (select count(distinct x.resolved_at) from public.member_reports x
                                      where x.reported_id = p.id and x.status = 'actioned'),
                 'oldest',          min(r.created_at),
                 'reports',         jsonb_agg(jsonb_build_object(
                                      'id', r.id, 'reason', r.reason, 'details', r.details, 'created_at', r.created_at,
                                      'reporter', rp.username, 'reporter_integrity', private.integrity(rp.id),
                                      'reporter_joined', rp.created_at)
                                    order by r.created_at)) as item
        from public.member_reports r
        join public.profiles p  on p.id = r.reported_id
        join public.profiles rp on rp.id = r.reporter_id
        where r.status = 'open'
        group by p.id
        order by min(r.created_at)
        limit 200
      ) g), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
               'username', t.username, 'outcome', replace(m.action, 'member_reports_', ''), 'reason', m.reason,
               'reports', coalesce((m.metadata ->> 'reports')::integer, 0), 'by', a.username, 'at', m.created_at)
             order by m.created_at desc)
      from (select * from public.mod_actions x
             where x.action in ('member_reports_actioned', 'member_reports_dismissed')
               and x.created_at > now() - interval '30 days'
             order by x.created_at desc limit 50) m
      join public.profiles t on t.id = m.target_user_id
      left join public.profiles a on a.id = m.actor_id), '[]'::jsonb),
    'actioned_30d',  (select count(*) from public.mod_actions m
                       where m.action = 'member_reports_actioned' and m.created_at > now() - interval '30 days'),
    'dismissed_30d', (select count(*) from public.mod_actions m
                       where m.action = 'member_reports_dismissed' and m.created_at > now() - interval '30 days')
  );
end;
$$;

-- Closes every open report about one member: 'actioned' (you did something,
-- usually from their page) or 'dismissed'. Returns how many were closed.
create function public.admin_resolve_member_reports(p_user uuid, p_outcome text, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
  v_n   integer;
begin
  if p_outcome is null or p_outcome not in ('actioned', 'dismissed') then
    perform private.raise_error('PF422', 'invalid_outcome');
  end if;
  if p_user = v_uid then
    perform private.raise_error('PF403', 'conflict_of_interest');
  end if;

  update public.member_reports r
     set status = p_outcome, resolved_by = v_uid, resolved_at = now()
   where r.reported_id = p_user and r.status = 'open';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    perform private.raise_error('PF409', 'not_pending');
  end if;

  perform private.log_mod_action(v_uid, 'member_reports_' || p_outcome, 'user', p_user, p_user, null,
                                 btrim(p_reason), jsonb_build_object('reports', v_n));
  return v_n;
end;
$$;

grant execute on function public.report_member(text, text, text)                    to authenticated;
grant execute on function public.admin_member_reports()                              to authenticated;
grant execute on function public.admin_resolve_member_reports(uuid, text, text)     to authenticated;

-- Your data export includes the member reports you filed (not who resolved them).
create or replace function public.export_my_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.enforce_rate_limit(v_uid, 'export');
  return jsonb_build_object(
    'exported_at', now(),
    'account', (select jsonb_build_object('id', u.id, 'email', u.email, 'created_at', u.created_at,
                                          'email_confirmed_at', u.email_confirmed_at)
                from auth.users u where u.id = v_uid),
    'profile',        (select to_jsonb(p) from public.profiles p where p.id = v_uid),
    'posts',          coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at) from public.posts p where p.author_id = v_uid), '[]'),
    'comments',       coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at) from public.comments c where c.author_id = v_uid), '[]'),
    'post_votes',     coalesce((select jsonb_agg(to_jsonb(v)) from public.post_votes v where v.voter_id = v_uid), '[]'),
    'comment_votes',  coalesce((select jsonb_agg(to_jsonb(v)) from public.comment_votes v where v.voter_id = v_uid), '[]'),
    'notes',          coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at) from public.notes n where n.author_id = v_uid), '[]'),
    'note_ratings',   coalesce((select jsonb_agg(to_jsonb(r)) from public.note_ratings r where r.rater_id = v_uid), '[]'),
    'reports_filed',  coalesce((select jsonb_agg(to_jsonb(r)) from public.reports r where r.reporter_id = v_uid), '[]'),
    'member_reports_filed',
                      coalesce((select jsonb_agg(to_jsonb(r) - 'resolved_by' order by r.created_at)
                                from public.member_reports r where r.reporter_id = v_uid), '[]'),
    'ledger',         coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from public.ledger_events e where e.user_id = v_uid), '[]'),
    'strikes',        coalesce((select jsonb_agg(to_jsonb(s)) from public.strikes s where s.user_id = v_uid), '[]'),
    'sanctions',      coalesce((select jsonb_agg(to_jsonb(s)) from public.sanctions s where s.user_id = v_uid), '[]'),
    'moderation_actions_on_me',
                      coalesce((select jsonb_agg(to_jsonb(a) - 'actor_id') from public.mod_actions a where a.target_user_id = v_uid), '[]')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Overview: member-report tickets and who the owner is
-- ---------------------------------------------------------------------------
create or replace function public.admin_overview()
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
    'held', (select count(*) from public.posts p where p.status = 'held' and p.held_reason is not null)
          + (select count(*) from public.comments c where c.status = 'held' and c.held_reason is not null),
    'links_pending', (select count(*) from public.posts p where p.status = 'held' and p.links_pending is not null)
                   + (select count(*) from public.comments c where c.status = 'held' and c.links_pending is not null),
    'links_oldest', (select min(x.at) from (
                       select p.status_changed_at as at from public.posts p where p.status = 'held' and p.links_pending is not null
                       union all
                       select c.status_changed_at from public.comments c where c.status = 'held' and c.links_pending is not null) x),
    'member_reports_open', (select count(distinct r.reported_id) from public.member_reports r where r.status = 'open'),
    'member_reports_oldest', (select min(r.created_at) from public.member_reports r where r.status = 'open'),
    'owner', (select p.username from public.user_roles r join public.profiles p on p.id = r.user_id
              where r.role = 'owner' and private.is_admin(r.user_id)),
    'is_owner', private.is_owner(v_uid),
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
