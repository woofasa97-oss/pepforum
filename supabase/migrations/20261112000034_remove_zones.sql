-- ============================================================================
-- 0034 · No zones: one site, site-wide moderators (ADR-0010)
--
-- Pepforums is global (pepforums.com). The Canadian "zones" go completely:
-- the zones and cities tables, zone moderators, members' home zone, the
-- zone of each post, report and log entry, the regions switch, the "zone"
-- ad package and the province fields.
--
--   * Moderators become site-wide (public.moderators); every zone moderator
--     is carried over once. is_moderator() keeps its signature, so the
--     policies and functions that use it are unchanged.
--   * Appeals on removed posts and comments go to any other moderator;
--     appeals on sanctions to an admin, as before.
--   * Two pinned posts for the whole site; older regional pins are unpinned.
--   * Clinicians and advertisers give a country (ISO 3166 alpha-2) instead
--     of a province; existing rows become 'CA'.
--   * The "zone" ad package goes: its campaigns become site-wide, and every
--     campaign needs French copy.
--   * log_mod_action() keeps its 8 arguments so its 54 callers stay as they
--     are; the zone argument is ignored. The action names appoint_moderator,
--     remove_moderator and taxonomy_change stay valid for past log rows.
--
-- Every function whose latest definition used a zone is recreated here from
-- that definition. packages/database/tests/zones-removed.test.ts checks that
-- no function still mentions a zone, city, home zone or province.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Site-wide moderators
-- ---------------------------------------------------------------------------
-- Site-wide moderators replace zone moderators. Read through functions only.
create table public.moderators (
  user_id      uuid primary key references public.profiles (id) on delete cascade,
  appointed_by uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);
alter table public.moderators enable row level security;

-- Every zone moderator becomes a site-wide moderator, once.
insert into public.moderators (user_id, appointed_by, created_at)
select distinct on (m.user_id) m.user_id, m.appointed_by, m.created_at
from public.zone_moderators m
order by m.user_id, m.created_at;

-- A moderator is an admin or a row in moderators (same signature: 7 policies and 10 callers use it).
create or replace function private.is_moderator(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and (
    private.is_admin(p_user)
    or exists (select 1 from public.moderators m where m.user_id = p_user)
  );
$$;

-- Moderator actions need a moderator in an MFA session (replaces require_zone_mod).
create function private.require_moderator(p_user uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_aal2();
  if not private.is_moderator(p_user) then
    perform private.raise_error('PF403', 'not_moderator');
  end if;
end;
$$;

-- Admins appoint or remove a site-wide moderator (replaces set_zone_moderator).
create function public.set_moderator(p_user uuid, p_appoint boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
begin
  if p_user is null or not exists (select 1 from public.profiles p where p.id = p_user and p.deleted_at is null) then
    perform private.raise_error('PF404', 'not_found');
  end if;
  if p_user = v_uid then
    perform private.raise_error('PF403', 'conflict_of_interest');
  end if;
  if p_appoint then
    insert into public.moderators (user_id, appointed_by) values (p_user, v_uid)
    on conflict (user_id) do nothing;
  else
    delete from public.moderators where user_id = p_user;
  end if;
  perform private.log_mod_action(v_uid, case when p_appoint then 'appoint_moderator' else 'remove_moderator' end,
                                 'user', p_user, p_user, null, btrim(p_reason));
end;
$$;
grant execute on function public.set_moderator(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Countries instead of provinces; data that changes meaning
-- ---------------------------------------------------------------------------
alter table public.clinician_verifications add column country text;
update public.clinician_verifications set country = 'CA';
alter table public.clinician_verifications alter column country set not null;
alter table public.clinician_verifications add constraint clinician_verifications_country_check check (country ~ '^[A-Z]{2}$');

alter table public.advertisers add column billing_country text;
update public.advertisers set billing_country = 'CA';
alter table public.advertisers alter column billing_country set not null;
alter table public.advertisers add constraint advertisers_billing_country_check check (billing_country ~ '^[A-Z]{2}$');

-- Regional campaigns become site-wide.
update public.ad_campaigns set package = 'national', zone_id = null where package = 'zone';

-- Two pins for the whole site: keep the two most recent.
update public.posts set pinned_at = null
 where pinned_at is not null
   and id not in (select x.id from public.posts x where x.pinned_at is not null order by x.pinned_at desc limit 2);

-- The regions switch and the zone package price go (their history rows stay).
delete from public.app_config where key in ('features.regions', 'ads.cpm.zone');

-- ---------------------------------------------------------------------------
-- Read access: moderators are site-wide
-- ---------------------------------------------------------------------------
drop policy posts_read on public.posts;
create policy posts_read on public.posts
  for select to anon, authenticated
  using (
    status in ('visible', 'collapsed')
    or author_id = auth.uid()
    or (private.is_moderator(auth.uid()) and private.staff_session())
  );

drop policy comments_read on public.comments;
create policy comments_read on public.comments
  for select to anon, authenticated
  using (
    -- Public only while the parent post is public: a post removed for
    -- sourcing must not leave its "DM me" replies readable.
    (status in ('visible', 'collapsed', 'deleted')   -- deleted shows as "[deleted]" to keep threads intact
     and exists (select 1 from public.posts p where p.id = post_id and p.status in ('visible', 'collapsed')))
    or author_id = auth.uid()
    or (private.is_moderator(auth.uid()) and private.staff_session())
  );

drop policy reports_self_or_zone_mod_read on public.reports;
create policy reports_self_or_mod_read on public.reports
  for select to authenticated
  using (reporter_id = auth.uid() or (private.is_moderator(auth.uid()) and private.staff_session()));

-- ---------------------------------------------------------------------------
-- Functions: recreated from their latest definitions without zones
-- ---------------------------------------------------------------------------
-- content_target no longer returns a zone.
drop function private.content_target(text, uuid);
create function private.content_target(p_kind text, p_id uuid, out author_id uuid, out status text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_kind = 'post' then
    select p.author_id, p.status into author_id, status from public.posts p where p.id = p_id;
  elsif p_kind = 'comment' then
    select c.author_id, c.status into author_id, status
    from public.comments c where c.id = p_id;
  else
    perform private.raise_error('PF422', 'invalid_target');
  end if;
  if author_id is null then
    perform private.raise_error('PF404', 'not_found', p_kind);
  end if;
end;
$$;

-- Expired collapses: no zone.
create or replace function public.expire_stale_collapses()
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
    select 'post' as kind, p.id, p.author_id from public.posts p
     where p.status = 'collapsed' and p.status_changed_at < v_cutoff
    union all
    select 'comment', c.id, c.author_id from public.comments c join public.posts p on p.id = c.post_id
     where c.status = 'collapsed' and c.status_changed_at < v_cutoff
  loop
    perform private.set_content_status(v_row.kind, v_row.id, 'visible');
    perform private.log_mod_action(null, 'auto_uncollapse', v_row.kind, v_row.id, v_row.author_id, null,
                                   'collapse expired without moderator review');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Removals: no zone.
create or replace function private.remove_content(p_actor uuid, p_kind text, p_id uuid, p_violation text, p_reason text)
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
  v_action := private.log_mod_action(p_actor, 'remove', p_kind, p_id, v_target.author_id, null,
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

-- get_note: the post has no zone.
create or replace function public.get_note(p_note_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.note_projection(n) || jsonb_build_object(
    'post', (select jsonb_build_object('id', p.id, 'title', p.title, 'body', left(p.body, 1200),
                                       'post_type', p.post_type, 'category_id', p.category_id,
                                       'is_mine', coalesce(p.author_id = auth.uid(), false))
             from public.posts p where p.id = n.post_id),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('event', h.event, 'from', h.from_status,
                                                             'to', h.to_status, 'at', h.created_at) order by h.id), '[]'::jsonb)
                from public.note_status_history h where h.note_id = n.id),
    'can_rate', n.locked_at is null
                and n.author_id is distinct from auth.uid()
                and (select p.author_id from public.posts p where p.id = n.post_id) is distinct from auth.uid()
                and private.has_capability(auth.uid(), 'rate_notes')
  )
  from public.notes n
  where n.id = p_note_id and private.note_visible(n);
$$;

-- Sign-up: no home zone.
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- raw_app_meta_data is written by Supabase Auth; members can't edit it.
  v_provider text    := coalesce(new.raw_app_meta_data ->> 'provider', 'email');
  v_social   boolean := v_provider not in ('email', 'phone');
  v_username text    := new.raw_user_meta_data ->> 'username';
  -- Providers send locales such as "fr-CA"; the sign-up form sends "en"/"fr".
  v_locale   text    := lower(left(coalesce(new.raw_user_meta_data ->> 'locale', 'en'), 2));
begin
  if v_social then
    -- Never take a username from the provider's profile.
    loop
      v_username := 'member_' || substr(md5(gen_random_uuid()::text), 1, 8);
      exit when not exists (select 1 from public.profiles p where lower(p.username) = v_username);
    end loop;
  else
    if v_username is null or v_username !~ '^[A-Za-z0-9_]{3,20}$' then
      perform private.raise_error('PF422', 'invalid_username');
    end if;
    if lower(v_username) ~ '^(deleted_|admin|mod_|moderator|pepforum|system|support|staff)' then
      perform private.raise_error('PF422', 'reserved_username');
    end if;
  end if;
  if v_locale not in ('en', 'fr') then
    v_locale := 'en';
  end if;
  insert into public.profiles (id, username, locale, needs_onboarding)
  values (new.id, v_username, v_locale, v_social);
  return new;
end;
$$;

-- Onboarding: username and age only.
drop function public.complete_onboarding(text, text, boolean);
create function public.complete_onboarding(p_username text, p_adult boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  -- Every capability is denied until this succeeds, so there is none to
  -- require here; it can only succeed once.
  perform private.enforce_rate_limit(v_uid, 'onboarding');
  if not exists (
    select 1 from public.profiles p where p.id = v_uid and p.needs_onboarding and p.deleted_at is null
  ) then
    perform private.raise_error('PF409', 'already_onboarded');
  end if;
  if p_adult is distinct from true then
    perform private.raise_error('PF422', 'adult_required');
  end if;
  if p_username is null or p_username !~ '^[A-Za-z0-9_]{3,20}$' then
    perform private.raise_error('PF422', 'invalid_username');
  end if;
  if lower(p_username) ~ '^(deleted_|admin|mod_|moderator|pepforum|system|support|staff)' then
    perform private.raise_error('PF422', 'reserved_username');
  end if;
  if exists (select 1 from public.profiles p where lower(p.username) = lower(p_username) and p.id <> v_uid) then
    perform private.raise_error('PF409', 'username_taken');
  end if;

  update public.profiles
     set username = p_username, needs_onboarding = false
   where id = v_uid;
exception
  when unique_violation then  -- lost a race for the same username
    perform private.raise_error('PF409', 'username_taken');
end;
$$;
grant execute on function public.complete_onboarding(text, boolean) to authenticated;

-- Appeals: removals to any other moderator, sanctions to an admin.
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

  -- Appeals on content removals go to any other moderator; appeals on sanctions to an admin (…034).
  if a.target_kind in ('post', 'comment') then
    perform private.require_moderator(v_uid);
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
                                 'appeal', p_appeal_id, ap.appellant_id, null, p_note,
                                 jsonb_build_object('mod_action_id', a.id));
end;
$$;

-- Restores: no zone.
create or replace function public.admin_restore_content(p_kind text, p_id uuid, p_reason text)
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
  perform private.log_mod_action(v_uid, 'restore', p_kind, p_id, v_target.author_id, null, btrim(p_reason),
                                 jsonb_build_object('mod_action_id', v_action));
end;
$$;

-- Hiding notes: no zone.
create or replace function public.admin_set_note_hidden(p_note uuid, p_hidden boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_admin_write(p_reason);
  n      public.notes;
begin
  select * into n from public.notes where id = p_note for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'note');
  end if;

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
                                 'note', p_note, n.author_id, null, btrim(p_reason));
end;
$$;

-- Pins: two for the whole site.
create or replace function public.admin_set_pinned(p_post uuid, p_pinned boolean, p_reason text)
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
    -- Two pinned posts across the whole site (…034).
    if (select count(*) from public.posts p where p.pinned_at is not null) >= 2 then
      perform private.raise_error('PF409', 'pin_limit');
    end if;
    update public.posts set pinned_at = now() where id = p_post;
  else
    update public.posts set pinned_at = null where id = p_post;
  end if;
  perform private.log_mod_action(v_uid, case when p_pinned then 'pin' else 'unpin' end,
                                 'post', p_post, v.author_id, null, btrim(p_reason));
end;
$$;

-- Locking comments: no zone.
create or replace function public.admin_set_comments_locked(p_post uuid, p_locked boolean, p_reason text)
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
                                 'post', p_post, v.author_id, null, btrim(p_reason));
end;
$$;

-- Staff without MFA counts moderators.
create or replace function private.staff_without_mfa()
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
         or exists (select 1 from public.moderators m where m.user_id = p.id))
    and not exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified');
$$;

-- People list: moderator flag.
create or replace function public.admin_people(p_query text, p_filter text, p_sort text, p_page integer)
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
           exists (select 1 from public.moderators m where m.user_id = p.id) as is_moderator,
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

-- Member page: moderator flag, no home zone.
create or replace function public.admin_member(p_username text)
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
    'id', p.id, 'username', p.username, 'locale', p.locale,
    'bio', p.bio, 'coi', p.coi, 'karma', p.karma, 'mod_xp', p.mod_xp, 'tier', p.tier,
    'integrity', private.integrity(p.id), 'rater_status', private.effective_rater_status(p),
    'rater_impact', p.rater_impact, 'writer_impact', p.writer_impact,
    'founding_until', p.founding_until, 'writing_locked_until', p.writing_locked_until,
    'needs_onboarding', p.needs_onboarding, 'created_at', p.created_at, 'deleted_at', p.deleted_at,
    'is_admin', private.is_admin(p.id), 'is_self', p.id = v_uid,
    'is_moderator', exists (select 1 from public.moderators m where m.user_id = p.id),
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
                                  'created_at', x.created_at) as c
          from public.posts x where x.author_id = p.id
        union all
        select x.created_at,
               jsonb_build_object('kind', 'comment', 'id', x.id, 'post_id', x.post_id, 'text', left(x.body, 160),
                                  'status', x.status, 'created_at', x.created_at)
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

-- Content search: no zone filter.
drop function public.admin_content(text, text, text, text, integer);
create function public.admin_content(p_kind text, p_query text, p_status text, p_page integer)
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
               'status', p.status, 'category_id', p.category_id, 'author', a.username,
               'created_at', p.created_at, 'pinned', p.pinned_at is not null, 'locked', p.comments_locked_at is not null,
               'removal_reason', p.removal_reason,
               'open_reports', (select count(*) from public.reports r where r.post_id = p.id and r.status = 'open')) as r
      from public.posts p join public.profiles a on a.id = p.author_id
      where (p.title ilike v_q or p.body ilike v_q or a.username ilike v_q)
        and (p_status is null or p.status = p_status)
      order by p.created_at desc
      limit 51 offset v_page * 50) t;
  elsif p_kind = 'comment' then
    select coalesce(jsonb_agg(r order by r ->> 'created_at' desc), '[]'::jsonb) into v_rows from (
      select jsonb_build_object(
               'kind', 'comment', 'id', c.id, 'post_id', c.post_id, 'title', p.title, 'excerpt', left(c.body, 200),
               'status', c.status, 'author', a.username, 'created_at', c.created_at,
               'removal_reason', c.removal_reason,
               'open_reports', (select count(*) from public.reports r where r.comment_id = c.id and r.status = 'open')) as r
      from public.comments c
      join public.posts p on p.id = c.post_id
      join public.profiles a on a.id = c.author_id
      where (c.body ilike v_q or a.username ilike v_q)
        and (p_status is null or c.status = p_status)
      order by c.created_at desc
      limit 51 offset v_page * 50) t;
  elsif p_kind = 'note' then
    select coalesce(jsonb_agg(r order by r ->> 'created_at' desc), '[]'::jsonb) into v_rows from (
      select jsonb_build_object(
               'kind', 'note', 'id', n.id, 'post_id', n.post_id, 'title', p.title, 'excerpt', left(n.body, 200),
               'status', coalesce(n.locked_status, n.status), 'locked', n.locked_at is not null,
               'hidden', n.hidden_at is not null, 'hidden_reason', n.hidden_reason,
               'classification', n.classification, 'author', a.username,
               'created_at', n.created_at) as r
      from public.notes n
      join public.posts p on p.id = n.post_id
      join public.profiles a on a.id = n.author_id
      where (n.body ilike v_q or a.username ilike v_q or p.title ilike v_q)
        and (p_status is null or (p_status = 'hidden' and n.hidden_at is not null) or coalesce(n.locked_status, n.status) = p_status)
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
grant execute on function public.admin_content(text, text, text, integer) to authenticated;

-- Moderation log: no zone filter.
drop function public.admin_mod_log(text, text, text, text, timestamptz);
create function public.admin_mod_log(p_action text, p_actor text, p_target text, p_before timestamptz)
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
             'target_user', t.username, 'reason', m.reason, 'metadata', m.metadata,
             'actor', a.username, 'created_at', m.created_at,
             'appealed', exists (select 1 from public.appeals ap where ap.mod_action_id = m.id),
             'post_id', case m.target_kind when 'post' then m.target_id
                                           when 'comment' then (select c.post_id from public.comments c where c.id = m.target_id)
                                           when 'note' then (select n.post_id from public.notes n where n.id = m.target_id) end)
           order by m.created_at desc)
    from (
      select * from public.mod_actions m
      where (p_action is null or m.action = p_action)
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
grant execute on function public.admin_mod_log(text, text, text, timestamptz) to authenticated;

-- Team page: site-wide moderators.
create or replace function public.admin_team()
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
               'username', p.username, 'since', zm.created_at,
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
             order by p.username)
      from public.moderators zm join public.profiles p on p.id = zm.user_id), '[]'::jsonb),
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

-- Resolving reports: any moderator, site-wide.
create or replace function public.resolve_reports(
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
  perform private.require_moderator(v_uid);
  if v_target.author_id = v_uid then
    perform private.raise_error('PF403', 'conflict_of_interest');
  end if;

  if p_decision = 'remove' then
    if p_violation is null or p_violation not in ('sourcing', 'medical_advice', 'harassment', 'misinformation', 'spam', 'before_after', 'other') then
      perform private.raise_error('PF422', 'invalid_violation');
    end if;
    v_action := private.remove_content(v_uid, p_target_kind, p_target_id, p_violation, p_reason);
  elsif p_decision = 'keep' then
    if v_target.status in ('collapsed', 'held') then
      perform private.set_content_status(p_target_kind, p_target_id, 'visible');
      if p_target_kind = 'post' then
        update public.posts set held_reason = null where id = p_target_id;
      else
        update public.comments set held_reason = null where id = p_target_id;
      end if;
    end if;
    v_action := private.log_mod_action(v_uid, 'dismiss_reports', p_target_kind, p_target_id, v_target.author_id,
                                       null, p_reason);
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

-- Open appeals: one list for moderators.
drop function public.open_appeals(text);
create function public.open_appeals()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.require_moderator(v_uid);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', ap.id, 'body', ap.body, 'created_at', ap.created_at,
      'appellant', u.username,
      'action', a.action, 'target_kind', a.target_kind, 'target_id', a.target_id, 'reason', a.reason,
      'acted_by', m.username, 'acted_at', a.created_at,
      -- Removals: any other moderator. Sanctions: an admin (…034).
      'can_decide', a.actor_id is distinct from v_uid and ap.appellant_id is distinct from v_uid
                    and (a.target_kind in ('post', 'comment') or private.is_admin(v_uid))
    ) order by ap.created_at)
    from public.appeals ap
    join public.mod_actions a on a.id = ap.mod_action_id
    join public.profiles u on u.id = ap.appellant_id
    left join public.profiles m on m.id = a.actor_id
    where ap.status = 'open'
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.open_appeals() to authenticated;

-- The moderation queue: one site-wide queue for moderators.
drop function public.mod_queue(text);
create function public.mod_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.require_moderator(v_uid);
  return coalesce((
    select jsonb_agg(q.item order by q.first_at)
    from (
      select jsonb_build_object(
        'target_kind',       t.kind,
        'target_id',         t.target_id,
        'post_id',           coalesce(p.id, c.post_id),
        'excerpt',           coalesce(p.title, left(c.body, 200)),
        'body',              left(coalesce(p.body, c.body), 1200),
        'status',            coalesce(p.status, c.status),
        'held_reason',       coalesce(p.held_reason, c.held_reason),
        'author_username',   a.username,
        'author_tier',       a.tier,
        'author_integrity',  private.integrity(a.id),
        'author_prior_actions', (select count(*) from public.mod_actions m
                                 where m.target_user_id = a.id and m.action in ('remove', 'sanction')),
        'total_weight',      coalesce(sum(r.weight), 0),
        'report_count',      count(r.id),
        'first_reported_at', coalesce(min(r.created_at), coalesce(p.status_changed_at, c.status_changed_at)),
        'reports', coalesce(jsonb_agg(jsonb_build_object(
                     'id', r.id, 'reason', r.reason, 'details', r.details, 'weight', r.weight,
                     'reporter', rp.username, 'created_at', r.created_at) order by r.created_at)
                     filter (where r.id is not null), '[]'::jsonb)
      ) as item,
      coalesce(min(r.created_at), coalesce(p.status_changed_at, c.status_changed_at)) as first_at
      from (
        select coalesce(r.post_id, r.comment_id) as target_id,
               case when r.post_id is not null then 'post' else 'comment' end as kind
        from public.reports r
        where r.status = 'open'
        union
        select hp.id, 'post' from public.posts hp
        where hp.status = 'held' and hp.held_reason is not null
        union
        select hc.id, 'comment' from public.comments hc
        where hc.status = 'held' and hc.held_reason is not null
      ) t
      left join public.posts p    on t.kind = 'post' and p.id = t.target_id
      left join public.comments c on t.kind = 'comment' and c.id = t.target_id
      join public.profiles a      on a.id = coalesce(p.author_id, c.author_id)
      left join public.reports r  on r.status = 'open' and (r.post_id = t.target_id or r.comment_id = t.target_id)
      left join public.profiles rp on rp.id = r.reporter_id
      group by t.kind, t.target_id, p.id, c.id, a.id
    ) q
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.mod_queue() to authenticated;

-- Shield holds on posts: no zone.
create or replace function private.shield_posts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_verdict text;
begin
  if new.status not in ('visible', 'collapsed') then
    return new;  -- erasure, removal and deletion are never blocked
  end if;
  v_verdict := private.shield_verdict('post', new.author_id, concat_ws(' ', new.title, new.body, new.link_url));
  if v_verdict = 'block' then
    perform private.raise_error('PF422', 'blocked_by_shield');
  elsif v_verdict like 'hold:%' then
    new.status := 'held';
    new.held_reason := substr(v_verdict, 6);
    new.status_changed_at := now();
    perform private.log_mod_action(null, 'shield_hold', 'post', new.id, new.author_id, null,
                                   'sourcing shield', jsonb_build_object('rule', new.held_reason));
  end if;
  return new;
end;
$$;

-- Shield holds on comments: no zone.
create or replace function private.shield_comments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_verdict text;
begin
  if new.status not in ('visible', 'collapsed') then
    return new;
  end if;
  v_verdict := private.shield_verdict('comment', new.author_id, new.body);
  if v_verdict = 'block' then
    perform private.raise_error('PF422', 'blocked_by_shield');
  elsif v_verdict like 'hold:%' then
    new.status := 'held';
    new.held_reason := substr(v_verdict, 6);
    new.status_changed_at := now();
    perform private.log_mod_action(null, 'shield_hold', 'comment', new.id, new.author_id, null,
                                   'sourcing shield', jsonb_build_object('rule', new.held_reason));
  end if;
  return new;
end;
$$;

-- Link holds on posts: no zone.
create or replace function private.shield_links_posts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status not in ('visible', 'collapsed', 'held') then
    return new;
  end if;
  new.links_pending := private.pending_hosts(
    new.author_id, concat_ws(' ', new.title, new.body, new.link_url),
    case when tg_op = 'UPDATE' then concat_ws(' ', old.title, old.body, old.link_url) end,
    case when tg_op = 'UPDATE' then old.links_pending end);
  if new.links_pending is not null and new.status <> 'held' then
    new.status := 'held';
    new.status_changed_at := now();
    perform private.log_mod_action(null, 'link_hold', 'post', new.id, new.author_id, null,
                                   'link review', jsonb_build_object('hosts', to_jsonb(new.links_pending)));
  end if;
  return new;
end;
$$;

-- Link holds on comments: no zone.
create or replace function private.shield_links_comments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status not in ('visible', 'collapsed', 'held') then
    return new;
  end if;
  new.links_pending := private.pending_hosts(
    new.author_id, new.body,
    case when tg_op = 'UPDATE' then old.body end,
    case when tg_op = 'UPDATE' then old.links_pending end);
  if new.links_pending is not null and new.status <> 'held' then
    new.status := 'held';
    new.status_changed_at := now();
    perform private.log_mod_action(null, 'link_hold', 'comment', new.id, new.author_id,
                                   null,
                                   'link review', jsonb_build_object('hosts', to_jsonb(new.links_pending)));
  end if;
  return new;
end;
$$;

-- Link queue: no zone.
create or replace function public.admin_links()
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
    'enabled', private.cfg_bool('links.require_approval'),
    'pending', coalesce((
      select jsonb_agg(i.item order by i.at) from (
        select jsonb_build_object(
                 'target_kind', 'post', 'target_id', p.id, 'post_id', p.id, 'title', p.title, 'body', left(p.body, 600),
                 'urls', to_jsonb(private.link_urls(concat_ws(' ', p.body, p.link_url, p.title))),
                 'hosts', to_jsonb(p.links_pending), 'held_reason', p.held_reason,
                 'author_username', a.username, 'author_tier', a.tier, 'author_karma', a.karma,
                 'author_integrity', private.integrity(a.id), 'author_joined', a.created_at,
                 'waiting_since', p.status_changed_at) as item,
               p.status_changed_at as at
        from public.posts p join public.profiles a on a.id = p.author_id
        where p.status = 'held' and p.links_pending is not null
        union all
        select jsonb_build_object(
                 'target_kind', 'comment', 'target_id', c.id, 'post_id', c.post_id, 'title', p.title, 'body', left(c.body, 600),
                 'urls', to_jsonb(private.link_urls(c.body)),
                 'hosts', to_jsonb(c.links_pending), 'held_reason', c.held_reason,
                 'author_username', a.username, 'author_tier', a.tier, 'author_karma', a.karma,
                 'author_integrity', private.integrity(a.id), 'author_joined', a.created_at,
                 'waiting_since', c.status_changed_at),
               c.status_changed_at
        from public.comments c join public.posts p on p.id = c.post_id join public.profiles a on a.id = c.author_id
        where c.status = 'held' and c.links_pending is not null
        order by 2 limit 200
      ) i), '[]'::jsonb),
    -- Sites waiting, busiest first: approving one clears every item below it.
    'sites', coalesce((
      select jsonb_agg(jsonb_build_object('host', s.host, 'items', s.items, 'since', s.since)
                       order by s.items desc, s.since)
      from (
        select h.host, count(*) as items, min(h.at) as since
        from (
          select unnest(p.links_pending) as host, p.status_changed_at as at
          from public.posts p where p.status = 'held' and p.links_pending is not null
          union all
          select unnest(c.links_pending), c.status_changed_at
          from public.comments c where c.status = 'held' and c.links_pending is not null
        ) h
        group by h.host
      ) s), '[]'::jsonb),
    'approved', coalesce((
      select jsonb_agg(jsonb_build_object('domain', d.domain, 'reason', d.reason, 'created_by', a.username,
                                          'created_at', d.created_at) order by d.domain)
      from public.approved_domains d left join public.profiles a on a.id = d.created_by), '[]'::jsonb),
    'approved_30d', (select count(*) from public.mod_actions m
                     where m.action = 'link_approved' and m.created_at > now() - interval '30 days'),
    'declined_30d', (select count(*) from public.mod_actions m
                     where m.action = 'link_declined' and m.created_at > now() - interval '30 days')
  );
end;
$$;

-- Link decisions: no zone.
create or replace function public.admin_link_decide(p_kind text, p_id uuid, p_decision text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := private.require_admin_write(p_reason);
  v_target  record;
  v_pending text[];
  v_held    text;
begin
  select * into v_target from private.content_target(p_kind, p_id);
  if p_kind = 'post' then
    select p.links_pending, p.held_reason into v_pending, v_held from public.posts p where p.id = p_id for update;
  else
    select c.links_pending, c.held_reason into v_pending, v_held from public.comments c where c.id = p_id for update;
  end if;
  if v_target.status <> 'held' or v_pending is null then
    perform private.raise_error('PF409', 'not_pending');
  end if;

  if p_decision = 'approve' then
    if p_kind = 'post' then
      update public.posts
         set links_pending = null, status = case when v_held is null then 'visible' else 'held' end, status_changed_at = now()
       where id = p_id;
    else
      update public.comments
         set links_pending = null, status = case when v_held is null then 'visible' else 'held' end, status_changed_at = now()
       where id = p_id;
    end if;
  elsif p_decision = 'decline' then
    perform private.set_content_status(p_kind, p_id, 'removed', 'link_declined');
  else
    perform private.raise_error('PF422', 'invalid_decision');
  end if;
  perform private.log_mod_action(v_uid, case when p_decision = 'approve' then 'link_approved' else 'link_declined' end,
                                 p_kind, p_id, v_target.author_id, null, btrim(p_reason),
                                 jsonb_build_object('hosts', to_jsonb(v_pending)));
end;
$$;

-- Whole-site link decisions: no zone.
create or replace function public.admin_link_site(p_host text, p_decision text, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_admin_write(p_reason);
  v_domain text := lower(btrim(coalesce(p_host, '')));
  v_count  integer := 0;
  v_item   record;
begin
  v_domain := regexp_replace(v_domain, '^[a-z]+://', '');
  v_domain := regexp_replace(v_domain, '[/?#:].*$', '');
  v_domain := regexp_replace(v_domain, '^www\.', '');
  if v_domain !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' or char_length(v_domain) > 253 then
    perform private.raise_error('PF422', 'invalid_domain');
  end if;

  if p_decision = 'approve' then
    insert into public.approved_domains (domain, reason, created_by) values (v_domain, btrim(p_reason), v_uid)
    on conflict (domain) do nothing;
    for v_item in
      select 'post' as kind, p.id, p.author_id, p.links_pending, p.held_reason
      from public.posts p
      where p.status = 'held' and p.links_pending is not null
        and exists (select 1 from unnest(p.links_pending) h where private.domain_covers(v_domain, h))
      union all
      select 'comment', c.id, c.author_id, c.links_pending, c.held_reason
      from public.comments c join public.posts p on p.id = c.post_id
      where c.status = 'held' and c.links_pending is not null
        and exists (select 1 from unnest(c.links_pending) h where private.domain_covers(v_domain, h))
    loop
      declare
        v_left text[] := array(select h from unnest(v_item.links_pending) h where not private.domain_covers(v_domain, h));
        v_next text[] := case when cardinality(v_left) > 0 then v_left end;
        v_status text := case when v_next is null and v_item.held_reason is null then 'visible' else 'held' end;
      begin
        if v_item.kind = 'post' then
          update public.posts set links_pending = v_next, status = v_status,
                 status_changed_at = case when v_status = 'visible' then now() else status_changed_at end
           where id = v_item.id;
        else
          update public.comments set links_pending = v_next, status = v_status,
                 status_changed_at = case when v_status = 'visible' then now() else status_changed_at end
           where id = v_item.id;
        end if;
        if v_next is null then
          v_count := v_count + 1;
          perform private.log_mod_action(v_uid, 'link_approved', v_item.kind, v_item.id, v_item.author_id, null,
                                         btrim(p_reason), jsonb_build_object('hosts', to_jsonb(v_item.links_pending), 'site', v_domain));
        end if;
      end;
    end loop;
    perform private.log_mod_action(v_uid, 'site_approved', 'shield', null, null, null, btrim(p_reason),
                                   jsonb_build_object('domain', v_domain, 'published', v_count));

  elsif p_decision = 'block' then
    delete from public.approved_domains where domain = v_domain;
    insert into public.shield_domains (domain, reason, created_by) values (v_domain, btrim(p_reason), v_uid)
    on conflict (domain) do nothing;
    perform private.log_mod_action(v_uid, 'shield_rule_added', 'shield', null, null, null, btrim(p_reason),
                                   jsonb_build_object('kind', 'domain', 'value', v_domain, 'action', 'block'));
    for v_item in
      select 'post' as kind, p.id, p.author_id, p.links_pending
      from public.posts p
      where p.status = 'held' and p.links_pending is not null
        and exists (select 1 from unnest(p.links_pending) h where private.domain_covers(v_domain, h))
      union all
      select 'comment', c.id, c.author_id, c.links_pending
      from public.comments c join public.posts p on p.id = c.post_id
      where c.status = 'held' and c.links_pending is not null
        and exists (select 1 from unnest(c.links_pending) h where private.domain_covers(v_domain, h))
    loop
      perform private.set_content_status(v_item.kind, v_item.id, 'removed', 'link_declined');
      perform private.log_mod_action(v_uid, 'link_declined', v_item.kind, v_item.id, v_item.author_id, null,
                                     btrim(p_reason), jsonb_build_object('hosts', to_jsonb(v_item.links_pending), 'site', v_domain));
      v_count := v_count + 1;
    end loop;

  elsif p_decision = 'unapprove' then
    delete from public.approved_domains where domain = v_domain;
    if not found then
      perform private.raise_error('PF404', 'not_found', 'approved_domain');
    end if;
    perform private.log_mod_action(v_uid, 'site_unapproved', 'shield', null, null, null, btrim(p_reason),
                                   jsonb_build_object('domain', v_domain));
  else
    perform private.raise_error('PF422', 'invalid_decision');
  end if;
  return v_count;
end;
$$;

-- Reports: no zone.
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
    insert into public.reports (reporter_id, post_id, comment_id, reason, details, weight, counts_toward_collapse)
    values (v_uid,
            case when p_target_kind = 'post' then p_target_id end,
            case when p_target_kind = 'comment' then p_target_id end,
            p_reason, coalesce(p_details, ''), v_weight, v_counts);
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
                                     null, 'community reports',
                                     jsonb_build_object('weight', v_sum, 'reporters', v_reporters));
      v_collapsed := true;
    end if;
  end if;

  return jsonb_build_object('collapsed', v_collapsed);
end;
$$;

-- Moderation notifications: no zone.
create or replace function private.on_mod_action_for_notifications()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.target_user_id is not null
     and new.action in ('remove', 'restore', 'sanction', 'revoke_sanction', 'appeal_upheld', 'appeal_denied', 'revoke_strike',
                        'link_declined', 'link_approved', 'member_reports_actioned') then
    perform private.notify(new.target_user_id, 'mod_action', 'mod_action:' || new.id, null,
                           case when new.target_kind = 'post' then new.target_id end,
                           case when new.target_kind = 'comment' then new.target_id end,
                           null, null, new.id,
                           jsonb_build_object('action', new.action, 'reason', new.reason));
  end if;
  return new;
end;
$$;

-- Media removal: no zone.
create or replace function public.admin_remove_media(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
  m     public.media;
begin
  select * into m from public.media x where x.id = p_id for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'media');
  end if;
  if m.status = 'removed' then
    perform private.raise_error('PF409', 'already_removed');
  end if;
  update public.media
     set status = 'removed', removed_reason = 'admin', removed_by = v_uid, post_id = null
   where id = m.id;
  perform private.log_mod_action(v_uid, 'media_removed', 'media', m.id, m.owner_id,
                                 null, p_reason,
                                 jsonb_build_object('post_id', m.post_id, 'kind', m.kind));
end;
$$;

-- Posting: a category, no zone or city.
drop function public.create_post(text, text, text, text, text, text, text, text);
create function public.create_post(
  p_category_id text,
  p_post_type   text,
  p_title       text,
  p_body        text,
  p_link_url    text default null,
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

  if not exists (select 1 from public.categories c where c.id = p_category_id and c.archived_at is null) then
    perform private.raise_error('PF422', 'invalid_category');
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

  insert into public.posts (author_id, category_id, post_type, title, body, link_url, language)
  values (v_uid, p_category_id, p_post_type, v_title, v_body, v_link, p_language)
  returning id into v_id;

  insert into public.post_revisions (post_id, revision, title, body, link_url)
  values (v_id, 1, v_title, v_body, v_link);

  return v_id;
end;
$$;
grant execute on function public.create_post(text, text, text, text, text, text) to authenticated;

-- Clinician verification: a country (ISO 3166 alpha-2) instead of a province.
drop function public.submit_clinician_verification(text, text, text, text, uuid, text);
create function public.submit_clinician_verification(
  p_profession text, p_regulator text, p_country text, p_registration_number text,
  p_document_id uuid, p_statement text default ''
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := private.require_user();
  v_regulator text := btrim(coalesce(p_regulator, ''));
  v_number    text := btrim(coalesce(p_registration_number, ''));
  v_statement text := btrim(coalesce(p_statement, ''));
  v_id        uuid;
begin
  perform private.require_capability(v_uid, 'report');
  perform private.enforce_rate_limit(v_uid, 'clinician_submit');

  if p_profession is null or p_profession not in ('physician', 'nurse_practitioner', 'registered_nurse', 'pharmacist', 'naturopathic_doctor', 'dietitian', 'other') then
    perform private.raise_error('PF422', 'invalid_profession');
  end if;
  if char_length(v_regulator) not between 2 and 120 then
    perform private.raise_error('PF422', 'invalid_regulator');
  end if;
  if p_country is null or p_country !~ '^[A-Z]{2}$' then
    perform private.raise_error('PF422', 'invalid_country');
  end if;
  if char_length(v_number) not between 2 and 60 then
    perform private.raise_error('PF422', 'invalid_registration');
  end if;
  if char_length(v_statement) > 1000 then
    perform private.raise_error('PF422', 'invalid_body');
  end if;
  if p_document_id is null or not exists (
       select 1 from public.media m
       where m.id = p_document_id and m.owner_id = v_uid and m.kind = 'credential' and m.status = 'ready') then
    perform private.raise_error('PF404', 'not_found', 'document');
  end if;
  if exists (select 1 from public.clinician_verifications v where v.user_id = v_uid and v.status = 'pending') then
    perform private.raise_error('PF409', 'already_pending');
  end if;
  if private.clinician_badge(v_uid) is not null
     and (select v.expires_at from public.clinician_verifications v where v.user_id = v_uid and v.status = 'approved') > now() + interval '90 days' then
    perform private.raise_error('PF409', 'already_verified');
  end if;

  insert into public.clinician_verifications (user_id, profession, regulator, country, registration_number, document_id, statement)
  values (v_uid, p_profession, v_regulator, p_country, v_number, p_document_id, v_statement)
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.submit_clinician_verification(text, text, text, text, uuid, text) to authenticated;

-- My clinician verification: country.
create or replace function public.my_clinician_verification()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v     public.clinician_verifications;
begin
  select * into v from public.clinician_verifications x where x.user_id = v_uid
   order by case x.status when 'pending' then 0 when 'approved' then 1 else 2 end, x.submitted_at desc limit 1;
  return jsonb_build_object(
    'badge', private.clinician_badge(v_uid),
    'latest', case when v.id is null then null else jsonb_build_object(
      'id', v.id, 'profession', v.profession, 'regulator', v.regulator, 'country', v.country,
      'status', case when v.status = 'approved' and v.expires_at <= now() then 'expired' else v.status end,
      'submitted_at', v.submitted_at, 'reviewed_at', v.reviewed_at, 'review_note', v.review_note, 'expires_at', v.expires_at,
      'document_id', v.document_id) end,
    'valid_days', private.cfg_int('clinician.valid_days'));
end;
$$;

-- Clinician review list: country.
create or replace function public.admin_clinician_verifications(p_filter text default 'pending')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_user();
  v_filter text := coalesce(p_filter, 'pending');
begin
  perform private.require_admin(v_uid);
  if v_filter not in ('pending', 'approved', 'expiring', 'rejected', 'revoked') then
    perform private.raise_error('PF422', 'invalid_status');
  end if;
  return jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', v.id, 'member', p.username, 'member_tier', p.tier, 'user_id', p.id, 'joined', p.created_at,
               'profession', v.profession, 'regulator', v.regulator, 'country', v.country,
               'registration_number', v.registration_number, 'document_id', v.document_id, 'statement', v.statement,
               'status', case when v.status = 'approved' and v.expires_at <= now() then 'expired' else v.status end,
               'submitted_at', v.submitted_at, 'reviewed_at', v.reviewed_at,
               'reviewed_by', (select r.username from public.profiles r where r.id = v.reviewed_by),
               'review_note', v.review_note, 'expires_at', v.expires_at,
               'previous', (select count(*) from public.clinician_verifications x where x.user_id = v.user_id and x.id <> v.id))
             order by case when v_filter = 'pending' then v.submitted_at end asc, coalesce(v.reviewed_at, v.submitted_at) desc)
      from public.clinician_verifications v
      join public.profiles p on p.id = v.user_id
      where case v_filter
              when 'pending'  then v.status = 'pending'
              when 'approved' then v.status = 'approved' and v.expires_at > now()
              when 'expiring' then v.status = 'approved' and v.expires_at between now() and now() + interval '60 days'
              else v.status = v_filter end), '[]'::jsonb),
    'counts', jsonb_build_object(
      'pending',  (select count(*) from public.clinician_verifications v where v.status = 'pending'),
      'approved', (select count(*) from public.clinician_verifications v where v.status = 'approved' and v.expires_at > now()),
      'expiring', (select count(*) from public.clinician_verifications v where v.status = 'approved' and v.expires_at between now() and now() + interval '60 days'),
      'rejected', (select count(*) from public.clinician_verifications v where v.status = 'rejected'),
      'revoked',  (select count(*) from public.clinician_verifications v where v.status = 'revoked'))
  );
end;
$$;

-- Overview: appeals only an admin can decide are the non-content ones.
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
                           where a.status = 'open' and m.target_kind not in ('post', 'comment')),
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
    'tickets_open', (select count(*) from public.support_tickets t where t.status = 'open'),
    'tickets_oldest', (select min(t.last_message_at) from public.support_tickets t where t.status = 'open'),
    -- …024 / …025: verification requests and advertising waiting for review.
    'clinicians_pending', (select count(*) from public.clinician_verifications v where v.status = 'pending'),
    'ads_pending', (select count(*) from public.advertisers a where a.status = 'pending')
                 + (select count(*) from public.ad_campaigns c where c.status = 'review')
                 + (select count(*) from public.ad_reports r where r.status = 'open'),
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

-- French copy is required for every campaign, so the Québec rule goes.
drop function private.ad_french_required(text, text);

-- Rate card: category and site-wide.
create or replace function public.ad_rate_card()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'enabled',      private.cfg_bool('ads.enabled'),
    'cpm',          jsonb_build_object('category', private.cfg_int('ads.cpm.category')::bigint,
                                       'national', private.cfg_int('ads.cpm.national')::bigint),
    'min_booking',  (private.cfg('ads.min_booking_microcad') #>> '{}')::bigint,
    'flight_days',  private.cfg_int('ads.flight_days'));
$$;

-- Advertisers: a billing country instead of a province.
drop function public.create_advertiser(text, text, text, text, text);
create function public.create_advertiser(
  p_name text, p_website text, p_billing_email text, p_billing_address text, p_billing_country text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_user();
  v_name text := btrim(coalesce(p_name, ''));
  v_id   uuid;
begin
  perform private.require_capability(v_uid, 'report');
  perform private.enforce_rate_limit(v_uid, 'ad_write');
  if char_length(v_name) not between 2 and 80 then
    perform private.raise_error('PF422', 'invalid_name');
  end if;
  if coalesce(p_website, '') !~ '^https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(/\S*)?$' or char_length(p_website) > 500 then
    perform private.raise_error('PF422', 'invalid_url');
  end if;
  if exists (select 1 from private.shield_matches(p_website) m where m.action = 'block') then
    perform private.raise_error('PF422', 'blocked_by_shield');
  end if;
  if coalesce(p_billing_email, '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform private.raise_error('PF422', 'invalid_email');
  end if;
  if p_billing_country is null or p_billing_country !~ '^[A-Z]{2}$' then
    perform private.raise_error('PF422', 'invalid_country');
  end if;
  if exists (select 1 from public.advertisers a where a.owner_id = v_uid) then
    perform private.raise_error('PF409', 'already_advertiser');
  end if;

  insert into public.advertisers (owner_id, name, website, billing_email, billing_address, billing_country)
  values (v_uid, v_name, p_website, lower(btrim(p_billing_email)), left(btrim(coalesce(p_billing_address, '')), 300), p_billing_country)
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.create_advertiser(text, text, text, text, text) to authenticated;

-- My advertiser: country, no zone.
create or replace function public.my_advertiser()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  a     public.advertisers;
begin
  select * into a from public.advertisers x where x.owner_id = v_uid;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'id', a.id, 'name', a.name, 'website', a.website, 'billing_email', a.billing_email,
    'billing_address', a.billing_address, 'billing_country', a.billing_country,
    'status', a.status, 'review_note', a.review_note, 'created_at', a.created_at,
    'balance', a.balance_microcad, 'reserved', a.reserved_microcad, 'available', a.balance_microcad - a.reserved_microcad,
    'campaigns', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'name', c.name, 'package', c.package, 'category_id', c.category_id,
               'budget', c.budget_microcad, 'cpm', c.cpm_microcad, 'reserved', c.reserved_microcad, 'spent', c.spent_microcad,
               'status', c.status, 'headline', c.headline, 'body', c.body, 'cta', c.cta,
               'headline_fr', c.headline_fr, 'body_fr', c.body_fr, 'cta_fr', c.cta_fr,
               'landing_url', c.landing_url, 'image_id', c.image_id,
               'starts_on', c.starts_on, 'ends_on', c.ends_on, 'review_note', c.review_note, 'reviewed_at', c.reviewed_at,
               'submitted_at', c.submitted_at, 'impressions', c.impressions, 'clicks', c.clicks,
               'created_at', c.created_at, 'updated_at', c.updated_at,
               'days', coalesce((select jsonb_agg(jsonb_build_object('day', d.day, 'impressions', d.impressions, 'clicks', d.clicks,
                                                                      'charged', d.charged_microcad, 'settled', d.settled_at is not null)
                                                   order by d.day desc)
                                 from (select * from public.ad_daily_stats s where s.campaign_id = c.id order by s.day desc limit 60) d), '[]'::jsonb))
             order by c.created_at desc)
      from public.ad_campaigns c where c.advertiser_id = a.id), '[]'::jsonb),
    'ledger', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'kind', l.kind, 'amount', l.amount_microcad, 'campaign_id', l.campaign_id,
                                          'reference', l.reference, 'note', l.note, 'created_at', l.created_at)
                       order by l.id desc)
      from (select * from public.ad_ledger x where x.advertiser_id = a.id order by x.id desc limit 100) l), '[]'::jsonb)
  );
end;
$$;

-- Campaigns: category or site-wide.
drop function public.upsert_campaign(uuid, text, text, text, text, bigint, text, text, text, text, text, text, text, uuid);
create function public.upsert_campaign(
  p_id uuid, p_name text, p_package text, p_category text, p_budget_microcad bigint,
  p_headline text, p_body text, p_cta text, p_headline_fr text, p_body_fr text, p_cta_fr text,
  p_landing_url text, p_image_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_user();
  a        public.advertisers;
  c        public.ad_campaigns;
  v_cat    text := nullif(btrim(coalesce(p_category, '')), '');
  v_french boolean;
  v_id     uuid;
begin
  perform private.require_capability(v_uid, 'report');
  perform private.enforce_rate_limit(v_uid, 'ad_write');
  a := private.my_advertiser_for_update(v_uid);
  if a.status = 'suspended' then
    perform private.raise_error('PF403', 'advertiser_suspended');
  end if;

  if p_package not in ('category', 'national') then
    perform private.raise_error('PF422', 'invalid_package');
  end if;
  if p_package = 'category' then
    if v_cat is null or not exists (select 1 from public.categories x where x.id = v_cat and x.archived_at is null) then
      perform private.raise_error('PF422', 'invalid_category');
    end if;
  else
    v_cat := null;
  end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 2 and 80 then
    perform private.raise_error('PF422', 'invalid_name');
  end if;
  if p_budget_microcad is null or p_budget_microcad < (private.cfg('ads.min_booking_microcad') #>> '{}')::bigint
     or p_budget_microcad > 1000000000000 then
    perform private.raise_error('PF422', 'budget_below_minimum');
  end if;
  if char_length(btrim(coalesce(p_headline, ''))) not between 3 and 60
     or char_length(btrim(coalesce(p_body, ''))) not between 10 and 160
     or char_length(btrim(coalesce(p_cta, ''))) not between 2 and 24 then
    perform private.raise_error('PF422', 'invalid_creative');
  end if;
  v_french := true;  -- every campaign needs French copy (…034)
  if v_french and (char_length(btrim(coalesce(p_headline_fr, ''))) not between 3 and 60
                   or char_length(btrim(coalesce(p_body_fr, ''))) not between 10 and 160
                   or char_length(btrim(coalesce(p_cta_fr, ''))) not between 2 and 24) then
    perform private.raise_error('PF422', 'french_required');
  end if;
  if char_length(coalesce(p_headline_fr, '')) > 60 or char_length(coalesce(p_body_fr, '')) > 160 or char_length(coalesce(p_cta_fr, '')) > 24 then
    perform private.raise_error('PF422', 'invalid_creative');
  end if;
  if coalesce(p_landing_url, '') !~ '^https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(/\S*)?$' or char_length(p_landing_url) > 1000 then
    perform private.raise_error('PF422', 'invalid_url');
  end if;
  -- No vendors, no sales: a landing page on a blocked domain is refused here, not in review.
  if exists (select 1 from private.shield_matches(p_landing_url) m where m.action = 'block')
     or exists (select 1 from private.shield_matches(p_headline || ' ' || p_body || ' ' || coalesce(p_headline_fr, '') || ' ' || coalesce(p_body_fr, '')) m where m.action = 'block') then
    perform private.raise_error('PF422', 'blocked_by_shield');
  end if;
  if p_image_id is not null and not exists (
       select 1 from public.media m where m.id = p_image_id and m.owner_id = v_uid and m.kind = 'ad_image' and m.status = 'ready') then
    perform private.raise_error('PF404', 'not_found', 'image');
  end if;

  if p_id is null then
    insert into public.ad_campaigns (advertiser_id, name, package, category_id, budget_microcad,
                                     headline, body, cta, headline_fr, body_fr, cta_fr, landing_url, image_id)
    values (a.id, btrim(p_name), p_package, v_cat, p_budget_microcad,
            btrim(p_headline), btrim(p_body), btrim(p_cta), btrim(coalesce(p_headline_fr, '')), btrim(coalesce(p_body_fr, '')), btrim(coalesce(p_cta_fr, '')),
            p_landing_url, p_image_id)
    returning id into v_id;
    return v_id;
  end if;

  select * into c from public.ad_campaigns x where x.id = p_id and x.advertiser_id = a.id for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'campaign');
  end if;
  if c.status not in ('draft', 'rejected') then
    perform private.raise_error('PF409', 'campaign_locked');
  end if;
  update public.ad_campaigns
     set name = btrim(p_name), package = p_package, category_id = v_cat, budget_microcad = p_budget_microcad,
         headline = btrim(p_headline), body = btrim(p_body), cta = btrim(p_cta),
         headline_fr = btrim(coalesce(p_headline_fr, '')), body_fr = btrim(coalesce(p_body_fr, '')), cta_fr = btrim(coalesce(p_cta_fr, '')),
         landing_url = p_landing_url, image_id = p_image_id,
         status = 'draft', review_note = '', reviewed_by = null, reviewed_at = null
   where id = c.id;
  return c.id;
end;
$$;
grant execute on function public.upsert_campaign(uuid, text, text, text, bigint, text, text, text, text, text, text, text, uuid) to authenticated;

-- Submitting a campaign: category or site-wide price.
create or replace function public.submit_campaign(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  a     public.advertisers;
  c     public.ad_campaigns;
begin
  perform private.require_capability(v_uid, 'report');
  perform private.enforce_rate_limit(v_uid, 'ad_write');
  a := private.my_advertiser_for_update(v_uid);
  if a.status <> 'active' then
    perform private.raise_error('PF403', 'advertiser_not_approved');
  end if;
  select * into c from public.ad_campaigns x where x.id = p_id and x.advertiser_id = a.id for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'campaign');
  end if;
  if c.status not in ('draft', 'rejected') then
    perform private.raise_error('PF409', 'campaign_locked');
  end if;
  if a.balance_microcad - a.reserved_microcad < c.budget_microcad then
    perform private.raise_error('PF422', 'insufficient_credit', (c.budget_microcad - (a.balance_microcad - a.reserved_microcad))::text);
  end if;

  update public.advertisers set reserved_microcad = reserved_microcad + c.budget_microcad where id = a.id;
  update public.ad_campaigns
     set status = 'review', reserved_microcad = budget_microcad, submitted_at = now(),
         cpm_microcad = case package when 'category' then private.cfg_int('ads.cpm.category')
                                     else private.cfg_int('ads.cpm.national') end,
         review_note = '', reviewed_by = null, reviewed_at = null
   where id = c.id;
end;
$$;

-- Serving ads: category or site-wide.
create or replace function public.get_ad(p_package text, p_target text, p_visitor text, p_locale text default 'en')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c        public.ad_campaigns;
  v_hour   timestamptz := date_trunc('hour', now());
  v_counts boolean;
begin
  if not private.cfg_bool('ads.enabled') then
    return null;
  end if;
  select x.* into c
  from public.ad_campaigns x
  join public.advertisers a on a.id = x.advertiser_id and a.status = 'active'
  where x.status = 'active'
    and current_date between x.starts_on and x.ends_on
    and x.spent_microcad < x.budget_microcad
    and ((p_package = 'national' and x.package = 'national')
      or (p_package = 'category' and x.package = 'category' and x.category_id = p_target))
    -- Today's unsettled impressions must still fit in the budget.
    and coalesce((select s.impressions from public.ad_daily_stats s where s.campaign_id = x.id and s.day = current_date), 0) * x.cpm_microcad / 1000
        < x.budget_microcad - x.spent_microcad
  order by random()
  limit 1;
  if not found then
    return null;
  end if;

  if coalesce(p_visitor, '') ~ '^[A-Za-z0-9_-]{8,128}$' then
    insert into public.ad_deliveries (campaign_id, visitor_hash, hour_bucket)
    values (c.id, p_visitor, v_hour)
    on conflict do nothing;
    v_counts := found;
    if v_counts then
      insert into public.ad_daily_stats (campaign_id, day, impressions) values (c.id, current_date, 1)
      on conflict (campaign_id, day) do update set impressions = public.ad_daily_stats.impressions + 1;
      update public.ad_campaigns set impressions = impressions + 1 where id = c.id;
    end if;
  end if;

  return jsonb_build_object(
    'id', c.id,
    'advertiser', (select a.name from public.advertisers a where a.id = c.advertiser_id),
    'headline', case when p_locale = 'fr' and c.headline_fr <> '' then c.headline_fr else c.headline end,
    'body',     case when p_locale = 'fr' and c.body_fr <> '' then c.body_fr else c.body end,
    'cta',      case when p_locale = 'fr' and c.cta_fr <> '' then c.cta_fr else c.cta end,
    'image_id', c.image_id);
end;
$$;

-- Ads console: country, no zone.
create or replace function public.admin_ads()
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
    'rate_card', public.ad_rate_card(),
    'advertisers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'name', a.name, 'website', a.website, 'billing_email', a.billing_email,
               'billing_country', a.billing_country, 'status', a.status, 'review_note', a.review_note,
               'owner', p.username, 'owner_tier', p.tier, 'created_at', a.created_at,
               'balance', a.balance_microcad, 'reserved', a.reserved_microcad,
               'campaigns', (select count(*) from public.ad_campaigns c where c.advertiser_id = a.id),
               'in_review', (select count(*) from public.ad_campaigns c where c.advertiser_id = a.id and c.status = 'review'))
             order by case a.status when 'pending' then 0 when 'active' then 1 else 2 end, a.created_at)
      from public.advertisers a join public.profiles p on p.id = a.owner_id), '[]'::jsonb),
    'campaigns', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'advertiser_id', c.advertiser_id, 'advertiser', a.name, 'owner', p.username,
               'name', c.name, 'package', c.package, 'category_id', c.category_id,
               'budget', c.budget_microcad, 'cpm', c.cpm_microcad, 'spent', c.spent_microcad, 'reserved', c.reserved_microcad,
               'status', c.status, 'headline', c.headline, 'body', c.body, 'cta', c.cta,
               'headline_fr', c.headline_fr, 'body_fr', c.body_fr, 'cta_fr', c.cta_fr,
               'landing_url', c.landing_url, 'image_id', c.image_id,
               'starts_on', c.starts_on, 'ends_on', c.ends_on, 'submitted_at', c.submitted_at,
               'review_note', c.review_note, 'reviewed_by', (select r.username from public.profiles r where r.id = c.reviewed_by),
               'impressions', c.impressions, 'clicks', c.clicks,
               'open_reports', (select count(*) from public.ad_reports r where r.campaign_id = c.id and r.status = 'open'))
             order by case c.status when 'review' then 0 when 'active' then 1 when 'paused' then 2 else 3 end, c.submitted_at, c.created_at desc)
      from public.ad_campaigns c
      join public.advertisers a on a.id = c.advertiser_id
      join public.profiles p on p.id = a.owner_id
      where c.status <> 'draft'), '[]'::jsonb),
    'reports', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'campaign_id', r.campaign_id, 'campaign', c.name, 'advertiser', a.name,
                                          'reason', r.reason, 'details', r.details, 'reporter', p.username, 'created_at', r.created_at)
                       order by r.created_at)
      from public.ad_reports r
      join public.ad_campaigns c on c.id = r.campaign_id
      join public.advertisers a on a.id = c.advertiser_id
      join public.profiles p on p.id = r.reporter_id
      where r.status = 'open'), '[]'::jsonb),
    'ledger', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'advertiser', a.name, 'kind', l.kind, 'amount', l.amount_microcad,
                                          'reference', l.reference, 'note', l.note, 'by', (select x.username from public.profiles x where x.id = l.actor_id),
                                          'created_at', l.created_at)
                       order by l.id desc)
      from (select * from public.ad_ledger order by id desc limit 100) l
      join public.advertisers a on a.id = l.advertiser_id), '[]'::jsonb),
    'totals', jsonb_build_object(
      'balance',  (select coalesce(sum(a.balance_microcad), 0) from public.advertisers a),
      'reserved', (select coalesce(sum(a.reserved_microcad), 0) from public.advertisers a),
      'charged_30d', (select coalesce(-sum(l.amount_microcad), 0) from public.ad_ledger l where l.kind = 'charge' and l.created_at > now() - interval '30 days'),
      'pending_advertisers', (select count(*) from public.advertisers a where a.status = 'pending'),
      'campaigns_in_review', (select count(*) from public.ad_campaigns c where c.status = 'review'),
      'open_reports', (select count(*) from public.ad_reports r where r.status = 'open'))
  );
end;
$$;

-- Campaign review: no zone.
create or replace function public.admin_review_campaign(p_id uuid, p_decision text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
  c     public.ad_campaigns;
  a     public.advertisers;
begin
  if p_decision not in ('approve', 'reject') then
    perform private.raise_error('PF422', 'invalid_decision');
  end if;
  select * into c from public.ad_campaigns x where x.id = p_id for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'campaign');
  end if;
  select * into a from public.advertisers x where x.id = c.advertiser_id for update;
  if a.owner_id = v_uid then
    perform private.raise_error('PF403', 'conflict_of_interest');
  end if;
  if c.status <> 'review' then
    perform private.raise_error('PF409', 'not_pending');
  end if;

  if p_decision = 'approve' then
    update public.ad_campaigns
       set status = 'active', starts_on = current_date, ends_on = current_date + (private.cfg_int('ads.flight_days') - 1),
           review_note = btrim(p_reason), reviewed_by = v_uid, reviewed_at = now()
     where id = c.id;
  else
    update public.advertisers set reserved_microcad = reserved_microcad - c.reserved_microcad where id = a.id;
    update public.ad_campaigns
       set status = 'rejected', reserved_microcad = 0, review_note = btrim(p_reason), reviewed_by = v_uid, reviewed_at = now()
     where id = c.id;
  end if;
  perform private.log_mod_action(v_uid, case when p_decision = 'approve' then 'ad_approved' else 'ad_rejected' end,
                                 'campaign', c.id, a.owner_id, null, p_reason,
                                 jsonb_build_object('name', c.name, 'package', c.package, 'budget', c.budget_microcad));
  perform private.notify(a.owner_id, 'ad_review', 'campaign:' || c.id || ':' || p_decision || ':' || extract(epoch from now())::bigint,
                         null, null, null, null, null, null,
                         jsonb_build_object('action', case when p_decision = 'approve' then 'ad_approved' else 'ad_rejected' end,
                                            'reason', btrim(p_reason), 'campaign', c.name));
end;
$$;

-- Campaign suspension: no zone.
create or replace function public.admin_suspend_campaign(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
  c     public.ad_campaigns;
  a     public.advertisers;
begin
  select * into c from public.ad_campaigns x where x.id = p_id for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'campaign');
  end if;
  if c.status not in ('review', 'approved', 'active', 'paused') then
    perform private.raise_error('PF409', 'campaign_locked');
  end if;
  select * into a from public.advertisers x where x.id = c.advertiser_id for update;
  update public.advertisers set reserved_microcad = reserved_microcad - c.reserved_microcad where id = a.id;
  update public.ad_campaigns
     set status = 'suspended', reserved_microcad = 0, review_note = btrim(p_reason), reviewed_by = v_uid, reviewed_at = now()
   where id = c.id;
  update public.ad_reports set status = 'resolved', resolution = 'suspended', resolved_by = v_uid, resolved_at = now()
   where campaign_id = c.id and status = 'open';
  perform private.log_mod_action(v_uid, 'ad_suspended', 'campaign', c.id, a.owner_id, null, p_reason, jsonb_build_object('name', c.name));
  perform private.notify(a.owner_id, 'ad_review', 'campaign:' || c.id || ':suspended:' || extract(epoch from now())::bigint,
                         null, null, null, null, null, null,
                         jsonb_build_object('action', 'ad_suspended', 'reason', btrim(p_reason), 'campaign', c.name));
end;
$$;

-- Images on hidden posts: visible to moderators (site-wide).
create or replace function private.media_visible(m public.media)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select m.status = 'ready' and (
    -- Your own uploads, always (a pending one too, so you can check it).
    coalesce(m.owner_id = auth.uid(), false)
    or (m.kind = 'post_image' and m.post_id is not null and exists (
          select 1 from public.posts p
          where p.id = m.post_id
            and (p.status in ('visible', 'collapsed')
                 or coalesce(p.author_id = auth.uid(), false)
                 or coalesce(private.is_moderator(auth.uid()) and private.staff_session(), false))))
    or (m.kind = 'post_image' and coalesce(private.is_admin(auth.uid()) and private.staff_session(), false))
    or (m.kind = 'credential' and coalesce(private.is_admin(auth.uid()) and private.staff_session(), false))
    -- …025
    or (m.kind = 'ad_image' and (coalesce(private.is_admin(auth.uid()) and private.staff_session(), false)
                                 or exists (select 1 from public.ad_campaigns c where c.image_id = m.id and c.status in ('active', 'paused', 'completed'))))
    -- …027: a profile picture is public while it is someone's current one
    or (m.kind = 'avatar' and (exists (select 1 from public.profiles p where p.avatar_media_id = m.id and p.deleted_at is null)
                               or coalesce(private.is_admin(auth.uid()) and private.staff_session(), false)))
  ) or (m.status = 'pending' and coalesce(m.owner_id = auth.uid(), false));
$$;

-- Deleting an account removes its moderator role.
create or replace function private.tombstone_profile(p_user uuid, p_erase_content boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_adv uuid;
begin
  update public.profiles
     set username             = 'deleted_' || substr(md5(id::text), 1, 10),
         bio                  = '',
         coi                  = '',
         rater_status         = 'none',
         founding_until       = null,
         avatar_media_id      = null,
         deleted_at           = coalesce(deleted_at, now())
   where id = p_user;

  delete from public.user_roles      where user_id = p_user;
  delete from public.moderators      where user_id = p_user;
  -- Follows go both ways (…027).
  delete from public.follows where follower_id = p_user or followee_id = p_user;
  -- Verified social accounts too, so they can back another account later (…028).
  delete from public.social_accounts where user_id = p_user;
  -- Tickets are private correspondence with the team: they go with the account (…020).
  delete from public.support_tickets  where member_id = p_user;
  -- So do notifications, preferences and push browsers (…022).
  delete from public.notifications         where user_id = p_user;
  delete from public.notification_settings where user_id = p_user;
  delete from public.push_subscriptions    where user_id = p_user;
  -- Registration numbers and credential documents go with the account (…024).
  delete from public.clinician_verifications where user_id = p_user;
  -- Advertising: campaigns stop, reservations are released, the ledger stays (…025).
  select a.id into v_adv from public.advertisers a where a.owner_id = p_user;
  if v_adv is not null then
    update public.ad_campaigns set status = 'suspended', reserved_microcad = 0
     where advertiser_id = v_adv and status in ('draft', 'review', 'approved', 'active', 'paused');
    update public.advertisers set status = 'suspended', reserved_microcad = 0, review_note = 'Account deleted' where id = v_adv;
  end if;
  -- Uploads are removed; the worker deletes the bytes (…023). Ad images on finished campaigns stay with the record.
  update public.media set status = 'removed', removed_reason = 'account_deleted', post_id = null
   where owner_id = p_user and status <> 'removed' and kind <> 'ad_image';

  if p_erase_content then
    update public.posts
       set status = 'deleted', status_changed_at = now(), title = '[deleted post]', body = '', link_url = null
     where author_id = p_user;
    update public.post_revisions r
       set title = '[deleted post]', body = '', link_url = null
      from public.posts p
     where p.id = r.post_id and p.author_id = p_user;
    update public.comments
       set status = 'deleted', status_changed_at = now(), body = '[deleted]'
     where author_id = p_user;
  end if;
end;
$$;

-- Profiles: a moderator flag instead of zones.
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
    'clinician',     private.clinician_badge(p.id),   -- …024
    -- …027: picture and follows. The viewer-relative flags are false for anonymous visitors.
    'avatar',        private.avatar_id(p.id),
    'followers',     (select count(*) from public.follows f where f.followee_id = p.id),
    'following',     (select count(*) from public.follows f where f.follower_id = p.id),
    'is_following',  coalesce(exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.followee_id = p.id), false),
    'follows_you',   coalesce(exists (select 1 from public.follows f where f.follower_id = p.id and f.followee_id = auth.uid()), false),
    -- …028: verified social accounts, largest audience first.
    'socials',       coalesce((select jsonb_agg(jsonb_build_object('platform', s.platform, 'handle', s.handle, 'audience', s.audience,
                                                                  'url', s.profile_url, 'verified_at', s.verified_at) order by s.audience desc)
                               from public.social_accounts s where s.user_id = p.id and p.deleted_at is null), '[]'::jsonb),
    'is_moderator',  exists (select 1 from public.moderators m where m.user_id = p.id),
    'post_count',    (select count(*) from public.posts x where x.author_id = p.id and x.status in ('visible', 'collapsed')),
    'comment_count', (select count(*) from public.comments x where x.author_id = p.id and x.status in ('visible', 'collapsed'))
  )
  from public.profiles p
  where lower(p.username) = lower(p_username);
$$;

-- The feed: no zone or city.
drop function public.get_feed(text, text, text, text, text, integer, integer, boolean);
create function public.get_feed(
  p_category        text    default null,
  p_author_username text    default null,
  p_sort            text    default 'hot',
  p_limit           integer default 25,
  p_offset          integer default 0,
  p_following       boolean default false   -- …029: only people the caller follows
)
returns table (
  id              uuid,
  title           text,
  excerpt         text,
  post_type       text,
  link_url        text,
  language        text,
  status          text,
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
  pinned          boolean,
  author_avatar   uuid                     -- …029
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.title, left(p.body, 400), p.post_type, p.link_url, p.language, p.status,
         p.category_id,
         a.username, a.tier, a.karma,
         p.score, p.comment_count, p.created_at, p.edited_at,
         (select v.value from public.post_votes v where v.post_id = p.id and v.voter_id = auth.uid()),
         exists (select 1 from public.notes n where n.post_id = p.id and n.status = 'helpful' and n.hidden_at is null),
         exists (select 1 from public.notes n where n.post_id = p.id and n.status = 'needs_more_ratings'
                                                and n.locked_at is null and n.hidden_at is null),
         -- Pins lead the community feed (…034: no zones).
         p.pinned_at is not null and p_author_username is null and p_category is null
           and not coalesce(p_following, false),
         private.avatar_id(a.id)
  from public.posts p
  join public.profiles a on a.id = p.author_id
  where p.status in ('visible', 'collapsed')
    and (p_category is null or p.category_id = p_category)
    and (p_author_username is null or lower(a.username) = lower(p_author_username))
    -- Following: false for anonymous callers (auth.uid() is null), so they get nothing.
    and (not coalesce(p_following, false)
         or exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.followee_id = p.author_id))
  order by
    (p.pinned_at is not null and p_author_username is null and p_category is null
       and not coalesce(p_following, false)) desc,
    case p_sort
      when 'new' then extract(epoch from p.created_at)
      when 'top' then p.score::numeric
      else p.score / power(extract(epoch from (now() - p.created_at)) / 3600 + 2, 1.5)
    end desc,
    p.created_at desc
  limit least(greatest(coalesce(p_limit, 25), 1), 50)
  offset least(greatest(coalesce(p_offset, 0), 0), 1000);
$$;
grant execute on function public.get_feed(text, text, text, integer, integer, boolean) to anon, authenticated;

-- A post: no zone or city; moderators are site-wide.
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
  comments_locked boolean,
  author_clinician text,
  author_avatar   uuid   -- …029
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
         p.category_id,
         a.username, a.tier, a.karma,
         coalesce(p.author_id = auth.uid(), false),
         p.score, p.comment_count, p.revision, p.created_at, p.edited_at,
         (select v.value from public.post_votes v where v.post_id = p.id and v.voter_id = auth.uid()),
         coalesce(private.is_moderator(auth.uid()) and private.staff_session(), false),
         p.pinned_at is not null,
         p.comments_locked_at is not null,
         private.clinician_badge(a.id),   -- …024
         private.avatar_id(a.id)          -- …029
  from public.posts p
  join public.profiles a on a.id = p.author_id
  where p.id = p_post_id
    and (p.status in ('visible', 'collapsed')
         or p.author_id = auth.uid()
         or (private.is_moderator(auth.uid()) and private.staff_session()));
$$;
grant execute on function public.get_post(uuid) to anon, authenticated;

-- Comments: moderators are site-wide.
create or replace function public.get_comments(p_post_id uuid)
returns table (
  id              uuid,
  parent_id       uuid,
  depth           smallint,
  author_username text,
  author_tier     smallint,
  is_op           boolean,
  is_mine         boolean,
  body            text,
  status          text,
  score           integer,
  created_at      timestamptz,
  edited_at       timestamptz,
  my_vote         smallint,
  author_clinician text,
  author_avatar   uuid   -- …029
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.parent_id, c.depth,
         a.username, a.tier,
         c.author_id = p.author_id,
         coalesce(c.author_id = auth.uid(), false),
         case
           -- NULL-safe: for anonymous callers auth.uid() is NULL, and NOT (NULL) would
           -- fall through to the original text.
           when c.status = 'removed'
                and not coalesce(c.author_id = auth.uid()
                                 or (private.is_moderator(auth.uid()) and private.staff_session()), false)
             then '[removed by a moderator]'
           else c.body
         end,
         c.status, c.score, c.created_at, c.edited_at,
         (select v.value from public.comment_votes v where v.comment_id = c.id and v.voter_id = auth.uid()),
         private.clinician_badge(a.id),   -- …024
         private.avatar_id(a.id)          -- …029
  from public.comments c
  join public.posts p on p.id = c.post_id
  join public.profiles a on a.id = c.author_id
  where c.post_id = p_post_id
    and p.status in ('visible', 'collapsed')
    -- Held comments: only their author and the moderators see them.
    and (c.status <> 'held'
         or coalesce(c.author_id = auth.uid()
                     or (private.is_moderator(auth.uid()) and private.staff_session()), false))
  order by c.created_at;
$$;

-- The moderation log keeps its signature; the zone argument is ignored.
create or replace function private.log_mod_action(
  p_actor uuid, p_action text, p_target_kind text, p_target_id uuid,
  p_target_user uuid, p_zone text, p_reason text, p_metadata jsonb default '{}'::jsonb
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  -- p_zone is kept so its 54 callers stay unchanged; it is ignored since …034 (no zones).
  insert into public.mod_actions (actor_id, action, target_kind, target_id, target_user_id, reason, metadata)
  values (p_actor, p_action, p_target_kind, p_target_id, p_target_user, coalesce(p_reason, ''), coalesce(p_metadata, '{}'::jsonb))
  returning id;
$$;

-- ---------------------------------------------------------------------------
-- What only zones used
-- ---------------------------------------------------------------------------
drop function public.set_zone_moderator(uuid, text, boolean, text);
drop function public.admin_upsert_city(text, text, text, smallint, text);
drop function public.admin_update_zone(text, text, text, text, text, text, text);
drop function private.require_zone_mod(uuid, text);
drop function private.is_zone_mod(uuid, text);

-- Columns (their zone indexes and the campaign package/zone check go with them).
alter table public.posts drop column zone_id, drop column city_id;
alter table public.reports drop column zone_id;
alter table public.mod_actions drop column zone_id;
alter table public.profiles drop column home_zone_id;
alter table public.clinician_verifications drop column province_id;
alter table public.advertisers drop column billing_province;
alter table public.ad_campaigns drop column zone_id;

alter table public.ad_campaigns drop constraint ad_campaigns_package_check;
alter table public.ad_campaigns add constraint ad_campaigns_package_check check (package in ('category', 'national'));
alter table public.ad_campaigns add constraint ad_campaigns_package_target_check
  check ((package = 'category' and category_id is not null) or (package = 'national' and category_id is null));

-- Indexes that replace the zone ones.
create index posts_pinned on public.posts (pinned_at desc) where pinned_at is not null;
create index reports_open on public.reports (created_at) where status = 'open';
create index ad_campaigns_serving on public.ad_campaigns (status, package, category_id) where status = 'active';

drop table public.zone_moderators;
drop table public.cities;
drop table public.zones;
