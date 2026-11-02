-- ============================================================================
-- 0005 · Content: posts, revisions, comments, votes
--
-- Clients never INSERT/UPDATE these tables directly. Every write goes through
-- an RPC below that checks the caller, their capability and rate limits.
--
-- Vote karma (docs/SELF_MODERATION.md §Karma):
--   * self-votes are rejected;
--   * whether a vote moves the author's karma is decided once, at cast time,
--     and stored in `counts_for_karma` (anti-farming: new accounts, low
--     integrity, >5 votes to one author per 30 days, >100/day per author);
--   * per item, the author's vote karma is floored at `karma.vote_floor_per_item`.
-- ============================================================================

create table public.posts (
  id                uuid primary key default gen_random_uuid(),
  author_id         uuid        not null references public.profiles (id),
  zone_id           text        not null references public.zones (id),
  city_id           text references public.cities (id),
  category_id       text        not null references public.categories (id),
  -- Experience posts are first-hand accounts. Notes add context to them but
  -- never produce a strike against the author (honest reports are protected).
  post_type         text        not null check (post_type in ('experience', 'claim', 'question', 'resource')),
  title             text        not null check (char_length(title) between 8 and 140),
  body              text        not null default '' check (char_length(body) <= 10000),
  link_url          text check (link_url is null or (link_url ~ '^https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(/\S*)?$' and char_length(link_url) <= 2048)),
  language          text        not null default 'en' check (language in ('en', 'fr')),
  status            text        not null default 'visible' check (status in ('visible', 'collapsed', 'removed', 'deleted')),
  status_changed_at timestamptz,
  removal_reason    text,
  score             integer     not null default 0,  -- net votes (all)
  karma_score       integer     not null default 0,  -- net votes that count for karma
  comment_count     integer     not null default 0,
  revision          integer     not null default 1,
  edited_at         timestamptz,
  created_at        timestamptz not null default now(),
  check (post_type <> 'resource' or link_url is not null or status = 'deleted')
);
create index posts_created      on public.posts (created_at desc);
create index posts_zone_created on public.posts (zone_id, created_at desc);
create index posts_cat_created  on public.posts (category_id, created_at desc);
create index posts_author       on public.posts (author_id, created_at desc);

-- Notes attach to the revision they were written against, so "the author
-- corrected the post" is a verifiable fact rather than a claim.
create table public.post_revisions (
  post_id    uuid    not null references public.posts (id),
  revision   integer not null,
  title      text    not null,
  body       text    not null,
  link_url   text,
  created_at timestamptz not null default now(),
  primary key (post_id, revision)
);

create table public.comments (
  id                uuid primary key default gen_random_uuid(),
  post_id           uuid        not null references public.posts (id),
  parent_id         uuid references public.comments (id),
  author_id         uuid        not null references public.profiles (id),
  body              text        not null check (char_length(body) between 1 and 5000),
  depth             smallint    not null default 0 check (depth between 0 and 6),
  status            text        not null default 'visible' check (status in ('visible', 'collapsed', 'removed', 'deleted')),
  status_changed_at timestamptz,
  removal_reason    text,
  score             integer     not null default 0,
  karma_score       integer     not null default 0,
  edited_at         timestamptz,
  created_at        timestamptz not null default now()
);
create index comments_post   on public.comments (post_id, created_at);
create index comments_author on public.comments (author_id, created_at desc);

create table public.post_votes (
  post_id          uuid     not null references public.posts (id),
  voter_id         uuid     not null references public.profiles (id),
  value            smallint not null check (value in (-1, 1)),
  counts_for_karma boolean  not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (post_id, voter_id)
);
create index post_votes_voter on public.post_votes (voter_id, created_at desc);

create table public.comment_votes (
  comment_id       uuid     not null references public.comments (id),
  voter_id         uuid     not null references public.profiles (id),
  value            smallint not null check (value in (-1, 1)),
  counts_for_karma boolean  not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (comment_id, voter_id)
);
create index comment_votes_voter on public.comment_votes (voter_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Vote-karma eligibility (decided once per vote, at cast time)
-- ---------------------------------------------------------------------------
create function private.vote_counts_for_karma(p_voter uuid, p_author uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_voter_created timestamptz;
  v_given_30d     integer;
  v_received_today integer;
begin
  select u.created_at into v_voter_created from auth.users u where u.id = p_voter;

  if v_voter_created is null
     or v_voter_created > now() - make_interval(days => private.cfg_int('gates.vote_counts.min_account_days')) then
    return false;
  end if;

  if private.integrity(p_voter) < private.cfg_int('gates.vote_counts.min_integrity') then
    return false;
  end if;

  -- One voter can move one author's karma only so much (vote rings, fans).
  select
    (select count(*) from public.post_votes v join public.posts p on p.id = v.post_id
      where v.voter_id = p_voter and p.author_id = p_author and v.counts_for_karma
        and v.created_at > now() - interval '30 days')
  + (select count(*) from public.comment_votes v join public.comments c on c.id = v.comment_id
      where v.voter_id = p_voter and c.author_id = p_author and v.counts_for_karma
        and v.created_at > now() - interval '30 days')
  into v_given_30d;

  if v_given_30d >= private.cfg_int('karma.max_counted_votes_per_voter_author_30d') then
    return false;
  end if;

  -- Daily cap on vote karma per author (viral spikes and brigades).
  select
    (select count(*) from public.post_votes v join public.posts p on p.id = v.post_id
      where p.author_id = p_author and v.counts_for_karma and v.created_at >= date_trunc('day', now()))
  + (select count(*) from public.comment_votes v join public.comments c on c.id = v.comment_id
      where c.author_id = p_author and v.counts_for_karma and v.created_at >= date_trunc('day', now()))
  into v_received_today;

  return v_received_today < private.cfg_int('karma.max_counted_votes_per_author_day');
end;
$$;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------
create function public.create_post(
  p_zone_id     text,
  p_category_id text,
  p_post_type   text,
  p_title       text,
  p_body        text,
  p_link_url    text default null,
  p_city_id     text default null,
  p_language    text default 'en'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := private.require_user();
  v_title text := btrim(coalesce(p_title, ''));
  v_body  text := btrim(coalesce(p_body, ''));
  v_link  text := nullif(btrim(coalesce(p_link_url, '')), '');
  v_id    uuid;
begin
  perform private.require_capability(v_uid, case when v_link is null then 'post_text' else 'post_link' end);
  perform private.enforce_rate_limit(v_uid, 'post');
  if private.integrity(v_uid) < private.cfg_int('gates.posting.cooldown_integrity') then
    perform private.enforce_rate_limit(v_uid, 'post_low_integrity');
  end if;

  if not exists (select 1 from public.zones z where z.id = p_zone_id) then
    perform private.raise_error('PF422', 'invalid_zone');
  end if;
  if not exists (select 1 from public.categories c where c.id = p_category_id and c.archived_at is null) then
    perform private.raise_error('PF422', 'invalid_category');
  end if;
  if p_city_id is not null and not exists (
    select 1 from public.cities c where c.id = p_city_id and c.zone_id = p_zone_id
  ) then
    perform private.raise_error('PF422', 'invalid_city');
  end if;
  if p_post_type is null or p_post_type not in ('experience', 'claim', 'question', 'resource') then
    perform private.raise_error('PF422', 'invalid_post_type');
  end if;
  if char_length(v_title) not between 8 and 140 then
    perform private.raise_error('PF422', 'invalid_title');
  end if;
  if char_length(v_body) > 10000 or (p_post_type <> 'resource' and char_length(v_body) < 1) then
    perform private.raise_error('PF422', 'invalid_body');
  end if;
  if p_post_type = 'resource' and v_link is null then
    perform private.raise_error('PF422', 'link_required');
  end if;
  if p_language is null or p_language not in ('en', 'fr') then
    perform private.raise_error('PF422', 'invalid_language');
  end if;

  insert into public.posts (author_id, zone_id, city_id, category_id, post_type, title, body, link_url, language)
  values (v_uid, p_zone_id, p_city_id, p_category_id, p_post_type, v_title, v_body, v_link, p_language)
  returning id into v_id;

  insert into public.post_revisions (post_id, revision, title, body, link_url)
  values (v_id, 1, v_title, v_body, v_link);

  return v_id;
end;
$$;

-- Editing creates a new revision. If a community note is currently shown on
-- the post and still within its correction window, the edit is recorded as a
-- correction: the author fixed the problem, so no strike will be applied when
-- the note settles (see private.settle_note).
create function public.edit_post(
  p_post_id  uuid,
  p_title    text,
  p_body     text,
  p_link_url text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := private.require_user();
  v_post  public.posts;
  v_title text := btrim(coalesce(p_title, ''));
  v_body  text := btrim(coalesce(p_body, ''));
  v_link  text := nullif(btrim(coalesce(p_link_url, '')), '');
  v_rev   integer;
begin
  select * into v_post from public.posts where id = p_post_id for update;
  if not found or v_post.author_id <> v_uid then
    perform private.raise_error('PF404', 'not_found', 'post');
  end if;
  if v_post.status not in ('visible', 'collapsed') then
    perform private.raise_error('PF409', 'not_editable');
  end if;
  -- Editing is posting: frozen, sanctioned or low-integrity members can't
  -- rewrite visible posts (e.g. to slip vendor details into an old thread).
  perform private.require_capability(v_uid, 'post_text');
  if v_link is not null and v_link is distinct from v_post.link_url then
    perform private.require_capability(v_uid, 'post_link');
  end if;
  perform private.enforce_rate_limit(v_uid, 'edit');

  if char_length(v_title) not between 8 and 140 then
    perform private.raise_error('PF422', 'invalid_title');
  end if;
  if char_length(v_body) > 10000 then
    perform private.raise_error('PF422', 'invalid_body');
  end if;
  if v_post.post_type = 'resource' and v_link is null then
    perform private.raise_error('PF422', 'link_required');
  end if;
  if (v_title, v_body, v_link) is not distinct from (v_post.title, v_post.body, v_post.link_url) then
    perform private.raise_error('PF422', 'no_changes');
  end if;

  v_rev := v_post.revision + 1;
  insert into public.post_revisions (post_id, revision, title, body, link_url)
  values (p_post_id, v_rev, v_title, v_body, v_link);

  update public.posts
     set title = v_title, body = v_body, link_url = v_link, revision = v_rev, edited_at = now()
   where id = p_post_id;

  -- A correction must actually change what the note was written against.
  -- (Whether the change is adequate is visible to everyone: revisions are public.)
  update public.notes n
     set post_corrected_at = now()
   where n.post_id = p_post_id
     and n.status = 'helpful'
     and n.locked_at is null
     and n.post_corrected_at is null
     and n.first_shown_at > now() - make_interval(hours => private.cfg_int('notes.correction_window_hours'))
     and exists (
       select 1 from public.post_revisions r
       where r.post_id = n.post_id and r.revision = n.post_revision
         and (r.title, r.body, r.link_url) is distinct from (v_title, v_body, v_link)
     );

  return v_rev;
end;
$$;

-- Soft delete. The row (and its revisions) stay so that notes, reports and
-- any settlement already under way remain verifiable; reads hide the content.
create function public.delete_own_post(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  update public.posts
     set status = 'deleted', status_changed_at = now()
   where id = p_post_id and author_id = v_uid and status in ('visible', 'collapsed');
  if not found then
    perform private.raise_error('PF404', 'not_found', 'post');
  end if;
end;
$$;

create function public.create_comment(p_post_id uuid, p_body text, p_parent_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_user();
  v_body   text := btrim(coalesce(p_body, ''));
  v_depth  smallint := 0;
  v_parent public.comments;
  v_id     uuid;
begin
  perform private.require_capability(v_uid, 'comment');
  perform private.enforce_rate_limit(v_uid, 'comment');

  if char_length(v_body) not between 1 and 5000 then
    perform private.raise_error('PF422', 'invalid_body');
  end if;

  perform 1 from public.posts p where p.id = p_post_id and p.status in ('visible', 'collapsed') for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'post');
  end if;

  if p_parent_id is not null then
    select * into v_parent from public.comments c where c.id = p_parent_id;
    if not found or v_parent.post_id <> p_post_id or v_parent.status not in ('visible', 'collapsed') then
      perform private.raise_error('PF404', 'not_found', 'parent_comment');
    end if;
    v_depth := v_parent.depth + 1;
    if v_depth > 6 then
      perform private.raise_error('PF422', 'thread_too_deep');
    end if;
  end if;

  insert into public.comments (post_id, parent_id, author_id, body, depth)
  values (p_post_id, p_parent_id, v_uid, v_body, v_depth)
  returning id into v_id;

  update public.posts set comment_count = comment_count + 1 where id = p_post_id;
  return v_id;
end;
$$;

-- A member-deleted comment's text is erased (it's theirs); a moderator-removed
-- comment keeps its text for appeals.
create function public.delete_own_comment(p_comment_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  update public.comments
     set status = 'deleted', status_changed_at = now(), body = '[deleted]'
   where id = p_comment_id and author_id = v_uid and status in ('visible', 'collapsed');
  if not found then
    perform private.raise_error('PF404', 'not_found', 'comment');
  end if;
end;
$$;

-- p_value: 1 upvote, -1 downvote, 0 remove vote.
create function public.cast_vote(p_target_kind text, p_target_id uuid, p_value smallint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := private.require_user();
  v_author  uuid;
  v_status  text;
  v_counts  boolean;
  v_score   integer;
  v_kscore  integer;
  v_floor   integer := private.cfg_int('karma.vote_floor_per_item');
begin
  perform private.require_capability(v_uid, 'vote');
  if p_value is null or p_value not in (-1, 0, 1) then
    perform private.raise_error('PF422', 'invalid_vote');
  end if;
  perform private.enforce_rate_limit(v_uid, 'vote');

  if p_target_kind = 'post' then
    select p.author_id, p.status into v_author, v_status
    from public.posts p where p.id = p_target_id for update;
  elsif p_target_kind = 'comment' then
    select c.author_id, c.status into v_author, v_status
    from public.comments c where c.id = p_target_id for update;
  else
    perform private.raise_error('PF422', 'invalid_target');
  end if;

  if v_author is null then
    perform private.raise_error('PF404', 'not_found', p_target_kind);
  end if;
  if v_status not in ('visible', 'collapsed') then
    perform private.raise_error('PF409', 'not_votable');
  end if;
  if v_author = v_uid then
    perform private.raise_error('PF422', 'self_vote');
  end if;

  if p_target_kind = 'post' then
    if p_value = 0 then
      delete from public.post_votes where post_id = p_target_id and voter_id = v_uid;
    else
      v_counts := private.vote_counts_for_karma(v_uid, v_author);
      insert into public.post_votes (post_id, voter_id, value, counts_for_karma)
      values (p_target_id, v_uid, p_value, v_counts)
      on conflict (post_id, voter_id)
      do update set value = excluded.value, updated_at = now();  -- eligibility is not re-evaluated
    end if;

    select coalesce(sum(value), 0), coalesce(sum(value) filter (where counts_for_karma), 0)
      into v_score, v_kscore
    from public.post_votes where post_id = p_target_id;

    update public.posts set score = v_score, karma_score = v_kscore where id = p_target_id;
    perform private.reconcile('post_votes:' || p_target_id, v_author, 'karma', 'post_votes',
                              'post', p_target_id, greatest(v_kscore, v_floor));
  else
    if p_value = 0 then
      delete from public.comment_votes where comment_id = p_target_id and voter_id = v_uid;
    else
      v_counts := private.vote_counts_for_karma(v_uid, v_author);
      insert into public.comment_votes (comment_id, voter_id, value, counts_for_karma)
      values (p_target_id, v_uid, p_value, v_counts)
      on conflict (comment_id, voter_id)
      do update set value = excluded.value, updated_at = now();
    end if;

    select coalesce(sum(value), 0), coalesce(sum(value) filter (where counts_for_karma), 0)
      into v_score, v_kscore
    from public.comment_votes where comment_id = p_target_id;

    update public.comments set score = v_score, karma_score = v_kscore where id = p_target_id;
    perform private.reconcile('comment_votes:' || p_target_id, v_author, 'karma', 'comment_votes',
                              'comment', p_target_id, greatest(v_kscore, v_floor));
  end if;

  return jsonb_build_object('score', v_score, 'my_vote', p_value);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.posts          enable row level security;
alter table public.post_revisions enable row level security;
alter table public.comments       enable row level security;
alter table public.post_votes     enable row level security;
alter table public.comment_votes  enable row level security;

create policy posts_read on public.posts
  for select to anon, authenticated
  using (
    status in ('visible', 'collapsed')
    or author_id = auth.uid()
    or (private.is_zone_mod(auth.uid(), zone_id) and private.staff_session())
  );

create policy post_revisions_read on public.post_revisions
  for select to anon, authenticated
  using (exists (select 1 from public.posts p where p.id = post_id));  -- inherits posts_read

create policy comments_read on public.comments
  for select to anon, authenticated
  using (
    -- Public only while the parent post is public: a post removed for
    -- sourcing must not leave its "DM me" replies readable.
    (status in ('visible', 'collapsed', 'deleted')   -- deleted shows as "[deleted]" to keep threads intact
     and exists (select 1 from public.posts p where p.id = post_id and p.status in ('visible', 'collapsed')))
    or author_id = auth.uid()
    or exists (select 1 from public.posts p where p.id = post_id
               and private.is_zone_mod(auth.uid(), p.zone_id) and private.staff_session())
  );

-- Votes are private: you see your own (to render the arrows), nobody else's.
create policy post_votes_self_read on public.post_votes
  for select to authenticated using (voter_id = auth.uid());
create policy comment_votes_self_read on public.comment_votes
  for select to authenticated using (voter_id = auth.uid());

grant select on public.posts, public.post_revisions, public.comments to anon, authenticated;
grant select on public.post_votes, public.comment_votes to authenticated;
grant select on public.posts, public.comments to service_role;

grant execute on function public.create_post(text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.edit_post(uuid, text, text, text)                         to authenticated;
grant execute on function public.delete_own_post(uuid)                                     to authenticated;
grant execute on function public.create_comment(uuid, text, uuid)                          to authenticated;
grant execute on function public.delete_own_comment(uuid)                                  to authenticated;
grant execute on function public.cast_vote(text, uuid, smallint)                           to authenticated;
