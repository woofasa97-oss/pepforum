-- ============================================================================
-- 0021 · SEO: sitemaps, managed redirects, username history
--
-- Ported from the pepforum-ca prototype build (src/lib/sitemaps.ts,
-- src/modules/seo-admin.ts, migrations 012 and 018) onto the Supabase model:
--
--   * Sitemaps are generated from read-API functions callable anonymously.
--     They list only what an anonymous visitor can already see: visible posts,
--     helpful notes on visible posts, and the profiles of members with at
--     least one visible post.
--   * Admins can map an old or mistyped path to a new one (301/302). The web
--     app resolves a redirect only when no page matched the request, so a
--     redirect can never shadow a real page.
--   * When a member is renamed (admin_rename_user, …015) their old username is
--     remembered so links to /u/<old> keep working — unless a new member has
--     since taken the old name, or the member deleted their account.
--
-- Nobody gets table access; everything is an RPC. See docs/ADMIN.md ("SEO").
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
  'lookup_email', 'reveal_email',
  'link_hold', 'link_approved', 'link_declined', 'site_approved', 'site_unapproved',
  'member_reports_actioned', 'member_reports_dismissed',
  'redirect_set', 'redirect_removed'));

alter table public.mod_actions drop constraint mod_actions_target_kind_check;
alter table public.mod_actions add constraint mod_actions_target_kind_check check (target_kind in (
  'post', 'comment', 'user', 'config', 'appeal', 'sanction', 'note', 'strike', 'shield', 'taxonomy', 'redirect'));

-- ---------------------------------------------------------------------------
-- Managed redirects
-- ---------------------------------------------------------------------------
create table public.redirects (
  -- Site-relative, lower-case, no query string: "/old-page".
  from_path  text primary key check (from_path ~ '^/[a-z0-9._~/-]*$' and char_length(from_path) <= 500),
  -- Another path on this site, or an https URL elsewhere.
  to_path    text        not null check ((to_path ~ '^/\S*$' or to_path ~ '^https://\S+$') and char_length(to_path) <= 1000 and to_path <> from_path),
  permanent  boolean     not null default true,
  reason     text        not null default '',
  created_by uuid        references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger redirects_touch before update on public.redirects
  for each row execute function private.touch_updated_at();
alter table public.redirects enable row level security;

-- Where a path should go, if an admin mapped it. Null when it isn't mapped.
-- Resolved by the web app's catch-all route after no page matched.
create function public.resolve_redirect(p_path text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('to', r.to_path, 'permanent', r.permanent)
  from public.redirects r
  where r.from_path = lower(rtrim(coalesce(p_path, ''), '/'))
     or (r.from_path = '/' and coalesce(p_path, '') in ('', '/'));
$$;
grant execute on function public.resolve_redirect(text) to anon, authenticated;

create function public.admin_redirects()
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
             'from', r.from_path, 'to', r.to_path, 'permanent', r.permanent, 'reason', r.reason,
             'by', (select p.username from public.profiles p where p.id = r.created_by),
             'created_at', r.created_at, 'updated_at', r.updated_at)
           order by r.updated_at desc)
    from public.redirects r), '[]'::jsonb);
end;
$$;

-- Create or change a redirect. Paths are normalised (lower-case, no trailing slash).
create function public.admin_set_redirect(p_from text, p_to text, p_permanent boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_admin_write(p_reason);
  v_from text := lower(rtrim(btrim(coalesce(p_from, '')), '/'));
  v_to   text := btrim(coalesce(p_to, ''));
begin
  if v_from = '' then
    v_from := '/';
  end if;
  if v_from !~ '^/[a-z0-9._~/-]*$' or char_length(v_from) > 500 then
    perform private.raise_error('PF422', 'invalid_path');
  end if;
  -- Never hijack the console, auth or API routes.
  if v_from ~ '^/(admin|auth|api|mod|settings|notifications)(/|$)' then
    perform private.raise_error('PF422', 'reserved_path');
  end if;
  if not (v_to ~ '^/\S*$' or v_to ~ '^https://\S+$') or char_length(v_to) > 1000 then
    perform private.raise_error('PF422', 'invalid_url');
  end if;
  if v_to = v_from then
    perform private.raise_error('PF422', 'redirect_loop');
  end if;
  -- A chain through another managed redirect would be two hops; refuse the loop case outright.
  if exists (select 1 from public.redirects r where r.from_path = v_to and r.to_path = v_from) then
    perform private.raise_error('PF422', 'redirect_loop');
  end if;

  insert into public.redirects (from_path, to_path, permanent, reason, created_by)
  values (v_from, v_to, coalesce(p_permanent, true), btrim(p_reason), v_uid)
  on conflict (from_path) do update
    set to_path = excluded.to_path, permanent = excluded.permanent, reason = excluded.reason, created_by = excluded.created_by;

  perform private.log_mod_action(v_uid, 'redirect_set', 'redirect', null, null, null, p_reason,
                                 jsonb_build_object('from', v_from, 'to', v_to, 'permanent', coalesce(p_permanent, true)));
end;
$$;

create function public.admin_delete_redirect(p_from text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_admin_write(p_reason);
  v_from text := lower(rtrim(btrim(coalesce(p_from, '')), '/'));
begin
  if v_from = '' then
    v_from := '/';
  end if;
  delete from public.redirects where from_path = v_from;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'redirect');
  end if;
  perform private.log_mod_action(v_uid, 'redirect_removed', 'redirect', null, null, null, p_reason,
                                 jsonb_build_object('from', v_from));
end;
$$;

grant execute on function public.admin_redirects()                                to authenticated;
grant execute on function public.admin_set_redirect(text, text, boolean, text)    to authenticated;
grant execute on function public.admin_delete_redirect(text, text)                to authenticated;

-- ---------------------------------------------------------------------------
-- Username history: /u/<old-name> keeps working after a rename
-- ---------------------------------------------------------------------------
create table public.username_history (
  user_id      uuid        not null references public.profiles (id),
  old_username text        not null,
  changed_at   timestamptz not null default now(),
  primary key (user_id, old_username)
);
create index username_history_old on public.username_history (lower(old_username));
alter table public.username_history enable row level security;

create function private.record_username_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Tombstoning (deleted_xxxx) is not a rename anyone should be able to follow.
  if new.username is distinct from old.username
     and old.username !~ '^deleted_' and new.username !~ '^deleted_' then
    insert into public.username_history (user_id, old_username)
    values (old.id, old.username)
    on conflict (user_id, old_username) do update set changed_at = now();
    -- The member took back a previous name: that name no longer points elsewhere.
    delete from public.username_history where user_id = old.id and lower(old_username) = lower(new.username);
  end if;
  return new;
end;
$$;

create trigger profiles_username_history
  after update of username on public.profiles
  for each row execute function private.record_username_change();

-- The current username behind a former one, or null when nothing should redirect:
-- the name is unknown, a new member now holds it, or the account was deleted.
create function public.resolve_username(p_old text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.username
  from public.username_history h
  join public.profiles p on p.id = h.user_id
  where lower(h.old_username) = lower(btrim(coalesce(p_old, '')))
    and p.deleted_at is null
    and not exists (select 1 from public.profiles x where lower(x.username) = lower(h.old_username))
  order by h.changed_at desc
  limit 1;
$$;
grant execute on function public.resolve_username(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Sitemaps: what anonymous visitors can already see, in pages of 5,000
-- ---------------------------------------------------------------------------
create function public.sitemap_counts()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'posts',    (select count(*) from public.posts p where p.status in ('visible', 'collapsed')),
    'notes',    (select count(*) from public.notes n join public.posts p on p.id = n.post_id
                  where n.status = 'helpful' and n.hidden_at is null and p.status in ('visible', 'collapsed')),
    'profiles', (select count(*) from public.profiles m
                  where m.deleted_at is null
                    and exists (select 1 from public.posts p where p.author_id = m.id and p.status in ('visible', 'collapsed'))),
    'page_size', 5000
  );
$$;

create function public.sitemap_entries(p_kind text, p_page integer default 0)
returns table (path text, updated_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select x.path, x.updated_at
  from (
    select '/post/' || p.id as path,
           greatest(p.created_at, coalesce(p.edited_at, p.created_at), coalesce(p.status_changed_at, p.created_at)) as updated_at,
           p.created_at as sort_at
    from public.posts p
    where p_kind = 'posts' and p.status in ('visible', 'collapsed')
    union all
    select '/notes/' || n.id, greatest(n.created_at, n.status_since), n.created_at
    from public.notes n join public.posts p on p.id = n.post_id
    where p_kind = 'notes' and n.status = 'helpful' and n.hidden_at is null and p.status in ('visible', 'collapsed')
    union all
    select '/u/' || m.username, m.updated_at, m.created_at
    from public.profiles m
    where p_kind = 'profiles' and m.deleted_at is null
      and exists (select 1 from public.posts p where p.author_id = m.id and p.status in ('visible', 'collapsed'))
  ) x
  order by x.sort_at
  limit 5000 offset greatest(coalesce(p_page, 0), 0) * 5000;
$$;

grant execute on function public.sitemap_counts()               to anon, authenticated;
grant execute on function public.sitemap_entries(text, integer) to anon, authenticated;
