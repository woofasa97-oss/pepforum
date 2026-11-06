-- ============================================================================
-- 0023 · Media: image uploads on posts (Supabase Storage)
--
-- Ported from the pepforum-ca prototype build (src/lib/storage.ts,
-- src/modules/admin/media.ts, MediaUpload.tsx) onto the Supabase model.
--
--   * The database owns every upload as a `media` row: who, what, how big,
--     which post, and its status. The file itself lives in the private
--     Storage bucket `media` at the path the row dictates; Storage policies
--     (declared at the end, applied only where the storage schema exists)
--     accept an object only when a matching pending row exists for the
--     caller and serve it only when this schema says the viewer may see it.
--   * Uploading is a capability (`upload_image`, Trusted by default — see
--     gates.upload.min_tier), rate limited, size and type limited.
--   * The browser never talks to Storage: the web app registers the upload,
--     puts the bytes as the member, confirms it, and attaches it to the post
--     in one Server Action; images are served through /media/<id>, which asks
--     get_media_access() first.
--   * Removal is a status change here (member or admin, logged). The worker
--     deletes the bytes afterwards (media_to_purge / mark_media_purged), so a
--     removed image disappears even if Storage is briefly unavailable.
--   * `credential` uploads (clinician verification, …024) reuse this table:
--     private, visible to the owner and admins only, never attached to posts.
--
-- See docs/ADMIN.md ("Media") and docs/DATA_PRIVACY.md.
-- ============================================================================

create table public.media (
  id             uuid        primary key default gen_random_uuid(),
  owner_id       uuid        not null references public.profiles (id),
  kind           text        not null check (kind in ('post_image', 'credential')),
  bucket         text        not null default 'media',
  object_path    text        not null unique check (char_length(object_path) <= 200),
  content_type   text        not null check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  bytes          integer     not null check (bytes > 0),
  width          integer     check (width is null or width between 1 and 10000),
  height         integer     check (height is null or height between 1 and 10000),
  alt            text        not null default '' check (char_length(alt) <= 300),
  status         text        not null default 'pending' check (status in ('pending', 'ready', 'removed')),
  post_id        uuid        references public.posts (id),
  sort_order     smallint    not null default 0,
  removed_reason text,
  removed_by     uuid        references public.profiles (id),
  purged_at      timestamptz,
  created_at     timestamptz not null default now(),
  ready_at       timestamptz,
  check (kind <> 'credential' or post_id is null),
  check (content_type <> 'application/pdf' or kind = 'credential')
);
create index media_owner  on public.media (owner_id, created_at desc);
create index media_post   on public.media (post_id, sort_order) where post_id is not null;
create index media_purge  on public.media (created_at) where status = 'removed' and purged_at is null;
create index media_status on public.media (status, created_at desc);

-- Read through the RPCs below; nobody gets table access.
alter table public.media enable row level security;

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
  'media_removed'));

alter table public.mod_actions drop constraint mod_actions_target_kind_check;
alter table public.mod_actions add constraint mod_actions_target_kind_check check (target_kind in (
  'post', 'comment', 'user', 'config', 'appeal', 'sanction', 'note', 'strike', 'shield', 'taxonomy', 'redirect', 'media'));

insert into public.app_config (key, value, is_public, description) values
  ('gates.upload.min_tier',  '2', true,  'Minimum tier to attach images to posts (Trusted by default).'),
  ('uploads.max_bytes',      '5000000', true, 'Largest accepted upload, in bytes.'),
  ('uploads.max_per_post',   '4', true,  'Images one post can carry.'),
  ('rate_limit.upload',      '{"limit": 20, "window_seconds": 86400}', false, 'Uploads one member can start per day.');
update public.app_config c set bounds = b.bounds
  from (values ('gates.upload.min_tier', '{"min": 0, "max": 4}'::jsonb),
               ('uploads.max_bytes', '{"min": 100000, "max": 25000000}'::jsonb),
               ('uploads.max_per_post', '{"min": 1, "max": 10}'::jsonb)) as b (key, bounds)
 where c.key = b.key;

-- ---------------------------------------------------------------------------
-- Capability: upload_image (recreated from …019 verbatim, plus the …023 branch)
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
     and p_capability in ('post_text', 'post_link', 'rate_notes', 'write_notes', 'steward', 'upload_image') then
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

    -- …023: images on posts. Same integrity bar as posting, its own tier gate.
    when 'upload_image' then
      if v_frozen then return 'frozen'; end if;
      if v_integrity < private.cfg_int('gates.posting.min_integrity') then
        return 'integrity:' || private.cfg_int('gates.posting.min_integrity');
      end if;
      if p.tier < private.cfg_int('gates.upload.min_tier') then
        return 'tier:' || private.cfg_int('gates.upload.min_tier');
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
-- Visibility (shared by get_media_access and the Storage policies)
-- ---------------------------------------------------------------------------
-- May the current caller see this media row's bytes?
create function private.media_visible(m public.media)
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
  ) or (m.status = 'pending' and coalesce(m.owner_id = auth.uid(), false));
$$;

-- For Storage RLS: object name → may the caller read it / write it.
create function private.media_readable(p_object_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select private.media_visible(m) from public.media m where m.object_path = p_object_path), false);
$$;

create function private.media_uploadable(p_object_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.media m
    where m.object_path = p_object_path and m.status = 'pending'
      and coalesce(m.owner_id = auth.uid(), false));
$$;

grant execute on function private.media_readable(text)   to anon, authenticated;
grant execute on function private.media_uploadable(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Members: register → (upload bytes) → confirm → attach
-- ---------------------------------------------------------------------------
create function public.register_upload(p_kind text, p_content_type text, p_bytes integer)
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

-- The bytes are in Storage: the upload becomes usable.
create function public.confirm_upload(p_id uuid, p_width integer default null, p_height integer default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  update public.media
     set status = 'ready', ready_at = now(),
         width  = case when p_width  between 1 and 10000 then p_width  end,
         height = case when p_height between 1 and 10000 then p_height end
   where id = p_id and owner_id = v_uid and status = 'pending';
  if not found then
    perform private.raise_error('PF404', 'not_found', 'media');
  end if;
end;
$$;

-- Set exactly these images (in this order, with these alt texts) on one of
-- the caller's posts. Images left out are detached and removed.
create function public.attach_post_media(p_post_id uuid, p_media_ids uuid[], p_alts text[] default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_ids uuid[] := coalesce(p_media_ids, '{}'::uuid[]);
  i     integer;
begin
  perform private.require_capability(v_uid, 'upload_image');
  perform private.enforce_rate_limit(v_uid, 'edit');

  perform 1 from public.posts p where p.id = p_post_id and p.author_id = v_uid and p.status not in ('removed', 'deleted') for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'post');
  end if;
  if cardinality(v_ids) > private.cfg_int('uploads.max_per_post') then
    perform private.raise_error('PF422', 'too_many_images', private.cfg_int('uploads.max_per_post')::text);
  end if;
  if (select count(*) from public.media m
       where m.id = any (v_ids) and m.owner_id = v_uid and m.kind = 'post_image' and m.status = 'ready'
         and (m.post_id is null or m.post_id = p_post_id)) <> cardinality(v_ids) then
    perform private.raise_error('PF404', 'not_found', 'media');
  end if;

  update public.media
     set status = 'removed', removed_reason = 'detached', removed_by = v_uid, post_id = null
   where post_id = p_post_id and status = 'ready' and not (id = any (v_ids));

  for i in 1 .. cardinality(v_ids) loop
    update public.media
       set post_id = p_post_id, sort_order = i,
           alt = left(btrim(coalesce(p_alts[i], alt)), 300)
     where id = v_ids[i];
  end loop;
end;
$$;

-- A member removes their own image (from a post or before attaching it).
create function public.delete_my_media(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  update public.media
     set status = 'removed', removed_reason = 'owner', removed_by = v_uid, post_id = null
   where id = p_id and owner_id = v_uid and status <> 'removed';
  if not found then
    perform private.raise_error('PF404', 'not_found', 'media');
  end if;
end;
$$;

-- Images on a post, in order, for whoever may see the post.
create function public.get_post_media(p_post_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'alt', m.alt, 'width', m.width, 'height', m.height, 'content_type', m.content_type)
           order by m.sort_order, m.created_at), '[]'::jsonb)
  from public.media m
  where m.post_id = p_post_id and m.kind = 'post_image' and private.media_visible(m);
$$;

-- The caller's own uploads not yet on a post (the composer's pending tray).
create function public.my_pending_media()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'alt', m.alt, 'width', m.width, 'height', m.height, 'created_at', m.created_at)
                            order by m.created_at), '[]'::jsonb)
  from public.media m
  where m.owner_id = private.require_user() and m.kind = 'post_image' and m.status = 'ready' and m.post_id is null;
$$;

-- Where the bytes are, if the caller may see them (used by /media/<id>).
create function public.get_media_access(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('bucket', m.bucket, 'path', m.object_path, 'content_type', m.content_type, 'kind', m.kind,
                            'public', m.kind = 'post_image' and m.post_id is not null and m.status = 'ready'
                                      and exists (select 1 from public.posts p where p.id = m.post_id and p.status in ('visible', 'collapsed')))
  from public.media m
  where m.id = p_id and private.media_visible(m);
$$;

grant execute on function public.register_upload(text, text, integer)      to authenticated;
grant execute on function public.confirm_upload(uuid, integer, integer)    to authenticated;
grant execute on function public.attach_post_media(uuid, uuid[], text[])   to authenticated;
grant execute on function public.delete_my_media(uuid)                     to authenticated;
grant execute on function public.my_pending_media()                        to authenticated;
grant execute on function public.get_post_media(uuid)                      to anon, authenticated;
grant execute on function public.get_media_access(uuid)                    to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Admins: review recent uploads, remove one
-- ---------------------------------------------------------------------------
create function public.admin_media(p_status text default 'ready', p_page integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_user();
  v_status text := coalesce(p_status, 'ready');
  v_page   integer := greatest(coalesce(p_page, 0), 0);
begin
  perform private.require_admin(v_uid);
  if v_status not in ('pending', 'ready', 'removed') then
    perform private.raise_error('PF422', 'invalid_status');
  end if;
  return jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'kind', m.kind, 'status', m.status, 'content_type', m.content_type, 'bytes', m.bytes,
               'width', m.width, 'height', m.height, 'alt', m.alt, 'created_at', m.created_at,
               'owner', o.username, 'owner_tier', o.tier,
               'post', case when p.id is not null then jsonb_build_object('id', p.id, 'title', p.title, 'status', p.status) end,
               'removed_reason', m.removed_reason, 'purged', m.purged_at is not null)
             order by m.created_at desc)
      from (select * from public.media x where x.status = v_status and x.kind = 'post_image'
             order by x.created_at desc limit 50 offset v_page * 50) m
      join public.profiles o on o.id = m.owner_id
      left join public.posts p on p.id = m.post_id), '[]'::jsonb),
    'has_more', (select count(*) from public.media x where x.status = v_status and x.kind = 'post_image') > (v_page + 1) * 50,
    'counts', jsonb_build_object(
      'ready',   (select count(*) from public.media x where x.status = 'ready' and x.kind = 'post_image'),
      'pending', (select count(*) from public.media x where x.status = 'pending' and x.kind = 'post_image'),
      'removed_30d', (select count(*) from public.media x where x.status = 'removed' and x.kind = 'post_image' and x.created_at > now() - interval '30 days'),
      'bytes',   (select coalesce(sum(x.bytes), 0) from public.media x where x.status = 'ready'))
  );
end;
$$;

create function public.admin_remove_media(p_id uuid, p_reason text)
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
                                 (select p.zone_id from public.posts p where p.id = m.post_id), p_reason,
                                 jsonb_build_object('post_id', m.post_id, 'kind', m.kind));
end;
$$;

grant execute on function public.admin_media(text, integer)     to authenticated;
grant execute on function public.admin_remove_media(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Worker: purge the bytes of removed and abandoned uploads (service_role only)
-- ---------------------------------------------------------------------------
-- Abandoned = pending for a day (the upload never completed) or ready but
-- never attached within a day (the member closed the composer).
create function public.media_to_purge(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.media
     set status = 'removed', removed_reason = 'abandoned'
   where status in ('pending', 'ready') and kind = 'post_image' and post_id is null
     and created_at < now() - interval '1 day';
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'bucket', m.bucket, 'path', m.object_path) order by m.created_at)
    from (select * from public.media x where x.status = 'removed' and x.purged_at is null
           order by x.created_at limit least(greatest(coalesce(p_limit, 100), 1), 1000)) m), '[]'::jsonb);
end;
$$;

create function public.mark_media_purged(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update public.media set purged_at = now() where id = any (coalesce(p_ids, '{}'::uuid[])) and status = 'removed' and purged_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

grant execute on function public.media_to_purge(integer)  to service_role;
grant execute on function public.mark_media_purged(uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- Recreated from earlier migrations (verbatim, plus the lines marked …023)
-- ---------------------------------------------------------------------------
-- The standing view lists the new capability (from …022).
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

-- Deleting an account removes its uploads; the worker purges the bytes (from …022).
create or replace function private.tombstone_profile(p_user uuid, p_erase_content boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
     set username             = 'deleted_' || substr(md5(id::text), 1, 10),
         bio                  = '',
         coi                  = '',
         home_zone_id         = null,
         rater_status         = 'none',
         founding_until       = null,
         deleted_at           = coalesce(deleted_at, now())
   where id = p_user;

  delete from public.user_roles      where user_id = p_user;
  delete from public.zone_moderators where user_id = p_user;
  -- Tickets are private correspondence with the team: they go with the account (…020).
  delete from public.support_tickets  where member_id = p_user;
  -- So do notifications, preferences and push browsers (…022).
  delete from public.notifications         where user_id = p_user;
  delete from public.notification_settings where user_id = p_user;
  delete from public.push_subscriptions    where user_id = p_user;
  -- Uploads are removed; the worker deletes the bytes (…023).
  update public.media set status = 'removed', removed_reason = 'account_deleted', post_id = null
   where owner_id = p_user and status <> 'removed';

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

-- ---------------------------------------------------------------------------
-- Storage (only where the storage schema exists — i.e. on Supabase, not PGlite)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('media', 'media', false, 25000000, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
  on conflict (id) do nothing;

  -- Readers: whoever this schema says may see the row (served via /media/<id>).
  execute $p$create policy media_read on storage.objects for select to anon, authenticated
            using (bucket_id = 'media' and private.media_readable(name))$p$;
  -- Writers: the owner of a pending row, at exactly that path, once.
  execute $p$create policy media_upload on storage.objects for insert to authenticated
            with check (bucket_id = 'media' and private.media_uploadable(name))$p$;
  -- No update/delete for API roles: removal is a status change here and the worker deletes bytes.
end;
$$;
