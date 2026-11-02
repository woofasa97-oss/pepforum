-- Social sign-in (every OAuth provider Supabase Auth offers: Google, Apple,
-- Facebook, X, Discord, GitHub, …).
--
-- OAuth sign-ups never pass through our sign-up form, so they arrive without a
-- username, age acknowledgement or terms acceptance. Rather than trust what the
-- identity provider sends (a display name would also break pseudonymity), the
-- sign-up trigger gives them a placeholder username and flags the profile
-- `needs_onboarding`. Until the member chooses a username and confirms they are
-- an adult (`complete_onboarding`), every capability is denied with the reason
-- `onboarding`. See docs/THREAT_MODEL.md and docs/DATA_PRIVACY.md.

alter table public.profiles add column needs_onboarding boolean not null default false;
-- Deliberately not added to the column-level SELECT grant: members read their
-- own flag through my_standing().

-- ---------------------------------------------------------------------------
-- Sign-up trigger: placeholder username for social providers
-- ---------------------------------------------------------------------------
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
  v_zone     text    := new.raw_user_meta_data ->> 'home_zone';
begin
  if v_social then
    -- Never take a username or zone from the provider's profile.
    v_zone := null;
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
  if v_zone is not null and not exists (select 1 from public.zones z where z.id = v_zone) then
    v_zone := null;
  end if;

  insert into public.profiles (id, username, locale, home_zone_id, needs_onboarding)
  values (new.id, v_username, v_locale, v_zone, v_social);
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Capabilities: nothing is allowed until onboarding is complete
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

-- ---------------------------------------------------------------------------
-- my_standing(): expose the member's own onboarding flag
-- ---------------------------------------------------------------------------
create or replace function public.my_standing()
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
    'needs_onboarding',     p.needs_onboarding,
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

-- ---------------------------------------------------------------------------
-- complete_onboarding(): the social sign-up equivalent of the sign-up form
-- ---------------------------------------------------------------------------
create function public.complete_onboarding(p_username text, p_home_zone text, p_adult boolean)
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
  if p_home_zone is not null
     and not exists (select 1 from public.zones z where z.id = p_home_zone and z.id <> 'national') then
    perform private.raise_error('PF422', 'invalid_zone');
  end if;
  if exists (select 1 from public.profiles p where lower(p.username) = lower(p_username) and p.id <> v_uid) then
    perform private.raise_error('PF409', 'username_taken');
  end if;

  update public.profiles
     set username = p_username, home_zone_id = p_home_zone, needs_onboarding = false
   where id = v_uid;
exception
  when unique_violation then  -- lost a race for the same username
    perform private.raise_error('PF409', 'username_taken');
end;
$$;
grant execute on function public.complete_onboarding(text, text, boolean) to authenticated;

insert into public.app_config (key, value, is_public, description) values
  ('rate_limit.onboarding', '{"limit": 20, "window_seconds": 3600}', false, 'Successful complete_onboarding() calls per hour (it can succeed only once).');
