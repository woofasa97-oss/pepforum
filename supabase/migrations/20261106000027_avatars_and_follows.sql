-- ============================================================================
-- 0027 · Profile pictures and following
--
-- Profile pictures
--   * A new media kind, 'avatar', reuses the upload pipeline of …023: the
--     database registers the upload, the bytes go to the private `media`
--     bucket as the member, and /media/<id> serves them. Any member with the
--     basic permissions can set one (not only Trusted, unlike post images).
--   * The web app re-encodes every picture to a 256×256 WebP before storing
--     it, which also drops EXIF data such as a phone's GPS position.
--   * profiles.avatar_media_id points at the current picture. A picture is
--     public only while it is someone's current one; replacing or removing
--     it removes the old file (the worker purges the bytes). Admins remove
--     an offensive picture from the Media page like any upload.
--
-- Following
--   * public.follows: who follows whom. Members who follow each other are
--     shown as friends. Counts and lists are public, like on most networks.
--   * set_follow() needs the basic 'vote' permission and is rate limited
--     (rate_limit.follow). The followed member gets one 'new_follower'
--     notification per follower, ever (re-following doesn't notify again).
--   * Deleting an account removes its follows in both directions.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
alter table public.media drop constraint media_kind_check;
alter table public.media add constraint media_kind_check check (kind in ('post_image', 'credential', 'ad_image', 'avatar'));
alter table public.media add constraint media_avatar_unattached check (kind <> 'avatar' or post_id is null);

alter table public.profiles add column avatar_media_id uuid references public.media (id);

create table public.follows (
  follower_id uuid        not null references public.profiles (id),
  followee_id uuid        not null references public.profiles (id),
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create index follows_followee on public.follows (followee_id, created_at desc);

-- Read through the RPCs below; nobody gets table access.
alter table public.follows enable row level security;

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'reply_post', 'reply_comment', 'note_outcome', 'note_on_post', 'mod_action', 'team_reply', 'clinician_review', 'ad_review',
  'new_follower'));

insert into public.app_config (key, value, is_public, description) values
  ('rate_limit.follow', '{"limit": 60, "window_seconds": 3600}', false, 'Follows and unfollows one member can make per hour.'),
  ('rate_limit.avatar', '{"limit": 10, "window_seconds": 86400}', false, 'Profile picture changes one member can make per day.');

-- ---------------------------------------------------------------------------
-- Profile pictures
-- ---------------------------------------------------------------------------
-- The member's current picture, if it is ready (null otherwise).
create function private.avatar_id(p_user uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id
  from public.profiles p
  join public.media m on m.id = p.avatar_media_id
  where p.id = p_user and p.deleted_at is null and m.status = 'ready';
$$;

-- Make an uploaded 'avatar' the caller's picture, or remove it (null).
create function public.set_avatar(p_media uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_old uuid;
begin
  perform private.require_capability(v_uid, 'comment');
  perform private.enforce_rate_limit(v_uid, 'avatar');

  if p_media is not null and not exists (
       select 1 from public.media m
       where m.id = p_media and m.owner_id = v_uid and m.kind = 'avatar' and m.status = 'ready') then
    perform private.raise_error('PF404', 'not_found', 'media');
  end if;

  select p.avatar_media_id into v_old from public.profiles p where p.id = v_uid for update;
  update public.profiles set avatar_media_id = p_media where id = v_uid;
  if v_old is not null and v_old is distinct from p_media then
    update public.media set status = 'removed', removed_reason = 'replaced'
     where id = v_old and status <> 'removed';
  end if;
end;
$$;

grant execute on function public.set_avatar(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Following
-- ---------------------------------------------------------------------------
create function public.set_follow(p_username text, p_follow boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_user();
  v_target uuid;
  v_added  integer := 0;
begin
  perform private.require_capability(v_uid, 'vote');
  perform private.enforce_rate_limit(v_uid, 'follow');

  select p.id into v_target from public.profiles p
   where lower(p.username) = lower(btrim(coalesce(p_username, ''))) and p.deleted_at is null;
  if v_target is null then
    perform private.raise_error('PF404', 'not_found', 'profile');
  end if;
  if v_target = v_uid then
    perform private.raise_error('PF422', 'follow_self');
  end if;

  if coalesce(p_follow, false) then
    insert into public.follows (follower_id, followee_id) values (v_uid, v_target) on conflict do nothing;
    get diagnostics v_added = row_count;
    if v_added > 0 then
      perform private.notify(v_target, 'new_follower', 'follow:' || v_uid, v_uid);
    end if;
  else
    delete from public.follows where follower_id = v_uid and followee_id = v_target;
  end if;

  return jsonb_build_object(
    'following', coalesce(p_follow, false),
    'followers', (select count(*) from public.follows f where f.followee_id = v_target),
    'friends',   coalesce(p_follow, false)
                 and exists (select 1 from public.follows f where f.follower_id = v_target and f.followee_id = v_uid));
end;
$$;

-- A member's followers or the people they follow, newest first, 50 per page.
-- `friend` = they follow each other. Null for an unknown or deleted member.
create function public.get_follows(p_username text, p_kind text default 'followers', p_page integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_target uuid;
begin
  if p_kind is null or p_kind not in ('followers', 'following') then
    perform private.raise_error('PF422', 'invalid_kind');
  end if;
  select p.id into v_target from public.profiles p
   where lower(p.username) = lower(btrim(coalesce(p_username, ''))) and p.deleted_at is null;
  if v_target is null then
    return null;
  end if;

  return coalesce((
    select jsonb_agg(x.item order by x.at desc)
    from (
      select f.created_at as at,
             jsonb_build_object(
               'username', p.username, 'tier', p.tier, 'avatar', private.avatar_id(p.id),
               'friend', exists (select 1 from public.follows a where a.follower_id = v_target and a.followee_id = p.id)
                         and exists (select 1 from public.follows b where b.follower_id = p.id and b.followee_id = v_target),
               'is_me', coalesce(p.id = auth.uid(), false)) as item
      from public.follows f
      join public.profiles p on p.id = case when p_kind = 'followers' then f.follower_id else f.followee_id end
      where (case when p_kind = 'followers' then f.followee_id else f.follower_id end) = v_target
        and p.deleted_at is null
      order by f.created_at desc
      limit 50 offset greatest(coalesce(p_page, 0), 0) * 50
    ) x), '[]'::jsonb);
end;
$$;

grant execute on function public.set_follow(text, boolean)          to authenticated;
grant execute on function public.get_follows(text, text, integer)   to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Recreated from earlier migrations (verbatim, plus the lines marked …027)
-- ---------------------------------------------------------------------------
-- Uploads accept the new 'avatar' kind (from …025).
create or replace function public.register_upload(p_kind text, p_content_type text, p_bytes integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_user();
  v_id   uuid := gen_random_uuid();
  v_ext  text;
  v_path text;
begin
  if p_kind = 'post_image' then
    perform private.require_capability(v_uid, 'upload_image');
  elsif p_kind = 'credential' then
    perform private.require_capability(v_uid, 'report');
  elsif p_kind = 'avatar' then     -- …027: anyone with the basic permissions
    perform private.require_capability(v_uid, 'comment');
  elsif p_kind = 'ad_image' then   -- …025: advertisers only
    perform private.require_capability(v_uid, 'report');
    if not exists (select 1 from public.advertisers a where a.owner_id = v_uid and a.status <> 'suspended') then
      perform private.raise_error('PF404', 'not_found', 'advertiser');
    end if;
  else
    perform private.raise_error('PF422', 'invalid_kind');
  end if;
  perform private.enforce_rate_limit(v_uid, 'upload');

  v_ext := case p_content_type
             when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp'
             when 'application/pdf' then 'pdf' end;
  if v_ext is null or (p_content_type = 'application/pdf' and p_kind <> 'credential') then
    perform private.raise_error('PF422', 'unsupported_file_type');
  end if;
  if p_bytes is null or p_bytes <= 0 or p_bytes > private.cfg_int('uploads.max_bytes') then
    perform private.raise_error('PF422', 'file_too_large', private.cfg_int('uploads.max_bytes')::text);
  end if;

  v_path := p_kind || '/' || v_uid || '/' || v_id || '.' || v_ext;
  insert into public.media (id, owner_id, kind, object_path, content_type, bytes)
  values (v_id, v_uid, p_kind, v_path, p_content_type, p_bytes);
  return jsonb_build_object('id', v_id, 'bucket', 'media', 'path', v_path);
end;
$$;

-- Who may see an upload: current profile pictures are public (from …025).
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
                 or coalesce(private.is_zone_mod(auth.uid(), p.zone_id) and private.staff_session(), false))))
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

-- /media/<id> may cache current profile pictures (from …023).
create or replace function public.get_media_access(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('bucket', m.bucket, 'path', m.object_path, 'content_type', m.content_type, 'kind', m.kind,
                            'public', (m.kind = 'post_image' and m.post_id is not null and m.status = 'ready'
                                       and exists (select 1 from public.posts p where p.id = m.post_id and p.status in ('visible', 'collapsed')))
                                      -- …027: current profile pictures are cacheable
                                      or (m.kind = 'avatar' and m.status = 'ready'
                                          and exists (select 1 from public.profiles p where p.avatar_media_id = m.id and p.deleted_at is null)))
  from public.media m
  where m.id = p_id and private.media_visible(m);
$$;

-- Pictures that were uploaded but never set, or replaced, are purged (from …025).
create or replace function public.media_to_purge(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.media m
     set status = 'removed', removed_reason = 'abandoned'
   where m.status in ('pending', 'ready') and m.created_at < now() - interval '1 day'
     and ((m.kind = 'post_image' and m.post_id is null)
       or (m.kind = 'ad_image' and not exists (select 1 from public.ad_campaigns c where c.image_id = m.id))   -- …025
       or (m.kind = 'avatar' and not exists (select 1 from public.profiles p where p.avatar_media_id = m.id)));   -- …027
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'bucket', m.bucket, 'path', m.object_path) order by m.created_at)
    from (select * from public.media x where x.status = 'removed' and x.purged_at is null
           order by x.created_at limit least(greatest(coalesce(p_limit, 100), 1), 1000)) m), '[]'::jsonb);
end;
$$;

-- New followers count as "replies and followers" in notification settings (from …025).
create or replace function private.notification_wanted(p_user uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_kind
           when 'reply_post'       then coalesce(s.replies, true)
           when 'reply_comment'    then coalesce(s.replies, true)
           when 'note_outcome'     then coalesce(s.notes, true)
           when 'note_on_post'     then coalesce(s.notes, true)
           when 'mod_action'       then coalesce(s.moderation, true)
           when 'team_reply'       then coalesce(s.team, true)
           when 'clinician_review' then coalesce(s.team, true)   -- …024
           when 'ad_review'        then coalesce(s.team, true)   -- …025
           when 'new_follower'     then coalesce(s.replies, true)   -- …027
           else false
         end
  from (select 1) x
  left join public.notification_settings s on s.user_id = p_user;
$$;

-- Deleting an account clears its picture and follows (from …025).
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

-- Your data export lists your follows (from …025).
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
    'ledger',         coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from public.ledger_events e where e.user_id = v_uid), '[]'),
    'strikes',        coalesce((select jsonb_agg(to_jsonb(s)) from public.strikes s where s.user_id = v_uid), '[]'),
    'sanctions',      coalesce((select jsonb_agg(to_jsonb(s)) from public.sanctions s where s.user_id = v_uid), '[]'),
    'moderation_actions_on_me',
                      coalesce((select jsonb_agg(to_jsonb(a) - 'actor_id') from public.mod_actions a where a.target_user_id = v_uid), '[]')
  );
end;
$$;

-- Profiles show the picture, follower counts and whether you follow each other (from …024).
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
    'moderates',     coalesce((select jsonb_agg(m.zone_id) from public.zone_moderators m where m.user_id = p.id), '[]'::jsonb),
    'post_count',    (select count(*) from public.posts x where x.author_id = p.id and x.status in ('visible', 'collapsed')),
    'comment_count', (select count(*) from public.comments x where x.author_id = p.id and x.status in ('visible', 'collapsed'))
  )
  from public.profiles p
  where lower(p.username) = lower(p_username);
$$;

-- The header shows your picture (from …023).
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

  foreach v_cap in array array['vote', 'comment', 'report', 'post_text', 'post_link', 'rate_notes', 'write_notes', 'steward', 'upload_image'] loop   -- …023
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
    'avatar',               private.avatar_id(v_uid),   -- …027
    -- Tickets with a team reply the member hasn't opened yet (…020).
    'support_unread',       (select count(*) from public.support_tickets t
                              where t.member_id = v_uid and t.last_staff_reply_at > t.member_read_at),
    -- Unread notifications (…022).
    'notifications_unread', (select count(*) from public.notifications n where n.user_id = v_uid and n.read_at is null),
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
