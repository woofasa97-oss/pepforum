-- ============================================================================
-- 0008 · Privacy: data export and account deletion (PIPEDA, Québec Loi 25)
--
-- Deletion is two-phase:
--   1. request_account_deletion() immediately tombstones the profile
--      (username → deleted_xxxx, descriptive fields cleared, roles removed) and
--      optionally erases authored content; the member is signed out.
--   2. The worker deletes the auth user (email, password hash, sessions) via
--      the Auth admin API and marks the request processed.
-- The profile row survives as an anonymous id so the append-only ledger and
-- other members' karma stay consistent. A trigger also tombstones profiles of
-- auth users deleted any other way (e.g. from the Supabase dashboard).
-- See docs/DATA_PRIVACY.md.
-- ============================================================================

create table public.account_deletions (
  user_id       uuid primary key references public.profiles (id),
  erase_content boolean     not null default false,
  requested_at  timestamptz not null default now(),
  processed_at  timestamptz
);

create function private.tombstone_profile(p_user uuid, p_erase_content boolean)
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

create function private.on_auth_user_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.tombstone_profile(old.id, false);
  return old;
end;
$$;

create trigger on_auth_user_deleted
  before delete on auth.users
  for each row execute function private.on_auth_user_deleted();

create function public.request_account_deletion(p_erase_content boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.tombstone_profile(v_uid, coalesce(p_erase_content, false));
  insert into public.account_deletions (user_id, erase_content)
  values (v_uid, coalesce(p_erase_content, false))
  on conflict (user_id) do nothing;
end;
$$;

-- Everything Pepforum holds about the caller, as one JSON document.
create function public.export_my_data()
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
    'ledger',         coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from public.ledger_events e where e.user_id = v_uid), '[]'),
    'strikes',        coalesce((select jsonb_agg(to_jsonb(s)) from public.strikes s where s.user_id = v_uid), '[]'),
    'sanctions',      coalesce((select jsonb_agg(to_jsonb(s)) from public.sanctions s where s.user_id = v_uid), '[]'),
    'moderation_actions_on_me',
                      coalesce((select jsonb_agg(to_jsonb(a) - 'actor_id') from public.mod_actions a where a.target_user_id = v_uid), '[]')
  );
end;
$$;

alter table public.account_deletions enable row level security;

create policy account_deletions_self_read on public.account_deletions
  for select to authenticated using (user_id = auth.uid());

grant select on public.account_deletions to authenticated;
grant select, update (processed_at) on public.account_deletions to service_role;

grant execute on function public.request_account_deletion(boolean) to authenticated;
grant execute on function public.export_my_data()                  to authenticated;
