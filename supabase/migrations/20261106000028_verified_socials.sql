-- ============================================================================
-- 0028 · Verified social accounts and the audience bonus
--
-- A member proves they own an X, YouTube, Instagram, TikTok or Reddit
-- account by signing in to it from Settings. The web server does that OAuth
-- exchange, reads the account's id, handle and audience (followers or
-- subscribers) from the network's API, throws the token away, and passes
-- the result here with an HMAC signature. This schema only accepts results
-- signed with the attestation key it shares with the web server
-- (private.app_secrets 'social_attestation'), less than 15 minutes old and
-- bound to the caller — so calling the RPC directly with made-up numbers
-- does nothing. Each network account can back one Pepforum account only.
--
-- Profiles show the verified accounts as badges. The karma bonus is one-time
-- and capped (the owner's choice: "badge + capped bonus"):
--     bonus = min(max, step × (1 + floor(log10(audience / min))))
-- for the member's largest verified audience, 0 below `min`. Defaults: 1k →
-- 25, 10k → 50, 100k → 75, 1M+ → 100 karma, i.e. at most enough for Member;
-- Trusted and above are still earned on Pepforum. The bonus is one ledger
-- fact (event 'social_bonus:<user>'), reconciled whenever accounts change:
-- unlinking the last account, or an admin removing one (logged as
-- 'social_unlinked'), takes it back.
-- ============================================================================

create table private.app_secrets (
  name  text primary key check (name ~ '^[a-z_]+$'),
  value text not null check (char_length(value) >= 32)
);
alter table private.app_secrets enable row level security;   -- no policies: definer functions only
-- Owner sets it once in the SQL editor (docs/DEPLOYMENT.md), with the same
-- value as SOCIAL_ATTESTATION_KEY on the web service.

create table public.social_accounts (
  user_id     uuid        not null references public.profiles (id),
  platform    text        not null check (platform in ('x', 'youtube', 'instagram', 'tiktok', 'reddit')),
  external_id text        not null check (char_length(external_id) between 1 and 100),
  handle      text        not null check (char_length(handle) between 1 and 100),
  audience    bigint      not null check (audience >= 0),
  profile_url text        not null check (profile_url ~ '^https://\S+$' and char_length(profile_url) <= 300),
  metrics     jsonb       not null default '{}'::jsonb,
  verified_at timestamptz not null default now(),
  primary key (user_id, platform),
  unique (platform, external_id)
);
alter table public.social_accounts enable row level security;
-- Read through get_profile() and my_social_accounts(); nobody gets table access.

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
  'member_reports_actioned', 'member_reports_dismissed',
  'redirect_set', 'redirect_removed',
  'media_removed',
  'clinician_approved', 'clinician_rejected', 'clinician_revoked',
  'advertiser_approved', 'advertiser_suspended', 'ad_approved', 'ad_rejected', 'ad_suspended',
  'ad_payment_recorded', 'ad_adjustment', 'ad_report_resolved',
  'social_unlinked'));

insert into public.app_config (key, value, is_public, description) values
  ('socials.bonus_min_audience', '1000', true, 'Smallest verified audience (followers/subscribers) that earns a karma bonus.'),
  ('socials.bonus_step_karma',   '25',   true, 'Karma per tenfold audience above the minimum (1k, 10k, 100k, 1M…).'),
  ('socials.bonus_max_karma',    '100',  true, 'Largest karma bonus from verified accounts. 100 = exactly enough for Member.'),
  ('rate_limit.social_link',     '{"limit": 10, "window_seconds": 86400}', false, 'Social accounts one member can verify or remove per day.');
update public.app_config c set bounds = b.bounds
  from (values ('socials.bonus_min_audience', '{"min": 1, "max": 100000000}'::jsonb),
               ('socials.bonus_step_karma',   '{"min": 0, "max": 1000}'::jsonb),
               ('socials.bonus_max_karma',    '{"min": 0, "max": 10000}'::jsonb)) as b (key, bounds)
 where c.key = b.key;

-- ---------------------------------------------------------------------------
-- Signatures
-- ---------------------------------------------------------------------------
-- HMAC-SHA256 (RFC 2104) on the built-in sha256(), so no extension is needed.
create function private.hmac_sha256(p_key bytea, p_message bytea)
returns bytea
language plpgsql
immutable
set search_path = ''
as $$
declare
  k    bytea := p_key;
  ipad bytea;
  opad bytea;
begin
  if length(k) > 64 then
    k := sha256(k);
  end if;
  k := k || decode(repeat('00', 64 - length(k)), 'hex');
  ipad := k;
  opad := k;
  for i in 0..63 loop
    ipad := set_byte(ipad, i, get_byte(k, i) # 54);   -- 0x36
    opad := set_byte(opad, i, get_byte(k, i) # 92);   -- 0x5c
  end loop;
  return sha256(opad || sha256(ipad || p_message));
end;
$$;

-- ---------------------------------------------------------------------------
-- The bonus
-- ---------------------------------------------------------------------------
create function private.social_bonus_for(p_audience bigint)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when p_audience is null or p_audience < private.cfg_int('socials.bonus_min_audience') then 0
           else least(private.cfg_int('socials.bonus_max_karma'),
                      private.cfg_int('socials.bonus_step_karma')
                        * (1 + floor(log(10, p_audience::numeric / private.cfg_int('socials.bonus_min_audience'))))::integer)
         end;
$$;

-- Brings the member's bonus in line with their largest verified audience.
create function private.sync_social_bonus(p_user uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bonus integer := private.social_bonus_for((select max(s.audience) from public.social_accounts s where s.user_id = p_user));
begin
  perform private.reconcile('social_bonus:' || p_user, p_user, 'karma', 'social_verified', 'user', p_user, v_bonus);
  return v_bonus;
end;
$$;

-- ---------------------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------------------
create function public.link_social_account(
  p_platform    text,
  p_external_id text,
  p_handle      text,
  p_audience    bigint,
  p_profile_url text,
  p_metrics     text,
  p_issued_at   bigint,
  p_signature   text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := private.require_user();
  v_key     text;
  v_message text;
  v_metrics jsonb;
  v_owner   uuid;
  v_bonus   integer;
begin
  perform private.require_capability(v_uid, 'comment');
  perform private.enforce_rate_limit(v_uid, 'social_link');

  select s.value into v_key from private.app_secrets s where s.name = 'social_attestation';
  if v_key is null then
    perform private.raise_error('PF422', 'socials_not_configured');
  end if;
  if p_platform is null or p_platform not in ('x', 'youtube', 'instagram', 'tiktok', 'reddit') then
    perform private.raise_error('PF422', 'invalid_kind');
  end if;
  if p_issued_at is null or p_issued_at < extract(epoch from now())::bigint - 900 or p_issued_at > extract(epoch from now())::bigint + 60 then
    perform private.raise_error('PF422', 'attestation_expired');
  end if;

  -- Exactly the string the web server signed (apps/web/src/lib/socials.ts).
  v_message := concat_ws('|', 'pepforum-social-v1', v_uid::text, p_platform, coalesce(p_external_id, ''), coalesce(p_handle, ''),
                         coalesce(p_audience, -1)::text, coalesce(p_profile_url, ''), coalesce(p_metrics, ''), p_issued_at::text);
  if p_signature is null
     or lower(p_signature) <> encode(private.hmac_sha256(convert_to(v_key, 'UTF8'), convert_to(v_message, 'UTF8')), 'hex') then
    perform private.raise_error('PF403', 'invalid_attestation');
  end if;

  begin
    v_metrics := coalesce(nullif(p_metrics, '')::jsonb, '{}'::jsonb);
  exception when others then
    perform private.raise_error('PF422', 'invalid_attestation');
  end;
  if jsonb_typeof(v_metrics) <> 'object' then
    perform private.raise_error('PF422', 'invalid_attestation');
  end if;

  select s.user_id into v_owner from public.social_accounts s where s.platform = p_platform and s.external_id = p_external_id;
  if v_owner is not null and v_owner <> v_uid then
    perform private.raise_error('PF409', 'social_taken');
  end if;

  insert into public.social_accounts (user_id, platform, external_id, handle, audience, profile_url, metrics, verified_at)
  values (v_uid, p_platform, p_external_id, p_handle, p_audience, p_profile_url, v_metrics, now())
  on conflict (user_id, platform) do update
     set external_id = excluded.external_id, handle = excluded.handle, audience = excluded.audience,
         profile_url = excluded.profile_url, metrics = excluded.metrics, verified_at = excluded.verified_at;

  v_bonus := private.sync_social_bonus(v_uid);
  return jsonb_build_object('platform', p_platform, 'handle', p_handle, 'audience', p_audience, 'bonus', v_bonus);
end;
$$;

create function public.unlink_social_account(p_platform text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.require_capability(v_uid, 'comment');
  perform private.enforce_rate_limit(v_uid, 'social_link');
  delete from public.social_accounts where user_id = v_uid and platform = p_platform;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'social_account');
  end if;
  return private.sync_social_bonus(v_uid);
end;
$$;

-- The caller's verified accounts and their current bonus (Settings).
create function public.my_social_accounts()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'accounts', coalesce((select jsonb_agg(jsonb_build_object(
                    'platform', s.platform, 'handle', s.handle, 'audience', s.audience, 'url', s.profile_url,
                    'metrics', s.metrics, 'verified_at', s.verified_at) order by s.audience desc)
                  from public.social_accounts s where s.user_id = auth.uid()), '[]'::jsonb),
    'bonus', coalesce(private.ledger_total('social_bonus:' || auth.uid(), auth.uid(), 'karma'), 0),
    'configured', exists (select 1 from private.app_secrets x where x.name = 'social_attestation'))
  where auth.uid() is not null;
$$;

-- ---------------------------------------------------------------------------
-- Admins: take a verified account off a profile (and its bonus with it)
-- ---------------------------------------------------------------------------
create function public.admin_unlink_social(p_user uuid, p_platform text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_admin_write(p_reason);
  v_handle text;
begin
  delete from public.social_accounts where user_id = p_user and platform = p_platform returning handle into v_handle;
  if v_handle is null then
    perform private.raise_error('PF404', 'not_found', 'social_account');
  end if;
  perform private.sync_social_bonus(p_user);
  perform private.log_mod_action(v_uid, 'social_unlinked', 'user', p_user, p_user, null, btrim(p_reason),
                                 jsonb_build_object('platform', p_platform, 'handle', v_handle));
end;
$$;

grant execute on function public.link_social_account(text, text, text, bigint, text, text, bigint, text) to authenticated;
grant execute on function public.unlink_social_account(text)                                         to authenticated;
grant execute on function public.my_social_accounts()                                                to authenticated;
grant execute on function public.admin_unlink_social(uuid, text, text)                               to authenticated;

-- ---------------------------------------------------------------------------
-- Recreated from …027 (verbatim, plus the lines marked …028)
-- ---------------------------------------------------------------------------
-- Profiles show verified accounts as badges.
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
    'moderates',     coalesce((select jsonb_agg(m.zone_id) from public.zone_moderators m where m.user_id = p.id), '[]'::jsonb),
    'post_count',    (select count(*) from public.posts x where x.author_id = p.id and x.status in ('visible', 'collapsed')),
    'comment_count', (select count(*) from public.comments x where x.author_id = p.id and x.status in ('visible', 'collapsed'))
  )
  from public.profiles p
  where lower(p.username) = lower(p_username);
$$;

-- Deleting an account releases its verified social accounts.
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
         home_zone_id         = null,
         rater_status         = 'none',
         founding_until       = null,
         avatar_media_id      = null,
         deleted_at           = coalesce(deleted_at, now())
   where id = p_user;

  delete from public.user_roles      where user_id = p_user;
  delete from public.zone_moderators where user_id = p_user;
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

-- Your data export lists your verified accounts.
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
    'support_tickets',
                      coalesce((select jsonb_agg((to_jsonb(t) - 'closed_by') || jsonb_build_object('messages', coalesce((
                                  select jsonb_agg(jsonb_build_object('body', m.body, 'from_team', m.from_staff, 'created_at', m.created_at)
                                                   order by m.created_at)
                                  from public.support_messages m where m.ticket_id = t.id), '[]'::jsonb))
                                  order by t.created_at)
                                from public.support_tickets t where t.member_id = v_uid), '[]'),
    -- …022: notifications never name a note writer or a moderator, so nothing to withhold.
    'notifications',  coalesce((select jsonb_agg(to_jsonb(n) - 'actor_id' order by n.created_at) from public.notifications n where n.user_id = v_uid), '[]'),
    'notification_settings', (select to_jsonb(s) from public.notification_settings s where s.user_id = v_uid),
    'push_subscriptions', coalesce((select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'user_agent', s.user_agent, 'created_at', s.created_at))
                                    from public.push_subscriptions s where s.user_id = v_uid), '[]'),
    -- …023 / …024: uploads and verification requests (reviewer withheld).
    'media',          coalesce((select jsonb_agg(to_jsonb(m) - 'removed_by' order by m.created_at) from public.media m where m.owner_id = v_uid), '[]'),
    'clinician_verifications',
                      coalesce((select jsonb_agg(to_jsonb(v) - 'reviewed_by' order by v.submitted_at)
                                from public.clinician_verifications v where v.user_id = v_uid), '[]'),
    -- …025: advertiser account, campaigns and ledger (reviewer and recording admin withheld).
    'advertiser',     (select to_jsonb(a) - 'reviewed_by' from public.advertisers a where a.owner_id = v_uid),
    'ad_campaigns',   coalesce((select jsonb_agg(to_jsonb(c) - 'reviewed_by' order by c.created_at)
                                from public.ad_campaigns c join public.advertisers a on a.id = c.advertiser_id where a.owner_id = v_uid), '[]'),
    'ad_ledger',      coalesce((select jsonb_agg(to_jsonb(l) - 'actor_id' order by l.id)
                                from public.ad_ledger l join public.advertisers a on a.id = l.advertiser_id where a.owner_id = v_uid), '[]'),
    'ad_reports_filed', coalesce((select jsonb_agg(to_jsonb(r) - 'resolved_by' order by r.created_at) from public.ad_reports r where r.reporter_id = v_uid), '[]'),
    -- …027: who you follow and who follows you.
    'following',      coalesce((select jsonb_agg(jsonb_build_object('username', p.username, 'since', f.created_at) order by f.created_at)
                                from public.follows f join public.profiles p on p.id = f.followee_id where f.follower_id = v_uid), '[]'),
    'followers',      coalesce((select jsonb_agg(jsonb_build_object('username', p.username, 'since', f.created_at) order by f.created_at)
                                from public.follows f join public.profiles p on p.id = f.follower_id where f.followee_id = v_uid), '[]'),
    -- …028: verified social accounts.
    'social_accounts', coalesce((select jsonb_agg(to_jsonb(s) - 'user_id' order by s.platform) from public.social_accounts s where s.user_id = v_uid), '[]'),
    'ledger',         coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from public.ledger_events e where e.user_id = v_uid), '[]'),
    'strikes',        coalesce((select jsonb_agg(to_jsonb(s)) from public.strikes s where s.user_id = v_uid), '[]'),
    'sanctions',      coalesce((select jsonb_agg(to_jsonb(s)) from public.sanctions s where s.user_id = v_uid), '[]'),
    'moderation_actions_on_me',
                      coalesce((select jsonb_agg(to_jsonb(a) - 'actor_id') from public.mod_actions a where a.target_user_id = v_uid), '[]')
  );
end;
$$;
