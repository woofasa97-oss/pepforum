-- ============================================================================
-- 0022 · Notifications and web push
--
-- Ported from the pepforum-ca prototype build (src/modules/notifications.ts,
-- migration 009, public/sw.js) onto the Supabase model.
--
--   * A notification is created inside the database by triggers — a reply to
--     your post or comment, the outcome of a note you wrote, a helpful note on
--     your post, a moderator action on you or your content, a team reply to
--     your ticket — so it fires however the write happened (web app or direct
--     PostgREST call) and never from the client.
--   * Nothing is ever "sent" from the web app. The worker (apps/worker, the
--     only holder of the secret key) delivers web push through
--     pending_push() / record_push_results(); the web app only reads and marks.
--   * Who caused a notification is shown only when it is public anyway (the
--     author of a reply). Note writers stay pseudonymous; moderators stay
--     unnamed.
--   * Preferences are per category; push is opt-in and needs a subscription
--     (browser endpoint + keys), which the member can revoke at any time.
--   * Notifications are private correspondence: they are purged after
--     `notifications.retention_days` and deleted with the account, and listed
--     in the member's data export (docs/DATA_PRIVACY.md).
-- ============================================================================

create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid        not null references public.profiles (id),
  kind          text        not null check (kind in ('reply_post', 'reply_comment', 'note_outcome', 'note_on_post', 'mod_action', 'team_reply')),
  -- Only set when the actor is public (replies). Never for notes or moderation.
  actor_id      uuid        references public.profiles (id),
  post_id       uuid        references public.posts (id) on delete cascade,
  comment_id    uuid        references public.comments (id) on delete cascade,
  note_id       uuid        references public.notes (id) on delete cascade,
  ticket_id     uuid        references public.support_tickets (id) on delete cascade,
  mod_action_id uuid        references public.mod_actions (id),
  payload       jsonb       not null default '{}'::jsonb,
  -- One notification per event per member, however many times a trigger fires.
  dedupe_key    text        not null,
  read_at       timestamptz,
  pushed_at     timestamptz,
  created_at    timestamptz not null default now(),
  unique (user_id, dedupe_key)
);
create index notifications_user_unread on public.notifications (user_id, created_at desc) where read_at is null;
create index notifications_user        on public.notifications (user_id, created_at desc);
create index notifications_push        on public.notifications (created_at) where pushed_at is null;

create table public.notification_settings (
  user_id    uuid        primary key references public.profiles (id),
  replies    boolean     not null default true,
  notes      boolean     not null default true,
  moderation boolean     not null default true,
  team       boolean     not null default true,
  push       boolean     not null default false,
  updated_at timestamptz not null default now()
);
create trigger notification_settings_touch before update on public.notification_settings
  for each row execute function private.touch_updated_at();

create table public.push_subscriptions (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references public.profiles (id),
  endpoint        text        not null unique check (endpoint ~ '^https://\S+$' and char_length(endpoint) <= 2048),
  p256dh          text        not null check (char_length(p256dh) between 16 and 512),
  auth            text        not null check (char_length(auth) between 8 and 256),
  user_agent      text        not null default '' check (char_length(user_agent) <= 200),
  created_at      timestamptz not null default now(),
  last_success_at timestamptz,
  failures        integer     not null default 0
);
create index push_subscriptions_user on public.push_subscriptions (user_id);

-- Read through the RPCs below; nobody gets table access.
alter table public.notifications         enable row level security;
alter table public.notification_settings enable row level security;
alter table public.push_subscriptions    enable row level security;

insert into public.app_config (key, value, is_public, description) values
  ('notifications.retention_days', '90', false,
   'Notifications older than this are purged by the worker.'),
  ('rate_limit.push_subscribe',    '{"limit": 10, "window_seconds": 86400}', false,
   'Push subscriptions one member can register per day.'),
  ('rate_limit.notification_settings', '{"limit": 30, "window_seconds": 3600}', false,
   'Notification preference changes per member per hour.');
update public.app_config set bounds = '{"min": 7, "max": 730}' where key = 'notifications.retention_days';

-- ---------------------------------------------------------------------------
-- Creating notifications (internal)
-- ---------------------------------------------------------------------------
-- Does this member want this category? Defaults apply when they never saved settings.
create function private.notification_wanted(p_user uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_kind
           when 'reply_post'    then coalesce(s.replies, true)
           when 'reply_comment' then coalesce(s.replies, true)
           when 'note_outcome'  then coalesce(s.notes, true)
           when 'note_on_post'  then coalesce(s.notes, true)
           when 'mod_action'    then coalesce(s.moderation, true)
           when 'team_reply'    then coalesce(s.team, true)
           else false
         end
  from (select 1) x
  left join public.notification_settings s on s.user_id = p_user;
$$;

create function private.notify(
  p_user uuid, p_kind text, p_dedupe text,
  p_actor uuid default null, p_post uuid default null, p_comment uuid default null,
  p_note uuid default null, p_ticket uuid default null, p_mod_action uuid default null,
  p_payload jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user is null or p_user = p_actor then
    return;
  end if;
  if exists (select 1 from public.profiles p where p.id = p_user and p.deleted_at is not null) then
    return;
  end if;
  if not private.notification_wanted(p_user, p_kind) then
    return;
  end if;
  insert into public.notifications (user_id, kind, actor_id, post_id, comment_id, note_id, ticket_id, mod_action_id, payload, dedupe_key)
  values (p_user, p_kind, p_actor, p_post, p_comment, p_note, p_ticket, p_mod_action, coalesce(p_payload, '{}'::jsonb), p_dedupe)
  on conflict (user_id, dedupe_key) do nothing;
end;
$$;

-- Replies: the post's author hears about top-level comments, a comment's
-- author about direct replies. A held comment (link review, sourcing shield)
-- notifies once it becomes visible.
create function private.notify_comment(c public.comments)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post_author   uuid;
  v_parent_author uuid;
begin
  if c.status not in ('visible', 'collapsed') then
    return;
  end if;
  select p.author_id into v_post_author from public.posts p where p.id = c.post_id;
  if c.parent_id is null then
    perform private.notify(v_post_author, 'reply_post', 'comment:' || c.id, c.author_id, c.post_id, c.id);
  else
    select x.author_id into v_parent_author from public.comments x where x.id = c.parent_id;
    perform private.notify(v_parent_author, 'reply_comment', 'comment:' || c.id, c.author_id, c.post_id, c.id);
  end if;
end;
$$;

create function private.on_comment_for_notifications()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or (old.status = 'held' and new.status in ('visible', 'collapsed')) then
    perform private.notify_comment(new);
  end if;
  return new;
end;
$$;

create trigger comments_notify
  after insert or update of status on public.comments
  for each row execute function private.on_comment_for_notifications();

-- Notes: the writer learns the final outcome when the note locks; the post's
-- author learns a helpful note is now attached (and that fixing the post
-- within the correction window avoids a strike — see docs/SELF_MODERATION.md).
create function private.on_note_locked_for_notifications()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post_author uuid;
begin
  if old.locked_at is null and new.locked_at is not null then
    perform private.notify(new.author_id, 'note_outcome', 'note_locked:' || new.id, null, new.post_id, null, new.id, null, null,
                           jsonb_build_object('status', new.locked_status));
    if new.locked_status = 'helpful' and new.hidden_at is null then
      select p.author_id into v_post_author from public.posts p where p.id = new.post_id;
      perform private.notify(v_post_author, 'note_on_post', 'note_on_post:' || new.id, null, new.post_id, null, new.id);
    end if;
  end if;
  return new;
end;
$$;

create trigger notes_notify
  after update of locked_at on public.notes
  for each row execute function private.on_note_locked_for_notifications();

-- Moderation: the member concerned hears what happened and why, never who did it.
create function private.on_mod_action_for_notifications()
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
                           jsonb_build_object('action', new.action, 'reason', new.reason, 'zone_id', new.zone_id));
  end if;
  return new;
end;
$$;

create trigger mod_actions_notify
  after insert on public.mod_actions
  for each row execute function private.on_mod_action_for_notifications();

-- Team replies: the ticket's member, as "the Pepforum team".
create function private.on_support_message_for_notifications()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member uuid;
begin
  if new.from_staff then
    select t.member_id into v_member from public.support_tickets t where t.id = new.ticket_id;
    perform private.notify(v_member, 'team_reply', 'support_message:' || new.id, null, null, null, null, new.ticket_id);
  end if;
  return new;
end;
$$;

create trigger support_messages_notify
  after insert on public.support_messages
  for each row execute function private.on_support_message_for_notifications();

-- ---------------------------------------------------------------------------
-- Members: read, mark, preferences, push subscriptions
-- ---------------------------------------------------------------------------
create function public.my_notifications(p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', n.id, 'kind', n.kind, 'created_at', n.created_at, 'read', n.read_at is not null,
             'actor', (select a.username from public.profiles a where a.id = n.actor_id and a.deleted_at is null),
             'post', (select jsonb_build_object('id', p.id, 'title', case when p.status = 'deleted' then '[deleted post]' else p.title end)
                      from public.posts p where p.id = n.post_id),
             'comment_excerpt', (select case when c.status in ('visible', 'collapsed') then left(c.body, 140) end
                                 from public.comments c where c.id = n.comment_id),
             'note_status', n.payload ->> 'status',
             'action', n.payload ->> 'action',
             'reason', n.payload ->> 'reason',
             'ticket', (select jsonb_build_object('id', t.id, 'subject', t.subject) from public.support_tickets t where t.id = n.ticket_id))
           order by n.created_at desc)
    from (select * from public.notifications x where x.user_id = v_uid
           order by x.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) n), '[]'::jsonb);
end;
$$;

-- Mark some (p_ids) or all (null) of the caller's notifications read. Returns how many changed.
create function public.mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_n   integer;
begin
  update public.notifications
     set read_at = now()
   where user_id = v_uid and read_at is null
     and (p_ids is null or id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create function public.my_notification_settings()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'replies',    coalesce(s.replies, true),
    'notes',      coalesce(s.notes, true),
    'moderation', coalesce(s.moderation, true),
    'team',       coalesce(s.team, true),
    'push',       coalesce(s.push, false),
    'subscriptions', (select count(*) from public.push_subscriptions x where x.user_id = private.require_user()))
  from (select 1) o
  left join public.notification_settings s on s.user_id = private.require_user();
$$;

create function public.set_notification_settings(
  p_replies boolean, p_notes boolean, p_moderation boolean, p_team boolean, p_push boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.enforce_rate_limit(v_uid, 'notification_settings');
  insert into public.notification_settings (user_id, replies, notes, moderation, team, push)
  values (v_uid, coalesce(p_replies, true), coalesce(p_notes, true), coalesce(p_moderation, true), coalesce(p_team, true), coalesce(p_push, false))
  on conflict (user_id) do update
    set replies = excluded.replies, notes = excluded.notes, moderation = excluded.moderation, team = excluded.team, push = excluded.push;
end;
$$;

-- Register this browser for push. Re-registering the same endpoint (keys rotate) updates it.
create function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default '')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_id  uuid;
begin
  perform private.enforce_rate_limit(v_uid, 'push_subscribe');
  if coalesce(p_endpoint, '') !~ '^https://\S+$' or char_length(p_endpoint) > 2048 then
    perform private.raise_error('PF422', 'invalid_push_endpoint');
  end if;
  if char_length(coalesce(p_p256dh, '')) not between 16 and 512 or char_length(coalesce(p_auth, '')) not between 8 and 256 then
    perform private.raise_error('PF422', 'invalid_push_keys');
  end if;

  -- An endpoint belongs to one browser profile; if another account registered it, it moves.
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (v_uid, p_endpoint, p_p256dh, p_auth, left(coalesce(p_user_agent, ''), 200))
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, failures = 0
  returning id into v_id;

  insert into public.notification_settings (user_id, push) values (v_uid, true)
  on conflict (user_id) do update set push = true;
  return v_id;
end;
$$;

create function public.delete_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  delete from public.push_subscriptions where user_id = v_uid and endpoint = p_endpoint;
  if not exists (select 1 from public.push_subscriptions x where x.user_id = v_uid) then
    update public.notification_settings set push = false where user_id = v_uid;
  end if;
end;
$$;

grant execute on function public.my_notifications(integer)                                    to authenticated;
grant execute on function public.mark_notifications_read(uuid[])                               to authenticated;
grant execute on function public.my_notification_settings()                                    to authenticated;
grant execute on function public.set_notification_settings(boolean, boolean, boolean, boolean, boolean) to authenticated;
grant execute on function public.save_push_subscription(text, text, text, text)                to authenticated;
grant execute on function public.delete_push_subscription(text)                                to authenticated;

-- ---------------------------------------------------------------------------
-- Worker: push delivery (service_role only)
-- ---------------------------------------------------------------------------
-- Unpushed notifications for members with push on, with every subscription to
-- send to and the facts the worker needs to word the message in their locale.
-- Notifications for members without push are marked pushed immediately so
-- the backlog never grows.
create function public.pending_push(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  update public.notifications n
     set pushed_at = now()
   where n.pushed_at is null
     and not exists (select 1 from public.notification_settings s
                      where s.user_id = n.user_id and s.push
                        and exists (select 1 from public.push_subscriptions x where x.user_id = s.user_id));

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', n.id, 'kind', n.kind, 'locale', p.locale,
           'post_title', (select left(case when x.status = 'deleted' then '' else x.title end, 80) from public.posts x where x.id = n.post_id),
           'url', case
                    when n.post_id is not null and n.comment_id is not null then '/post/' || n.post_id || '#c-' || n.comment_id
                    when n.note_id is not null then '/notes/' || n.note_id
                    when n.post_id is not null then '/post/' || n.post_id
                    when n.ticket_id is not null then '/contact/' || n.ticket_id
                    else '/notifications' end,
           'subscriptions', coalesce((
             select jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
             from public.push_subscriptions s where s.user_id = n.user_id), '[]'::jsonb))
         order by n.created_at), '[]'::jsonb)
    into v_rows
  from (select * from public.notifications x where x.pushed_at is null order by x.created_at limit least(greatest(coalesce(p_limit, 200), 1), 1000)) n
  join public.profiles p on p.id = n.user_id;
  return v_rows;
end;
$$;

-- p_results: [{ "notification_id": uuid, "subscription_id": uuid, "ok": bool, "gone": bool }]
-- `gone` (HTTP 404/410 from the push service) drops the subscription; other
-- failures count up and drop it after five in a row.
create function public.record_push_results(p_results jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r         record;
  v_dropped integer := 0;
  v_sent    integer := 0;
begin
  for r in select (e ->> 'notification_id')::uuid as nid, (e ->> 'subscription_id')::uuid as sid,
                  coalesce((e ->> 'ok')::boolean, false) as ok, coalesce((e ->> 'gone')::boolean, false) as gone
           from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) e
  loop
    update public.notifications set pushed_at = coalesce(pushed_at, now()) where id = r.nid;
    if r.sid is null then
      continue;
    end if;
    if r.ok then
      update public.push_subscriptions set last_success_at = now(), failures = 0 where id = r.sid;
      v_sent := v_sent + 1;
    elsif r.gone then
      delete from public.push_subscriptions where id = r.sid;
      v_dropped := v_dropped + 1;
    else
      update public.push_subscriptions set failures = failures + 1 where id = r.sid;
      delete from public.push_subscriptions where id = r.sid and failures >= 5;
      if found then v_dropped := v_dropped + 1; end if;
    end if;
  end loop;
  -- Members whose last browser was dropped are no longer "push on".
  update public.notification_settings s set push = false
   where s.push and not exists (select 1 from public.push_subscriptions x where x.user_id = s.user_id);
  return jsonb_build_object('sent', v_sent, 'dropped', v_dropped);
end;
$$;

create function private.purge_old_notifications()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.notifications
   where created_at < now() - make_interval(days => private.cfg_int('notifications.retention_days'));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

grant execute on function public.pending_push(integer)      to service_role;
grant execute on function public.record_push_results(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Recreated from earlier migrations (verbatim, plus the lines marked …022)
-- ---------------------------------------------------------------------------
-- Maintenance also purges old notifications (from …012).
create or replace function public.run_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return jsonb_build_object(
    'uncollapsed',         public.expire_stale_collapses(),
    'rate_limit_purged',   private.purge_rate_limit_events(),
    'assignments_purged',  private.purge_stale_assignments(),
    'notifications_purged', private.purge_old_notifications()   -- …022
  );
end;
$$;

-- The header shows the unread count (from …020).
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

-- Deleting an account deletes its notifications, preferences and browsers (from …020).
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

-- Your data export includes your notifications, preferences and push browsers (from …020).
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
    'ledger',         coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from public.ledger_events e where e.user_id = v_uid), '[]'),
    'strikes',        coalesce((select jsonb_agg(to_jsonb(s)) from public.strikes s where s.user_id = v_uid), '[]'),
    'sanctions',      coalesce((select jsonb_agg(to_jsonb(s)) from public.sanctions s where s.user_id = v_uid), '[]'),
    'moderation_actions_on_me',
                      coalesce((select jsonb_agg(to_jsonb(a) - 'actor_id') from public.mod_actions a where a.target_user_id = v_uid), '[]')
  );
end;
$$;
