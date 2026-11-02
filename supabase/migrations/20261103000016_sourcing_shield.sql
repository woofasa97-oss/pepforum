-- ============================================================================
-- 0016 · Sourcing shield, and one queue for admins
--
-- Pepforum's hard line is "no vendors, no sourcing". Reports and moderators
-- catch it after the fact; the shield catches the obvious cases first:
--   * blocked domains: a post, comment or note that links to (or names) a
--     listed vendor domain is rejected;
--   * watched phrases ("dm me", "telegram"…): `block` rejects the text,
--     `hold` saves it with status 'held' — invisible to everyone but the author
--     and moderators — until a moderator keeps or removes it. Held content
--     never reopens on its own (unlike report collapses).
-- Rules are checked by triggers, so every write path is covered. Moderators'
-- own posts are exempt (e.g. a warning that names a scam channel).
-- Only holds are recorded in shield_hits (author + rule, never the text): a
-- block rolls back the whole write, including any record of it.
--
-- The moderator queue (mod_queue / open_appeals) now also lists held content
-- and, for admins, every zone at once (p_zone = null), including sanction
-- appeals that belong to no zone.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 'held' status
-- ---------------------------------------------------------------------------
alter table public.posts drop constraint posts_status_check;
alter table public.posts add constraint posts_status_check
  check (status in ('visible', 'collapsed', 'held', 'removed', 'deleted'));
alter table public.comments drop constraint comments_status_check;
alter table public.comments add constraint comments_status_check
  check (status in ('visible', 'collapsed', 'held', 'removed', 'deleted'));

alter table public.posts    add column held_reason text;
alter table public.comments add column held_reason text;

-- ---------------------------------------------------------------------------
-- Rules and hits
-- ---------------------------------------------------------------------------
create table public.shield_domains (
  domain     text primary key check (domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' and char_length(domain) <= 253),
  reason     text        not null default '' check (char_length(reason) <= 500),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create table public.shield_phrases (
  id         uuid primary key default gen_random_uuid(),
  phrase     text        not null unique check (char_length(phrase) between 2 and 60 and phrase = lower(phrase)),
  action     text        not null check (action in ('hold', 'block')),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create table public.shield_hits (
  id          bigint generated always as identity primary key,
  rule_kind   text        not null check (rule_kind in ('domain', 'phrase')),
  rule        text        not null,
  user_id     uuid references public.profiles (id),
  target_kind text        not null check (target_kind in ('post', 'comment')),
  created_at  timestamptz not null default now()
);
create index shield_hits_created on public.shield_hits (created_at desc);
create index shield_hits_user    on public.shield_hits (user_id, created_at desc);

alter table public.shield_domains enable row level security;
alter table public.shield_phrases enable row level security;
alter table public.shield_hits    enable row level security;
-- Read and written only through the admin_shield* RPCs; no API grants.

insert into public.shield_phrases (phrase, action) values
  ('dm me', 'hold'), ('telegram', 'hold'), ('whatsapp', 'hold'), ('signal me', 'hold'), ('wickr', 'hold'),
  ('discount code', 'hold'), ('promo code', 'hold'), ('coupon code', 'hold');

-- ---------------------------------------------------------------------------
-- Matching
-- ---------------------------------------------------------------------------
-- Every rule that matches p_text. Domains match as whole host names (and
-- their subdomains), with or without a scheme; phrases match whole words,
-- case-insensitively.
create function private.shield_matches(p_text text)
returns table (rule_kind text, rule text, action text)
language sql
stable
security definer
set search_path = ''
as $$
  select 'domain', d.domain, 'block'
  from public.shield_domains d
  where lower(coalesce(p_text, '')) ~ ('(^|[^a-z0-9.-])([a-z0-9-]+\.)*' || replace(d.domain, '.', '\.') || '([^a-z0-9-]|$)')
  union all
  select 'phrase', f.phrase, f.action
  from public.shield_phrases f
  where lower(coalesce(p_text, '')) ~ ('(^|[^[:alnum:]])'
        || regexp_replace(f.phrase, '([.^$*+?()\[\]{}|\\])', '\\\1', 'g')
        || '($|[^[:alnum:]])');
$$;

-- 'block', 'hold' or null; records holds.
create function private.shield_verdict(p_kind text, p_user uuid, p_text text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_block text;
  v_hold  record;
begin
  if p_user is not null and private.is_moderator(p_user) then
    return null;
  end if;
  select m.rule into v_block from private.shield_matches(p_text) m where m.action = 'block' limit 1;
  if v_block is not null then
    return 'block';
  end if;
  select m.rule_kind, m.rule into v_hold from private.shield_matches(p_text) m where m.action = 'hold' limit 1;
  if v_hold.rule is null then
    return null;
  end if;
  insert into public.shield_hits (rule_kind, rule, user_id, target_kind)
  values (v_hold.rule_kind, v_hold.rule, p_user, p_kind);
  return 'hold:' || v_hold.rule;
end;
$$;

create function private.shield_posts()
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
    perform private.log_mod_action(null, 'shield_hold', 'post', new.id, new.author_id, new.zone_id,
                                   'sourcing shield', jsonb_build_object('rule', new.held_reason));
  end if;
  return new;
end;
$$;

create function private.shield_comments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_verdict text;
  v_zone    text;
begin
  if new.status not in ('visible', 'collapsed') then
    return new;
  end if;
  v_verdict := private.shield_verdict('comment', new.author_id, new.body);
  if v_verdict = 'block' then
    perform private.raise_error('PF422', 'blocked_by_shield');
  elsif v_verdict like 'hold:%' then
    select p.zone_id into v_zone from public.posts p where p.id = new.post_id;
    new.status := 'held';
    new.held_reason := substr(v_verdict, 6);
    new.status_changed_at := now();
    perform private.log_mod_action(null, 'shield_hold', 'comment', new.id, new.author_id, v_zone,
                                   'sourcing shield', jsonb_build_object('rule', new.held_reason));
  end if;
  return new;
end;
$$;

-- Notes and their sources can't be held (they have no review state), so any
-- matching rule rejects them.
create function private.shield_notes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_moderator(new.author_id) and exists (select 1 from private.shield_matches(new.body)) then
    perform private.raise_error('PF422', 'blocked_by_shield');
  end if;
  return new;
end;
$$;

create function private.shield_note_sources()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from private.shield_matches(new.url) m where m.rule_kind = 'domain')
     and not private.is_moderator((select n.author_id from public.notes n where n.id = new.note_id)) then
    perform private.raise_error('PF422', 'blocked_by_shield');
  end if;
  return new;
end;
$$;

create trigger posts_shield before insert or update of title, body, link_url on public.posts
  for each row execute function private.shield_posts();
create trigger comments_shield before insert or update of body on public.comments
  for each row execute function private.shield_comments();
create trigger notes_shield before insert on public.notes
  for each row execute function private.shield_notes();
create trigger note_sources_shield before insert on public.note_sources
  for each row execute function private.shield_note_sources();

-- ---------------------------------------------------------------------------
-- Held content stays out of public reads
-- ---------------------------------------------------------------------------
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
  my_vote         smallint
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
                                 or (private.is_zone_mod(auth.uid(), p.zone_id) and private.staff_session()), false)
             then '[removed by a moderator]'
           else c.body
         end,
         c.status, c.score, c.created_at, c.edited_at,
         (select v.value from public.comment_votes v where v.comment_id = c.id and v.voter_id = auth.uid())
  from public.comments c
  join public.posts p on p.id = c.post_id
  join public.profiles a on a.id = c.author_id
  where c.post_id = p_post_id
    and p.status in ('visible', 'collapsed')
    -- Held comments: only their author and the zone's moderators see them.
    and (c.status <> 'held'
         or coalesce(c.author_id = auth.uid()
                     or (private.is_zone_mod(auth.uid(), p.zone_id) and private.staff_session()), false))
  order by c.created_at;
$$;

-- ---------------------------------------------------------------------------
-- Queue: held content, and every zone for admins
-- ---------------------------------------------------------------------------
create or replace function public.mod_queue(p_zone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  if p_zone is null then
    perform private.require_admin(v_uid);
  else
    perform private.require_zone_mod(v_uid, p_zone);
  end if;
  return coalesce((
    select jsonb_agg(q.item order by q.first_at)
    from (
      select jsonb_build_object(
        'target_kind',       t.kind,
        'target_id',         t.target_id,
        'post_id',           coalesce(p.id, c.post_id),
        'zone_id',           t.zone_id,
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
               case when r.post_id is not null then 'post' else 'comment' end as kind,
               r.zone_id
        from public.reports r
        where r.status = 'open' and (p_zone is null or r.zone_id = p_zone)
        union
        select hp.id, 'post', hp.zone_id from public.posts hp
        where hp.status = 'held' and (p_zone is null or hp.zone_id = p_zone)
        union
        select hc.id, 'comment', hp.zone_id from public.comments hc join public.posts hp on hp.id = hc.post_id
        where hc.status = 'held' and (p_zone is null or hp.zone_id = p_zone)
      ) t
      left join public.posts p    on t.kind = 'post' and p.id = t.target_id
      left join public.comments c on t.kind = 'comment' and c.id = t.target_id
      join public.profiles a      on a.id = coalesce(p.author_id, c.author_id)
      left join public.reports r  on r.status = 'open' and (r.post_id = t.target_id or r.comment_id = t.target_id)
      left join public.profiles rp on rp.id = r.reporter_id
      group by t.kind, t.target_id, t.zone_id, p.id, c.id, a.id
    ) q
  ), '[]'::jsonb);
end;
$$;

create or replace function public.open_appeals(p_zone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  if p_zone is null then
    perform private.require_admin(v_uid);
  else
    perform private.require_zone_mod(v_uid, p_zone);
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', ap.id, 'body', ap.body, 'created_at', ap.created_at,
      'appellant', u.username, 'zone_id', a.zone_id,
      'action', a.action, 'target_kind', a.target_kind, 'target_id', a.target_id, 'reason', a.reason,
      'acted_by', m.username, 'acted_at', a.created_at,
      'can_decide', a.actor_id is distinct from v_uid and ap.appellant_id is distinct from v_uid
    ) order by ap.created_at)
    from public.appeals ap
    join public.mod_actions a on a.id = ap.mod_action_id
    join public.profiles u on u.id = ap.appellant_id
    left join public.profiles m on m.id = a.actor_id
    where ap.status = 'open' and (p_zone is null or a.zone_id = p_zone)
  ), '[]'::jsonb);
end;
$$;

-- "Keep" now also releases held content.
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
  perform private.require_zone_mod(v_uid, v_target.zone_id);
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
                                       v_target.zone_id, p_reason);
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

-- ---------------------------------------------------------------------------
-- Admin RPCs
-- ---------------------------------------------------------------------------
create function public.admin_shield()
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
    'domains', coalesce((
      select jsonb_agg(jsonb_build_object('domain', d.domain, 'reason', d.reason, 'created_by', a.username,
                                          'created_at', d.created_at) order by d.domain)
      from public.shield_domains d left join public.profiles a on a.id = d.created_by), '[]'::jsonb),
    'phrases', coalesce((
      select jsonb_agg(jsonb_build_object('phrase', f.phrase, 'action', f.action, 'created_by', a.username,
                                          'created_at', f.created_at,
                                          'holds_30d', (select count(*) from public.shield_hits h
                                                        where h.rule_kind = 'phrase' and h.rule = f.phrase
                                                          and h.created_at > now() - interval '30 days'))
                       order by f.phrase)
      from public.shield_phrases f left join public.profiles a on a.id = f.created_by), '[]'::jsonb),
    'held_now', (select count(*) from public.posts p where p.status = 'held')
              + (select count(*) from public.comments c where c.status = 'held'),
    'recent_holds', coalesce((
      select jsonb_agg(jsonb_build_object('username', p.username, 'rule', h.rule, 'rule_kind', h.rule_kind,
                                          'target_kind', h.target_kind, 'created_at', h.created_at) order by h.created_at desc)
      from (select * from public.shield_hits h order by h.created_at desc limit 30) h
      left join public.profiles p on p.id = h.user_id), '[]'::jsonb)
  );
end;
$$;

-- p_kind: 'domain' | 'phrase'. Domains are normalised ("https://www.Shop.example/x" → shop.example).
create function public.admin_shield_add(p_kind text, p_value text, p_action text, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := private.require_admin_write(p_reason);
  v_value text := lower(btrim(coalesce(p_value, '')));
begin
  if p_kind = 'domain' then
    v_value := regexp_replace(v_value, '^[a-z]+://', '');
    v_value := regexp_replace(v_value, '[/?#:].*$', '');
    v_value := regexp_replace(v_value, '^www\.', '');
    if v_value !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' or char_length(v_value) > 253 then
      perform private.raise_error('PF422', 'invalid_domain');
    end if;
    insert into public.shield_domains (domain, reason, created_by) values (v_value, btrim(p_reason), v_uid)
    on conflict (domain) do nothing;
  elsif p_kind = 'phrase' then
    v_value := regexp_replace(v_value, '\s+', ' ', 'g');
    if char_length(v_value) not between 2 and 60 then
      perform private.raise_error('PF422', 'invalid_phrase');
    end if;
    if p_action is null or p_action not in ('hold', 'block') then
      perform private.raise_error('PF422', 'invalid_action');
    end if;
    insert into public.shield_phrases (phrase, action, created_by) values (v_value, p_action, v_uid)
    on conflict (phrase) do update set action = excluded.action;
  else
    perform private.raise_error('PF422', 'invalid_kind');
  end if;
  perform private.log_mod_action(v_uid, 'shield_rule_added', 'shield', null, null, null, btrim(p_reason),
                                 jsonb_build_object('kind', p_kind, 'value', v_value, 'action', coalesce(p_action, 'block')));
  return v_value;
end;
$$;

create function public.admin_shield_remove(p_kind text, p_value text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_admin_write(p_reason);
begin
  if p_kind = 'domain' then
    delete from public.shield_domains where domain = lower(btrim(coalesce(p_value, '')));
  elsif p_kind = 'phrase' then
    delete from public.shield_phrases where phrase = lower(btrim(coalesce(p_value, '')));
  else
    perform private.raise_error('PF422', 'invalid_kind');
  end if;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'shield_rule');
  end if;
  perform private.log_mod_action(v_uid, 'shield_rule_removed', 'shield', null, null, null, btrim(p_reason),
                                 jsonb_build_object('kind', p_kind, 'value', lower(btrim(p_value))));
end;
$$;

-- Dry run: which rules would this text trigger? Records nothing.
create function public.admin_shield_test(p_text text)
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
  if char_length(coalesce(p_text, '')) > 10000 then
    perform private.raise_error('PF422', 'invalid_body');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('rule_kind', m.rule_kind, 'rule', m.rule, 'action', m.action))
    from private.shield_matches(p_text) m), '[]'::jsonb);
end;
$$;

grant execute on function public.admin_shield()                          to authenticated;
grant execute on function public.admin_shield_add(text, text, text, text) to authenticated;
grant execute on function public.admin_shield_remove(text, text, text)    to authenticated;
grant execute on function public.admin_shield_test(text)                  to authenticated;
