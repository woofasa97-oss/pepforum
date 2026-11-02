-- ============================================================================
-- 0001 · Foundation
--
-- Security model (see docs/ARCHITECTURE.md, ADR-0001):
--   * The database is the security boundary. PostgREST is assumed reachable
--     directly with any user's JWT, so every rule lives here, not in the app.
--   * Nothing is granted by default. Supabase's default privileges grant ALL on
--     new objects to anon/authenticated/service_role; we revoke those defaults
--     and grant explicitly, object by object.
--   * Business logic lives in the `private` schema, which PostgREST does not
--     expose. Thin `public` RPC wrappers are the only callable surface.
--
-- Error convention: functions raise SQLSTATE codes in the custom `PF` class so
-- the web app can map them to user-facing messages (apps/web/src/lib/errors.ts):
--   PF401 not_authenticated · PF403 forbidden/capability · PF404 not_found
--   PF409 conflict · PF422 invalid_input · PF428 mfa_required · PF429 rate_limited
--   PF500 server_misconfigured
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Default privileges: deny by default
-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE on every new function to PUBLIC. That built-in
-- default can only be revoked globally (an IN SCHEMA clause cannot remove it).
alter default privileges revoke execute on functions from public;

alter default privileges in schema public revoke all on tables    from anon, authenticated, service_role;
alter default privileges in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges in schema public revoke all on functions  from public, anon, authenticated, service_role;

create schema if not exists private;
comment on schema private is
  'Internal business logic and state. Never exposed through PostgREST. '
  'Functions here are executable only where explicitly granted.';

revoke all on schema private from public;
-- RLS policy expressions run as the querying role, so the predicate helpers
-- they call must be executable by anon/authenticated. USAGE alone grants no
-- table or function access; each function is granted individually.
grant usage on schema private to anon, authenticated, service_role;

alter default privileges in schema private revoke all on tables    from public, anon, authenticated, service_role;
alter default privileges in schema private revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges in schema private revoke all on functions  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Errors
-- ---------------------------------------------------------------------------
create function private.raise_error(p_code text, p_message text, p_detail text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = p_code, message = p_message, detail = coalesce(p_detail, '');
end;
$$;

-- ---------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------
create function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Attached to audit/ledger tables: rows can be inserted, never changed.
create function private.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'PF403',
    message = 'append_only',
    detail  = format('%I.%I is append-only', tg_table_schema, tg_table_name);
end;
$$;

-- ---------------------------------------------------------------------------
-- Runtime configuration
--
-- Every tunable threshold (tiers, gates, rewards, penalties, rate limits,
-- scoring parameters) lives here so the self-moderation economy can be tuned
-- without a deploy. Defaults are inserted by the reference-data migration.
-- Changes are written by `admin_set_config` and recorded in app_config_history.
-- ---------------------------------------------------------------------------
create table public.app_config (
  key         text primary key check (key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'),
  value       jsonb       not null,
  description text        not null default '',
  is_public   boolean     not null default true,
  updated_at  timestamptz not null default now()
);
comment on table public.app_config is
  'Tunable thresholds for the karma/notes economy. Public keys are readable by everyone; writes only via admin_set_config().';

create table public.app_config_history (
  id         bigint generated always as identity primary key,
  key        text        not null,
  old_value  jsonb,
  new_value  jsonb       not null,
  changed_by uuid,
  changed_at timestamptz not null default now()
);

create function private.record_config_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then
    return new;
  end if;
  insert into public.app_config_history (key, old_value, new_value, changed_by)
  values (new.key, case when tg_op = 'UPDATE' then old.value end, new.value, auth.uid());
  new.updated_at := now();
  return new;
end;
$$;

create trigger app_config_history
  before insert or update on public.app_config
  for each row execute function private.record_config_change();

create trigger app_config_history_append_only
  before update or delete on public.app_config_history
  for each row execute function private.forbid_mutation();

alter table public.app_config enable row level security;
alter table public.app_config_history enable row level security;

create policy app_config_public_read on public.app_config
  for select to anon, authenticated
  using (is_public);

grant select on public.app_config to anon, authenticated;
grant select on public.app_config to service_role;

create function private.cfg(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  select c.value into v from public.app_config c where c.key = p_key;
  if not found then
    perform private.raise_error('PF500', 'config_missing', p_key);
  end if;
  return v;
end;
$$;

create function private.cfg_int(p_key text) returns integer
language sql stable set search_path = ''
as $$ select (private.cfg(p_key) #>> '{}')::integer $$;

create function private.cfg_num(p_key text) returns numeric
language sql stable set search_path = ''
as $$ select (private.cfg(p_key) #>> '{}')::numeric $$;

create function private.cfg_bool(p_key text) returns boolean
language sql stable set search_path = ''
as $$ select (private.cfg(p_key) #>> '{}')::boolean $$;

create function private.cfg_text(p_key text) returns text
language sql stable set search_path = ''
as $$ select private.cfg(p_key) #>> '{}' $$;

-- Internal secrets (e.g. the salt for public note-writer aliases). Never
-- readable by any API role.
create table private.settings (
  key   text primary key,
  value text not null
);
alter table private.settings enable row level security;

insert into private.settings (key, value)
values ('note_alias_salt', md5(random()::text || clock_timestamp()::text || random()::text));

-- ---------------------------------------------------------------------------
-- Rate limiting
--
-- Sliding-window limits enforced inside every write RPC, so they hold even
-- when the API is called directly. Limits come from `rate_limit.<action>`:
--   {"limit": 200, "window_seconds": 3600}
-- ---------------------------------------------------------------------------
create table private.rate_limit_events (
  id         bigint generated always as identity primary key,
  user_id    uuid        not null,
  action     text        not null,
  created_at timestamptz not null default now()
);
create index rate_limit_events_lookup on private.rate_limit_events (user_id, action, created_at);
alter table private.rate_limit_events enable row level security;

create function private.enforce_rate_limit(p_user uuid, p_action text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule   jsonb := private.cfg('rate_limit.' || p_action);
  v_limit  integer := (v_rule ->> 'limit')::integer;
  v_window interval := make_interval(secs => (v_rule ->> 'window_seconds')::integer);
  v_count  integer;
begin
  -- Serialise concurrent requests from the same user for the same action so
  -- the count below can't be raced.
  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || p_action, 0));

  select count(*) into v_count
  from private.rate_limit_events e
  where e.user_id = p_user
    and e.action = p_action
    and e.created_at > now() - v_window;

  if v_count >= v_limit then
    perform private.raise_error('PF429', 'rate_limited', p_action);
  end if;

  insert into private.rate_limit_events (user_id, action) values (p_user, p_action);
end;
$$;

create function private.purge_rate_limit_events()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from private.rate_limit_events where created_at < now() - interval '2 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- Authentication helpers
-- ---------------------------------------------------------------------------

-- Returns the caller's user id or raises PF401. Every write RPC starts here.
create function private.require_user()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform private.raise_error('PF401', 'not_authenticated');
  end if;
  return v_uid;
end;
$$;

-- Moderator and admin actions require a second factor (TOTP). The assurance
-- level comes from the verified JWT, so it can't be forged by the client.
create function private.require_aal2()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if private.cfg_bool('security.require_mfa_for_staff')
     and coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    perform private.raise_error('PF428', 'mfa_required');
  end if;
end;
$$;
