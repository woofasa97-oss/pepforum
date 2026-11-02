-- ============================================================================
-- 0012 · Maintenance entry point (service_role, called by the worker cron)
-- ============================================================================

create function public.run_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return jsonb_build_object(
    'uncollapsed',         public.expire_stale_collapses(),
    'rate_limit_purged',   private.purge_rate_limit_events(),
    'assignments_purged',  private.purge_stale_assignments()
  );
end;
$$;

-- Assignments are only meaningful while a note is open; drop old ones.
create function private.purge_stale_assignments()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.rating_assignments a
  using public.notes n
  where n.id = a.note_id and (n.locked_at is not null or a.assigned_at < now() - interval '30 days');
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

grant execute on function public.run_maintenance() to service_role;
