-- ============================================================================
-- 0003 · Identity: profiles, roles, sanctions, strikes, capabilities
--
-- A member's standing is three independent things (docs/SELF_MODERATION.md):
--   karma      community standing from votes and helpful notes → posting tiers
--   mod_xp     moderation progress from accurate ratings/reports → note powers
--   integrity  0–100, reduced by active strikes → can switch privileges off
--
-- None of these columns is writable by any API role. They change only through
-- the ledger (0005) and settlement functions (0006, 0007).
-- ============================================================================

create table public.profiles (
  -- Equal to auth.users.id. Deliberately no FK: when an auth user is deleted
  -- (Loi 25 / PIPEDA erasure) the profile is tombstoned rather than removed, so
  -- the append-only ledger and other members' history stay consistent.
  id                   uuid primary key,
  username             text        not null check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  locale               text        not null default 'en' check (locale in ('en', 'fr')),
  home_zone_id         text references public.zones (id),
  bio                  text        not null default '' check (char_length(bio) <= 500),
  -- Conflicts of interest (employer, clinic, lab…). Shown next to notes in mod views.
  coi                  text        not null default '' check (char_length(coi) <= 300),

  -- Cached from public.ledger_events by trigger; never written directly.
  karma                integer       not null default 0,
  mod_xp               numeric(10,2) not null default 0,
  tier                 smallint      not null default 0 check (tier between 0 and 4),

  -- Community-notes standing.
  rater_status         text not null default 'none'
                         check (rater_status in ('none', 'probation', 'active', 'founding')),
  rater_impact         integer not null default 0,  -- settled ratings that matched − that didn't
  writer_impact        integer not null default 0,  -- helpful notes written − not-helpful notes
  founding_until       timestamptz,
  writing_locked_until timestamptz,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);
create unique index profiles_username_unique on public.profiles (lower(username));
create index profiles_karma on public.profiles (karma desc) where deleted_at is null;

create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();

comment on column public.profiles.karma is 'Cached sum of ledger_events(track=karma). Source of truth is the ledger.';
comment on column public.profiles.tier  is '0 Newcomer · 1 Member · 2 Trusted · 3 Contributor · 4 Steward. Hysteresis in private.apply_ledger_event().';

-- Platform administrators. Moderators are per zone (zone_moderators).
create table public.user_roles (
  user_id    uuid not null references public.profiles (id),
  role       text not null check (role in ('admin')),
  granted_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table public.zone_moderators (
  zone_id     text not null references public.zones (id),
  user_id     uuid not null references public.profiles (id),
  appointed_by uuid references public.profiles (id),
  created_at  timestamptz not null default now(),
  primary key (zone_id, user_id)
);

-- Moderator/admin-imposed restrictions. `freeze` blocks posting and notes,
-- `suspension` and `ban` block every write. Warnings are recorded only.
create table public.sanctions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id),
  kind        text not null check (kind in ('warning', 'freeze', 'suspension', 'ban')),
  reason      text not null check (char_length(reason) between 3 and 500),
  issued_by   uuid references public.profiles (id),   -- null = automatic
  starts_at   timestamptz not null default now(),
  ends_at     timestamptz,                             -- null = indefinite
  revoked_at  timestamptz,
  revoked_by  uuid references public.profiles (id),
  created_at  timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);
create index sanctions_user_active on public.sanctions (user_id) where revoked_at is null;

-- Strikes lower integrity while active (default 90 days). Unique per source so
-- settlement and moderation can be re-run safely.
create table public.strikes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id),
  reason      text not null check (reason in ('note_misleading', 'mod_removal', 'sourcing', 'sanction')),
  points      smallint not null check (points between 1 and 100),
  source_kind text not null,
  source_id   uuid not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  unique (user_id, reason, source_kind, source_id)
);
create index strikes_user_active on public.strikes (user_id, expires_at) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Predicates (used by RLS policies and RPCs)
-- ---------------------------------------------------------------------------
create function private.is_admin(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and exists (
    select 1 from public.user_roles r where r.user_id = p_user and r.role = 'admin'
  );
$$;

create function private.is_zone_mod(p_user uuid, p_zone text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and (
    private.is_admin(p_user)
    or exists (select 1 from public.zone_moderators m where m.user_id = p_user and m.zone_id = p_zone)
  );
$$;

create function private.is_moderator(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and (
    private.is_admin(p_user)
    or exists (select 1 from public.zone_moderators m where m.user_id = p_user)
  );
$$;

-- Staff *reads* (other members' ledgers, note authorship, pre-lock rating
-- breakdowns, sanctions) need the same MFA session as staff writes: a stolen
-- moderator password alone must not unmask anyone.
create function private.staff_session()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not private.cfg_bool('security.require_mfa_for_staff')
      or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;

create function private.integrity(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(0, 100 - coalesce(sum(s.points), 0))::integer
  from public.strikes s
  where s.user_id = p_user
    and s.revoked_at is null
    and s.expires_at > now();
$$;

create function private.has_active_sanction(p_user uuid, p_kinds text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.sanctions s
    where s.user_id = p_user
      and s.kind = any (p_kinds)
      and s.revoked_at is null
      and s.starts_at <= now()
      and (s.ends_at is null or s.ends_at > now())
  );
$$;

-- Founding raters lose their bypass when `founding_until` passes; after that
-- they are judged on impact like everyone else.
create function private.effective_rater_status(p_profile public.profiles)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_profile.rater_status = 'founding'
         and (p_profile.founding_until is null or p_profile.founding_until > now()) then 'founding'
    when p_profile.rater_status = 'founding'
         and p_profile.rater_impact >= private.cfg_int('notes.graduation_impact') then 'active'
    when p_profile.rater_status = 'founding' then 'probation'
    else p_profile.rater_status
  end;
$$;

-- ---------------------------------------------------------------------------
-- Capabilities
--
-- Returns NULL when the user may perform `p_capability`, otherwise a reason
-- key the UI can explain (e.g. 'tier:2', 'account_age:30', 'integrity:70').
-- Thresholds come from app_config `gates.*`. Every write RPC calls
-- private.require_capability(); the UI calls public.my_capabilities().
-- ---------------------------------------------------------------------------
create function private.capability_check(p_user uuid, p_capability text)
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

create function private.has_capability(p_user uuid, p_capability text)
returns boolean
language sql
stable
set search_path = ''
as $$ select private.capability_check(p_user, p_capability) is null $$;

create function private.require_capability(p_user uuid, p_capability text)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_reason text := private.capability_check(p_user, p_capability);
begin
  if v_reason is not null then
    perform private.raise_error('PF403', 'capability_denied', p_capability || ':' || v_reason);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Profile creation on sign-up
--
-- Only `username`, `locale` and `home_zone` are read from user metadata, and
-- they're validated here. Metadata is user-editable (auth.updateUser), so it
-- is never trusted for anything that grants privileges.
-- ---------------------------------------------------------------------------
create function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_username text := new.raw_user_meta_data ->> 'username';
  v_locale   text := coalesce(new.raw_user_meta_data ->> 'locale', 'en');
  v_zone     text := new.raw_user_meta_data ->> 'home_zone';
begin
  if v_username is null or v_username !~ '^[A-Za-z0-9_]{3,20}$' then
    perform private.raise_error('PF422', 'invalid_username');
  end if;
  if lower(v_username) ~ '^(deleted_|admin|mod_|moderator|pepforum|system|support|staff)' then
    perform private.raise_error('PF422', 'reserved_username');
  end if;
  if v_locale not in ('en', 'fr') then
    v_locale := 'en';
  end if;
  if v_zone is not null and not exists (select 1 from public.zones z where z.id = v_zone) then
    v_zone := null;
  end if;

  insert into public.profiles (id, username, locale, home_zone_id)
  values (new.id, v_username, v_locale, v_zone);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.user_roles      enable row level security;
alter table public.zone_moderators enable row level security;
alter table public.sanctions       enable row level security;
alter table public.strikes         enable row level security;

-- Every row is public, but only some columns are (see grants below):
-- mod_xp, rater/writer impact and rater status change when a note settles,
-- so exposing them would let anyone diff profiles to unmask pseudonymous note
-- writers and see how each rater voted.
create policy profiles_public_read on public.profiles
  for select to anon, authenticated using (true);

-- Members may edit their own descriptive fields. Column-level grants below
-- restrict *which* columns; this policy restricts *which row*.
create policy profiles_self_update on public.profiles
  for update to authenticated
  using (id = auth.uid() and deleted_at is null)
  with check (id = auth.uid() and deleted_at is null);

create policy user_roles_self_or_admin_read on public.user_roles
  for select to authenticated
  using (user_id = auth.uid() or (private.is_admin(auth.uid()) and private.staff_session()));

create policy zone_moderators_public_read on public.zone_moderators
  for select to anon, authenticated using (true);

create policy sanctions_self_or_mod_read on public.sanctions
  for select to authenticated
  using (user_id = auth.uid() or (private.is_moderator(auth.uid()) and private.staff_session()));

create policy strikes_self_or_mod_read on public.strikes
  for select to authenticated
  using (user_id = auth.uid() or (private.is_moderator(auth.uid()) and private.staff_session()));

grant select (id, username, locale, home_zone_id, bio, coi, karma, tier, created_at, deleted_at)
  on public.profiles to anon, authenticated;
grant select on public.profiles to service_role;
grant update (bio, locale, home_zone_id, coi) on public.profiles to authenticated;
grant select on public.zone_moderators to anon, authenticated;
grant select on public.user_roles, public.strikes to authenticated;
-- The sanctioned member sees what and why, not which moderator acted
-- (issued_by / revoked_by are withheld to prevent retaliation).
grant select (id, user_id, kind, reason, starts_at, ends_at, revoked_at, created_at)
  on public.sanctions to authenticated;

grant execute on function private.is_admin(uuid)            to anon, authenticated;
grant execute on function private.is_zone_mod(uuid, text)   to anon, authenticated;
grant execute on function private.is_moderator(uuid)        to anon, authenticated;
grant execute on function private.staff_session()           to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Public RPCs
-- ---------------------------------------------------------------------------
create function public.username_available(p_username text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_username ~ '^[A-Za-z0-9_]{3,20}$'
     and lower(p_username) !~ '^(deleted_|admin|mod_|moderator|pepforum|system|support|staff)'
     and not exists (select 1 from public.profiles p where lower(p.username) = lower(p_username));
$$;
grant execute on function public.username_available(text) to anon, authenticated;

-- Everything the UI needs to explain a member's standing and next unlocks.
create function public.my_standing()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  p     public.profiles;
  v_caps jsonb := '{}'::jsonb;
  v_cap  text;
begin
  select * into p from public.profiles where id = v_uid;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'profile');
  end if;

  foreach v_cap in array array['vote', 'comment', 'report', 'post_text', 'post_link', 'rate_notes', 'write_notes', 'steward'] loop
    v_caps := v_caps || jsonb_build_object(v_cap, private.capability_check(v_uid, v_cap));
  end loop;

  return jsonb_build_object(
    'user_id',              p.id,
    'username',             p.username,
    'karma',                p.karma,
    'mod_xp',               p.mod_xp,
    'tier',                 p.tier,
    'integrity',            private.integrity(v_uid),
    'rater_status',         private.effective_rater_status(p),
    'rater_impact',         p.rater_impact,
    'writer_impact',        p.writer_impact,
    'writing_locked_until', p.writing_locked_until,
    'is_moderator',         private.is_moderator(v_uid),
    'is_admin',             private.is_admin(v_uid),
    'capabilities',         v_caps,   -- null = allowed, otherwise reason key
    'tier_thresholds',      private.cfg('tiers.thresholds'),
    'active_strikes', coalesce((
      select jsonb_agg(jsonb_build_object('reason', s.reason, 'points', s.points, 'expires_at', s.expires_at) order by s.created_at)
      from public.strikes s
      where s.user_id = v_uid and s.revoked_at is null and s.expires_at > now()
    ), '[]'::jsonb),
    'active_sanctions', coalesce((
      select jsonb_agg(jsonb_build_object('kind', s.kind, 'reason', s.reason, 'ends_at', s.ends_at) order by s.created_at)
      from public.sanctions s
      where s.user_id = v_uid and s.revoked_at is null and s.starts_at <= now()
        and (s.ends_at is null or s.ends_at > now()) and s.kind <> 'warning'
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.my_standing() to authenticated;
