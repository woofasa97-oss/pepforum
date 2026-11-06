-- ============================================================================
-- 0020 · Contact the team: suggestions, reports and help tickets
--
-- A member opens a private ticket (a suggestion, a report about a member or a
-- post, a problem with the site, account help) and talks with the admins in
-- one thread. Admins read and answer every ticket from /admin/inbox.
--
--   * Status: open (waiting for the team) → answered (waiting for the member)
--     → closed. A member's reply moves it back to open. A closed ticket is
--     read-only for the member; an admin can reopen it or reply to it.
--   * The member sees replies as "the Pepforum team"; only admins see which
--     admin wrote what. An admin can't answer or close their own ticket.
--   * Nobody gets table access: every read and write is an RPC below. Member
--     writes need the basic 'report' capability (signed up, email confirmed,
--     not suspended or banned) and are rate limited.
--   * Messages are never edited. Deleting an account deletes the member's
--     tickets: they are private correspondence, and nothing else depends on
--     them (docs/DATA_PRIVACY.md).
--
-- See docs/ADMIN.md ("Inbox") and docs/SELF_MODERATION.md.
-- ============================================================================

create table public.support_tickets (
  id                  uuid primary key default gen_random_uuid(),
  member_id           uuid        not null references public.profiles (id),
  kind                text        not null check (kind in ('suggestion', 'report_member', 'report_content', 'bug', 'account', 'other')),
  subject             text        not null check (char_length(subject) between 3 and 120),
  -- What a report is about: a member (report_member) and/or a link.
  about_user_id       uuid        references public.profiles (id),
  about_url           text        check (about_url is null or (about_url ~ '^https://\S+$' and char_length(about_url) <= 500)),
  status              text        not null default 'open' check (status in ('open', 'answered', 'closed')),
  created_at          timestamptz not null default now(),
  last_message_at     timestamptz not null default now(),
  last_staff_reply_at timestamptz,
  member_read_at      timestamptz not null default now(),
  closed_at           timestamptz,
  closed_by           uuid        references public.profiles (id),
  check ((status = 'closed') = (closed_at is not null)),
  check (about_user_id is null or about_user_id <> member_id)
);
create index support_tickets_member on public.support_tickets (member_id, last_message_at desc);
create index support_tickets_status on public.support_tickets (status, last_message_at);

create table public.support_messages (
  id         uuid primary key default gen_random_uuid(),
  ticket_id  uuid        not null references public.support_tickets (id) on delete cascade,
  author_id  uuid        not null references public.profiles (id),
  from_staff boolean     not null,
  body       text        not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index support_messages_ticket on public.support_messages (ticket_id, created_at);

-- Messages are never edited. (Deletes happen only with the member's account.)
create trigger support_messages_no_update
  before update on public.support_messages
  for each row execute function private.forbid_mutation();

-- Read through the RPCs below; nobody gets table access.
alter table public.support_tickets  enable row level security;
alter table public.support_messages enable row level security;

insert into public.app_config (key, value, is_public, description) values
  ('rate_limit.open_ticket',  '{"limit": 5, "window_seconds": 86400}', false,
   'Tickets one member can open per day (suggestions, reports, help).'),
  ('rate_limit.ticket_reply', '{"limit": 30, "window_seconds": 3600}', false,
   'Replies one member can add to their tickets per hour.');

-- ---------------------------------------------------------------------------
-- Members: open, reply, close, read
-- ---------------------------------------------------------------------------
create function public.open_ticket(
  p_kind           text,
  p_subject        text,
  p_body           text,
  p_about_username text default null,
  p_about_url      text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := private.require_user();
  v_subject text := btrim(coalesce(p_subject, ''));
  v_body    text := btrim(coalesce(p_body, ''));
  v_url     text := nullif(btrim(coalesce(p_about_url, '')), '');
  v_about   uuid;
  v_id      uuid;
begin
  perform private.require_capability(v_uid, 'report');
  perform private.enforce_rate_limit(v_uid, 'open_ticket');

  if p_kind is null or p_kind not in ('suggestion', 'report_member', 'report_content', 'bug', 'account', 'other') then
    perform private.raise_error('PF422', 'invalid_kind');
  end if;
  if char_length(v_subject) not between 3 and 120 then
    perform private.raise_error('PF422', 'invalid_subject');
  end if;
  if char_length(v_body) not between 10 and 4000 then
    perform private.raise_error('PF422', 'invalid_body');
  end if;
  if v_url is not null and (v_url !~ '^https://\S+$' or char_length(v_url) > 500) then
    perform private.raise_error('PF422', 'invalid_url');
  end if;

  if p_kind = 'report_member' then
    select p.id into v_about from public.profiles p
     where lower(p.username) = lower(btrim(coalesce(p_about_username, ''))) and p.deleted_at is null;
    if v_about is null then
      perform private.raise_error('PF404', 'not_found', 'profile');
    end if;
    if v_about = v_uid then
      perform private.raise_error('PF422', 'report_self');
    end if;
  end if;

  insert into public.support_tickets (member_id, kind, subject, about_user_id, about_url)
  values (v_uid, p_kind, v_subject, v_about, v_url)
  returning id into v_id;
  insert into public.support_messages (ticket_id, author_id, from_staff, body)
  values (v_id, v_uid, false, v_body);
  return v_id;
end;
$$;

create function public.reply_ticket(p_ticket uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_user();
  v_body text := btrim(coalesce(p_body, ''));
  t      public.support_tickets;
begin
  perform private.require_capability(v_uid, 'report');
  perform private.enforce_rate_limit(v_uid, 'ticket_reply');

  select * into t from public.support_tickets x where x.id = p_ticket and x.member_id = v_uid for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'ticket');
  end if;
  if t.status = 'closed' then
    perform private.raise_error('PF409', 'ticket_closed');
  end if;
  if char_length(v_body) not between 1 and 4000 then
    perform private.raise_error('PF422', 'invalid_body');
  end if;

  insert into public.support_messages (ticket_id, author_id, from_staff, body)
  values (t.id, v_uid, false, v_body);
  update public.support_tickets
     set status = 'open', last_message_at = now(), member_read_at = now()
   where id = t.id;
end;
$$;

create function public.close_my_ticket(p_ticket uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  t     public.support_tickets;
begin
  perform private.require_capability(v_uid, 'report');
  perform private.enforce_rate_limit(v_uid, 'ticket_reply');

  select * into t from public.support_tickets x where x.id = p_ticket and x.member_id = v_uid for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'ticket');
  end if;
  if t.status = 'closed' then
    perform private.raise_error('PF409', 'ticket_closed');
  end if;

  update public.support_tickets
     set status = 'closed', closed_at = now(), closed_by = v_uid, member_read_at = now()
   where id = t.id;
end;
$$;

-- The caller's tickets, latest activity first. `unread` = a team reply they haven't opened.
create function public.my_tickets()
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
             'id', t.id, 'kind', t.kind, 'subject', t.subject, 'status', t.status,
             'created_at', t.created_at, 'last_message_at', t.last_message_at,
             'unread', coalesce(t.last_staff_reply_at > t.member_read_at, false),
             'messages', (select count(*) from public.support_messages m where m.ticket_id = t.id))
           order by t.last_message_at desc)
    from (select * from public.support_tickets x where x.member_id = v_uid
           order by x.last_message_at desc limit 100) t), '[]'::jsonb);
end;
$$;

-- One of the caller's tickets with its thread; opening it marks the team's replies read.
-- Returns null for a ticket that doesn't exist or isn't theirs.
create function public.my_ticket(p_ticket uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  t     public.support_tickets;
begin
  select * into t from public.support_tickets x where x.id = p_ticket and x.member_id = v_uid;
  if not found then
    return null;
  end if;
  update public.support_tickets set member_read_at = now() where id = t.id;

  return jsonb_build_object(
    'id', t.id, 'kind', t.kind, 'subject', t.subject, 'status', t.status,
    'about_username', (select p.username from public.profiles p where p.id = t.about_user_id),
    'about_url', t.about_url,
    'created_at', t.created_at, 'closed_at', t.closed_at,
    'closed_by_team', t.closed_at is not null and t.closed_by is distinct from t.member_id,
    -- Team replies carry no author: members see "the Pepforum team".
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'body', m.body, 'from_staff', m.from_staff, 'created_at', m.created_at)
                       order by m.created_at)
      from public.support_messages m where m.ticket_id = t.id), '[]'::jsonb)
  );
end;
$$;

grant execute on function public.open_ticket(text, text, text, text, text) to authenticated;
grant execute on function public.reply_ticket(uuid, text)                  to authenticated;
grant execute on function public.close_my_ticket(uuid)                     to authenticated;
grant execute on function public.my_tickets()                              to authenticated;
grant execute on function public.my_ticket(uuid)                           to authenticated;

-- ---------------------------------------------------------------------------
-- Admins: the inbox
-- ---------------------------------------------------------------------------
-- Tickets in one status: 'open' (waiting for the team, longest wait first),
-- 'answered' or 'closed' (latest first), optionally one kind, plus counts.
create function public.admin_tickets(p_status text default 'open', p_kind text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_user();
  v_status text := coalesce(p_status, 'open');
begin
  perform private.require_admin(v_uid);
  if v_status not in ('open', 'answered', 'closed') then
    perform private.raise_error('PF422', 'invalid_status');
  end if;

  return jsonb_build_object(
    'tickets', coalesce((
      select jsonb_agg(x.item order by x.n)
      from (
        select row_number() over (order by case when v_status = 'open' then t.last_message_at end asc,
                                           t.last_message_at desc) as n,
               jsonb_build_object(
                 'id', t.id, 'kind', t.kind, 'subject', t.subject, 'status', t.status,
                 'member', p.username, 'member_tier', p.tier, 'member_is_admin', private.is_admin(p.id),
                 'about', a.username,
                 'created_at', t.created_at, 'last_message_at', t.last_message_at,
                 'messages', (select count(*) from public.support_messages m where m.ticket_id = t.id),
                 'last_from_staff', (select m.from_staff from public.support_messages m where m.ticket_id = t.id
                                      order by m.created_at desc limit 1),
                 'preview', (select left(m.body, 160) from public.support_messages m where m.ticket_id = t.id
                              order by m.created_at desc limit 1)) as item
        from public.support_tickets t
        join public.profiles p on p.id = t.member_id
        left join public.profiles a on a.id = t.about_user_id
        where t.status = v_status
          and (p_kind is null or t.kind = p_kind)
          and (v_status <> 'closed' or t.closed_at > now() - interval '90 days')
        order by case when v_status = 'open' then t.last_message_at end asc, t.last_message_at desc
        limit 200
      ) x), '[]'::jsonb),
    'counts', jsonb_build_object(
      'open',       (select count(*) from public.support_tickets t where t.status = 'open'),
      'answered',   (select count(*) from public.support_tickets t where t.status = 'answered'),
      'closed_30d', (select count(*) from public.support_tickets t where t.status = 'closed' and t.closed_at > now() - interval '30 days')),
    'open_by_kind', coalesce((
      select jsonb_object_agg(k.kind, k.n)
      from (select t.kind, count(*) as n from public.support_tickets t where t.status = 'open' group by t.kind) k), '{}'::jsonb)
  );
end;
$$;

-- One ticket, its whole thread (with which admin wrote each reply) and who the member is.
create function public.admin_ticket(p_ticket uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  t     public.support_tickets;
  p     public.profiles;
begin
  perform private.require_admin(v_uid);
  select * into t from public.support_tickets x where x.id = p_ticket;
  if not found then
    return null;
  end if;
  select * into p from public.profiles x where x.id = t.member_id;

  return jsonb_build_object(
    'id', t.id, 'kind', t.kind, 'subject', t.subject, 'status', t.status,
    'about', (select a.username from public.profiles a where a.id = t.about_user_id),
    'about_url', t.about_url,
    'created_at', t.created_at, 'last_message_at', t.last_message_at, 'closed_at', t.closed_at,
    'closed_by', (select c.username from public.profiles c where c.id = t.closed_by),
    'closed_by_member', t.closed_by = t.member_id,
    'is_self', t.member_id = v_uid,
    'member', jsonb_build_object(
      'username', p.username, 'tier', p.tier, 'karma', p.karma, 'integrity', private.integrity(p.id),
      'joined', p.created_at, 'deleted', p.deleted_at is not null, 'is_admin', private.is_admin(p.id),
      'sanction', case when private.has_active_sanction(p.id, array['ban']) then 'ban'
                       when private.has_active_sanction(p.id, array['suspension']) then 'suspension'
                       when private.has_active_sanction(p.id, array['freeze']) then 'freeze' end,
      'tickets', (select count(*) from public.support_tickets x where x.member_id = p.id)),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'body', m.body, 'from_staff', m.from_staff,
                                          'author', u.username, 'created_at', m.created_at)
                       order by m.created_at)
      from public.support_messages m join public.profiles u on u.id = m.author_id
      where m.ticket_id = t.id), '[]'::jsonb)
  );
end;
$$;

-- Answer a ticket as the team; optionally close it in the same step.
create function public.admin_reply_ticket(p_ticket uuid, p_body text, p_close boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_user();
  v_body text := btrim(coalesce(p_body, ''));
  t      public.support_tickets;
begin
  perform private.require_admin(v_uid);
  perform private.enforce_rate_limit(v_uid, 'admin_action');

  select * into t from public.support_tickets x where x.id = p_ticket for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'ticket');
  end if;
  if t.member_id = v_uid then
    perform private.raise_error('PF403', 'conflict_of_interest');
  end if;
  if char_length(v_body) not between 1 and 4000 then
    perform private.raise_error('PF422', 'invalid_body');
  end if;

  insert into public.support_messages (ticket_id, author_id, from_staff, body)
  values (t.id, v_uid, true, v_body);
  update public.support_tickets
     set status              = case when coalesce(p_close, false) then 'closed' else 'answered' end,
         last_message_at     = now(),
         last_staff_reply_at = now(),
         closed_at           = case when coalesce(p_close, false) then now() end,
         closed_by           = case when coalesce(p_close, false) then v_uid end
   where id = t.id;
end;
$$;

-- Close a ticket without replying, or reopen it. Doing it twice changes nothing.
create function public.admin_set_ticket_closed(p_ticket uuid, p_closed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  t     public.support_tickets;
begin
  perform private.require_admin(v_uid);
  perform private.enforce_rate_limit(v_uid, 'admin_action');

  select * into t from public.support_tickets x where x.id = p_ticket for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'ticket');
  end if;
  if t.member_id = v_uid then
    perform private.raise_error('PF403', 'conflict_of_interest');
  end if;

  if coalesce(p_closed, false) and t.status <> 'closed' then
    update public.support_tickets set status = 'closed', closed_at = now(), closed_by = v_uid where id = t.id;
  elsif not coalesce(p_closed, false) and t.status = 'closed' then
    -- Back to whoever has to speak next.
    update public.support_tickets
       set status = case when (select m.from_staff from public.support_messages m where m.ticket_id = t.id
                                order by m.created_at desc limit 1) then 'answered' else 'open' end,
           closed_at = null, closed_by = null
     where id = t.id;
  end if;
end;
$$;

grant execute on function public.admin_tickets(text, text)                   to authenticated;
grant execute on function public.admin_ticket(uuid)                          to authenticated;
grant execute on function public.admin_reply_ticket(uuid, text, boolean)     to authenticated;
grant execute on function public.admin_set_ticket_closed(uuid, boolean)      to authenticated;

-- ---------------------------------------------------------------------------
-- Recreated from earlier migrations (verbatim, plus the lines marked …020)
-- ---------------------------------------------------------------------------
-- The header shows a dot when the team has replied (from …014).
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

-- Deleting an account deletes the member's tickets (from …008).
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

-- Your data export includes your tickets and their threads, not which admin replied (from …019).
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
    'ledger',         coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from public.ledger_events e where e.user_id = v_uid), '[]'),
    'strikes',        coalesce((select jsonb_agg(to_jsonb(s)) from public.strikes s where s.user_id = v_uid), '[]'),
    'sanctions',      coalesce((select jsonb_agg(to_jsonb(s)) from public.sanctions s where s.user_id = v_uid), '[]'),
    'moderation_actions_on_me',
                      coalesce((select jsonb_agg(to_jsonb(a) - 'actor_id') from public.mod_actions a where a.target_user_id = v_uid), '[]')
  );
end;
$$;

-- The admin home and sidebar count tickets waiting for the team (from …019).
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
    'tickets_open', (select count(*) from public.support_tickets t where t.status = 'open'),
    'tickets_oldest', (select min(t.last_message_at) from public.support_tickets t where t.status = 'open'),
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
