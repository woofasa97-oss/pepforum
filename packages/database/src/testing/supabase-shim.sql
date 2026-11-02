-- Minimal Supabase environment for PGlite, so the real migrations can run
-- unmodified in tests. Mirrors the parts of a Supabase project our migrations
-- and policies depend on:
--   * API roles anon / authenticated / service_role (service_role bypasses RLS)
--   * Supabase's default privileges, which grant everything on new objects in
--     `public` to the API roles — our migrations must revoke these, and the
--     tests prove they do
--   * auth.users plus auth.uid() / auth.jwt() reading PostgREST's request GUCs
-- It intentionally does NOT give `postgres` any extra privileges beyond what
-- PGlite's superuser already has.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  instance_id        uuid,
  id                 uuid primary key default gen_random_uuid(),
  aud                text,
  role               text,
  email              text unique,
  encrypted_password text,
  confirmation_token text,
  recovery_token     text,
  email_change_token_new text,
  email_change       text,
  phone              text,
  email_confirmed_at timestamptz,
  phone_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data  jsonb not null default '{}'::jsonb,
  last_sign_in_at    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Supabase Auth's MFA factors (status is an enum there: unverified | verified).
create table auth.mfa_factors (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  friendly_name text,
  factor_type   text not null default 'totp',
  status        text not null default 'unverified',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table auth.identities (
  id              uuid primary key default gen_random_uuid(),
  provider_id     text not null,
  user_id         uuid not null references auth.users (id) on delete cascade,
  identity_data   jsonb not null,
  provider        text not null,
  last_sign_in_at timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

create function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;

create publication supabase_realtime;
