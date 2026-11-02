-- ============================================================================
-- 0006 · Community notes (ADR-0003, docs/SELF_MODERATION.md §Notes)
--
-- Lifecycle
--   proposed ─▶ needs_more_ratings ◀─▶ helpful / not_helpful ─▶ locked
--
--   * Status is computed outside the database by the scoring worker
--     (apps/worker) and applied atomically by apply_note_scores().
--   * A note locks once its status has been stable for `notes.lock_stable_hours`
--     with enough full-weight ratings, or when it reaches `notes.max_age_days`.
--   * Rewards and penalties are paid only at lock ("settlement"), never at
--     rating time, so there is nothing to farm and nothing flip-flops.
--
-- Anti-gaming
--   * Raters can't rate their own notes or notes on their own posts.
--   * New raters are on probation: their ratings carry zero weight until their
--     record shows they agree with eventual cross-perspective consensus.
--   * Notes reach raters through a randomised queue; ratings on notes the
--     server didn't assign count at `notes.unassigned_weight`.
--   * Ratings cast after a note's status became public earn nothing (herding).
--   * Rater rewards are base-rate adjusted: xp = scale·(match − π), where π is
--     the recent match rate for that rating value, so guessing earns ~0.
--   * Writers are pseudonymous to the public; breakdowns are hidden until lock.
--     Writer rewards go to the private moderation track (mod_xp, writer
--     impact), never to public karma: a public karma jump at settlement would
--     reveal who wrote the note.
-- ============================================================================

create table public.notes (
  id                uuid primary key default gen_random_uuid(),
  post_id           uuid        not null references public.posts (id),
  post_revision     integer     not null,
  author_id         uuid        not null references public.profiles (id),
  classification    text        not null check (classification in
                      ('misleading', 'missing_context', 'outdated', 'unverifiable', 'opinion_as_fact', 'satire')),
  language          text        not null default 'en' check (language in ('en', 'fr')),
  body              text        not null check (char_length(body) between 20 and 500),
  status            text        not null default 'needs_more_ratings'
                      check (status in ('needs_more_ratings', 'helpful', 'not_helpful')),
  status_since      timestamptz not null default now(),
  first_shown_at    timestamptz,                -- first time the note became Helpful (public)
  locked_at         timestamptz,
  locked_status     text check (locked_status in ('needs_more_ratings', 'helpful', 'not_helpful')),
  intercept         double precision,           -- latest scoring output
  factor            double precision,
  scoring_mode      text check (scoring_mode in ('bootstrap', 'bridging')),
  scored_at         timestamptz,
  post_corrected_at timestamptz,                -- author edited the post within the correction window
  created_at        timestamptz not null default now(),
  unique (post_id, author_id),
  foreign key (post_id, post_revision) references public.post_revisions (post_id, revision),
  check ((locked_at is null) = (locked_status is null))
);
create index notes_post        on public.notes (post_id);
create index notes_author      on public.notes (author_id, created_at desc);
create index notes_open_status on public.notes (status, created_at) where locked_at is null;

create table public.note_sources (
  id       uuid primary key default gen_random_uuid(),
  note_id  uuid     not null references public.notes (id),
  url      text     not null check (url ~ '^https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}/\S+$' and char_length(url) <= 2048),
  kind     text     not null check (kind in ('journal', 'registry', 'gov', 'news', 'other')),
  position smallint not null check (position between 1 and 5),
  unique (note_id, position)
);

create table public.note_ratings (
  note_id           uuid        not null references public.notes (id),
  rater_id          uuid        not null references public.profiles (id),
  value             text        not null check (value in ('helpful', 'somewhat', 'not_helpful')),
  reasons           text[]      not null check (cardinality(reasons) between 1 and 6),
  weight            numeric(3,2) not null check (weight between 0 and 1),
  cast_while_public boolean     not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (note_id, rater_id)
);
create index note_ratings_rater on public.note_ratings (rater_id, created_at desc);

create table public.rating_assignments (
  rater_id    uuid not null references public.profiles (id),
  note_id     uuid not null references public.notes (id),
  assigned_at timestamptz not null default now(),
  primary key (rater_id, note_id)
);

create table public.scoring_runs (
  id            uuid primary key,
  mode          text        not null check (mode in ('bootstrap', 'bridging')),
  snapshot_ts   timestamptz not null,
  notes_scored  integer     not null default 0,
  transitions   integer     not null default 0,
  locked        integer     not null default 0,
  skipped_stale integer     not null default 0,
  shadow        jsonb,
  created_at    timestamptz not null default now()
);

create table public.note_status_history (
  id          bigint generated always as identity primary key,
  note_id     uuid        not null references public.notes (id),
  event       text        not null check (event in ('proposed', 'status_changed', 'locked')),
  from_status text,
  to_status   text,
  run_id      uuid references public.scoring_runs (id),
  created_at  timestamptz not null default now()
);
create index note_status_history_note on public.note_status_history (note_id, created_at);

create trigger note_status_history_append_only
  before update or delete on public.note_status_history
  for each row execute function private.forbid_mutation();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Stable public pseudonym for a note writer ("Contributor 3FA2").
create function private.note_alias(p_author uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select 'Contributor ' || upper(substr(md5(p_author::text || s.value), 1, 4))
  from private.settings s where s.key = 'note_alias_salt';
$$;

create function private.note_min_ratings(p_note_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(c.min_note_ratings::integer, private.cfg_int('notes.min_ratings'))
  from public.notes n
  join public.posts p on p.id = n.post_id
  join public.categories c on c.id = p.category_id
  where n.id = p_note_id;
$$;

create function private.rating_reasons_valid(p_value text, p_reasons text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select cardinality(p_reasons) between 1 and 6
     and cardinality(p_reasons) = (select count(distinct r) from unnest(p_reasons) r)
     and p_reasons <@ case p_value
       when 'helpful'     then array['cites_sources', 'clear', 'addresses_claim', 'neutral', 'important_context']
       when 'somewhat'    then array['sources_weak', 'partial', 'unclear', 'minor_errors']
       when 'not_helpful' then array['no_sources', 'source_mismatch', 'off_topic', 'opinion', 'incorrect', 'argumentative', 'harassment']
       else array[]::text[]
     end;
$$;

-- A rating "counts" for accuracy when it was cast before the note's status was
-- public and expressed a definite view (not 'somewhat').
create function private.rating_matches(p_value text, p_final text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_value = 'helpful' and p_final = 'helpful')
      or (p_value = 'not_helpful' and p_final = 'not_helpful');
$$;

-- π_v: recent probability that a rating of value v matched the settled outcome.
-- Paying scale·(match − π) makes always-voting-the-majority worth ~0.
create function private.rating_base_rate(p_value text, p_exclude_note uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total   integer;
  v_matched integer;
begin
  select count(*), count(*) filter (where private.rating_matches(r.value, n.locked_status))
    into v_total, v_matched
  from public.note_ratings r
  join public.notes n on n.id = r.note_id
  where r.value = p_value
    and not r.cast_while_public
    and n.locked_status in ('helpful', 'not_helpful')
    and n.locked_at > now() - make_interval(days => private.cfg_int('notes.base_rate_window_days'))
    and n.id <> p_exclude_note;

  if v_total < private.cfg_int('notes.base_rate_min_samples') then
    return 0.5;
  end if;
  return round(v_matched::numeric / v_total, 4);
end;
$$;

create function private.compute_rater_impact(p_rater uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(case when private.rating_matches(r.value, n.locked_status) then 1 else -1 end), 0)::integer
  from public.note_ratings r
  join public.notes n on n.id = r.note_id
  where r.rater_id = p_rater
    and r.value <> 'somewhat'
    and not r.cast_while_public
    and n.locked_status in ('helpful', 'not_helpful');
$$;

-- ---------------------------------------------------------------------------
-- Member RPCs
-- ---------------------------------------------------------------------------
create function public.propose_note(
  p_post_id        uuid,
  p_classification text,
  p_body           text,
  p_sources        jsonb,
  p_language       text default 'en'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_user();
  v_body   text := btrim(coalesce(p_body, ''));
  v_post   public.posts;
  v_id     uuid;
  v_source jsonb;
  v_pos    smallint := 0;
begin
  perform private.require_capability(v_uid, 'write_notes');
  perform private.enforce_rate_limit(v_uid, 'note');

  select * into v_post from public.posts where id = p_post_id;
  if not found or v_post.status not in ('visible', 'collapsed') then
    perform private.raise_error('PF404', 'not_found', 'post');
  end if;
  if v_post.author_id = v_uid then
    perform private.raise_error('PF403', 'own_post');
  end if;
  if exists (select 1 from public.notes n where n.post_id = p_post_id and n.author_id = v_uid) then
    perform private.raise_error('PF409', 'already_noted');
  end if;
  if p_classification is null or p_classification not in ('misleading', 'missing_context', 'outdated', 'unverifiable', 'opinion_as_fact', 'satire') then
    perform private.raise_error('PF422', 'invalid_classification');
  end if;
  if char_length(v_body) not between 20 and 500 then
    perform private.raise_error('PF422', 'invalid_body');
  end if;
  if p_language is null or p_language not in ('en', 'fr') then
    perform private.raise_error('PF422', 'invalid_language');
  end if;
  if p_sources is null or jsonb_typeof(p_sources) <> 'array' or jsonb_array_length(p_sources) not between 1 and 5 then
    perform private.raise_error('PF422', 'sources_required');
  end if;

  insert into public.notes (post_id, post_revision, author_id, classification, language, body)
  values (p_post_id, v_post.revision, v_uid, p_classification, p_language, v_body)
  returning id into v_id;

  for v_source in select * from jsonb_array_elements(p_sources) loop
    v_pos := v_pos + 1;
    if coalesce(v_source ->> 'url', '') !~ '^https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}/\S+$'
       or char_length(v_source ->> 'url') > 2048 then
      perform private.raise_error('PF422', 'invalid_source_url', v_pos::text);
    end if;
    if coalesce(v_source ->> 'kind', '') not in ('journal', 'registry', 'gov', 'news', 'other') then
      perform private.raise_error('PF422', 'invalid_source_kind', v_pos::text);
    end if;
    insert into public.note_sources (note_id, url, kind, position)
    values (v_id, v_source ->> 'url', v_source ->> 'kind', v_pos);
  end loop;

  insert into public.note_status_history (note_id, event, to_status)
  values (v_id, 'proposed', 'needs_more_ratings');

  return v_id;
end;
$$;

-- Hands the caller a note to rate, chosen at random among the least-rated
-- open notes they're eligible for. The assignment is what gives a rating full
-- weight, so raters can't cherry-pick brigade targets: a rater holds one
-- outstanding assignment at a time (calling again returns the same note until
-- it is rated, closes, or 24 h pass) and new draws are rate-limited, so the
-- queue can't be re-rolled until a target comes up.
create function public.next_note_to_rate()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := private.require_user();
  v_note uuid;
begin
  perform private.require_capability(v_uid, 'rate_notes');

  select a.note_id into v_note
  from public.rating_assignments a
  join public.notes n on n.id = a.note_id
  join public.posts p on p.id = n.post_id
  where a.rater_id = v_uid
    and a.assigned_at > now() - interval '24 hours'
    and n.locked_at is null
    and n.status = 'needs_more_ratings'
    and p.status in ('visible', 'collapsed')
    and not exists (select 1 from public.note_ratings r where r.note_id = a.note_id and r.rater_id = v_uid)
  order by a.assigned_at
  limit 1;
  if v_note is not null then
    return v_note;
  end if;

  perform private.enforce_rate_limit(v_uid, 'queue');

  select n.id into v_note
  from public.notes n
  join public.posts p on p.id = n.post_id
  where n.locked_at is null
    and n.status = 'needs_more_ratings'
    and n.author_id <> v_uid
    and p.author_id <> v_uid
    and p.status in ('visible', 'collapsed')
    and not exists (select 1 from public.note_ratings r where r.note_id = n.id and r.rater_id = v_uid)
  order by (select count(*) from public.note_ratings r where r.note_id = n.id and r.weight > 0), random()
  limit 1;

  if v_note is not null then
    insert into public.rating_assignments (rater_id, note_id) values (v_uid, v_note)
    on conflict do nothing;
  end if;
  return v_note;
end;
$$;

create function public.rate_note(p_note_id uuid, p_value text, p_reasons text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := private.require_user();
  v_note     public.notes;
  v_post     public.posts;
  v_profile  public.profiles;
  v_status   text;
  v_weight   numeric;
begin
  perform private.require_capability(v_uid, 'rate_notes');
  perform private.enforce_rate_limit(v_uid, 'rating');

  select * into v_note from public.notes where id = p_note_id for update;
  if not found then
    perform private.raise_error('PF404', 'not_found', 'note');
  end if;
  if v_note.locked_at is not null then
    perform private.raise_error('PF409', 'note_locked');
  end if;
  select * into v_post from public.posts where id = v_note.post_id;
  if v_post.status not in ('visible', 'collapsed') then
    perform private.raise_error('PF404', 'not_found', 'note');
  end if;
  if v_note.author_id = v_uid then
    perform private.raise_error('PF403', 'own_note');
  end if;
  if v_post.author_id = v_uid then
    perform private.raise_error('PF403', 'own_post');
  end if;
  if p_value is null or p_value not in ('helpful', 'somewhat', 'not_helpful') or not private.rating_reasons_valid(p_value, p_reasons) then
    perform private.raise_error('PF422', 'invalid_rating');
  end if;

  -- First rating enrols the member as a probationary rater.
  update public.profiles set rater_status = 'probation'
   where id = v_uid and rater_status = 'none'
  returning * into v_profile;
  if v_profile.id is null then
    select * into v_profile from public.profiles where id = v_uid;
  end if;

  v_status := private.effective_rater_status(v_profile);
  v_weight := case when v_status in ('founding', 'active') then 1 else 0 end;
  if v_weight > 0 and not exists (
    select 1 from public.rating_assignments a where a.rater_id = v_uid and a.note_id = p_note_id
  ) then
    v_weight := private.cfg_num('notes.unassigned_weight');
  end if;

  insert into public.note_ratings (note_id, rater_id, value, reasons, weight, cast_while_public)
  -- "Public" means the rater could have seen a result: the note is showing a
  -- status now, or showed one before falling back to Needs More Ratings.
  values (p_note_id, v_uid, p_value, p_reasons, v_weight,
          v_note.status <> 'needs_more_ratings'
          or exists (select 1 from public.note_status_history h
                     where h.note_id = p_note_id and h.event = 'status_changed'))
  on conflict (note_id, rater_id) do update
     set value             = excluded.value,
         reasons           = excluded.reasons,
         -- Changing your mind after the result is public forfeits accuracy credit.
         cast_while_public = public.note_ratings.cast_while_public or excluded.cast_while_public,
         updated_at        = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- Settlement (runs once per note, at lock)
-- ---------------------------------------------------------------------------
create function private.settle_note(p_note_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  n            public.notes;
  v_post       public.posts;
  v_final      text;
  v_helpful    integer;
  v_xp         numeric := 0;
  v_rating     record;
  v_pi_helpful numeric;
  v_pi_not     numeric;
  v_pi         numeric;
  v_recent     numeric;
  v_penalty    numeric;
  v_rater      uuid;
  v_impact     integer;
  v_window     record;
begin
  select * into n from public.notes where id = p_note_id;
  select * into v_post from public.posts where id = n.post_id;
  v_final := n.locked_status;

  -- 1 · Writer: moderation track only. Public karma would unmask the writer.
  if v_final = 'helpful' then
    select count(*) into v_helpful from public.note_ratings r
     where r.note_id = n.id and r.value = 'helpful' and r.weight > 0;
    v_xp := private.cfg_num('notes.writer_helpful_xp')
          + least(v_helpful, private.cfg_int('notes.writer_helpful_bonus_cap'));
  elsif v_final = 'not_helpful' then
    v_xp := private.cfg_num('notes.writer_not_helpful_xp');
  end if;

  perform private.reconcile('note_writer:' || n.id, n.author_id, 'mod_xp', 'note_written', 'note', n.id, v_xp);

  update public.profiles p
     set writer_impact = (
       select count(*) filter (where x.locked_status = 'helpful')
            - count(*) filter (where x.locked_status = 'not_helpful')
       from public.notes x where x.author_id = n.author_id and x.locked_at is not null
     )
   where p.id = n.author_id;

  -- Writer lock: a recent run of unhelpful notes suspends writing until it
  -- expires (members re-earn trust by rating in the meantime).
  select count(*) as total,
         count(*) filter (where w.locked_status = 'helpful')     as helpful,
         count(*) filter (where w.locked_status = 'not_helpful') as not_helpful
    into v_window
  from (
    select x.locked_status from public.notes x
    where x.author_id = n.author_id and x.locked_status in ('helpful', 'not_helpful')
    order by x.locked_at desc
    limit private.cfg_int('notes.writer_lock_window')
  ) w;

  if v_window.not_helpful >= private.cfg_int('notes.writer_lock_min_not_helpful')
     and v_window.helpful::numeric / greatest(v_window.total, 1) < private.cfg_num('notes.writer_lock_helpful_ratio') then
    update public.profiles
       set writing_locked_until = greatest(coalesce(writing_locked_until, now()),
                                           now() + make_interval(days => private.cfg_int('notes.writer_lock_days')))
     where id = n.author_id;
  end if;

  if v_final not in ('helpful', 'not_helpful') then
    return;  -- locked as Needs More Ratings: no rater payouts, no author consequences
  end if;

  -- 2 · Raters: base-rate-adjusted accuracy rewards on the moderation track.
  v_pi_helpful := private.rating_base_rate('helpful', n.id);
  v_pi_not     := private.rating_base_rate('not_helpful', n.id);

  for v_rating in
    select r.rater_id, r.value from public.note_ratings r
    where r.note_id = n.id and not r.cast_while_public and r.value <> 'somewhat'
  loop
    v_pi := case v_rating.value when 'helpful' then v_pi_helpful else v_pi_not end;
    perform private.reconcile(
      'note_rating:' || n.id, v_rating.rater_id, 'mod_xp', 'note_rating', 'note', n.id,
      private.cfg_num('notes.rater_xp_scale')
        * ((case when private.rating_matches(v_rating.value, v_final) then 1 else 0 end) - v_pi)
    );
  end loop;

  -- Impact drives graduation out of (and demotion back into) probation.
  for v_rater in select distinct r.rater_id from public.note_ratings r where r.note_id = n.id loop
    v_impact := private.compute_rater_impact(v_rater);
    update public.profiles p
       set rater_impact = v_impact,
           rater_status = case
             when p.rater_status = 'probation' and v_impact >= private.cfg_int('notes.graduation_impact') then 'active'
             when p.rater_status = 'active'    and v_impact <= private.cfg_int('notes.demotion_impact')   then 'probation'
             else p.rater_status
           end
     where p.id = v_rater;
  end loop;

  -- 3 · Post author: a strike only for a *misleading*-class note that settled
  -- Helpful on a non-experience post the author didn't correct in time.
  if v_final = 'helpful'
     and n.classification = any (array(select jsonb_array_elements_text(private.cfg('notes.strike_classifications'))))
     and v_post.post_type <> 'experience'
     and n.post_corrected_at is null then

    insert into public.strikes (user_id, reason, points, source_kind, source_id, expires_at)
    values (v_post.author_id, 'note_misleading', private.cfg_int('strikes.note_misleading_points'),
            'note', n.id, now() + make_interval(days => private.cfg_int('strikes.duration_days')))
    on conflict (user_id, reason, source_kind, source_id) do nothing;

    -- Karma penalty, capped per rolling 30 days so a pile-on can't wipe an account.
    select coalesce(-sum(e.delta), 0) into v_recent
    from public.ledger_events e
    where e.user_id = v_post.author_id
      and e.reason = 'note_strike'
      and e.track = 'karma'
      and e.event_key <> 'note_strike:' || n.id
      and e.created_at > now() - interval '30 days';

    v_penalty := least(private.cfg_int('notes.author_penalty_karma'),
                       greatest(0, private.cfg_int('notes.author_penalty_cap_30d') - v_recent));
    perform private.reconcile('note_strike:' || n.id, v_post.author_id, 'karma', 'note_strike', 'note', n.id, -v_penalty);
  end if;
end;
$$;

-- Locks every note whose status is settled, then settles it.
create function private.lock_due_notes(p_run_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_note   record;
  v_locked integer := 0;
begin
  for v_note in
    select n.id, n.status from public.notes n
    where n.locked_at is null
      and (
        (n.status <> 'needs_more_ratings'
         and n.status_since <= now() - make_interval(hours => private.cfg_int('notes.lock_stable_hours'))
         and (select count(*) from public.note_ratings r where r.note_id = n.id and r.weight > 0)
             >= private.note_min_ratings(n.id))
        or n.created_at <= now() - make_interval(days => private.cfg_int('notes.max_age_days'))
      )
    for update of n skip locked
  loop
    update public.notes set locked_at = now(), locked_status = v_note.status where id = v_note.id;
    insert into public.note_status_history (note_id, event, from_status, to_status, run_id)
    values (v_note.id, 'locked', v_note.status, v_note.status, p_run_id);
    perform private.settle_note(v_note.id);
    v_locked := v_locked + 1;
  end loop;
  return v_locked;
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker entry point (service_role only)
--
-- p_results: [{ "note_id": uuid, "status": text, "intercept": num, "factor": num }]
-- Idempotent per run id; stale results (ratings newer than the snapshot the
-- worker scored) are skipped and picked up next run; only one run at a time.
-- ---------------------------------------------------------------------------
create function public.apply_note_scores(
  p_run_id   uuid,
  p_snapshot timestamptz,
  p_mode     text,
  p_results  jsonb,
  p_shadow   jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result      jsonb;
  v_note        public.notes;
  v_status      text;
  v_scored      integer := 0;
  v_transitions integer := 0;
  v_stale       integer := 0;
  v_locked      integer;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('pepforum:apply_note_scores', 0)) then
    perform private.raise_error('PF409', 'scoring_busy');
  end if;
  if exists (select 1 from public.scoring_runs where id = p_run_id) then
    return jsonb_build_object('run_id', p_run_id, 'already_applied', true);
  end if;
  if p_mode is null or p_mode not in ('bootstrap', 'bridging') or jsonb_typeof(p_results) is distinct from 'array' then
    perform private.raise_error('PF422', 'invalid_scoring_payload');
  end if;

  insert into public.scoring_runs (id, mode, snapshot_ts, shadow) values (p_run_id, p_mode, p_snapshot, p_shadow);

  for v_result in select * from jsonb_array_elements(p_results) loop
    v_status := v_result ->> 'status';
    if v_status not in ('needs_more_ratings', 'helpful', 'not_helpful') then
      perform private.raise_error('PF422', 'invalid_scoring_payload', v_result ->> 'note_id');
    end if;

    select * into v_note from public.notes where id = (v_result ->> 'note_id')::uuid for update;
    if not found or v_note.locked_at is not null then
      continue;
    end if;
    if exists (select 1 from public.note_ratings r where r.note_id = v_note.id and r.updated_at > p_snapshot) then
      v_stale := v_stale + 1;
      continue;
    end if;

    v_scored := v_scored + 1;
    update public.notes
       set intercept    = (v_result ->> 'intercept')::double precision,
           factor       = (v_result ->> 'factor')::double precision,
           scoring_mode = p_mode,
           scored_at    = now()
     where id = v_note.id;

    if v_status <> v_note.status then
      update public.notes
         set status         = v_status,
             status_since   = now(),
             first_shown_at = coalesce(first_shown_at, case when v_status = 'helpful' then now() end)
       where id = v_note.id;
      insert into public.note_status_history (note_id, event, from_status, to_status, run_id)
      values (v_note.id, 'status_changed', v_note.status, v_status, p_run_id);
      v_transitions := v_transitions + 1;
    end if;
  end loop;

  v_locked := private.lock_due_notes(p_run_id);

  update public.scoring_runs
     set notes_scored = v_scored, transitions = v_transitions, locked = v_locked, skipped_stale = v_stale
   where id = p_run_id;

  return jsonb_build_object(
    'run_id', p_run_id, 'scored', v_scored, 'transitions', v_transitions,
    'locked', v_locked, 'skipped_stale', v_stale
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS & grants
-- ---------------------------------------------------------------------------
alter table public.notes               enable row level security;
alter table public.note_sources        enable row level security;
alter table public.note_ratings        enable row level security;
alter table public.rating_assignments  enable row level security;
alter table public.scoring_runs        enable row level security;
alter table public.note_status_history enable row level security;

-- Public reads go through get_post_notes()/get_note(), which return the alias
-- instead of author_id. Direct table reads are limited to the writer and mods.
create policy notes_self_or_mod_read on public.notes
  for select to authenticated
  using (author_id = auth.uid() or (private.is_moderator(auth.uid()) and private.staff_session()));

create policy note_ratings_self_read on public.note_ratings
  for select to authenticated using (rater_id = auth.uid());

create policy rating_assignments_self_read on public.rating_assignments
  for select to authenticated using (rater_id = auth.uid());

create policy scoring_runs_mod_read on public.scoring_runs
  for select to authenticated using (private.is_moderator(auth.uid()) and private.staff_session());

grant select on public.notes, public.note_ratings, public.rating_assignments, public.scoring_runs to authenticated;

-- The scoring worker reads raw ratings with the secret key (bypasses RLS).
grant select on public.notes, public.note_ratings, public.note_sources, public.scoring_runs to service_role;

grant execute on function public.propose_note(uuid, text, text, jsonb, text) to authenticated;
grant execute on function public.next_note_to_rate()                         to authenticated;
grant execute on function public.rate_note(uuid, text, text[])               to authenticated;
grant execute on function public.apply_note_scores(uuid, timestamptz, text, jsonb, jsonb) to service_role;
