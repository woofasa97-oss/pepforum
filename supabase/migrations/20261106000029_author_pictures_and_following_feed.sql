-- ============================================================================
-- 0029 · Pictures next to authors, and the Following feed
--
--   * get_feed, get_post and get_comments return `author_avatar`: the
--     author's current profile picture (…027), served at /media/<id>, or null.
--   * get_feed takes `p_following`: only posts by people the caller follows,
--     with the usual sorts. Anonymous callers get an empty list; pins don't
--     lead it (they belong to their zone's feed).
-- The result shapes change, so the functions are dropped and recreated
-- (verbatim from …015 and …024 plus the lines marked …029) and re-granted.
-- ============================================================================

drop function public.get_feed(text, text, text, text, text, integer, integer);
create function public.get_feed(
  p_zone            text    default null,
  p_category        text    default null,
  p_city            text    default null,
  p_author_username text    default null,
  p_sort            text    default 'hot',
  p_limit           integer default 25,
  p_offset          integer default 0,
  p_following       boolean default false   -- …029: only people the caller follows
)
returns table (
  id              uuid,
  title           text,
  excerpt         text,
  post_type       text,
  link_url        text,
  language        text,
  status          text,
  zone_id         text,
  city_id         text,
  category_id     text,
  author_username text,
  author_tier     smallint,
  author_karma    integer,
  score           integer,
  comment_count   integer,
  created_at      timestamptz,
  edited_at       timestamptz,
  my_vote         smallint,
  has_helpful_note boolean,
  has_open_note   boolean,
  pinned          boolean,
  author_avatar   uuid                     -- …029
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.title, left(p.body, 400), p.post_type, p.link_url, p.language, p.status,
         p.zone_id, p.city_id, p.category_id,
         a.username, a.tier, a.karma,
         p.score, p.comment_count, p.created_at, p.edited_at,
         (select v.value from public.post_votes v where v.post_id = p.id and v.voter_id = auth.uid()),
         exists (select 1 from public.notes n where n.post_id = p.id and n.status = 'helpful' and n.hidden_at is null),
         exists (select 1 from public.notes n where n.post_id = p.id and n.status = 'needs_more_ratings'
                                                and n.locked_at is null and n.hidden_at is null),
         -- Pins lead the feed of their own zone (national pins lead the national feed).
         p.pinned_at is not null and p_author_username is null and p_category is null and p_city is null
           and coalesce(nullif(p_zone, ''), 'national') = p.zone_id
           and not coalesce(p_following, false),
         private.avatar_id(a.id)
  from public.posts p
  join public.profiles a on a.id = p.author_id
  where p.status in ('visible', 'collapsed')
    and (p_zone is null or p_zone = 'national' or p.zone_id = p_zone)
    and (p_category is null or p.category_id = p_category)
    and (p_city is null or p.city_id = p_city)
    and (p_author_username is null or lower(a.username) = lower(p_author_username))
    -- Following: false for anonymous callers (auth.uid() is null), so they get nothing.
    and (not coalesce(p_following, false)
         or exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.followee_id = p.author_id))
  order by
    (p.pinned_at is not null and p_author_username is null and p_category is null and p_city is null
       and coalesce(nullif(p_zone, ''), 'national') = p.zone_id and not coalesce(p_following, false)) desc,
    case p_sort
      when 'new' then extract(epoch from p.created_at)
      when 'top' then p.score::numeric
      else p.score / power(extract(epoch from (now() - p.created_at)) / 3600 + 2, 1.5)
    end desc,
    p.created_at desc
  limit least(greatest(coalesce(p_limit, 25), 1), 50)
  offset least(greatest(coalesce(p_offset, 0), 0), 1000);
$$;
grant execute on function public.get_feed(text, text, text, text, text, integer, integer, boolean) to anon, authenticated;

drop function public.get_post(uuid);
create function public.get_post(p_post_id uuid)
returns table (
  id              uuid,
  title           text,
  body            text,
  post_type       text,
  link_url        text,
  language        text,
  status          text,
  removal_reason  text,
  zone_id         text,
  city_id         text,
  category_id     text,
  author_username text,
  author_tier     smallint,
  author_karma    integer,
  is_mine         boolean,
  score           integer,
  comment_count   integer,
  revision        integer,
  created_at      timestamptz,
  edited_at       timestamptz,
  my_vote         smallint,
  can_moderate    boolean,
  pinned          boolean,
  comments_locked boolean,
  author_clinician text,
  author_avatar   uuid   -- …029
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id,
         case when p.status = 'deleted' then '[deleted post]' else p.title end,
         case when p.status = 'deleted' then '' else p.body end,
         p.post_type, p.link_url, p.language, p.status, p.removal_reason,
         p.zone_id, p.city_id, p.category_id,
         a.username, a.tier, a.karma,
         coalesce(p.author_id = auth.uid(), false),
         p.score, p.comment_count, p.revision, p.created_at, p.edited_at,
         (select v.value from public.post_votes v where v.post_id = p.id and v.voter_id = auth.uid()),
         coalesce(private.is_zone_mod(auth.uid(), p.zone_id) and private.staff_session(), false),
         p.pinned_at is not null,
         p.comments_locked_at is not null,
         private.clinician_badge(a.id),   -- …024
         private.avatar_id(a.id)          -- …029
  from public.posts p
  join public.profiles a on a.id = p.author_id
  where p.id = p_post_id
    and (p.status in ('visible', 'collapsed')
         or p.author_id = auth.uid()
         or (private.is_zone_mod(auth.uid(), p.zone_id) and private.staff_session()));
$$;
grant execute on function public.get_post(uuid) to anon, authenticated;

drop function public.get_comments(uuid);
create function public.get_comments(p_post_id uuid)
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
  my_vote         smallint,
  author_clinician text,
  author_avatar   uuid   -- …029
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
         (select v.value from public.comment_votes v where v.comment_id = c.id and v.voter_id = auth.uid()),
         private.clinician_badge(a.id),   -- …024
         private.avatar_id(a.id)          -- …029
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
grant execute on function public.get_comments(uuid) to anon, authenticated;
