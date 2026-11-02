-- ============================================================================
-- 0004 · Karma / moderation-XP ledger (ADR-0002)
--
-- Every point a member gains or loses is one append-only row with a reason and
-- a source. Cached totals on profiles are maintained by trigger and can always
-- be recomputed from this table, which is what makes disputes and audits
-- answerable ("why did my karma drop?").
--
-- Writers never insert raw deltas. They call private.reconcile(), stating the
-- *desired* total for (event_key, user, track); reconcile inserts the
-- difference. Re-running a settlement is therefore a no-op, and a reversal
-- (appeal upheld, vote removed) is just "desired = 0".
-- ============================================================================

create table public.ledger_events (
  id          bigint generated always as identity primary key,
  user_id     uuid          not null references public.profiles (id),
  track       text          not null check (track in ('karma', 'mod_xp')),
  delta       numeric(10,2) not null check (delta <> 0),
  reason      text          not null check (reason ~ '^[a-z_]+$'),
  source_kind text          not null check (source_kind ~ '^[a-z_]+$'),
  source_id   uuid,
  -- Groups the rows that together express one fact, e.g. 'post_votes:<post id>'.
  event_key   text          not null,
  created_at  timestamptz   not null default now(),
  check (track <> 'karma' or delta = trunc(delta))
);
create index ledger_events_user_time on public.ledger_events (user_id, created_at desc);
create index ledger_events_key       on public.ledger_events (event_key, user_id, track);

comment on table public.ledger_events is
  'Append-only karma/mod-XP ledger. Written only through private.reconcile().';

create trigger ledger_events_append_only
  before update or delete on public.ledger_events
  for each row execute function private.forbid_mutation();

create trigger ledger_events_no_truncate
  before truncate on public.ledger_events
  for each statement execute function private.forbid_mutation();

-- Keep profiles.karma / mod_xp / tier in sync.
--
-- Tier hysteresis: promotion happens as soon as karma reaches a threshold;
-- demotion only once karma falls below `tiers.demotion_ratio` (default 90%) of
-- the current tier's threshold, so privileges don't flicker around a boundary.
create function private.apply_ledger_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_thresholds jsonb;
  v_ratio      numeric;
  v_karma      integer;
  v_tier       smallint;
  v_candidate  smallint := 0;
  i            integer;
begin
  if new.track = 'mod_xp' then
    update public.profiles set mod_xp = mod_xp + new.delta where id = new.user_id;
    return null;
  end if;

  update public.profiles
     set karma = karma + new.delta::integer
   where id = new.user_id
  returning karma, tier into v_karma, v_tier;

  v_thresholds := private.cfg('tiers.thresholds');
  v_ratio      := private.cfg_num('tiers.demotion_ratio');

  for i in 0 .. jsonb_array_length(v_thresholds) - 1 loop
    if v_karma >= (v_thresholds ->> i)::integer then
      v_candidate := i;
    end if;
  end loop;

  if v_candidate > v_tier
     or (v_candidate < v_tier and v_karma < floor((v_thresholds ->> v_tier)::integer * v_ratio)) then
    update public.profiles set tier = v_candidate where id = new.user_id;
  end if;

  return null;
end;
$$;

create trigger ledger_events_apply
  after insert on public.ledger_events
  for each row execute function private.apply_ledger_event();

-- Insert whatever delta brings (event_key, user, track) to `p_desired`.
-- Returns the delta inserted (0 when already reconciled).
create function private.reconcile(
  p_event_key   text,
  p_user        uuid,
  p_track       text,
  p_reason      text,
  p_source_kind text,
  p_source_id   uuid,
  p_desired     numeric
)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current numeric;
  v_delta   numeric;
begin
  if p_user is null then
    return 0;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_event_key || ':' || p_user::text || ':' || p_track, 0));

  select coalesce(sum(e.delta), 0) into v_current
  from public.ledger_events e
  where e.event_key = p_event_key and e.user_id = p_user and e.track = p_track;

  v_delta := round(p_desired, 2) - v_current;
  if p_track = 'karma' then
    v_delta := trunc(v_delta);
  end if;

  if v_delta <> 0 then
    insert into public.ledger_events (user_id, track, delta, reason, source_kind, source_id, event_key)
    values (p_user, p_track, v_delta, p_reason, p_source_kind, p_source_id, p_event_key);
  end if;

  return v_delta;
end;
$$;

-- Current total for one fact (used by caps, e.g. "−30 karma per 30 days").
create function private.ledger_total(p_event_key text, p_user uuid, p_track text)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(e.delta), 0)
  from public.ledger_events e
  where e.event_key = p_event_key and e.user_id = p_user and e.track = p_track;
$$;

alter table public.ledger_events enable row level security;

-- Your own history is yours to see; moderators can see anyone's (disputes).
create policy ledger_events_self_or_mod_read on public.ledger_events
  for select to authenticated
  using (user_id = auth.uid() or (private.is_moderator(auth.uid()) and private.staff_session()));

grant select on public.ledger_events to authenticated;
