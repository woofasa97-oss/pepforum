-- ============================================================================
-- 0018 · Link review: an admin approves every link
--
-- A post or comment that contains a link (http://, https:// or www.) is saved
-- with status 'held' and the link's site in `links_pending`. Only its author
-- and moderators can see it until an admin decides on the Links page:
--   * approve this item: it is published, and its links stay approved
--     when the author edits it later;
--   * approve the site: this item and every waiting one from that site are
--     published, and future links to the site (and its subdomains) pass;
--   * decline: the item is removed without any karma penalty or strike;
--   * block the site: it joins the sourcing shield's blocked domains (later
--     posts are refused) and every waiting item linking to it is declined.
--
-- Moderators and admins are exempt, as with the shield. Community-note
-- sources are not reviewed: only Contributors with a proven rating record can
-- write notes, every note is rated before anyone sees it, and the shield
-- still refuses blocked domains there. `links.require_approval` turns the
-- whole review off.
--
-- Shield holds and link holds are tracked separately (held_reason vs
-- links_pending), so content is published only when both are cleared: a
-- moderator's "keep" in the queue doesn't publish an unapproved link, and
-- approving a link doesn't publish text the shield is holding.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Vocabulary, columns, approved sites, setting
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
  'link_hold', 'link_approved', 'link_declined', 'site_approved', 'site_unapproved'));

alter table public.posts    add column links_pending text[] check (links_pending is null or cardinality(links_pending) > 0);
alter table public.comments add column links_pending text[] check (links_pending is null or cardinality(links_pending) > 0);
create index posts_links_pending    on public.posts (status_changed_at)    where links_pending is not null;
create index comments_links_pending on public.comments (status_changed_at) where links_pending is not null;

create table public.approved_domains (
  domain     text primary key check (domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' and char_length(domain) <= 253),
  reason     text        not null default '' check (char_length(reason) <= 500),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
alter table public.approved_domains enable row level security;
-- Read and written only through the admin_link* RPCs; no API grants.

insert into public.app_config (key, value, is_public, description) values
  ('links.require_approval', 'true', true,
   'Posts and comments with a link wait until an admin approves it. Moderators and admins are exempt.');

-- ---------------------------------------------------------------------------
-- Finding links
-- ---------------------------------------------------------------------------
-- The host of every link in p_text, lowercased, without "www.", user info or
-- port. Any host counts, including ones that aren't plain ASCII, so an odd
-- spelling can't slip a link past review.
create function private.link_hosts(p_text text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct h.host order by h.host), '{}')
  from (
    select regexp_replace(regexp_replace(regexp_replace(regexp_replace(
             m[1], '^.*@', ''), ':[0-9]*$', ''), '\.+$', ''), '^www\.', '') as host
    from regexp_matches(lower(coalesce(p_text, '')),
                        '(?:https?://|\mwww\.)([^\s/?#<>"''(){}|\\^`,;!*\[\]]+)', 'g') as m
  ) h
  where h.host <> '';
$$;

-- The full links, for the admin page.
create function private.link_urls(p_text text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(m[1]), '{}')
  from regexp_matches(coalesce(p_text, ''), '((?:[Hh][Tt][Tt][Pp][Ss]?://|\m[Ww][Ww][Ww]\.)[^\s<>"'']+)', 'g') as m;
$$;

create function private.domain_covers(p_domain text, p_host text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_host = p_domain or right(p_host, char_length(p_domain) + 1) = '.' || p_domain;
$$;

-- The hosts in p_hosts that no approved site covers.
create function private.unapproved_hosts(p_hosts text[])
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(h order by h), '{}')
  from unnest(p_hosts) h
  where not exists (select 1 from public.approved_domains d where private.domain_covers(d.domain, h));
$$;

-- Hosts that still need a decision. On an edit, hosts that were in the old
-- text and not pending were already let through, and stay through.
create function private.pending_hosts(p_author uuid, p_new_text text, p_old_text text, p_old_pending text[])
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hosts text[];
  v_old   text[] := private.link_hosts(p_old_text);
begin
  if not private.cfg_bool('links.require_approval') or private.is_moderator(p_author) then
    return null;
  end if;
  v_hosts := array(
    select h from unnest(private.unapproved_hosts(private.link_hosts(p_new_text))) h
    where h = any (coalesce(p_old_pending, '{}')) or not (h = any (v_old)));
  return case when cardinality(v_hosts) > 0 then v_hosts end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Triggers. They're named to fire after posts_shield / comments_shield
-- (same-event triggers run in name order), so blocked domains are refused and
-- phrase holds recorded before links are looked at.
-- ---------------------------------------------------------------------------
create function private.shield_links_posts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status not in ('visible', 'collapsed', 'held') then
    return new;
  end if;
  new.links_pending := private.pending_hosts(
    new.author_id, concat_ws(' ', new.title, new.body, new.link_url),
    case when tg_op = 'UPDATE' then concat_ws(' ', old.title, old.body, old.link_url) end,
    case when tg_op = 'UPDATE' then old.links_pending end);
  if new.links_pending is not null and new.status <> 'held' then
    new.status := 'held';
    new.status_changed_at := now();
    perform private.log_mod_action(null, 'link_hold', 'post', new.id, new.author_id, new.zone_id,
                                   'link review', jsonb_build_object('hosts', to_jsonb(new.links_pending)));
  end if;
  return new;
end;
$$;

create function private.shield_links_comments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status not in ('visible', 'collapsed', 'held') then
    return new;
  end if;
  new.links_pending := private.pending_hosts(
    new.author_id, new.body,
    case when tg_op = 'UPDATE' then old.body end,
    case when tg_op = 'UPDATE' then old.links_pending end);
  if new.links_pending is not null and new.status <> 'held' then
    new.status := 'held';
    new.status_changed_at := now();
    perform private.log_mod_action(null, 'link_hold', 'comment', new.id, new.author_id,
                                   (select p.zone_id from public.posts p where p.id = new.post_id),
                                   'link review', jsonb_build_object('hosts', to_jsonb(new.links_pending)));
  end if;
  return new;
end;
$$;

-- Nothing publishes content whose links are still waiting: a queue "keep",
-- a restore or an upheld appeal sends it back to link review instead.
create function private.shield_links_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('visible', 'collapsed') and new.links_pending is not null then
    new.status := 'held';
  end if;
  return new;
end;
$$;

create trigger posts_shield_links before insert or update of title, body, link_url on public.posts
  for each row execute function private.shield_links_posts();
create trigger comments_shield_links before insert or update of body on public.comments
  for each row execute function private.shield_links_comments();
create trigger posts_shield_links_guard before update of status on public.posts
  for each row execute function private.shield_links_guard();
create trigger comments_shield_links_guard before update of status on public.comments
  for each row execute function private.shield_links_guard();

-- ---------------------------------------------------------------------------
-- Admin RPCs
-- ---------------------------------------------------------------------------
create function public.admin_links()
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
    'enabled', private.cfg_bool('links.require_approval'),
    'pending', coalesce((
      select jsonb_agg(i.item order by i.at) from (
        select jsonb_build_object(
                 'target_kind', 'post', 'target_id', p.id, 'post_id', p.id, 'zone_id', p.zone_id,
                 'title', p.title, 'body', left(p.body, 600),
                 'urls', to_jsonb(private.link_urls(concat_ws(' ', p.body, p.link_url, p.title))),
                 'hosts', to_jsonb(p.links_pending), 'held_reason', p.held_reason,
                 'author_username', a.username, 'author_tier', a.tier, 'author_karma', a.karma,
                 'author_integrity', private.integrity(a.id), 'author_joined', a.created_at,
                 'waiting_since', p.status_changed_at) as item,
               p.status_changed_at as at
        from public.posts p join public.profiles a on a.id = p.author_id
        where p.status = 'held' and p.links_pending is not null
        union all
        select jsonb_build_object(
                 'target_kind', 'comment', 'target_id', c.id, 'post_id', c.post_id, 'zone_id', p.zone_id,
                 'title', p.title, 'body', left(c.body, 600),
                 'urls', to_jsonb(private.link_urls(c.body)),
                 'hosts', to_jsonb(c.links_pending), 'held_reason', c.held_reason,
                 'author_username', a.username, 'author_tier', a.tier, 'author_karma', a.karma,
                 'author_integrity', private.integrity(a.id), 'author_joined', a.created_at,
                 'waiting_since', c.status_changed_at),
               c.status_changed_at
        from public.comments c join public.posts p on p.id = c.post_id join public.profiles a on a.id = c.author_id
        where c.status = 'held' and c.links_pending is not null
        order by 2 limit 200
      ) i), '[]'::jsonb),
    -- Sites waiting, busiest first: approving one clears every item below it.
    'sites', coalesce((
      select jsonb_agg(jsonb_build_object('host', s.host, 'items', s.items, 'since', s.since)
                       order by s.items desc, s.since)
      from (
        select h.host, count(*) as items, min(h.at) as since
        from (
          select unnest(p.links_pending) as host, p.status_changed_at as at
          from public.posts p where p.status = 'held' and p.links_pending is not null
          union all
          select unnest(c.links_pending), c.status_changed_at
          from public.comments c where c.status = 'held' and c.links_pending is not null
        ) h
        group by h.host
      ) s), '[]'::jsonb),
    'approved', coalesce((
      select jsonb_agg(jsonb_build_object('domain', d.domain, 'reason', d.reason, 'created_by', a.username,
                                          'created_at', d.created_at) order by d.domain)
      from public.approved_domains d left join public.profiles a on a.id = d.created_by), '[]'::jsonb),
    'approved_30d', (select count(*) from public.mod_actions m
                     where m.action = 'link_approved' and m.created_at > now() - interval '30 days'),
    'declined_30d', (select count(*) from public.mod_actions m
                     where m.action = 'link_declined' and m.created_at > now() - interval '30 days')
  );
end;
$$;

-- One item. p_decision: 'approve' | 'decline'.
create function public.admin_link_decide(p_kind text, p_id uuid, p_decision text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := private.require_admin_write(p_reason);
  v_target  record;
  v_pending text[];
  v_held    text;
begin
  select * into v_target from private.content_target(p_kind, p_id);
  if p_kind = 'post' then
    select p.links_pending, p.held_reason into v_pending, v_held from public.posts p where p.id = p_id for update;
  else
    select c.links_pending, c.held_reason into v_pending, v_held from public.comments c where c.id = p_id for update;
  end if;
  if v_target.status <> 'held' or v_pending is null then
    perform private.raise_error('PF409', 'not_pending');
  end if;

  if p_decision = 'approve' then
    if p_kind = 'post' then
      update public.posts
         set links_pending = null, status = case when v_held is null then 'visible' else 'held' end, status_changed_at = now()
       where id = p_id;
    else
      update public.comments
         set links_pending = null, status = case when v_held is null then 'visible' else 'held' end, status_changed_at = now()
       where id = p_id;
    end if;
  elsif p_decision = 'decline' then
    perform private.set_content_status(p_kind, p_id, 'removed', 'link_declined');
  else
    perform private.raise_error('PF422', 'invalid_decision');
  end if;
  perform private.log_mod_action(v_uid, case when p_decision = 'approve' then 'link_approved' else 'link_declined' end,
                                 p_kind, p_id, v_target.author_id, v_target.zone_id, btrim(p_reason),
                                 jsonb_build_object('hosts', to_jsonb(v_pending)));
end;
$$;

-- A whole site. p_decision: 'approve' | 'block' | 'unapprove'. Returns how
-- many waiting items were published (approve) or declined (block).
create function public.admin_link_site(p_host text, p_decision text, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_admin_write(p_reason);
  v_domain text := lower(btrim(coalesce(p_host, '')));
  v_count  integer := 0;
  v_item   record;
begin
  v_domain := regexp_replace(v_domain, '^[a-z]+://', '');
  v_domain := regexp_replace(v_domain, '[/?#:].*$', '');
  v_domain := regexp_replace(v_domain, '^www\.', '');
  if v_domain !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' or char_length(v_domain) > 253 then
    perform private.raise_error('PF422', 'invalid_domain');
  end if;

  if p_decision = 'approve' then
    insert into public.approved_domains (domain, reason, created_by) values (v_domain, btrim(p_reason), v_uid)
    on conflict (domain) do nothing;
    for v_item in
      select 'post' as kind, p.id, p.author_id, p.zone_id, p.links_pending, p.held_reason
      from public.posts p
      where p.status = 'held' and p.links_pending is not null
        and exists (select 1 from unnest(p.links_pending) h where private.domain_covers(v_domain, h))
      union all
      select 'comment', c.id, c.author_id, p.zone_id, c.links_pending, c.held_reason
      from public.comments c join public.posts p on p.id = c.post_id
      where c.status = 'held' and c.links_pending is not null
        and exists (select 1 from unnest(c.links_pending) h where private.domain_covers(v_domain, h))
    loop
      declare
        v_left text[] := array(select h from unnest(v_item.links_pending) h where not private.domain_covers(v_domain, h));
        v_next text[] := case when cardinality(v_left) > 0 then v_left end;
        v_status text := case when v_next is null and v_item.held_reason is null then 'visible' else 'held' end;
      begin
        if v_item.kind = 'post' then
          update public.posts set links_pending = v_next, status = v_status,
                 status_changed_at = case when v_status = 'visible' then now() else status_changed_at end
           where id = v_item.id;
        else
          update public.comments set links_pending = v_next, status = v_status,
                 status_changed_at = case when v_status = 'visible' then now() else status_changed_at end
           where id = v_item.id;
        end if;
        if v_next is null then
          v_count := v_count + 1;
          perform private.log_mod_action(v_uid, 'link_approved', v_item.kind, v_item.id, v_item.author_id, v_item.zone_id,
                                         btrim(p_reason), jsonb_build_object('hosts', to_jsonb(v_item.links_pending), 'site', v_domain));
        end if;
      end;
    end loop;
    perform private.log_mod_action(v_uid, 'site_approved', 'shield', null, null, null, btrim(p_reason),
                                   jsonb_build_object('domain', v_domain, 'published', v_count));

  elsif p_decision = 'block' then
    delete from public.approved_domains where domain = v_domain;
    insert into public.shield_domains (domain, reason, created_by) values (v_domain, btrim(p_reason), v_uid)
    on conflict (domain) do nothing;
    perform private.log_mod_action(v_uid, 'shield_rule_added', 'shield', null, null, null, btrim(p_reason),
                                   jsonb_build_object('kind', 'domain', 'value', v_domain, 'action', 'block'));
    for v_item in
      select 'post' as kind, p.id, p.author_id, p.zone_id, p.links_pending
      from public.posts p
      where p.status = 'held' and p.links_pending is not null
        and exists (select 1 from unnest(p.links_pending) h where private.domain_covers(v_domain, h))
      union all
      select 'comment', c.id, c.author_id, p.zone_id, c.links_pending
      from public.comments c join public.posts p on p.id = c.post_id
      where c.status = 'held' and c.links_pending is not null
        and exists (select 1 from unnest(c.links_pending) h where private.domain_covers(v_domain, h))
    loop
      perform private.set_content_status(v_item.kind, v_item.id, 'removed', 'link_declined');
      perform private.log_mod_action(v_uid, 'link_declined', v_item.kind, v_item.id, v_item.author_id, v_item.zone_id,
                                     btrim(p_reason), jsonb_build_object('hosts', to_jsonb(v_item.links_pending), 'site', v_domain));
      v_count := v_count + 1;
    end loop;

  elsif p_decision = 'unapprove' then
    delete from public.approved_domains where domain = v_domain;
    if not found then
      perform private.raise_error('PF404', 'not_found', 'approved_domain');
    end if;
    perform private.log_mod_action(v_uid, 'site_unapproved', 'shield', null, null, null, btrim(p_reason),
                                   jsonb_build_object('domain', v_domain));
  else
    perform private.raise_error('PF422', 'invalid_decision');
  end if;
  return v_count;
end;
$$;

grant execute on function public.admin_links()                              to authenticated;
grant execute on function public.admin_link_decide(text, uuid, text, text)  to authenticated;
grant execute on function public.admin_link_site(text, text, text)          to authenticated;

-- ---------------------------------------------------------------------------
-- Shield holds and link holds are counted apart: the moderator queue shows
-- only what the shield holds; links wait on the admin Links page.
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
        where hp.status = 'held' and hp.held_reason is not null and (p_zone is null or hp.zone_id = p_zone)
        union
        select hc.id, 'comment', hp.zone_id from public.comments hc join public.posts hp on hp.id = hc.post_id
        where hc.status = 'held' and hc.held_reason is not null and (p_zone is null or hp.zone_id = p_zone)
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

create or replace function public.admin_shield()
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
    'held_now', (select count(*) from public.posts p where p.status = 'held' and p.held_reason is not null)
              + (select count(*) from public.comments c where c.status = 'held' and c.held_reason is not null),
    'recent_holds', coalesce((
      select jsonb_agg(jsonb_build_object('username', p.username, 'rule', h.rule, 'rule_kind', h.rule_kind,
                                          'target_kind', h.target_kind, 'created_at', h.created_at) order by h.created_at desc)
      from (select * from public.shield_hits h order by h.created_at desc limit 30) h
      left join public.profiles p on p.id = h.user_id), '[]'::jsonb)
  );
end;
$$;
