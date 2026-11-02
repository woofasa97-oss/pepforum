-- ============================================================================
-- 0010 · Security self-audit
--
-- private.security_audit() inspects the catalog and returns one row per
-- violation of the rules in docs/ARCHITECTURE.md. The test suite asserts it
-- returns nothing, and docs/RUNBOOK.md has you run it after every production
-- migration:
--     select * from private.security_audit();
-- ============================================================================

create function private.security_audit()
returns table (check_name text, object_name text, detail text)
language sql
stable
security definer
set search_path = ''
as $$
  -- 1 · Every table in an app schema has RLS enabled.
  select 'rls_disabled', n.nspname || '.' || c.relname, 'row level security is not enabled'
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and n.nspname in ('public', 'private') and not c.relrowsecurity

  union all
  -- 2 · No API role can write any table directly (all writes go through RPCs).
  --     Column-level UPDATE grants (profiles' descriptive fields) are reported
  --     separately by information_schema.column_privileges and are allowed.
  select 'direct_write_grant', g.table_schema || '.' || g.table_name, g.grantee || ' has ' || g.privilege_type
  from information_schema.role_table_grants g
  where g.table_schema in ('public', 'private')
    and g.grantee in ('anon', 'authenticated', 'public')
    and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES')

  union all
  -- 3 · Nothing in the private schema is readable by API roles.
  select 'private_table_grant', g.table_schema || '.' || g.table_name, g.grantee || ' has ' || g.privilege_type
  from information_schema.role_table_grants g
  where g.table_schema = 'private' and g.grantee in ('anon', 'authenticated', 'public', 'service_role')

  union all
  -- 4 · SECURITY DEFINER functions pin search_path (prevents object hijacking).
  select 'definer_without_search_path', n.nspname || '.' || p.proname, 'security definer function without search_path'
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')

  union all
  -- 5 · No function is executable by PUBLIC (the Postgres default we revoke).
  select 'function_executable_by_public', n.nspname || '.' || p.proname, 'EXECUTE granted to PUBLIC'
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE')

  union all
  -- 6 · Votes, ratings and reports are never broadcast over Realtime.
  select 'realtime_publication', pt.schemaname || '.' || pt.tablename, 'table is in supabase_realtime'
  from pg_catalog.pg_publication_tables pt
  where pt.pubname = 'supabase_realtime' and pt.schemaname in ('public', 'private');
$$;

-- Realtime is not used in v1. If the publication exists (it does on Supabase),
-- make sure none of our tables are part of it.
do $$
declare
  v_table record;
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    for v_table in
      select schemaname, tablename from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname in ('public', 'private')
    loop
      execute format('alter publication supabase_realtime drop table %I.%I', v_table.schemaname, v_table.tablename);
    end loop;
  end if;
end;
$$;
