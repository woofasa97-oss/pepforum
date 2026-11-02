-- ============================================================================
-- 0009 · Read API
--
-- The query surface used by the web app. These functions are SECURITY DEFINER
-- because they *project* data rather than expose tables: they hide note-writer
-- identities behind aliases, hide rating breakdowns until a note locks, mask
-- removed content, and attach the caller's own vote/rating. Each one applies
-- its visibility rules explicitly in its WHERE clause; keep those rules in
-- step with the RLS policies on the underlying tables.
-- ============================================================================

create function public.get_feed(
  p_zone            text    default null,
  p_category        text    default null,
  p_city            text    default null,
  p_author_username text    default null,
  p_sort            text    default 'hot',
  p_limit           integer default 25,
  p_offset          integer default 0
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
  has_open_note   boolean
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
         exists (select 1 from public.notes n where n.post_id = p.id and n.status = 'helpful'),
         exists (select 1 from public.notes n where n.post_id = p.id and n.status = 'needs_more_ratings' and n.locked_at is null)
  from public.posts p
  join public.profiles a on a.id = p.author_id
  where p.status in ('visible', 'collapsed')
    and (p_zone is null or p_zone = 'national' or p.zone_id = p_zone)
    and (p_category is null or p.category_id = p_category)
    and (p_city is null or p.city_id = p_city)
    and (p_author_username is null or lower(a.username) = lower(p_author_username))
  order by
    case p_sort
      when 'new' then extract(epoch from p.created_at)
      when 'top' then p.score::numeric
      else p.score / power(extract(epoch from (now() - p.created_at)) / 3600 + 2, 1.5)
    end desc,
    p.created_at desc
  limit least(greatest(coalesce(p_limit, 25), 1), 50)
  offset least(greatest(coalesce(p_offset, 0), 0), 1000);
$$;

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
  can_moderate    boolean
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
         coalesce(private.is_zone_mod(auth.uid(), p.zone_id) and private.staff_session(), false)
  from public.posts p
  join public.profiles a on a.id = p.author_id
  where p.id = p_post_id
    and (p.status in ('visible', 'collapsed')
         or p.author_id = auth.uid()
         or (private.is_zone_mod(auth.uid(), p.zone_id) and private.staff_session()));
$$;

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
  order by c.created_at;
$$;

-- Note projection shared by get_post_notes / get_note / list_notes.
--   * anonymous visitors see Helpful notes only; members see every note;
--   * writer identity is replaced by a stable alias (moderators see it in mod tools);
--   * the helpful/somewhat/not breakdown is hidden until the note locks.
create function private.note_projection(p_note public.notes)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id',               p_note.id,
    'post_id',          p_note.post_id,
    'post_revision',    p_note.post_revision,
    'classification',   p_note.classification,
    'language',         p_note.language,
    'body',             p_note.body,
    'status',           p_note.status,
    'locked',           p_note.locked_at is not null,
    'locked_at',        p_note.locked_at,
    'first_shown_at',   p_note.first_shown_at,
    'post_corrected',   p_note.post_corrected_at is not null,
    'created_at',       p_note.created_at,
    'author_alias',     private.note_alias(p_note.author_id),
    'is_mine',          coalesce(p_note.author_id = auth.uid(), false),
    'rating_count',     (select count(*) from public.note_ratings r where r.note_id = p_note.id and r.weight > 0),
    'min_ratings',      private.note_min_ratings(p_note.id),
    'breakdown', case when p_note.locked_at is not null
                           or (private.is_moderator(auth.uid()) and private.staff_session()) then (
        select jsonb_build_object(
          'helpful',     count(*) filter (where r.value = 'helpful'),
          'somewhat',    count(*) filter (where r.value = 'somewhat'),
          'not_helpful', count(*) filter (where r.value = 'not_helpful'))
        from public.note_ratings r where r.note_id = p_note.id and r.weight > 0)
      end,
    'my_rating', (select jsonb_build_object('value', r.value, 'reasons', r.reasons)
                  from public.note_ratings r where r.note_id = p_note.id and r.rater_id = auth.uid()),
    'sources', coalesce((select jsonb_agg(jsonb_build_object('url', s.url, 'kind', s.kind) order by s.position)
                         from public.note_sources s where s.note_id = p_note.id), '[]'::jsonb)
  );
$$;

create function private.note_visible(p_note public.notes)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.posts p
    where p.id = p_note.post_id and p.status in ('visible', 'collapsed')
  )
  and (p_note.status = 'helpful' or auth.uid() is not null);
$$;

create function public.get_post_notes(p_post_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(private.note_projection(n)
                            order by (n.status = 'helpful') desc, n.created_at), '[]'::jsonb)
  from public.notes n
  where n.post_id = p_post_id and private.note_visible(n);
$$;

create function public.get_note(p_note_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.note_projection(n) || jsonb_build_object(
    'post', (select jsonb_build_object('id', p.id, 'title', p.title, 'body', left(p.body, 1200),
                                       'post_type', p.post_type, 'category_id', p.category_id, 'zone_id', p.zone_id,
                                       'is_mine', coalesce(p.author_id = auth.uid(), false))
             from public.posts p where p.id = n.post_id),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('event', h.event, 'from', h.from_status,
                                                             'to', h.to_status, 'at', h.created_at) order by h.id), '[]'::jsonb)
                from public.note_status_history h where h.note_id = n.id),
    'can_rate', n.locked_at is null
                and n.author_id is distinct from auth.uid()
                and (select p.author_id from public.posts p where p.id = n.post_id) is distinct from auth.uid()
                and private.has_capability(auth.uid(), 'rate_notes')
  )
  from public.notes n
  where n.id = p_note_id and private.note_visible(n);
$$;

create function public.list_notes(
  p_tab      text    default 'needs_ratings',
  p_category text    default null,
  p_limit    integer default 25,
  p_offset   integer default 0
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(private.note_projection(x.note) || jsonb_build_object('post_title', x.post_title)
                            order by (x.note).created_at desc), '[]'::jsonb)
  from (
    select n as note, p.title as post_title
    from public.notes n
    join public.posts p on p.id = n.post_id
    where private.note_visible(n)
      and (p_category is null or p.category_id = p_category)
      and case p_tab
            when 'needs_ratings' then n.status = 'needs_more_ratings' and n.locked_at is null
            when 'helpful'       then n.status = 'helpful'
            when 'not_helpful'   then n.status = 'not_helpful'
            when 'mine'          then n.author_id = auth.uid()
            else false
          end
    order by n.created_at desc
    limit least(greatest(coalesce(p_limit, 25), 1), 50)
    offset least(greatest(coalesce(p_offset, 0), 0), 1000)
  ) x;
$$;

create function public.get_profile(p_username text)
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
    'moderates',     coalesce((select jsonb_agg(m.zone_id) from public.zone_moderators m where m.user_id = p.id), '[]'::jsonb),
    'post_count',    (select count(*) from public.posts x where x.author_id = p.id and x.status in ('visible', 'collapsed')),
    'comment_count', (select count(*) from public.comments x where x.author_id = p.id and x.status in ('visible', 'collapsed'))
  )
  from public.profiles p
  where lower(p.username) = lower(p_username);
$$;

-- Moderator queue: open reports grouped per piece of content.
create function public.mod_queue(p_zone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.require_zone_mod(v_uid, p_zone);
  return coalesce((
    select jsonb_agg(t order by t ->> 'first_reported_at')
    from (
      select jsonb_build_object(
        'target_kind',       case when r.post_id is not null then 'post' else 'comment' end,
        'target_id',         coalesce(r.post_id, r.comment_id),
        'post_id',           coalesce(r.post_id, c.post_id),
        'excerpt',           coalesce(p.title, left(c.body, 200)),
        'body',              left(coalesce(p.body, c.body), 1200),
        'status',            coalesce(p.status, c.status),
        'author_username',   a.username,
        'author_tier',       a.tier,
        'author_integrity',  private.integrity(a.id),
        'author_prior_actions', (select count(*) from public.mod_actions m
                                 where m.target_user_id = a.id and m.action in ('remove', 'sanction')),
        'total_weight',      sum(r.weight),
        'report_count',      count(*),
        'first_reported_at', min(r.created_at),
        'reports', jsonb_agg(jsonb_build_object(
                     'id', r.id, 'reason', r.reason, 'details', r.details, 'weight', r.weight,
                     'reporter', rp.username, 'created_at', r.created_at) order by r.created_at)
      ) as t
      from public.reports r
      left join public.posts p    on p.id = r.post_id
      left join public.comments c on c.id = r.comment_id
      join public.profiles a      on a.id = coalesce(p.author_id, c.author_id)
      join public.profiles rp     on rp.id = r.reporter_id
      where r.status = 'open' and r.zone_id = p_zone
      group by r.post_id, r.comment_id, c.post_id, p.title, p.body, c.body, p.status, c.status, a.id, a.username, a.tier
    ) q
  ), '[]'::jsonb);
end;
$$;

create function public.open_appeals(p_zone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.require_zone_mod(v_uid, p_zone);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', ap.id, 'body', ap.body, 'created_at', ap.created_at,
      'appellant', u.username,
      'action', a.action, 'target_kind', a.target_kind, 'target_id', a.target_id, 'reason', a.reason,
      'acted_by', m.username, 'acted_at', a.created_at,
      'can_decide', a.actor_id is distinct from v_uid
    ) order by ap.created_at)
    from public.appeals ap
    join public.mod_actions a on a.id = ap.mod_action_id
    join public.profiles u on u.id = ap.appellant_id
    left join public.profiles m on m.id = a.actor_id
    where ap.status = 'open' and a.zone_id = p_zone
  ), '[]'::jsonb);
end;
$$;

grant execute on function public.get_feed(text, text, text, text, text, integer, integer) to anon, authenticated;
grant execute on function public.get_post(uuid)                                          to anon, authenticated;
grant execute on function public.get_comments(uuid)                                      to anon, authenticated;
grant execute on function public.get_post_notes(uuid)                                    to anon, authenticated;
grant execute on function public.get_note(uuid)                                          to anon, authenticated;
grant execute on function public.list_notes(text, text, integer, integer)                to anon, authenticated;
grant execute on function public.get_profile(text)                                       to anon, authenticated;
grant execute on function public.mod_queue(text)                                         to authenticated;
grant execute on function public.open_appeals(text)                                      to authenticated;
